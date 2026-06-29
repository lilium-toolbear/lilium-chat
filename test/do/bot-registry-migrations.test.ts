import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import {
  indexExists,
  migrateSqlite,
  tableExists,
} from "../../src/do/sql-migrations";
import {
  BOT_REGISTRY_CURRENT_SCHEMA_VERSION,
  botRegistryBaseline,
  botRegistryMigrations,
  migrateBotRegistrySchema,
} from "../../src/do/migrations/bot-registry";

function registryStub() {
  return getNamedDo(env.BOT_REGISTRY as unknown as DurableObjectNamespace, "registry");
}

async function withDoState(
  stub: DurableObjectStub,
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function schemaVersion(stub: DurableObjectStub): Promise<number> {
  const res = await stub.fetch(
    new Request("https://x/internal/schema-version", { headers: { "X-Test-Only": "1" } }),
  );
  const body = (await res.json()) as { current_version: number };
  return body.current_version;
}

function expectSlashCatalogBaseline(ctx: DurableObjectState): void {
  expect(tableExists(ctx, "bot_apps")).toBe(true);
  expect(tableExists(ctx, "bot_tokens")).toBe(true);
  expect(tableExists(ctx, "bot_commands")).toBe(true);
  expect(tableExists(ctx, "bot_command_aliases")).toBe(true);
  expect(tableExists(ctx, "bot_command_names")).toBe(true);
  expect(tableExists(ctx, "bot_idempotency_keys")).toBe(true);
  expect(indexExists(ctx, "idx_bot_commands_bot")).toBe(true);
  expect(indexExists(ctx, "idx_bot_tokens_hash")).toBe(true);
  expect(tableExists(ctx, "bot_event_capabilities")).toBe(false);
}

describe("BotRegistry v4 migrations (slash command baseline)", () => {
  it("fresh install reaches slash catalog schema", async () => {
    const stub = registryStub();
    await stub.fetch(new Request("https://x/ping"));
    await withDoState(stub, (ctx) => {
      expectSlashCatalogBaseline(ctx);
      expect(tableExists(ctx, "archive_outbox")).toBe(true);
      expect(tableExists(ctx, "archive_seq")).toBe(true);
    });
    expect(await schemaVersion(stub)).toBe(BOT_REGISTRY_CURRENT_SCHEMA_VERSION);
  });

  it("fresh baseline includes bot_command_names and excludes bot_event_capabilities", async () => {
    const stub = registryStub();
    await stub.fetch(new Request("https://x/ping"));
    await withDoState(stub, (ctx) => {
      expect(tableExists(ctx, "bot_command_names")).toBe(true);
      expect(tableExists(ctx, "bot_event_capabilities")).toBe(false);
    });
  });

  it("defensive v4 reset upgrades a v3 schema shape", async () => {
    const stub = registryStub();

    await withDoState(stub, (ctx) => {
      ctx.storage.sql.exec("DROP TABLE IF EXISTS schema_migrations");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS bot_apps");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS bot_tokens");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS bot_commands");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS bot_command_aliases");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS bot_event_capabilities");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS bot_idempotency_keys");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS bot_command_names");
      ctx.storage.sql.exec("DROP INDEX IF EXISTS idx_bot_commands_bot");
      ctx.storage.sql.exec("DROP INDEX IF EXISTS idx_bot_tokens_hash");

      ctx.storage.sql.exec(`
        CREATE TABLE schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      ctx.storage.sql.exec(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'baseline', ?)",
        "2026-06-28T00:00:00.000Z",
      );
      ctx.storage.sql.exec(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'phase7', ?)",
        "2026-06-28T00:00:01.000Z",
      );
      ctx.storage.sql.exec(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, 'archive', ?)",
        "2026-06-28T00:00:02.000Z",
      );

      // Simulate pre-v4 schema with deprecated columns/tables.
      ctx.storage.sql.exec(`CREATE TABLE bot_apps (
        bot_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, display_name TEXT NOT NULL,
        avatar_url TEXT, callback_url TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      ctx.storage.sql.exec(`CREATE TABLE bot_tokens (
        token_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, token_hash TEXT NOT NULL,
        scopes TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
      )`);
      ctx.storage.sql.exec(`CREATE TABLE bot_event_capabilities (
        bot_id TEXT NOT NULL, event_type TEXT NOT NULL, filters_json TEXT NOT NULL,
        default_enabled_on_install INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(bot_id, event_type)
      )`);
      ctx.storage.sql.exec("CREATE INDEX idx_bot_tokens_hash ON bot_tokens(token_hash)");

      migrateBotRegistrySchema(ctx);
      expectSlashCatalogBaseline(ctx);
      expect(tableExists(ctx, "archive_outbox")).toBe(true);
      expect(tableExists(ctx, "archive_seq")).toBe(true);
    });
    expect(await schemaVersion(stub)).toBe(BOT_REGISTRY_CURRENT_SCHEMA_VERSION);
  });

  it("migration is idempotent (re-run is noop)", async () => {
    const stub = registryStub();
    await stub.fetch(new Request("https://x/ping"));

    let extraRuns = 0;
    const extra = {
      version: 99,
      name: "count runs",
      up() {
        extraRuns += 1;
      },
    };

    await withDoState(stub, (ctx) => {
      migrateSqlite(ctx, "BotRegistry", botRegistryBaseline, [
        ...botRegistryMigrations,
        extra,
      ]);
      migrateSqlite(ctx, "BotRegistry", botRegistryBaseline, [
        ...botRegistryMigrations,
        extra,
      ]);
    });
    expect(extraRuns).toBe(1);
  });

  it("idx_bot_tokens_hash is unique", async () => {
    const stub = registryStub();
    await stub.fetch(new Request("https://x/ping"));
    await withDoState(stub, (ctx) => {
      const rows = ctx.storage.sql
        .exec("PRAGMA index_list(bot_tokens)")
        .toArray() as Array<{ name: string; unique: number }>;
      const idx = rows.find((r) => r.name === "idx_bot_tokens_hash");
      expect(idx).toBeDefined();
      expect(idx?.unique).toBe(1);
    });
  });
});