import { indexExists, tableExists } from "../do/shared/sql-migrations";

/** Idempotent DDL for archive_seq + archive_outbox (spec §4.1). */
export function applyArchiveOutboxMigration(ctx: DurableObjectState): void {
  if (!tableExists(ctx, "archive_seq")) {
    ctx.storage.sql.exec(`CREATE TABLE archive_seq (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_seq INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec("INSERT OR IGNORE INTO archive_seq (id, last_seq) VALUES (1, 0)");
  }
  if (!tableExists(ctx, "archive_outbox")) {
    ctx.storage.sql.exec(`CREATE TABLE archive_outbox (
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
    )`);
  }
  if (!indexExists(ctx, "idx_archive_outbox_due")) {
    ctx.storage.sql.exec(
      "CREATE INDEX idx_archive_outbox_due ON archive_outbox(status, next_attempt_at)",
    );
  }
  if (!indexExists(ctx, "idx_archive_outbox_source_seq")) {
    ctx.storage.sql.exec(
      "CREATE INDEX idx_archive_outbox_source_seq ON archive_outbox(source_kind, source_key, source_seq)",
    );
  }
}
