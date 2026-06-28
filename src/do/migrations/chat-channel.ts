import {
  applyBaselineSchema,
  columnExists,
  indexExists,
  migrateSqlite,
  tableExists,
  type BaselineDetector,
  type SqlMigration,
} from "../sql-migrations";
import { applyArchiveOutboxMigration } from "../../archive/apply-archive-migration";

export const CHAT_CHANNEL_CURRENT_SCHEMA_VERSION = 2026062803;

export const CHAT_CHANNEL_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS channel_meta (
    channel_id TEXT PRIMARY KEY, kind TEXT NOT NULL, visibility TEXT NOT NULL,
    title TEXT NOT NULL, topic TEXT, avatar_url TEXT, status TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    member_count INTEGER NOT NULL DEFAULT 0, membership_version INTEGER NOT NULL DEFAULT 0
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
    reply_snapshot_json TEXT, stream_state TEXT NOT NULL DEFAULT 'none',
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
    status TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS message_attachments (
    message_id TEXT NOT NULL, attachment_id TEXT NOT NULL, PRIMARY KEY (message_id, attachment_id)
  )`,
  `CREATE TABLE IF NOT EXISTS message_stickers (
    message_id TEXT PRIMARY KEY, sticker_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
    url TEXT NOT NULL, mime_type TEXT NOT NULL, width INTEGER, height INTEGER, size_bytes INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mentions (
    message_id TEXT NOT NULL, user_id TEXT NOT NULL, start INTEGER NOT NULL, end_ INTEGER NOT NULL,
    PRIMARY KEY (message_id, start, end_)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(user_id)`,
  `CREATE TABLE IF NOT EXISTS bot_installations (
    bot_id TEXT PRIMARY KEY, installed_by TEXT NOT NULL, scopes TEXT NOT NULL, installed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commands (
    bot_command_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
    options_json TEXT NOT NULL, default_perm TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL, UNIQUE (bot_id, name)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_enabled_command_name ON commands(name) WHERE enabled = 1`,
  `CREATE TABLE IF NOT EXISTS invocations (
    invocation_id TEXT PRIMARY KEY, bot_command_id TEXT NOT NULL, bot_id TEXT NOT NULL,
    invoker_user_id TEXT NOT NULL, dedupe_principal_key TEXT NOT NULL,
    command_id TEXT NOT NULL, options_json TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, error_code TEXT,
    UNIQUE (bot_command_id, dedupe_principal_key, command_id)
  )`,
  `CREATE TABLE IF NOT EXISTS interactions (
    interaction_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, component_id TEXT NOT NULL,
    custom_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, dedupe_principal_key TEXT NOT NULL,
    command_id TEXT NOT NULL,
    value_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
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
  `CREATE TABLE IF NOT EXISTS rate_buckets (
    bucket_key TEXT PRIMARY KEY, tokens REAL NOT NULL, refill_rate REAL NOT NULL,
    capacity REAL NOT NULL, updated_at TEXT NOT NULL
  )`,
];

export const CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA = CHAT_CHANNEL_BASELINE_SCHEMA;

export const chatChannelBaseline: BaselineDetector = {
  version: 1,
  name: "baseline existing ChatChannel schema",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, CHAT_CHANNEL_BASELINE_SCHEMA);
  },
};

export const chatChannelMigrations: SqlMigration[] = [
  {
    version: 2026062601,
    name: "add blurhash metadata columns",
    up(ctx) {
      if (!columnExists(ctx, "attachments", "blurhash")) {
        ctx.storage.sql.exec("ALTER TABLE attachments ADD COLUMN blurhash TEXT");
      }
      if (!columnExists(ctx, "message_stickers", "blurhash")) {
        ctx.storage.sql.exec("ALTER TABLE message_stickers ADD COLUMN blurhash TEXT");
      }
    },
  },
  {
    version: 2026062602,
    name: "Phase 7 bot command bindings + delivery outbox + effects + event subscriptions + bot actor snapshot",
    up(ctx) {
      // baseline `commands` / `invocations` were unwritten shells (grep proof
      // in Task 7a-migration Step 3 + test). Drop and rebuild with repurposed
      // semantics: channel_command_bindings (read-cache snapshot of the
      // BotRegistry catalog) + channel_command_names (slash token conflict
      // domain) + command_invocations (invocation lifecycle).
      ctx.storage.sql.exec("DROP TABLE IF EXISTS commands");
      ctx.storage.sql.exec("DROP TABLE IF EXISTS invocations");

      // bot message components + bot actor snapshot (only sender_kind='bot'
      // rows write the bot_* columns; projectMessageForBrowser reads them so
      // history/ack/event/replay/context all emit {kind:"bot", bot:{...}}
      // without N BotRegistry fetches).
      if (!columnExists(ctx, "messages", "components_json")) {
        ctx.storage.sql.exec(
          "ALTER TABLE messages ADD COLUMN components_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      if (!columnExists(ctx, "messages", "sender_bot_display_name")) {
        ctx.storage.sql.exec(
          "ALTER TABLE messages ADD COLUMN sender_bot_display_name TEXT",
        );
      }
      if (!columnExists(ctx, "messages", "sender_bot_avatar_url")) {
        ctx.storage.sql.exec(
          "ALTER TABLE messages ADD COLUMN sender_bot_avatar_url TEXT",
        );
      }

      // bot_installations: per-channel install state + bot summary snapshot
      // (so /commands can render bot fields without cross-DO fetches).
      if (!columnExists(ctx, "bot_installations", "status")) {
        ctx.storage.sql.exec(
          "ALTER TABLE bot_installations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
        );
      }
      if (!columnExists(ctx, "bot_installations", "updated_by")) {
        ctx.storage.sql.exec("ALTER TABLE bot_installations ADD COLUMN updated_by TEXT");
      }
      if (!columnExists(ctx, "bot_installations", "updated_at")) {
        ctx.storage.sql.exec("ALTER TABLE bot_installations ADD COLUMN updated_at TEXT");
      }
      if (!columnExists(ctx, "bot_installations", "bot_display_name")) {
        ctx.storage.sql.exec(
          "ALTER TABLE bot_installations ADD COLUMN bot_display_name TEXT NOT NULL DEFAULT ''",
        );
      }
      if (!columnExists(ctx, "bot_installations", "bot_avatar_url")) {
        ctx.storage.sql.exec("ALTER TABLE bot_installations ADD COLUMN bot_avatar_url TEXT");
      }

      // interactions: rich UI lifecycle (pending -> dispatched -> completed |
      // failed | expired). Add completion tracking columns.
      if (!columnExists(ctx, "interactions", "updated_at")) {
        ctx.storage.sql.exec("ALTER TABLE interactions ADD COLUMN updated_at TEXT");
      }
      if (!columnExists(ctx, "interactions", "completed_at")) {
        ctx.storage.sql.exec("ALTER TABLE interactions ADD COLUMN completed_at TEXT");
      }
      if (!columnExists(ctx, "interactions", "error_code")) {
        ctx.storage.sql.exec("ALTER TABLE interactions ADD COLUMN error_code TEXT");
      }

      // channel_command_bindings: read-cache snapshot of the BotRegistry
      // catalog row (correctness source for command.invoke is the CURRENT
      // BotRegistry row, not this snapshot; drift is detected via
      // definition_hash and the snapshot is refreshed in-place).
      if (!tableExists(ctx, "channel_command_bindings")) {
        ctx.storage.sql.exec(`CREATE TABLE channel_command_bindings (
          binding_id               TEXT PRIMARY KEY,
          channel_id               TEXT NOT NULL,
          bot_id                   TEXT NOT NULL,
          bot_command_id           TEXT NOT NULL,
          status                   TEXT NOT NULL,
          permission_override       TEXT,
          name                     TEXT NOT NULL,
          description              TEXT,
          options_json             TEXT NOT NULL,
          aliases_json             TEXT NOT NULL DEFAULT '[]',
          default_member_permission TEXT NOT NULL,
          definition_hash          TEXT NOT NULL,
          created_by               TEXT NOT NULL,
          created_at               TEXT NOT NULL,
          updated_by               TEXT,
          updated_at               TEXT NOT NULL,
          UNIQUE (channel_id, bot_command_id)
        )`);
        ctx.storage.sql.exec(
          "CREATE INDEX idx_bindings_channel_enabled ON channel_command_bindings(channel_id, status)",
        );
      }

      // channel_command_names: the per-channel slash-token -> command map.
      // Enabling a binding writes canonical + alias rows; disabling removes
      // them. Same-channel enabled token conflict -> COMMAND_NAME_CONFLICT.
      if (!tableExists(ctx, "channel_command_names")) {
        ctx.storage.sql.exec(`CREATE TABLE channel_command_names (
          channel_id     TEXT NOT NULL,
          slash_name     TEXT NOT NULL,
          bot_command_id TEXT NOT NULL,
          bot_id         TEXT NOT NULL,
          kind           TEXT NOT NULL,
          created_at     TEXT NOT NULL,
          PRIMARY KEY (channel_id, slash_name)
        )`);
      }

      // command_invocations: invocation lifecycle. command_id is the Browser
      // WS operation_id (durable idempotency key); idempotency SoT is
      // idempotency_keys, the UNIQUE is secondary defense.
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
        ctx.storage.sql.exec(
          "CREATE INDEX idx_invocations_status ON command_invocations(status, updated_at)",
        );
      }

      // bot_delivery_outbox (renamed from bot_callback_outbox; transport is
      // no longer HTTP callback-specific). ChatChannel alarm flushes these to
      // BotConnection.enqueueDelivery. status aligns with projection_outbox
      // naming; separate from invocation/interaction lifecycle status.
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
        ctx.storage.sql.exec(
          "CREATE INDEX idx_bot_delivery_due ON bot_delivery_outbox(status, next_attempt_at)",
        );
      }

      // effect idempotency: PK = (channel_id, bot_id, client_effect_id) so
      // delivery retries never reapply the same effect. outbox_id is a debug
      // provenance column, not part of the PK. request_hash detects body drift.
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

      // passive message_event subscriptions (§9.9). Phase 7 only
      // event_type=message.created. observer/responder only.
      if (!tableExists(ctx, "channel_bot_event_subscriptions")) {
        ctx.storage.sql.exec(`CREATE TABLE channel_bot_event_subscriptions (
          subscription_id TEXT PRIMARY KEY,
          channel_id      TEXT NOT NULL,
          bot_id          TEXT NOT NULL,
          event_type      TEXT NOT NULL,
          status          TEXT NOT NULL,
          filters_json    TEXT NOT NULL,
          created_by      TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          updated_by      TEXT,
          updated_at      TEXT NOT NULL,
          UNIQUE(channel_id, bot_id, event_type)
        )`);
        if (!indexExists(ctx, "idx_channel_bot_event_subscriptions_enabled")) {
          ctx.storage.sql.exec(
            "CREATE INDEX idx_channel_bot_event_subscriptions_enabled ON channel_bot_event_subscriptions(channel_id, event_type, status)",
          );
        }
      }
    },
  },
  {
    version: 2026062803,
    name: "archive_outbox + archive_seq for local PG archive",
    up(ctx) {
      applyArchiveOutboxMigration(ctx);
    },
  },
];

export function migrateChatChannelSchema(ctx: DurableObjectState): void {
  migrateSqlite(ctx, "ChatChannel", chatChannelBaseline, chatChannelMigrations);
}
