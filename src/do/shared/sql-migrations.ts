import { execSchema } from "./sql";

export interface SqlMigration {
  version: number;
  name: string;
  up(ctx: DurableObjectState): void;
}

export interface BaselineDetector {
  version: number;
  name: string;
  applyFresh(ctx: DurableObjectState): void;
}

/** Per-DO schema bundle; export one `*_DO_SCHEMA` constant from each migrations module. */
export interface DoSchemaDefinition {
  doClassName: string;
  targetVersion: number;
  baseline: BaselineDetector;
  migrations: SqlMigration[];
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteIdent(identifier: string): string {
  if (!IDENT_RE.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function tableExists(ctx: DurableObjectState, tableName: string): boolean {
  const rows = ctx.storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", tableName)
    .toArray();
  return rows.length > 0;
}

export function columnExists(ctx: DurableObjectState, tableName: string, columnName: string): boolean {
  const rows = ctx.storage.sql
    .exec(`PRAGMA table_info(${quoteIdent(tableName)})`)
    .toArray() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

export function indexExists(ctx: DurableObjectState, indexName: string): boolean {
  const rows = ctx.storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type='index' AND name=?", indexName)
    .toArray();
  return rows.length > 0;
}

/** Highest applied schema_migrations.version, or null when the table is missing/empty. */
export function readAppliedSchemaVersion(ctx: DurableObjectState): number | null {
  if (!tableExists(ctx, "schema_migrations")) {
    return null;
  }
  const maxRow = ctx.storage.sql.exec("SELECT MAX(version) AS v FROM schema_migrations").toArray()[0] as
    | { v: number | null }
    | undefined;
  const v = maxRow?.v;
  if (v === null || v === undefined) return null;
  return Number(v);
}

/** True when constructor migration work may still be required for targetVersion. */
export function schemaMigrationPending(ctx: DurableObjectState, targetVersion: number): boolean {
  const applied = readAppliedSchemaVersion(ctx);
  if (applied === null) return true;
  return applied < targetVersion;
}

/**
 * Single constructor entry for all SQLite-backed DOs. Skips blockConcurrencyWhile when
 * schema is current; when pending, blocks per CF DO guidance and re-checks version
 * inside the block before running applyDoSchemaMigrations.
 */
export function migrateDoSchema(ctx: DurableObjectState, schema: DoSchemaDefinition): void {
  if (!schemaMigrationPending(ctx, schema.targetVersion)) {
    return;
  }
  ctx.blockConcurrencyWhile(async () => {
    if (!schemaMigrationPending(ctx, schema.targetVersion)) {
      return;
    }
    applyDoSchemaMigrations(ctx, schema);
  });
}

/** Synchronous migration body (transactionSync). Use in tests; migrateDoSchema wraps this. */
export function applyDoSchemaMigrations(ctx: DurableObjectState, schema: DoSchemaDefinition): void {
  migrateSqlite(ctx, schema.doClassName, schema.baseline, schema.migrations);
}

export function migrateSqlite(
  ctx: DurableObjectState,
  doClassName: string,
  baseline: BaselineDetector,
  migrations: SqlMigration[],
): void {
  // Runs inside transactionSync; migrateDoSchema gates blockConcurrencyWhile to
  // pending versions only (see DO constructors).
  ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);

      const maxRow = ctx.storage.sql.exec("SELECT MAX(version) AS v FROM schema_migrations").toArray()[0] as
        | { v: number | null }
        | undefined;
      let currentVersion = maxRow?.v ?? null;

      if (currentVersion === null) {
        baseline.applyFresh(ctx);
        stampMigration(ctx, baseline.version, baseline.name);
        currentVersion = baseline.version;
      }

      const sorted = [...migrations].sort((a, b) => a.version - b.version);
      for (const migration of sorted) {
        if (migration.version <= currentVersion) continue;
        try {
          migration.up(ctx);
        } catch (error) {
          console.error("DO SQLite migration failed", {
            do_class: doClassName,
            migration_version: migration.version,
            migration_name: migration.name,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        stampMigration(ctx, migration.version, migration.name);
        currentVersion = migration.version;
      }
    });
}

function stampMigration(ctx: DurableObjectState, version: number, name: string): void {
  ctx.storage.sql.exec(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    version,
    name,
    new Date().toISOString(),
  );
}

export function applyBaselineSchema(ctx: DurableObjectState, statements: string[]): void {
  execSchema(ctx, statements);
}

export function handleSchemaVersionRequest(
  ctx: DurableObjectState,
  doClassName: string,
  request: Request,
): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/schema-version") return null;
  if (request.headers.get("X-Test-Only") !== "1") {
    return new Response("forbidden", { status: 403 });
  }

  const applied = ctx.storage.sql
    .exec("SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC")
    .toArray() as Array<{ version: number; name: string; applied_at: string }>;

  const maxRow = ctx.storage.sql.exec("SELECT MAX(version) AS current_version FROM schema_migrations").toArray()[0] as
    | { current_version: number | null }
    | undefined;

  return Response.json({
    do_class: doClassName,
    current_version: maxRow?.current_version ?? 0,
    applied,
  });
}
