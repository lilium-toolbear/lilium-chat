import {
  applyBaselineSchema,
  migrateSqlite,
  type BaselineDetector,
  type SqlMigration,
} from "../sql-migrations";

export const USER_CONNECTION_CURRENT_SCHEMA_VERSION = 2026062701;

export const USER_CONNECTION_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS live_sessions (
    session_id      TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('open', 'live', 'closed')),
    opened_at       TEXT NOT NULL,
    live_started_at TEXT,
    last_seen_at    TEXT NOT NULL,
    closed_at       TEXT,
    close_reason    TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS live_channel_leases (
    session_id           TEXT NOT NULL,
    channel_id           TEXT NOT NULL,
    route_name           TEXT NOT NULL,
    lease_id             TEXT NOT NULL,
    membership_version   INTEGER NOT NULL,
    status               TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    expires_at           TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (session_id, channel_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_live_channel_leases_lease
    ON live_channel_leases(lease_id)`,
  `CREATE INDEX IF NOT EXISTS idx_live_channel_leases_session_status
    ON live_channel_leases(session_id, status)`,
];

export const userConnectionBaseline: BaselineDetector = {
  version: USER_CONNECTION_CURRENT_SCHEMA_VERSION,
  name: "baseline UserConnection live session schema",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, USER_CONNECTION_BASELINE_SCHEMA);
  },
};

export const userConnectionMigrations: SqlMigration[] = [];

export function migrateUserConnectionSchema(ctx: DurableObjectState): void {
  migrateSqlite(ctx, "UserConnection", userConnectionBaseline, userConnectionMigrations);
}
