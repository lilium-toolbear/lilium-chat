import {
  applyBaselineSchema,
  migrateSqlite,
  tableExists,
  type BaselineDetector,
  type SqlMigration,
} from "../sql-migrations";

export const BOT_REGISTRY_CURRENT_SCHEMA_VERSION = 1;

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
  isAlreadyApplied(ctx) {
    return tableExists(ctx, "bot_apps");
  },
  applyFresh(ctx) {
    applyBaselineSchema(ctx, BOT_REGISTRY_BASELINE_SCHEMA);
  },
};

export const botRegistryMigrations: SqlMigration[] = [];

export function migrateBotRegistrySchema(ctx: DurableObjectState): void {
  migrateSqlite(ctx, "BotRegistry", botRegistryBaseline, botRegistryMigrations);
}
