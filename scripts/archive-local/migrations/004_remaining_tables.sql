CREATE SCHEMA IF NOT EXISTS chat;

ALTER TABLE IF EXISTS chat.mentions
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS chat.message_attachments
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS chat.message_stickers
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS chat.message_edits (
  edit_id                 TEXT PRIMARY KEY,
  message_id              TEXT NOT NULL,
  old_text                TEXT,
  new_text                TEXT,
  editor_user_id          TEXT NOT NULL,
  request_id              TEXT,
  edited_at               TIMESTAMPTZ NOT NULL,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat.audit_logs (
  audit_id                TEXT PRIMARY KEY,
  actor_kind              TEXT NOT NULL,
  actor_id                TEXT NOT NULL,
  action                  TEXT NOT NULL,
  target_type             TEXT NOT NULL,
  target_id               TEXT NOT NULL,
  before_json             JSONB,
  after_json              JSONB,
  reason                  TEXT,
  request_id              TEXT,
  created_at              TIMESTAMPTZ NOT NULL,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat.attachments (
  attachment_id           TEXT PRIMARY KEY,
  owner_user_id           TEXT NOT NULL,
  kind                    TEXT NOT NULL,
  filename                TEXT,
  mime_type               TEXT NOT NULL,
  size_bytes              INTEGER NOT NULL,
  width                   INTEGER,
  height                  INTEGER,
  blurhash                TEXT,
  storage_key             TEXT NOT NULL,
  url                     TEXT NOT NULL,
  status                  TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat.invites (
  invite_code             TEXT PRIMARY KEY,
  created_by              TEXT NOT NULL,
  expires_at              TIMESTAMPTZ,
  max_uses                INTEGER,
  used_count              INTEGER NOT NULL DEFAULT 0,
  revoked_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat.dm_pairs (
  pair_key                TEXT PRIMARY KEY,
  user_low                TEXT NOT NULL,
  user_high               TEXT NOT NULL,
  channel_id              TEXT NOT NULL,
  created_by              TEXT NOT NULL,
  status                  TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat.personal_stickers (
  sticker_id              TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL,
  attachment_id           TEXT NOT NULL,
  url                     TEXT NOT NULL,
  mime_type               TEXT NOT NULL,
  width                   INTEGER,
  height                  INTEGER,
  size_bytes              INTEGER NOT NULL,
  blurhash                TEXT,
  created_at              TIMESTAMPTZ NOT NULL,
  deleted_at              TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS chat.bot_apps (
  bot_id                  TEXT PRIMARY KEY,
  owner_user_id           TEXT NOT NULL,
  display_name            TEXT NOT NULL,
  avatar_url              TEXT,
  callback_url            TEXT,
  status                  TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat.bot_tokens (
  token_id                TEXT PRIMARY KEY,
  bot_id                  TEXT NOT NULL,
  token_hash              TEXT NOT NULL,
  scopes                  TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  revoked_at              TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE (token_hash)
);

CREATE TABLE IF NOT EXISTS chat.bot_commands (
  bot_command_id          TEXT PRIMARY KEY,
  bot_id                  TEXT NOT NULL,
  name                    TEXT NOT NULL,
  description             TEXT,
  options_json            JSONB,
  default_member_permission TEXT,
  default_enabled_on_install INTEGER NOT NULL DEFAULT 0,
  schema_version          INTEGER NOT NULL DEFAULT 1,
  definition_hash         TEXT,
  enabled                 INTEGER NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  deleted_at              TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE (bot_id, name)
);

CREATE TABLE IF NOT EXISTS chat.bot_command_aliases (
  bot_command_id          TEXT NOT NULL,
  bot_id                  TEXT NOT NULL,
  alias                   TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  deleted_at              TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (bot_command_id, alias)
);

CREATE TABLE IF NOT EXISTS chat.bot_event_capabilities (
  bot_id                  TEXT NOT NULL,
  event_type              TEXT NOT NULL,
  filters_json            JSONB,
  default_enabled_on_install INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  deleted_at              TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (bot_id, event_type)
);

CREATE TABLE IF NOT EXISTS chat.bot_installations (
  channel_id              TEXT NOT NULL,
  bot_id                  TEXT NOT NULL,
  installed_by            TEXT NOT NULL,
  scopes                  TEXT NOT NULL,
  installed_at            TIMESTAMPTZ NOT NULL,
  status                  TEXT NOT NULL,
  updated_by              TEXT,
  updated_at              TIMESTAMPTZ NOT NULL,
  bot_display_name        TEXT,
  bot_avatar_url          TEXT,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (channel_id, bot_id)
);

CREATE TABLE IF NOT EXISTS chat.channel_command_bindings (
  binding_id              TEXT PRIMARY KEY,
  channel_id              TEXT NOT NULL,
  bot_id                  TEXT NOT NULL,
  bot_command_id          TEXT NOT NULL,
  status                  TEXT NOT NULL,
  permission_override     TEXT,
  name                    TEXT NOT NULL,
  description             TEXT,
  options_json            JSONB,
  aliases_json            JSONB,
  default_member_permission TEXT,
  definition_hash         TEXT,
  created_by              TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_by              TEXT,
  updated_at              TIMESTAMPTZ NOT NULL,
  deleted_at              TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE (channel_id, bot_command_id)
);

CREATE TABLE IF NOT EXISTS chat.channel_command_names (
  channel_id              TEXT NOT NULL,
  slash_name              TEXT NOT NULL,
  bot_command_id          TEXT NOT NULL,
  bot_id                  TEXT NOT NULL,
  kind                    TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  deleted_at              TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (channel_id, slash_name)
);

CREATE TABLE IF NOT EXISTS chat.channel_bot_event_subscriptions (
  subscription_id         TEXT PRIMARY KEY,
  channel_id              TEXT NOT NULL,
  bot_id                  TEXT NOT NULL,
  event_type              TEXT NOT NULL,
  status                  TEXT NOT NULL,
  filters_json            JSONB,
  created_by              TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_by              TEXT,
  updated_at              TIMESTAMPTZ NOT NULL,
  deleted_at              TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE (channel_id, bot_id, event_type)
);

CREATE TABLE IF NOT EXISTS chat.command_invocations (
  invocation_id           TEXT PRIMARY KEY,
  channel_id              TEXT NOT NULL,
  command_id              TEXT NOT NULL,
  invoker_user_id         TEXT NOT NULL,
  bot_id                  TEXT NOT NULL,
  bot_command_id          TEXT NOT NULL,
  command_name            TEXT NOT NULL,
  invoked_name            TEXT NOT NULL,
  command_schema_version  INTEGER NOT NULL,
  command_definition_hash TEXT,
  options_json            JSONB,
  status                  TEXT NOT NULL,
  error_code              TEXT,
  error_message           TEXT,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  completed_at            TIMESTAMPTZ,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE (channel_id, invoker_user_id, command_id)
);

CREATE TABLE IF NOT EXISTS chat.interactions (
  interaction_id          TEXT PRIMARY KEY,
  message_id              TEXT NOT NULL,
  component_id            TEXT NOT NULL,
  custom_id               TEXT NOT NULL,
  actor_user_id           TEXT NOT NULL,
  dedupe_principal_key    TEXT NOT NULL,
  command_id              TEXT NOT NULL,
  value_json              JSONB,
  status                  TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  completed_at            TIMESTAMPTZ,
  error_code              TEXT,
  archived_source_kind    TEXT,
  archived_source_key     TEXT,
  archived_source_seq     BIGINT,
  archived_at             TIMESTAMPTZ DEFAULT now()
);
