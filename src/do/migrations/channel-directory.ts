import {
  applyBaselineSchema,
  migrateSqlite,
  tableExists,
  type BaselineDetector,
  type SqlMigration,
} from "../sql-migrations";

export const CHANNEL_DIRECTORY_CURRENT_SCHEMA_VERSION = 1;

export const CHANNEL_DIRECTORY_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS public_channels (
    channel_id TEXT PRIMARY KEY, title TEXT NOT NULL, avatar_url TEXT,
    member_count INTEGER NOT NULL, last_message_at TEXT, status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

export const channelDirectoryBaseline: BaselineDetector = {
  version: 1,
  name: "baseline existing ChannelDirectory schema",
  isAlreadyApplied(ctx) {
    return tableExists(ctx, "public_channels");
  },
  applyFresh(ctx) {
    applyBaselineSchema(ctx, CHANNEL_DIRECTORY_BASELINE_SCHEMA);
  },
};

export const channelDirectoryMigrations: SqlMigration[] = [];

export function migrateChannelDirectorySchema(ctx: DurableObjectState): void {
  migrateSqlite(ctx, "ChannelDirectory", channelDirectoryBaseline, channelDirectoryMigrations);
}
