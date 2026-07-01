import {
  applyBaselineSchema,
  columnExists,
  indexExists,
  migrateSqlite,
  tableExists,
  type BaselineDetector,
  type DoSchemaDefinition,
  type SqlMigration,
} from "../../shared/sql-migrations";
import { applyArchiveOutboxMigration } from "../../../archive/apply-archive-migration";

export const CHAT_CHANNEL_CURRENT_SCHEMA_VERSION = 2026063001;

export const CHAT_CHANNEL_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS channel_meta (
    channel_id TEXT PRIMARY KEY, kind TEXT NOT NULL, visibility TEXT NOT NULL,
    title TEXT NOT NULL, topic TEXT, avatar_url TEXT, status TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    member_count INTEGER NOT NULL DEFAULT 0, membership_version INTEGER NOT NULL DEFAULT 0,
    command_manifest_version INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    channel_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
    joined_at TEXT NOT NULL, left_at TEXT, PRIMARY KEY (channel_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_members_active ON members(user_id) WHERE left_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY, command_id TEXT NOT NULL,
    dedupe_principal_key TEXT NOT NULL, channel_id TEXT NOT NULL,
    sender_kind TEXT NOT NULL, -- user | bot | system
    sender_user_id TEXT, sender_bot_id TEXT,
    type TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'plain',
    status TEXT NOT NULL DEFAULT 'normal', text TEXT, reply_to TEXT,
    reply_snapshot_json TEXT, components_json TEXT NOT NULL DEFAULT '[]',
    sender_bot_display_name TEXT, sender_bot_avatar_url TEXT,
    invocation_json TEXT,
    stream_state TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, edited_at TEXT,
    deleted_at TEXT, deleted_by TEXT, recalled_at TEXT,
    UNIQUE (channel_id, dedupe_principal_key, command_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_history ON messages(channel_id, message_id DESC)`,
  `CREATE TABLE IF NOT EXISTS message_edits (
    edit_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, old_text TEXT NOT NULL,
    new_text TEXT NOT NULL, editor_user_id TEXT NOT NULL, request_id TEXT, edited_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_edits_message ON message_edits(message_id, edited_at)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    audit_id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL,
    action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
    before_json TEXT, after_json TEXT, reason TEXT, request_id TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_kind, actor_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS attachments (
    attachment_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL,
    filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    width INTEGER, height INTEGER, storage_key TEXT NOT NULL, url TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, blurhash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS message_attachments (
    message_id TEXT NOT NULL, attachment_id TEXT NOT NULL, PRIMARY KEY (message_id, attachment_id)
  )`,
  `CREATE TABLE IF NOT EXISTS message_stickers (
    message_id TEXT PRIMARY KEY, sticker_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
    url TEXT NOT NULL, mime_type TEXT NOT NULL, width INTEGER, height INTEGER,
    size_bytes INTEGER NOT NULL, blurhash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS mentions (
    message_id TEXT NOT NULL, user_id TEXT NOT NULL, start INTEGER NOT NULL, end_ INTEGER NOT NULL,
    PRIMARY KEY (message_id, start, end_)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(user_id)`,
  `CREATE TABLE IF NOT EXISTS channel_command_bindings (
    channel_id TEXT NOT NULL,
    bot_command_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    status TEXT NOT NULL, -- allowed | blocked
    permission_override TEXT,
    command_snapshot_json TEXT NOT NULL,
    stateful_max_ttl_seconds INTEGER,
    updated_by_user_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, bot_command_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bindings_channel_enabled ON channel_command_bindings(channel_id, status)`,
  `CREATE TABLE IF NOT EXISTS command_invocations (
    invocation_id              TEXT PRIMARY KEY,
    channel_id                 TEXT NOT NULL,
    command_id                 TEXT NOT NULL,
    invoker_user_id            TEXT NOT NULL,
    bot_id                     TEXT NOT NULL,
    bot_command_id             TEXT NOT NULL,
    command_name               TEXT NOT NULL,
    invoked_name               TEXT NOT NULL,
    command_schema_version     INTEGER NOT NULL,
    command_definition_hash    TEXT NOT NULL,
    options_json               TEXT NOT NULL,
    status                     TEXT NOT NULL,
    error_code                 TEXT,
    error_message              TEXT,
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    completed_at               TEXT,
    UNIQUE (channel_id, invoker_user_id, command_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_invocations_status ON command_invocations(status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS stateful_command_sessions (
    session_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    bot_command_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    started_by_user_id TEXT NOT NULL,
    status TEXT NOT NULL, -- starting | active | suspended | closing | closed | expired | failed
    listen_rules_json TEXT NOT NULL,
    input_next_seq INTEGER NOT NULL DEFAULT 1,
    input_last_acked_seq INTEGER NOT NULL DEFAULT 0,
    effect_last_acked_seq INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    closed_at TEXT,
    close_reason TEXT,
    summary_json TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_stateful_session_per_channel
    ON stateful_command_sessions(channel_id)
    WHERE status IN ('starting', 'active', 'suspended', 'closing')`,
  `CREATE TABLE IF NOT EXISTS stateful_session_inputs (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_projection_json TEXT NOT NULL,
    status TEXT NOT NULL, -- pending | sent | acked | expired
    created_at TEXT NOT NULL,
    sent_at TEXT,
    acked_at TEXT,
    PRIMARY KEY (session_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS interactions (
    interaction_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, component_id TEXT NOT NULL,
    custom_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, dedupe_principal_key TEXT NOT NULL,
    command_id TEXT NOT NULL,
    value_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT, completed_at TEXT, error_code TEXT,
    UNIQUE (message_id, dedupe_principal_key, command_id)
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    invite_code TEXT PRIMARY KEY, created_by TEXT NOT NULL, expires_at TEXT NOT NULL,
    max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, revoked_at TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, channel_id TEXT NOT NULL,
    actor_kind TEXT, actor_id TEXT, actor_session_id TEXT, payload_json TEXT NOT NULL,
    membership_version_at_event INTEGER NOT NULL DEFAULT 0, occurred_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_after ON events(event_id)`,
  `CREATE TABLE IF NOT EXISTS event_seq ( id INTEGER PRIMARY KEY CHECK (id = 1), last_ms INTEGER NOT NULL, counter INTEGER NOT NULL )`,
  `INSERT OR IGNORE INTO event_seq (id, last_ms, counter) VALUES (1, 0, 0)`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL, operation TEXT NOT NULL,
    operation_id TEXT NOT NULL, -- HTTP Idempotency-Key or WS command_id
    request_hash TEXT NOT NULL, response_json TEXT,
    status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY (principal_kind, principal_id, operation, operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys(expires_at)`,
  `CREATE TABLE IF NOT EXISTS projection_outbox (
    outbox_id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_key TEXT NOT NULL,
    event_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error TEXT, failed_at TEXT, next_attempt_at TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projection_outbox_due ON projection_outbox(status, next_attempt_at)`,
  `CREATE TABLE IF NOT EXISTS bot_delivery_outbox (
    outbox_id        TEXT PRIMARY KEY,
    channel_id       TEXT NOT NULL,
    bot_id           TEXT NOT NULL,
    kind             TEXT NOT NULL,
    invocation_id    TEXT,
    interaction_id   TEXT,
    event_id         TEXT,
    request_json     TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 5,
    last_error       TEXT,
    failed_at        TEXT,
    next_attempt_at  TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bot_delivery_due ON bot_delivery_outbox(status, next_attempt_at)`,
  `CREATE TABLE IF NOT EXISTS bot_effects_applied (
    channel_id       TEXT NOT NULL,
    bot_id           TEXT NOT NULL,
    client_effect_id TEXT NOT NULL,
    effect_type      TEXT NOT NULL,
    request_hash     TEXT NOT NULL,
    message_id       TEXT,
    response_json    TEXT,
    applied_at       TEXT NOT NULL,
    outbox_id        TEXT,
    PRIMARY KEY (channel_id, bot_id, client_effect_id)
  )`,
  `CREATE TABLE IF NOT EXISTS archive_seq (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_seq INTEGER NOT NULL
  )`,
  `INSERT OR IGNORE INTO archive_seq (id, last_seq) VALUES (1, 0)`,
  `CREATE TABLE IF NOT EXISTS archive_outbox (
    archive_id       TEXT PRIMARY KEY,
    source_kind      TEXT NOT NULL,
    source_key       TEXT NOT NULL,
    source_seq       INTEGER NOT NULL,
    payload_json     TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 20,
    last_error       TEXT,
    next_attempt_at  TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE(source_kind, source_key, source_seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_archive_outbox_due ON archive_outbox(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_archive_outbox_source_seq ON archive_outbox(source_kind, source_key, source_seq)`,
  `CREATE TABLE IF NOT EXISTS rate_buckets (
    bucket_key TEXT PRIMARY KEY, tokens REAL NOT NULL, refill_rate REAL NOT NULL,
    capacity REAL NOT NULL, updated_at TEXT NOT NULL
  )`,
];

export const CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS channel_meta (
    channel_id TEXT PRIMARY KEY, kind TEXT NOT NULL, visibility TEXT NOT NULL,
    title TEXT NOT NULL, topic TEXT, avatar_url TEXT, status TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    member_count INTEGER NOT NULL DEFAULT 0, membership_version INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY, command_id TEXT NOT NULL,
    dedupe_principal_key TEXT NOT NULL, channel_id TEXT NOT NULL,
    sender_kind TEXT NOT NULL, sender_user_id TEXT, sender_bot_id TEXT,
    type TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'plain',
    status TEXT NOT NULL DEFAULT 'normal', text TEXT, reply_to TEXT,
    reply_snapshot_json TEXT, stream_state TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, edited_at TEXT,
    deleted_at TEXT, deleted_by TEXT, recalled_at TEXT,
    UNIQUE (channel_id, dedupe_principal_key, command_id)
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    attachment_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL,
    filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    width INTEGER, height INTEGER, storage_key TEXT NOT NULL, url TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS message_stickers (
    message_id TEXT PRIMARY KEY, sticker_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
    url TEXT NOT NULL, mime_type TEXT NOT NULL, width INTEGER, height INTEGER, size_bytes INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commands (
    bot_command_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, name TEXT NOT NULL,
    options_json TEXT NOT NULL, default_perm TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invocations (
    invocation_id TEXT PRIMARY KEY, bot_command_id TEXT NOT NULL, bot_id TEXT NOT NULL,
    invoker_user_id TEXT NOT NULL, dedupe_principal_key TEXT NOT NULL,
    command_id TEXT NOT NULL, options_json TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bot_installations (
    bot_id TEXT PRIMARY KEY, installed_by TEXT NOT NULL, scopes TEXT NOT NULL, installed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS interactions (
    interaction_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, component_id TEXT NOT NULL,
    custom_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, dedupe_principal_key TEXT NOT NULL,
    command_id TEXT NOT NULL, value_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
];

export const chatChannelBaseline: BaselineDetector = {
  version: 1,
  name: "baseline reset for slash bindings + stateful sessions",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, CHAT_CHANNEL_BASELINE_SCHEMA);
  },
};

export const chatChannelMigrations: SqlMigration[] = [
  {
    version: 2026062901,
    name: "defensive migration for legacy test schemas",
    up(ctx) {
      for (const legacyTable of [
        "commands",
        "invocations",
      ]) {
        ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${legacyTable}`);
      }

      if (!columnExists(ctx, "channel_meta", "command_manifest_version")) {
        ctx.storage.sql.exec(
          "ALTER TABLE channel_meta ADD COLUMN command_manifest_version INTEGER NOT NULL DEFAULT 0",
        );
      }

      if (tableExists(ctx, "messages") && !columnExists(ctx, "messages", "components_json")) {
        ctx.storage.sql.exec(
          "ALTER TABLE messages ADD COLUMN components_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      if (tableExists(ctx, "messages") && !columnExists(ctx, "messages", "sender_bot_display_name")) {
        ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN sender_bot_display_name TEXT");
      }
      if (tableExists(ctx, "messages") && !columnExists(ctx, "messages", "sender_bot_avatar_url")) {
        ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN sender_bot_avatar_url TEXT");
      }

      if (tableExists(ctx, "attachments") && !columnExists(ctx, "attachments", "blurhash")) {
        ctx.storage.sql.exec("ALTER TABLE attachments ADD COLUMN blurhash TEXT");
      }
      if (tableExists(ctx, "message_stickers") && !columnExists(ctx, "message_stickers", "blurhash")) {
        ctx.storage.sql.exec("ALTER TABLE message_stickers ADD COLUMN blurhash TEXT");
      }

      if (!tableExists(ctx, "channel_command_bindings")) {
        ctx.storage.sql.exec(`CREATE TABLE channel_command_bindings (
          channel_id TEXT NOT NULL,
          bot_command_id TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          status TEXT NOT NULL,
          permission_override TEXT,
          command_snapshot_json TEXT NOT NULL,
          stateful_max_ttl_seconds INTEGER,
          updated_by_user_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (channel_id, bot_command_id)
        )`);
      } else {
        if (!columnExists(ctx, "channel_command_bindings", "status")) {
          ctx.storage.sql.exec(
            "ALTER TABLE channel_command_bindings ADD COLUMN status TEXT NOT NULL DEFAULT 'allowed'",
          );
        }
        if (!columnExists(ctx, "channel_command_bindings", "permission_override")) {
          ctx.storage.sql.exec(
            "ALTER TABLE channel_command_bindings ADD COLUMN permission_override TEXT",
          );
        }
        if (!columnExists(ctx, "channel_command_bindings", "command_snapshot_json")) {
          ctx.storage.sql.exec(
            "ALTER TABLE channel_command_bindings ADD COLUMN command_snapshot_json TEXT NOT NULL DEFAULT '{}'",
          );
        }
        if (!columnExists(ctx, "channel_command_bindings", "stateful_max_ttl_seconds")) {
          ctx.storage.sql.exec(
            "ALTER TABLE channel_command_bindings ADD COLUMN stateful_max_ttl_seconds INTEGER",
          );
        }
        if (!columnExists(ctx, "channel_command_bindings", "updated_by_user_id")) {
          ctx.storage.sql.exec(
            "ALTER TABLE channel_command_bindings ADD COLUMN updated_by_user_id TEXT NOT NULL DEFAULT ''",
          );
        }
        if (!columnExists(ctx, "channel_command_bindings", "updated_at")) {
          ctx.storage.sql.exec(
            "ALTER TABLE channel_command_bindings ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
          );
        }
      }
      if (!indexExists(ctx, "idx_bindings_channel_enabled")) {
        ctx.storage.sql.exec(
          "CREATE INDEX idx_bindings_channel_enabled ON channel_command_bindings(channel_id, status)",
        );
      }

      if (!tableExists(ctx, "command_invocations")) {
        ctx.storage.sql.exec(`CREATE TABLE command_invocations (
          invocation_id              TEXT PRIMARY KEY,
          channel_id                 TEXT NOT NULL,
          command_id                 TEXT NOT NULL,
          invoker_user_id            TEXT NOT NULL,
          bot_id                     TEXT NOT NULL,
          bot_command_id             TEXT NOT NULL,
          command_name               TEXT NOT NULL,
          invoked_name               TEXT NOT NULL,
          command_schema_version     INTEGER NOT NULL,
          command_definition_hash    TEXT NOT NULL,
          options_json               TEXT NOT NULL,
          status                     TEXT NOT NULL,
          error_code                 TEXT,
          error_message              TEXT,
          created_at                 TEXT NOT NULL,
          updated_at                 TEXT NOT NULL,
          completed_at               TEXT,
          UNIQUE (channel_id, invoker_user_id, command_id)
        )`);
      }
      if (!indexExists(ctx, "idx_invocations_status")) {
        ctx.storage.sql.exec("CREATE INDEX idx_invocations_status ON command_invocations(status, updated_at)");
      }

      if (!tableExists(ctx, "stateful_command_sessions")) {
        ctx.storage.sql.exec(`CREATE TABLE stateful_command_sessions (
          session_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          bot_command_id TEXT NOT NULL,
          invocation_id TEXT NOT NULL,
          started_by_user_id TEXT NOT NULL,
          status TEXT NOT NULL,
          listen_rules_json TEXT NOT NULL,
          input_next_seq INTEGER NOT NULL DEFAULT 1,
          input_last_acked_seq INTEGER NOT NULL DEFAULT 0,
          effect_last_acked_seq INTEGER NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          closed_at TEXT,
          close_reason TEXT,
          summary_json TEXT
        )`);
      }
      if (!indexExists(ctx, "uniq_active_stateful_session_per_channel")) {
        ctx.storage.sql.exec(`CREATE UNIQUE INDEX uniq_active_stateful_session_per_channel
          ON stateful_command_sessions(channel_id)
          WHERE status IN ('starting', 'active', 'suspended', 'closing')`);
      }
      if (!tableExists(ctx, "stateful_session_inputs")) {
        ctx.storage.sql.exec(`CREATE TABLE stateful_session_inputs (
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          channel_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          message_projection_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sent_at TEXT,
          acked_at TEXT,
          PRIMARY KEY (session_id, seq)
        )`);
      }

      if (tableExists(ctx, "interactions") && !columnExists(ctx, "interactions", "updated_at")) {
        ctx.storage.sql.exec("ALTER TABLE interactions ADD COLUMN updated_at TEXT");
      }
      if (tableExists(ctx, "interactions") && !columnExists(ctx, "interactions", "completed_at")) {
        ctx.storage.sql.exec("ALTER TABLE interactions ADD COLUMN completed_at TEXT");
      }
      if (tableExists(ctx, "interactions") && !columnExists(ctx, "interactions", "error_code")) {
        ctx.storage.sql.exec("ALTER TABLE interactions ADD COLUMN error_code TEXT");
      }
      if (!indexExists(ctx, "uniq_interaction_per_user_once")) {
        ctx.storage.sql.exec(
          `CREATE UNIQUE INDEX uniq_interaction_per_user_once
           ON interactions(message_id, component_id, actor_user_id)
           WHERE status IN ('pending', 'completed')`,
        );
      }

      if (!tableExists(ctx, "bot_delivery_outbox")) {
        ctx.storage.sql.exec(`CREATE TABLE bot_delivery_outbox (
          outbox_id        TEXT PRIMARY KEY,
          channel_id       TEXT NOT NULL,
          bot_id           TEXT NOT NULL,
          kind             TEXT NOT NULL,
          invocation_id    TEXT,
          interaction_id   TEXT,
          event_id         TEXT,
          request_json     TEXT NOT NULL,
          status           TEXT NOT NULL DEFAULT 'pending',
          attempts         INTEGER NOT NULL DEFAULT 0,
          max_attempts     INTEGER NOT NULL DEFAULT 5,
          last_error       TEXT,
          failed_at        TEXT,
          next_attempt_at  TEXT NOT NULL,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        )`);
      }
      if (!indexExists(ctx, "idx_bot_delivery_due")) {
        ctx.storage.sql.exec(
          "CREATE INDEX idx_bot_delivery_due ON bot_delivery_outbox(status, next_attempt_at)",
        );
      }

      if (!tableExists(ctx, "bot_effects_applied")) {
        ctx.storage.sql.exec(`CREATE TABLE bot_effects_applied (
          channel_id       TEXT NOT NULL,
          bot_id           TEXT NOT NULL,
          client_effect_id TEXT NOT NULL,
          effect_type      TEXT NOT NULL,
          request_hash     TEXT NOT NULL,
          message_id       TEXT,
          response_json    TEXT,
          applied_at       TEXT NOT NULL,
          outbox_id        TEXT,
          PRIMARY KEY (channel_id, bot_id, client_effect_id)
        )`);
      }
      applyArchiveOutboxMigration(ctx);
    },
  },
  {
    version: 2026062902,
    name: "messages invocation_json for slash command display",
    up(ctx) {
      if (tableExists(ctx, "messages") && !columnExists(ctx, "messages", "invocation_json")) {
        ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN invocation_json TEXT");
      }
    },
  },
  {
    version: CHAT_CHANNEL_CURRENT_SCHEMA_VERSION,
    name: "message_stream_registry for bot streaming",
    up(ctx) {
      if (!tableExists(ctx, "message_stream_registry")) {
        ctx.storage.sql.exec(`CREATE TABLE message_stream_registry (
          channel_id        TEXT NOT NULL,
          message_id        TEXT NOT NULL,
          bot_id            TEXT NOT NULL,
          client_effect_id  TEXT NOT NULL,
          status            TEXT NOT NULL,
          sender_bot_display_name TEXT NOT NULL,
          sender_bot_avatar_url   TEXT,
          message_json      TEXT NOT NULL,
          created_at        TEXT NOT NULL,
          expires_at        TEXT NOT NULL,
          finalized_at      TEXT,
          abandoned_at      TEXT,
          final_event_id    TEXT,
          final_text_hash   TEXT,
          finalize_request_hash TEXT,
          finalized_response_json TEXT,
          abandoned_event_id TEXT,
          abandoned_text_hash TEXT,
          abandoned_response_json TEXT,
          PRIMARY KEY (channel_id, message_id)
        )`);
      }
      if (!indexExists(ctx, "idx_message_stream_registry_bot")) {
        ctx.storage.sql.exec(
          "CREATE INDEX idx_message_stream_registry_bot ON message_stream_registry(bot_id, status, expires_at)",
        );
      }
      if (!indexExists(ctx, "idx_message_stream_registry_expiry")) {
        ctx.storage.sql.exec(
          "CREATE INDEX idx_message_stream_registry_expiry ON message_stream_registry(status, expires_at)",
        );
      }
    },
  },
];

export const CHAT_CHANNEL_DO_SCHEMA = {
  doClassName: "ChatChannel",
  targetVersion: CHAT_CHANNEL_CURRENT_SCHEMA_VERSION,
  baseline: chatChannelBaseline,
  migrations: chatChannelMigrations,
} satisfies DoSchemaDefinition;
