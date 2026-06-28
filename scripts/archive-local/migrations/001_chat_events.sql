CREATE SCHEMA IF NOT EXISTS chat;

CREATE TABLE IF NOT EXISTS chat.events (
  event_id                      TEXT PRIMARY KEY,
  event_type                    TEXT NOT NULL,
  channel_id                    TEXT NOT NULL,
  actor_kind                    TEXT,
  actor_id                      TEXT,
  actor_session_id              TEXT,
  payload                       JSONB NOT NULL,
  membership_version_at_event   INTEGER NOT NULL DEFAULT 0,
  occurred_at                   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_events_channel_occurred
  ON chat.events (channel_id, occurred_at);
