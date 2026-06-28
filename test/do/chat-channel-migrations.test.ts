import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { applyBaselineSchema, columnExists, migrateSqlite, tableExists } from "../../src/do/sql-migrations";
import {
  CHAT_CHANNEL_CURRENT_SCHEMA_VERSION,
  CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA,
  chatChannelBaseline,
  chatChannelMigrations,
  migrateChatChannelSchema,
} from "../../src/do/migrations/chat-channel";

function chatStub(channelId: string) {
  return getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace, channelId);
}

async function withDoState(stub: DurableObjectStub, fn: (ctx: DurableObjectState) => void | Promise<void>): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

describe("ChatChannel migrations", () => {
  it("upgrades legacy schema to current version", async () => {
    const channelId = `legacy-migrate-${crypto.randomUUID()}`;
    const stub = chatStub(channelId);

    await withDoState(stub, (ctx) => {
      for (const table of ["schema_migrations", "message_stickers", "attachments", "channel_meta", "event_seq"]) {
        ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }

      applyBaselineSchema(ctx, CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA);
      ctx.storage.sql.exec(
        `INSERT INTO channel_meta (
          channel_id, kind, visibility, title, topic, avatar_url, status,
          created_by, created_at, updated_at, member_count, membership_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        channelId,
        "group",
        "private",
        "Legacy",
        null,
        null,
        "active",
        "user-1",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        1,
        1,
      );
      ctx.storage.sql.exec(
        `INSERT INTO attachments (
          attachment_id, owner_user_id, kind, filename, mime_type, size_bytes,
          width, height, storage_key, url, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "att-legacy",
        "user-1",
        "image",
        "legacy.png",
        "image/png",
        100,
        10,
        10,
        "key-legacy",
        "https://example.test/legacy.png",
        "ready",
        "2026-01-01T00:00:00.000Z",
      );

      migrateChatChannelSchema(ctx);

      expect(columnExists(ctx, "attachments", "blurhash")).toBe(true);
      expect(columnExists(ctx, "message_stickers", "blurhash")).toBe(true);

      const attachment = ctx.storage.sql
        .exec("SELECT attachment_id, blurhash FROM attachments WHERE attachment_id=?", "att-legacy")
        .toArray()[0] as { attachment_id: string; blurhash: string | null } | undefined;
      expect(attachment?.attachment_id).toBe("att-legacy");
      expect(attachment?.blurhash).toBeNull();
    });

    const res = await stub.fetch(
      new Request("https://x/internal/schema-version", { headers: { "X-Test-Only": "1" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current_version: number };
    expect(body.current_version).toBe(CHAT_CHANNEL_CURRENT_SCHEMA_VERSION);
  });

  it("rejects schema-version without X-Test-Only", async () => {
    const stub = chatStub(`schema-version-guard-${crypto.randomUUID()}`);
    const res = await stub.fetch(new Request("https://x/internal/schema-version"));
    expect(res.status).toBe(403);
  });

  it("does not reapply completed migrations", async () => {
    const channelId = `migrate-noop-${crypto.randomUUID()}`;
    const stub = chatStub(channelId);
    await stub.fetch(new Request("https://x/ping"));

    let migrationRuns = 0;
    const extraMigration = {
      version: 2026062899,
      name: "count runs",
      up() {
        migrationRuns += 1;
      },
    };

    await withDoState(stub, (ctx) => {
      migrateSqlite(ctx, "ChatChannel", chatChannelBaseline, [...chatChannelMigrations, extraMigration]);
      migrateSqlite(ctx, "ChatChannel", chatChannelBaseline, [...chatChannelMigrations, extraMigration]);
    });

    expect(migrationRuns).toBe(1);
  });

  it("upgrades pre-Phase-E DO with missing message_stickers table (P0 regression)", async () => {
    const channelId = `legacy-pre-phase-e-${crypto.randomUUID()}`;
    const stub = chatStub(channelId);

    const PRE_PHASE_E_CORE_SCHEMA = [
      `CREATE TABLE IF NOT EXISTS channel_meta (
        channel_id TEXT PRIMARY KEY, kind TEXT NOT NULL, visibility TEXT NOT NULL,
        title TEXT NOT NULL, topic TEXT, avatar_url TEXT, status TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        member_count INTEGER NOT NULL DEFAULT 0, membership_version INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL,
        filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        width INTEGER, height INTEGER, storage_key TEXT NOT NULL, url TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL
      )`,
    ];

    await withDoState(stub, (ctx) => {
      ctx.storage.sql.exec("DROP TABLE IF EXISTS schema_migrations");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS message_stickers");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS attachments");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS channel_meta");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS event_seq");

      applyBaselineSchema(ctx, PRE_PHASE_E_CORE_SCHEMA);
      ctx.storage.sql.exec(
        `INSERT INTO channel_meta (
          channel_id, kind, visibility, title, topic, avatar_url, status,
          created_by, created_at, updated_at, member_count, membership_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        channelId,
        "group",
        "private",
        "Pre-Phase-E",
        null,
        null,
        "active",
        "user-1",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        1,
        1,
      );

      expect(tableExists(ctx, "message_stickers")).toBe(false);

      migrateChatChannelSchema(ctx);

      expect(tableExists(ctx, "message_stickers")).toBe(true);
      expect(columnExists(ctx, "message_stickers", "blurhash")).toBe(true);
      expect(columnExists(ctx, "attachments", "blurhash")).toBe(true);

      const meta = ctx.storage.sql
        .exec("SELECT channel_id, title FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { channel_id: string; title: string } | undefined;
      expect(meta?.title).toBe("Pre-Phase-E");
    });

    const res = await stub.fetch(
      new Request("https://x/internal/schema-version", { headers: { "X-Test-Only": "1" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current_version: number };
    expect(body.current_version).toBe(CHAT_CHANNEL_CURRENT_SCHEMA_VERSION);
  });
});
