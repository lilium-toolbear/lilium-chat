import {
  applyBaselineSchema,
  columnExists,
  migrateSqlite,
  type BaselineDetector,
  type SqlMigration,
} from "../sql-migrations";

export const USER_DIRECTORY_CURRENT_SCHEMA_VERSION = 2026062601;

export const USER_DIRECTORY_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS my_channels (
    user_id TEXT NOT NULL, channel_id TEXT NOT NULL, kind TEXT NOT NULL,
    joined_at TEXT NOT NULL, left_at TEXT, removed_at TEXT,
    status TEXT NOT NULL DEFAULT 'active', membership_version INTEGER NOT NULL,
    last_read_event_id TEXT, PRIMARY KEY (user_id, channel_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_my_channels ON my_channels(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_my_channels_active ON my_channels(user_id) WHERE status='active'`,
  `CREATE TABLE IF NOT EXISTS pending_attachments (
    attachment_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL,
    filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    width INTEGER, height INTEGER, storage_key TEXT NOT NULL, url TEXT NOT NULL,
    status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_attachments(status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    operation TEXT NOT NULL, operation_id TEXT NOT NULL, -- HTTP Idempotency-Key or WS command_id
    request_hash TEXT NOT NULL, status TEXT NOT NULL,
    channel_id TEXT, response_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ud_idem_expires ON idempotency_keys(expires_at)`,
  `CREATE TABLE IF NOT EXISTS personal_stickers (
    sticker_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    url TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (user_id, attachment_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_personal_stickers_user ON personal_stickers(user_id, created_at DESC) WHERE deleted_at IS NULL`,
];

export const USER_DIRECTORY_LEGACY_BASELINE_SCHEMA = USER_DIRECTORY_BASELINE_SCHEMA;

export const userDirectoryBaseline: BaselineDetector = {
  version: 1,
  name: "baseline existing UserDirectory schema",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, USER_DIRECTORY_BASELINE_SCHEMA);
  },
};

export const userDirectoryMigrations: SqlMigration[] = [
  {
    version: 2026062601,
    name: "add blurhash metadata columns",
    up(ctx) {
      if (!columnExists(ctx, "pending_attachments", "blurhash")) {
        ctx.storage.sql.exec("ALTER TABLE pending_attachments ADD COLUMN blurhash TEXT");
      }
      if (!columnExists(ctx, "personal_stickers", "blurhash")) {
        ctx.storage.sql.exec("ALTER TABLE personal_stickers ADD COLUMN blurhash TEXT");
      }
    },
  },
];

export function migrateUserDirectorySchema(ctx: DurableObjectState): void {
  migrateSqlite(ctx, "UserDirectory", userDirectoryBaseline, userDirectoryMigrations);
}
