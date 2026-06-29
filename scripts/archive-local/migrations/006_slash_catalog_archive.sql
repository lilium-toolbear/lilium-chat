-- Slash-catalog archive schema: drop Phase-7 install/event tables, align bot + binding shapes.

DROP TABLE IF EXISTS chat.channel_bot_event_subscriptions;
DROP TABLE IF EXISTS chat.channel_command_names;
DROP TABLE IF EXISTS chat.bot_installations;
DROP TABLE IF EXISTS chat.bot_event_capabilities;

ALTER TABLE chat.bot_apps DROP COLUMN IF EXISTS callback_url;
ALTER TABLE chat.bot_apps ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE chat.bot_apps ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

ALTER TABLE chat.bot_tokens ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'default';
ALTER TABLE chat.bot_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE chat.bot_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

ALTER TABLE chat.bot_commands ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'stateless';
ALTER TABLE chat.bot_commands ADD COLUMN IF NOT EXISTS stateful_config_json JSONB;
ALTER TABLE chat.bot_commands ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE chat.bot_commands DROP COLUMN IF EXISTS enabled;
ALTER TABLE chat.bot_commands DROP COLUMN IF EXISTS default_enabled_on_install;

DROP TABLE IF EXISTS chat.channel_command_bindings;

CREATE TABLE chat.channel_command_bindings (
  channel_id              TEXT NOT NULL,
  bot_command_id          TEXT NOT NULL,
  bot_id                  TEXT NOT NULL,
  status                  TEXT NOT NULL,
  permission_override     TEXT,
  command_snapshot_json   JSONB NOT NULL,
  stateful_max_ttl_seconds INTEGER,
  updated_by_user_id      TEXT NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (channel_id, bot_command_id)
);

CREATE TABLE IF NOT EXISTS chat.bot_command_names (
  slash_token             TEXT PRIMARY KEY,
  bot_command_id          TEXT NOT NULL,
  bot_id                  TEXT NOT NULL,
  kind                    TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  deleted_at              TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat.stateful_command_sessions (
  session_id              TEXT PRIMARY KEY,
  channel_id              TEXT NOT NULL,
  bot_id                  TEXT NOT NULL,
  bot_command_id          TEXT NOT NULL,
  invocation_id           TEXT NOT NULL,
  started_by_user_id      TEXT NOT NULL,
  status                  TEXT NOT NULL,
  listen_rules_json       JSONB NOT NULL,
  input_next_seq          INTEGER NOT NULL DEFAULT 1,
  input_last_acked_seq    INTEGER NOT NULL DEFAULT 0,
  effect_last_acked_seq   INTEGER NOT NULL DEFAULT 0,
  started_at              TIMESTAMPTZ NOT NULL,
  expires_at              TIMESTAMPTZ NOT NULL,
  closed_at               TIMESTAMPTZ,
  close_reason            TEXT,
  summary_json            JSONB,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat.stateful_session_inputs (
  session_id              TEXT NOT NULL,
  seq                     INTEGER NOT NULL,
  channel_id              TEXT NOT NULL,
  event_id                TEXT NOT NULL,
  message_id              TEXT NOT NULL,
  message_projection_json JSONB NOT NULL,
  status                  TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  sent_at                 TIMESTAMPTZ,
  acked_at                TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);
