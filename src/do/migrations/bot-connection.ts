import {
  applyBaselineSchema,
  migrateSqlite,
  type BaselineDetector,
  type SqlMigration,
} from "../sql-migrations";

export const BOT_CONNECTION_CURRENT_SCHEMA_VERSION = 1;

// Phase 7 Bot Gateway WS RPC: BotConnection DO (by bot_id) holds the bot
// runtime WebSocket hibernation state + the delivery queue. Delivery is
// at-least-once: a bot_deliveries row is persisted BEFORE the `delivery`
// frame is pushed to the socket, so reconnect/alarm can redeliver. Effect
// application lives in the source ChatChannel; BotConnection only routes
// delivery_result back via /internal/bot-delivery-result.
export const BOT_CONNECTION_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS bot_connection_state (
    bot_id          TEXT PRIMARY KEY,
    session_id      TEXT,
    status          TEXT NOT NULL,
    connected_at    TEXT,
    disconnected_at TEXT,
    last_seen_at    TEXT
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
];

export const botConnectionBaseline: BaselineDetector = {
  version: 1,
  name: "baseline BotConnection schema",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, BOT_CONNECTION_BASELINE_SCHEMA);
  },
};

export const botConnectionMigrations: SqlMigration[] = [];

export function migrateBotConnectionSchema(ctx: DurableObjectState): void {
  migrateSqlite(ctx, "BotConnection", botConnectionBaseline, botConnectionMigrations);
}
