import {
  applyBaselineSchema,
  columnExists,
  migrateSqlite,
  tableExists,
  type BaselineDetector,
  type SqlMigration,
} from "../sql-migrations";

export const CHANNEL_FANOUT_CURRENT_SCHEMA_VERSION = 2026062701;

export const CHANNEL_FANOUT_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS online_sessions (
    channel_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
    membership_version INTEGER NOT NULL, registered_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, session_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_online_user ON online_sessions(channel_id, user_id)`,
  `CREATE TABLE IF NOT EXISTS fanout_events (
    channel_id TEXT NOT NULL, event_id TEXT NOT NULL, event_json TEXT NOT NULL,
    membership_version_at_event INTEGER NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, event_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fanout_events_cleanup ON fanout_events(created_at)`,
  `CREATE TABLE IF NOT EXISTS fanout_queue (
    queue_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, event_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL, target_user_id TEXT NOT NULL,
    target_lease_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error TEXT, failed_at TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fanout_due ON fanout_queue(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_fanout_event ON fanout_queue(channel_id, event_id)`,
  `CREATE TABLE IF NOT EXISTS fanout_leases (
    channel_id          TEXT NOT NULL,
    lease_id            TEXT NOT NULL,
    user_id             TEXT NOT NULL,
    session_id          TEXT NOT NULL,
    membership_version  INTEGER NOT NULL,
    expires_at          TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    last_error          TEXT,
    PRIMARY KEY (channel_id, lease_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fanout_leases_session
    ON fanout_leases(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fanout_leases_expires
    ON fanout_leases(channel_id, expires_at)`,
];

export const channelFanoutBaseline: BaselineDetector = {
  version: 1,
  name: "baseline existing ChannelFanout schema",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, CHANNEL_FANOUT_BASELINE_SCHEMA);
  },
};

export const channelFanoutMigrations: SqlMigration[] = [
  {
    version: 2026062701,
    name: "add fanout_leases and queue target_lease_id",
    up(ctx) {
      if (!tableExists(ctx, "fanout_leases")) {
        ctx.storage.sql.exec(
          `CREATE TABLE IF NOT EXISTS fanout_leases (
            channel_id          TEXT NOT NULL,
            lease_id            TEXT NOT NULL,
            user_id             TEXT NOT NULL,
            session_id          TEXT NOT NULL,
            membership_version  INTEGER NOT NULL,
            expires_at          TEXT NOT NULL,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            last_error          TEXT,
            PRIMARY KEY (channel_id, lease_id)
          )`,
        );
        ctx.storage.sql.exec(
          "CREATE INDEX IF NOT EXISTS idx_fanout_leases_session ON fanout_leases(session_id)",
        );
        ctx.storage.sql.exec(
          "CREATE INDEX IF NOT EXISTS idx_fanout_leases_expires ON fanout_leases(channel_id, expires_at)",
        );
      }
      if (!columnExists(ctx, "fanout_queue", "target_lease_id")) {
        ctx.storage.sql.exec(
          "ALTER TABLE fanout_queue ADD COLUMN target_lease_id TEXT",
        );
      }
    },
  },
];

export function migrateChannelFanoutSchema(ctx: DurableObjectState): void {
  migrateSqlite(ctx, "ChannelFanout", channelFanoutBaseline, channelFanoutMigrations);
}
