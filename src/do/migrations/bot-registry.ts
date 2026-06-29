import {
  applyBaselineSchema,
  indexExists,
  migrateSqlite,
  tableExists,
  type BaselineDetector,
  type SqlMigration,
} from "../sql-migrations";
import { applyArchiveOutboxMigration } from "../../archive/apply-archive-migration";

export const BOT_REGISTRY_CURRENT_SCHEMA_VERSION = 4;

export const BOT_REGISTRY_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS bot_apps (
    bot_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    description TEXT,
    visibility TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bot_tokens (
    token_id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bot_tokens_bot ON bot_tokens(bot_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_tokens_hash ON bot_tokens(token_hash)`,
  `CREATE TABLE IF NOT EXISTS bot_commands (
    bot_command_id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    options_json TEXT NOT NULL,
    default_member_permission TEXT NOT NULL,
    execution_mode TEXT NOT NULL,
    stateful_config_json TEXT,
    status TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    definition_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (bot_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bot_commands_bot ON bot_commands(bot_id, status, name)`,
  `CREATE TABLE IF NOT EXISTS bot_command_aliases (
    bot_command_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (bot_command_id, alias),
    UNIQUE (bot_id, alias)
  )`,
  `CREATE TABLE IF NOT EXISTS bot_command_names (
    slash_token TEXT PRIMARY KEY,
    bot_command_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bot_idempotency_keys (
    principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL,
    operation TEXT NOT NULL, operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, response_json TEXT,
    status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY (principal_kind, principal_id, operation, operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bot_idem_expires ON bot_idempotency_keys(expires_at)`,
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
    version: 3,
    name: "archive_outbox + archive_seq for local PG archive",
    up(ctx) {
      applyArchiveOutboxMigration(ctx);
    },
  },
  {
    version: 4,
    name: "defensive reset for slash command baseline schema",
    up(ctx) {
      for (const tableName of [
        "bot_command_names",
        "bot_event_capabilities",
        "bot_command_aliases",
        "bot_commands",
        "bot_idempotency_keys",
        "bot_tokens",
        "bot_apps",
      ]) {
        if (tableExists(ctx, tableName)) {
          ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${tableName}`);
        }
      }
      for (const indexName of ["idx_bot_commands_bot", "idx_bot_tokens_bot", "idx_bot_tokens_hash", "idx_bot_idem_expires"]) {
        if (indexExists(ctx, indexName)) {
          ctx.storage.sql.exec(`DROP INDEX IF EXISTS ${indexName}`);
        }
      }
      applyBaselineSchema(ctx, BOT_REGISTRY_BASELINE_SCHEMA);
      applyArchiveOutboxMigration(ctx);
    },
  },
];

export function migrateBotRegistrySchema(ctx: DurableObjectState): void {
  migrateSqlite(ctx, "BotRegistry", botRegistryBaseline, botRegistryMigrations);
}
