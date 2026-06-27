import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import {
  applyBaselineSchema,
  columnExists,
  migrateSqlite,
  tableExists,
  type BaselineDetector,
  type SqlMigration,
} from "../../src/do/sql-migrations";
import {
  CHANNEL_DIRECTORY_BASELINE_SCHEMA,
  CHANNEL_DIRECTORY_CURRENT_SCHEMA_VERSION,
  channelDirectoryBaseline,
  channelDirectoryMigrations,
} from "../../src/do/migrations/channel-directory";
import {
  DM_DIRECTORY_CURRENT_SCHEMA_VERSION,
  dmDirectoryBaseline,
  dmDirectoryMigrations,
} from "../../src/do/migrations/dm-directory";

function directoryStub(name: string) {
  return getNamedDo(env.CHANNEL_DIRECTORY as unknown as DurableObjectNamespace, name);
}

function dmDirectoryStub(name: string) {
  return getNamedDo(env.DM_DIRECTORY as unknown as DurableObjectNamespace, name);
}

async function withDoState(stub: DurableObjectStub, fn: (ctx: DurableObjectState) => void | Promise<void>): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function schemaVersion(stub: DurableObjectStub): Promise<{ current_version: number; applied: Array<{ version: number }> }> {
  const res = await stub.fetch(
    new Request("https://x/internal/schema-version", { headers: { "X-Test-Only": "1" } }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { current_version: number; applied: Array<{ version: number }> };
}

describe("migrateSqlite", () => {
  it("empty DB runs baseline and stamps version 1", async () => {
    const stub = directoryStub(`migrate-empty-${crypto.randomUUID()}`);
    const body = await schemaVersion(stub);
    expect(body.current_version).toBe(CHANNEL_DIRECTORY_CURRENT_SCHEMA_VERSION);
    expect(body.applied.map((row) => row.version)).toEqual([1]);
  });

  it("existing baseline tables without schema_migrations re-run idempotent baseline DDL and stamp baseline", async () => {
    const stub = directoryStub(`migrate-legacy-${crypto.randomUUID()}`);
    await stub.fetch(new Request("https://x/ping"));

    await withDoState(stub, (ctx) => {
      ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO public_channels (channel_id, title, avatar_url, member_count, last_message_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "legacy-channel",
        "Legacy",
        null,
        1,
        null,
        "active",
        "2026-01-01T00:00:00.000Z",
      );
      ctx.storage.sql.exec("DROP TABLE schema_migrations");

      migrateSqlite(ctx, "ChannelDirectory", channelDirectoryBaseline, channelDirectoryMigrations);

      // Idempotent baseline DDL re-ran (CREATE TABLE IF NOT EXISTS) — anchor data preserved
      const rows = ctx.storage.sql
        .exec("SELECT channel_id, title FROM public_channels WHERE channel_id=?", "legacy-channel")
        .toArray() as Array<{ channel_id: string; title: string }>;
      expect(rows[0]?.title).toBe("Legacy");
      expect(tableExists(ctx, "schema_migrations")).toBe(true);
    });

    const body = await schemaVersion(stub);
    expect(body.current_version).toBe(1);
    expect(body.applied.some((row) => row.version === 1)).toBe(true);
  });

  it("applies migrations in version order", async () => {
    const stub = directoryStub(`migrate-order-${crypto.randomUUID()}`);

    const order: number[] = [];
    const testBaseline: BaselineDetector = {
      version: 1,
      name: "test baseline",
      applyFresh(ctx) {
        applyBaselineSchema(ctx, CHANNEL_DIRECTORY_BASELINE_SCHEMA);
      },
    };
    const testMigrations: SqlMigration[] = [
      {
        version: 10,
        name: "first",
        up() {
          order.push(10);
        },
      },
      {
        version: 20,
        name: "second",
        up() {
          order.push(20);
        },
      },
    ];

    await withDoState(stub, (ctx) => {
      ctx.storage.sql.exec("DROP TABLE IF EXISTS schema_migrations");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS public_channels");
      migrateSqlite(ctx, "ChannelDirectory", testBaseline, testMigrations);
      migrateSqlite(ctx, "ChannelDirectory", testBaseline, testMigrations);
    });

    expect(order).toEqual([10, 20]);
  });

  it("re-running migration is idempotent", async () => {
    const stub = directoryStub(`migrate-idempotent-${crypto.randomUUID()}`);
    const first = await schemaVersion(stub);
    const second = await schemaVersion(stub);
    expect(second).toEqual(first);
  });

  it("failed migration does not stamp version", async () => {
    const stub = directoryStub(`migrate-fail-${crypto.randomUUID()}`);

    const failingMigrations: SqlMigration[] = [
      {
        version: 99,
        name: "boom",
        up() {
          throw new Error("migration failed");
        },
      },
    ];

    await withDoState(stub, (ctx) => {
      expect(() =>
        migrateSqlite(ctx, "ChannelDirectory", channelDirectoryBaseline, [
          ...channelDirectoryMigrations,
          ...failingMigrations,
        ]),
      ).toThrow("migration failed");

      const rows = ctx.storage.sql.exec("SELECT version FROM schema_migrations WHERE version=99").toArray();
      expect(rows).toHaveLength(0);
    });
  });

  it("retry after failure succeeds when migration is fixed", async () => {
    const stub = directoryStub(`migrate-retry-${crypto.randomUUID()}`);

    let shouldFail = true;
    const flakyMigration: SqlMigration = {
      version: 77,
      name: "flaky",
      up(ctx) {
        if (shouldFail) throw new Error("temporary failure");
        if (!columnExists(ctx, "public_channels", "title")) {
          throw new Error("missing anchor table");
        }
      },
    };

    await withDoState(stub, (ctx) => {
      expect(() => migrateSqlite(ctx, "ChannelDirectory", channelDirectoryBaseline, [flakyMigration])).toThrow(
        "temporary failure",
      );

      shouldFail = false;
      migrateSqlite(ctx, "ChannelDirectory", channelDirectoryBaseline, [flakyMigration]);

      const rows = ctx.storage.sql.exec("SELECT version FROM schema_migrations WHERE version=77").toArray();
      expect(rows).toHaveLength(1);
    });
  });
});

describe("DMDirectory migrateSqlite", () => {
  it("empty DB runs baseline and stamps version 1", async () => {
    const stub = dmDirectoryStub(`dm-migrate-empty-${crypto.randomUUID()}`);
    const res = await stub.fetch(
      new Request("https://x/internal/schema-version", { headers: { "X-Test-Only": "1" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { current_version: number; applied: Array<{ version: number }> };
    expect(body.current_version).toBe(DM_DIRECTORY_CURRENT_SCHEMA_VERSION);
    expect(body.applied.map((row) => row.version)).toEqual([1]);
  });

  it("dm_pairs table exists after migration", async () => {
    const stub = dmDirectoryStub(`dm-migrate-table-${crypto.randomUUID()}`);
    await stub.fetch(new Request("https://x/ping"));

    await withDoState(stub, (ctx) => {
      migrateSqlite(ctx, "DMDirectory", dmDirectoryBaseline, dmDirectoryMigrations);
      expect(tableExists(ctx, "dm_pairs")).toBe(true);
    });
  });
});
