import {
  applyBaselineSchema,
  migrateSqlite,
  type BaselineDetector,
  type SqlMigration,
} from "../sql-migrations";

export const BOT_STREAM_CONNECTION_CURRENT_SCHEMA_VERSION = 1;

export const BOT_STREAM_CONNECTION_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS stream_state (
    channel_id       TEXT NOT NULL,
    message_id       TEXT NOT NULL,
    bot_id           TEXT NOT NULL,
    status           TEXT NOT NULL,
    ack_seq          INTEGER NOT NULL DEFAULT 0,
    flushed_text     TEXT NOT NULL DEFAULT '',
    pending_bytes    INTEGER NOT NULL DEFAULT 0,
    expires_at       TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (channel_id, message_id)
  )`,
];

export const botStreamConnectionBaseline: BaselineDetector = {
  version: BOT_STREAM_CONNECTION_CURRENT_SCHEMA_VERSION,
  name: "baseline BotStreamConnection schema",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, BOT_STREAM_CONNECTION_BASELINE_SCHEMA);
  },
};

export const botStreamConnectionMigrations: SqlMigration[] = [];

export function migrateBotStreamConnectionSchema(ctx: DurableObjectState): void {
  migrateSqlite(
    ctx,
    "BotStreamConnection",
    botStreamConnectionBaseline,
    botStreamConnectionMigrations,
  );
}
