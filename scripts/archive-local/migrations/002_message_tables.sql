CREATE SCHEMA IF NOT EXISTS chat;

ALTER TABLE IF EXISTS chat.events
  ADD COLUMN IF NOT EXISTS archived_source_kind TEXT,
  ADD COLUMN IF NOT EXISTS archived_source_key TEXT,
  ADD COLUMN IF NOT EXISTS archived_source_seq BIGINT,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT now();

CREATE TABLE IF NOT EXISTS chat.messages (
  message_id              TEXT PRIMARY KEY,
  command_id              TEXT NOT NULL,
  dedupe_principal_key    TEXT NOT NULL,
  channel_id              TEXT NOT NULL,
  sender_kind             TEXT NOT NULL,
  sender_user_id          TEXT,
  sender_bot_id           TEXT,
  type                    TEXT NOT NULL,
  format                  TEXT NOT NULL DEFAULT 'plain',
  status                  TEXT NOT NULL DEFAULT 'normal',
  text                    TEXT,
  reply_to                TEXT,
  reply_snapshot_json     JSONB,
  stream_state            TEXT NOT NULL DEFAULT 'none',
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  edited_at               TIMESTAMPTZ,
  deleted_at              TIMESTAMPTZ,
  deleted_by              TEXT,
  recalled_at             TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created
  ON chat.messages (channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat.mentions (
  message_id            TEXT NOT NULL,
  user_id                 TEXT NOT NULL,
  start_index             INTEGER NOT NULL,
  end_index               INTEGER NOT NULL,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (message_id, start_index, end_index)
);

CREATE TABLE IF NOT EXISTS chat.message_attachments (
  message_id              TEXT NOT NULL,
  attachment_id           TEXT NOT NULL,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (message_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS chat.message_stickers (
  message_id              TEXT PRIMARY KEY,
  sticker_id              TEXT NOT NULL,
  attachment_id           TEXT NOT NULL,
  url                     TEXT NOT NULL,
  mime_type               TEXT NOT NULL,
  width                   INTEGER,
  height                  INTEGER,
  size_bytes              INTEGER NOT NULL,
  blurhash                TEXT,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);
