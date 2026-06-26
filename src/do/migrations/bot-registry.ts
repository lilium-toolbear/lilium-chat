import {
  applyBaselineSchema,
  indexExists,
  migrateSqlite,
  tableExists,
  type BaselineDetector,
  type SqlMigration,
} from "../sql-migrations";

export const BOT_REGISTRY_CURRENT_SCHEMA_VERSION = 2;

export const BOT_REGISTRY_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS bot_apps (
    bot_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, display_name TEXT NOT NULL,
    avatar_url TEXT, callback_url TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bot_tokens (
    token_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, token_hash TEXT NOT NULL,
    scopes TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bot_tokens_bot ON bot_tokens(bot_id)`,
];

export const botRegistryBaseline: BaselineDetector = {
  version: 1,
  name: "baseline existing BotRegistry schema",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, BOT_REGISTRY_BASELINE_SCHEMA);
  },
};

export const botRegistryMigrations: SqlMigration[] = [
  {
    version: 2,
    name: "Phase 7 bot command catalog + aliases + event capabilities + idempotency + token_hash unique index",
    up(ctx) {
      // Global bot command catalog (contract §9.3). bot_command_id is the
      // stable command definition id; name is canonical; aliases are alternate
      // slash triggers (same command). definition_hash detects semantic drift
      // so command.invoke can refresh channel binding snapshots.
      if (!tableExists(ctx, "bot_commands")) {
        ctx.storage.sql.exec(`CREATE TABLE bot_commands (
          bot_command_id            TEXT PRIMARY KEY,
          bot_id                    TEXT NOT NULL,
          name                      TEXT NOT NULL,
          description               TEXT,
          options_json              TEXT NOT NULL,
          default_member_permission TEXT NOT NULL,
          default_enabled_on_install INTEGER NOT NULL DEFAULT 1,
          schema_version            INTEGER NOT NULL DEFAULT 1,
          definition_hash           TEXT NOT NULL,
          enabled                   INTEGER NOT NULL DEFAULT 1,
          created_at                TEXT NOT NULL,
          updated_at                TEXT NOT NULL,
          deleted_at                TEXT,
          UNIQUE (bot_id, name)
        )`);
      }
      if (!indexExists(ctx, "idx_bot_commands_bot")) {
        ctx.storage.sql.exec(
          "CREATE INDEX idx_bot_commands_bot ON bot_commands(bot_id, enabled, name)",
        );
      }

      // Alternate slash triggers for the same bot_command_id.
      if (!tableExists(ctx, "bot_command_aliases")) {
        ctx.storage.sql.exec(`CREATE TABLE bot_command_aliases (
          bot_command_id TEXT NOT NULL,
          bot_id         TEXT NOT NULL,
          alias          TEXT NOT NULL,
          created_at     TEXT NOT NULL,
          PRIMARY KEY (bot_command_id, alias),
          UNIQUE (bot_id, alias)
        )`);
      }

      // Bot-declared passive event capabilities + default filters (§9.9).
      // Phase 7 only event_type=message.created.
      if (!tableExists(ctx, "bot_event_capabilities")) {
        ctx.storage.sql.exec(`CREATE TABLE bot_event_capabilities (
          bot_id       TEXT NOT NULL,
          event_type   TEXT NOT NULL,
          filters_json TEXT NOT NULL,
          default_enabled_on_install INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          PRIMARY KEY(bot_id, event_type)
        )`);
      }

      // Idempotency for PUT /bot/commands (operation=bot.commands.sync).
      // Same shape as ChatChannel.idempotency_keys but bot-namespaced.
      if (!tableExists(ctx, "bot_idempotency_keys")) {
        ctx.storage.sql.exec(`CREATE TABLE bot_idempotency_keys (
          principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL,
          operation TEXT NOT NULL, operation_id TEXT NOT NULL,
          request_hash TEXT NOT NULL, response_json TEXT,
          status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
          PRIMARY KEY (principal_kind, principal_id, operation, operation_id)
        )`);
        ctx.storage.sql.exec(
          "CREATE INDEX idx_bot_idem_expires ON bot_idempotency_keys(expires_at)",
        );
      }

      // token plaintext -> hash cannot reverse-resolve bot_id; singleton
      // registry SELECT ... WHERE token_hash=? requires the hash to be unique.
      if (!indexExists(ctx, "idx_bot_tokens_hash")) {
        ctx.storage.sql.exec(
          "CREATE UNIQUE INDEX idx_bot_tokens_hash ON bot_tokens(token_hash)",
        );
      }
    },
  },
];

export function migrateBotRegistrySchema(ctx: DurableObjectState): void {
  migrateSqlite(ctx, "BotRegistry", botRegistryBaseline, botRegistryMigrations);
}
