CREATE TABLE IF NOT EXISTS chat_archive_records (
  archive_id   TEXT PRIMARY KEY,
  source_kind  TEXT NOT NULL,
  source_key   TEXT NOT NULL,
  source_seq   BIGINT NOT NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at   TIMESTAMPTZ,
  apply_error  TEXT,

  UNIQUE (source_kind, source_key, source_seq)
);

CREATE INDEX IF NOT EXISTS idx_chat_archive_records_ready
  ON chat_archive_records (source_kind, source_key, source_seq)
  WHERE applied_at IS NULL;

CREATE TABLE IF NOT EXISTS chat_archive_source_watermarks (
  source_kind      TEXT NOT NULL,
  source_key       TEXT NOT NULL,
  last_applied_seq BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (source_kind, source_key)
);
