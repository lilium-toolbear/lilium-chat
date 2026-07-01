import {
  applyBaselineSchema,
  type BaselineDetector,
  type DoSchemaDefinition,
  type SqlMigration,
} from "../shared/sql-migrations";

export const INVITE_DIRECTORY_CURRENT_SCHEMA_VERSION = 1;

export const INVITE_DIRECTORY_BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS invite_index (
    invite_code TEXT PRIMARY KEY, channel_id TEXT NOT NULL, status TEXT NOT NULL,
    expires_at TEXT NOT NULL, revoked_at TEXT, updated_at TEXT NOT NULL
  )`,
];

export const inviteDirectoryBaseline: BaselineDetector = {
  version: 1,
  name: "baseline existing InviteDirectory schema",
  applyFresh(ctx) {
    applyBaselineSchema(ctx, INVITE_DIRECTORY_BASELINE_SCHEMA);
  },
};

export const inviteDirectoryMigrations: SqlMigration[] = [];

export const INVITE_DIRECTORY_DO_SCHEMA = {
  doClassName: "InviteDirectory",
  targetVersion: INVITE_DIRECTORY_CURRENT_SCHEMA_VERSION,
  baseline: inviteDirectoryBaseline,
  migrations: inviteDirectoryMigrations,
} satisfies DoSchemaDefinition;
