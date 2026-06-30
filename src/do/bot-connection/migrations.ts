import {
  applyBaselineSchema,
  columnExists,
  migrateSqlite,
  tableExists,
  type BaselineDetector,
  type SqlMigration,
} from "../shared/sql-migrations";

export const BOT_CONNECTION_CURRENT_SCHEMA_VERSION = 2026063002;

// Phase 7 Bot Gateway WS RPC: BotConnection DO (by bot_id) holds the bot
// runtime WebSocket hibernation state + the delivery queue. Delivery is
// at-least-once: a bot_deliveries row is persisted BEFORE the `delivery`
// frame is pushed to the socket, so reconnect/alarm can redeliver. Effect
// application lives in the source ChatChannel; BotConnection only routes
// delivery_result back via ChatChannel RPC.
//
// Stateful sessions: active_stateful_session_refs is a bot-scoped routing
// index so reconnect can resume inputs without enumerating ChatChannel DOs.
export const BOT_CONNECTION_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS bot_connection_state (
    bot_id          TEXT PRIMARY KEY,
    session_id      TEXT,
    status          TEXT NOT NULL,
    connected_at    TEXT,
    disconnected_at TEXT,
    last_seen_at    TEXT,
    expires_at      TEXT,
    is_official     INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS bot_deliveries (
    delivery_id      TEXT PRIMARY KEY,
    bot_id           TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    kind             TEXT NOT NULL,
    source_outbox_id TEXT NOT NULL,
    target_id        TEXT NOT NULL,
    request_json     TEXT NOT NULL,
    status           TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bot_deliveries_due
    ON bot_deliveries(bot_id, status, next_attempt_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_deliveries_source_outbox
    ON bot_deliveries(bot_id, source_outbox_id)`,
  `CREATE TABLE IF NOT EXISTS active_stateful_session_refs (
    session_id   TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL,
    bot_id       TEXT NOT NULL,
    status       TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_active_stateful_session_refs_bot_status
    ON active_stateful_session_refs(bot_id, status, updated_at)`,
];

export const botConnectionBaseline: BaselineDetector = {
  version: 1,
  name: "baseline BotConnection schema",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, BOT_CONNECTION_BASELINE_SCHEMA);
  },
};

export const botConnectionMigrations: SqlMigration[] = [
  {
    version: 2026062701,
    name: "add bot connection lease expiry",
    up(ctx) {
      if (!columnExists(ctx, "bot_connection_state", "expires_at")) {
        ctx.storage.sql.exec(
          "ALTER TABLE bot_connection_state ADD COLUMN expires_at TEXT",
        );
      }
    },
  },
  {
    version: 2026062901,
    name: "add active stateful session refs for reconnect resume",
    up(ctx) {
      if (!tableExists(ctx, "active_stateful_session_refs")) {
        ctx.storage.sql.exec(`CREATE TABLE active_stateful_session_refs (
          session_id   TEXT PRIMARY KEY,
          channel_id   TEXT NOT NULL,
          bot_id       TEXT NOT NULL,
          status       TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        )`);
        ctx.storage.sql.exec(
          "CREATE INDEX IF NOT EXISTS idx_active_stateful_session_refs_bot_status ON active_stateful_session_refs(bot_id, status, updated_at)",
        );
      }
    },
  },
  {
    version: BOT_CONNECTION_CURRENT_SCHEMA_VERSION,
    name: "cache bot is_official on connection state",
    up(ctx) {
      if (!columnExists(ctx, "bot_connection_state", "is_official")) {
        ctx.storage.sql.exec(
          "ALTER TABLE bot_connection_state ADD COLUMN is_official INTEGER NOT NULL DEFAULT 0",
        );
      }
    },
  },
];

export function migrateBotConnectionSchema(ctx: DurableObjectState): void {
  migrateSqlite(ctx, "BotConnection", botConnectionBaseline, botConnectionMigrations);
}
