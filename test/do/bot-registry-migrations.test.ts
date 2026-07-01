import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, readDoSchemaVersion } from "../helpers";
import {
  indexExists,
  applyDoSchemaMigrations,
  migrateSqlite,
  tableExists,
} from "../../src/do/shared/sql-migrations";
import {
  BOT_REGISTRY_CURRENT_SCHEMA_VERSION,
  BOT_REGISTRY_DO_SCHEMA,
  botRegistryBaseline,
  botRegistryMigrations,
} from "../../src/do/bot-registry/migrations";

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
  return (await readDoSchemaVersion(stub)).current_version;
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
    await schemaVersion(stub);
    await withDoState(stub, (ctx) => {
      expectSlashCatalogBaseline(ctx);
      expect(tableExists(ctx, "archive_outbox")).toBe(true);
      expect(tableExists(ctx, "archive_seq")).toBe(true);
    });
    expect(await schemaVersion(stub)).toBe(BOT_REGISTRY_CURRENT_SCHEMA_VERSION);
  });

  it("fresh baseline includes bot_command_names and excludes bot_event_capabilities", async () => {
    const stub = registryStub();
    await schemaVersion(stub);
    await withDoState(stub, (ctx) => {
      expect(tableExists(ctx, "bot_command_names")).toBe(true);
      expect(tableExists(ctx, "bot_event_capabilities")).toBe(false);
    });
  });

  it("v4 additive upgrade preserves Phase 7 rows", async () => {
    const stub = registryStub();
    const botId = `bot-${crypto.randomUUID()}`;
    const botCommandId = `cmd-${crypto.randomUUID()}`;
    const tokenId = `tok-${crypto.randomUUID()}`;

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
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, 'archive', ?)",
        "2026-06-28T00:00:02.000Z",
      );

      ctx.storage.sql.exec(`CREATE TABLE bot_apps (
        bot_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, display_name TEXT NOT NULL,
        avatar_url TEXT, callback_url TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      ctx.storage.sql.exec(
        `INSERT INTO bot_apps VALUES (?, 'owner-1', 'Legacy Bot', NULL, 'https://example/cb', 'active', ?, ?)`,
        botId,
        "2026-06-28T00:00:00.000Z",
        "2026-06-28T00:00:00.000Z",
      );

      ctx.storage.sql.exec(`CREATE TABLE bot_tokens (
        token_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, token_hash TEXT NOT NULL,
        scopes TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
      )`);
      ctx.storage.sql.exec(
        `INSERT INTO bot_tokens VALUES (?, ?, 'hash-legacy', '["chat:runtime:connect"]', ?, NULL)`,
        tokenId,
        botId,
        "2026-06-28T00:00:00.000Z",
      );
      ctx.storage.sql.exec("CREATE UNIQUE INDEX idx_bot_tokens_hash ON bot_tokens(token_hash)");

      ctx.storage.sql.exec(`CREATE TABLE bot_commands (
        bot_command_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT, options_json TEXT NOT NULL, default_member_permission TEXT NOT NULL,
        default_enabled_on_install INTEGER NOT NULL DEFAULT 1, schema_version INTEGER NOT NULL DEFAULT 1,
        definition_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
        UNIQUE (bot_id, name)
      )`);
      ctx.storage.sql.exec(
        `INSERT INTO bot_commands (
           bot_command_id, bot_id, name, description, options_json, default_member_permission,
           default_enabled_on_install, schema_version, definition_hash, enabled, created_at, updated_at, deleted_at
         ) VALUES (?, ?, 'legacy', 'desc', '[]', 'member', 1, 1, 'sha256:legacy', 1, ?, ?, NULL)`,
        botCommandId,
        botId,
        "2026-06-28T00:00:00.000Z",
        "2026-06-28T00:00:00.000Z",
      );
      ctx.storage.sql.exec("CREATE INDEX idx_bot_commands_bot ON bot_commands(bot_id, enabled, name)");

      ctx.storage.sql.exec(`CREATE TABLE bot_command_aliases (
        bot_command_id TEXT NOT NULL, bot_id TEXT NOT NULL, alias TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (bot_command_id, alias), UNIQUE (bot_id, alias)
      )`);
      ctx.storage.sql.exec(
        `INSERT INTO bot_command_aliases VALUES (?, ?, 'legacy-alias', ?)`,
        botCommandId,
        botId,
        "2026-06-28T00:00:00.000Z",
      );

      ctx.storage.sql.exec(`CREATE TABLE bot_event_capabilities (
        bot_id TEXT NOT NULL, event_type TEXT NOT NULL, filters_json TEXT NOT NULL,
        default_enabled_on_install INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(bot_id, event_type)
      )`);

      applyDoSchemaMigrations(ctx, BOT_REGISTRY_DO_SCHEMA);

      const app = ctx.storage.sql
        .exec("SELECT bot_id, display_name, visibility FROM bot_apps WHERE bot_id=?", botId)
        .toArray()[0] as { bot_id: string; display_name: string; visibility: string };
      expect(app.display_name).toBe("Legacy Bot");
      expect(app.visibility).toBe("private");

      const token = ctx.storage.sql
        .exec("SELECT scopes_json, name FROM bot_tokens WHERE token_id=?", tokenId)
        .toArray()[0] as { scopes_json: string; name: string };
      expect(token.scopes_json).toBe('["chat:runtime:connect"]');
      expect(token.name).toBe("default");

      const command = ctx.storage.sql
        .exec(
          "SELECT execution_mode, status FROM bot_commands WHERE bot_command_id=?",
          botCommandId,
        )
        .toArray()[0] as { execution_mode: string; status: string };
      expect(command.execution_mode).toBe("stateless");
      expect(command.status).toBe("active");

      const slashRows = ctx.storage.sql
        .exec("SELECT slash_token, kind FROM bot_command_names WHERE bot_command_id=?", botCommandId)
        .toArray() as Array<{ slash_token: string; kind: string }>;
      expect(slashRows.map((row) => row.slash_token).sort()).toEqual(["legacy", "legacy-alias"]);

      expectSlashCatalogBaseline(ctx);
      expect(tableExists(ctx, "bot_event_capabilities")).toBe(false);
    });
    expect(await schemaVersion(stub)).toBe(BOT_REGISTRY_CURRENT_SCHEMA_VERSION);
  });

  it("migration is idempotent (re-run is noop)", async () => {
    const stub = registryStub();
    await schemaVersion(stub);

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
    await schemaVersion(stub);
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
