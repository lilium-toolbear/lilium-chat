import {
  applyBaselineSchema,
  tableExists,
  type BaselineDetector,
  type DoSchemaDefinition,
  type SqlMigration,
} from "../shared/sql-migrations";

export const BOT_STREAM_CONNECTION_CURRENT_SCHEMA_VERSION = 2;

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
  `CREATE TABLE IF NOT EXISTS stream_due_jobs (
    job_kind         TEXT NOT NULL PRIMARY KEY,
    due_at_ms        INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
  )`,
];

const migrationV2StreamDueJobs: SqlMigration = {
  version: 2,
  name: "stream due jobs for flush/fanout alarms",
  up(ctx) {
    if (tableExists(ctx, "stream_due_jobs")) return;
    ctx.storage.sql.exec(
      `CREATE TABLE stream_due_jobs (
        job_kind TEXT NOT NULL PRIMARY KEY,
        due_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      )`,
    );
  },
};

export const botStreamConnectionBaseline: BaselineDetector = {
  version: BOT_STREAM_CONNECTION_CURRENT_SCHEMA_VERSION,
  name: "baseline BotStreamConnection schema",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, BOT_STREAM_CONNECTION_BASELINE_SCHEMA);
  },
};

export const botStreamConnectionMigrations: SqlMigration[] = [migrationV2StreamDueJobs];

export const BOT_STREAM_CONNECTION_DO_SCHEMA = {
  doClassName: "BotStreamConnection",
  targetVersion: BOT_STREAM_CONNECTION_CURRENT_SCHEMA_VERSION,
  baseline: botStreamConnectionBaseline,
  migrations: botStreamConnectionMigrations,
} satisfies DoSchemaDefinition;
