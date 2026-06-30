import {
  applyBaselineSchema,
  migrateSqlite,
  type BaselineDetector,
  type SqlMigration,
} from "../shared/sql-migrations";
import { applyArchiveOutboxMigration } from "../../archive/apply-archive-migration";

export const DM_DIRECTORY_CURRENT_SCHEMA_VERSION = 2;

export const DM_DIRECTORY_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS dm_pairs (
    pair_key TEXT PRIMARY KEY,
    user_low TEXT NOT NULL,
    user_high TEXT NOT NULL,
    channel_id TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dm_pairs_channel_id ON dm_pairs(channel_id)`,
];

export const dmDirectoryBaseline: BaselineDetector = {
  version: 1,
  name: "baseline existing DMDirectory schema",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, DM_DIRECTORY_BASELINE_SCHEMA);
  },
};

export const dmDirectoryMigrations: SqlMigration[] = [
  {
    version: 2,
    name: "archive_outbox + archive_seq for local PG archive",
    up(ctx) {
      applyArchiveOutboxMigration(ctx);
    },
  },
];

export function migrateDmDirectorySchema(ctx: DurableObjectState): void {
  migrateSqlite(ctx, "DMDirectory", dmDirectoryBaseline, dmDirectoryMigrations);
}
