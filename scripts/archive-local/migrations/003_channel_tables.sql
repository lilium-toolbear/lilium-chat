CREATE SCHEMA IF NOT EXISTS chat;

CREATE TABLE IF NOT EXISTS chat.channels (
  channel_id              TEXT PRIMARY KEY,
  kind                    TEXT NOT NULL,
  visibility              TEXT NOT NULL,
  title                   TEXT NOT NULL,
  topic                   TEXT,
  avatar_url              TEXT,
  status                  TEXT NOT NULL,
  created_by              TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  member_count            INTEGER NOT NULL DEFAULT 0,
  membership_version      INTEGER NOT NULL DEFAULT 0,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_channels_updated
  ON chat.channels (updated_at DESC);

CREATE TABLE IF NOT EXISTS chat.channel_members (
  channel_id              TEXT NOT NULL,
  user_id                 TEXT NOT NULL,
  role                    TEXT NOT NULL,
  joined_at               TIMESTAMPTZ NOT NULL,
  left_at                 TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_channel_members_user_active
  ON chat.channel_members (user_id)
  WHERE left_at IS NULL;
