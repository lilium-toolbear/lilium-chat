import type { ArchiveChange, ArchiveRecord } from "../archive/payload.js";
import type { PgQueryable } from "./pg-writer.js";
import { REPLAY_TABLES, type ReplayTableConfig } from "./replay-tables.js";

const ARCHIVE_COLUMNS = [
  "archived_source_kind",
  "archived_source_key",
  "archived_source_seq",
  "archived_at",
] as const;

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function withArchiveMeta(
  record: ArchiveRecord,
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...row,
    archived_source_kind: record.source_kind,
    archived_source_key: record.source_key,
    archived_source_seq: record.source_seq,
    archived_at: record.occurred_at,
  };
}

function buildUpsertSql(config: ReplayTableConfig, row: Record<string, unknown>): { sql: string; params: unknown[] } {
  const columns = Object.keys(row);
  const colSql = columns.map(quoteIdent).join(", ");
  const placeholders = columns.map((col, i) => {
    if (config.jsonColumns?.has(col)) return `$${i + 1}::jsonb`;
    if (col === "occurred_at" || col.endsWith("_at")) return `$${i + 1}::timestamptz`;
    return `$${i + 1}`;
  });
  const pkSql = config.pk.map(quoteIdent).join(", ");
  const archiveSet = new Set<string>(ARCHIVE_COLUMNS);
  const businessUpdateCols = columns.filter((c) => !config.pk.includes(c) && !archiveSet.has(c));
  const archiveUpdateCols = ARCHIVE_COLUMNS.filter((c) => columns.includes(c));
  const setCols = [...businessUpdateCols, ...archiveUpdateCols];
  const guardedSets = setCols.map((col) => {
    const ref = quoteIdent(col);
    return `${ref} = EXCLUDED.${ref}`;
  });
  const params = columns.map((col) => {
    const value = row[col];
    if (config.jsonColumns?.has(col)) return JSON.stringify(value);
    return value;
  });
  const tableRef = config.pgTable;
  const sql = `
INSERT INTO ${tableRef} (${colSql})
VALUES (${placeholders.join(", ")})
ON CONFLICT (${pkSql}) DO UPDATE SET
  ${guardedSets.join(", ")}
WHERE ${tableRef}.archived_source_seq IS NULL
   OR ${tableRef}.archived_source_seq <= EXCLUDED.archived_source_seq
`;
  return { sql, params };
}

async function applyUpsert(
  client: PgQueryable,
  record: ArchiveRecord,
  change: Extract<ArchiveChange, { op: "upsert" }>,
): Promise<void> {
  const config = REPLAY_TABLES[change.table];
  if (!config) return;
  const base = config.transformRow ? config.transformRow(change.after) : change.after;
  const row = withArchiveMeta(record, base);
  const { sql, params } = buildUpsertSql(config, row);
  await client.query(sql, params);
}

async function applySoftDeleteByPk(
  client: PgQueryable,
  record: ArchiveRecord,
  config: ReplayTableConfig,
  pk: Record<string, string | number>,
): Promise<void> {
  const softCol = config.softDeleteColumn;
  if (!softCol) {
    console.warn(`skip archive delete op: table ${config.pgTable} has no soft delete column`);
    return;
  }
  const pkCols = config.pk;
  const where = pkCols.map((col, i) => `${quoteIdent(col)} = $${i + 1}`).join(" AND ");
  const pkParams = pkCols.map((col) => pk[col]);
  const seqParam = pkCols.length + 1;
  const softParam = pkCols.length + 2;
  const kindParam = pkCols.length + 3;
  const keyParam = pkCols.length + 4;
  const atParam = pkCols.length + 5;
  await client.query(
    `UPDATE ${config.pgTable}
     SET ${quoteIdent(softCol)} = $${softParam}::timestamptz,
         archived_source_kind = $${kindParam},
         archived_source_key = $${keyParam},
         archived_source_seq = $${seqParam},
         archived_at = $${atParam}::timestamptz
     WHERE ${where}
       AND (archived_source_seq IS NULL OR archived_source_seq <= $${seqParam})`,
    [
      ...pkParams,
      record.source_seq,
      record.occurred_at,
      record.source_kind,
      record.source_key,
      record.occurred_at,
    ],
  );
}

async function applyDelete(
  client: PgQueryable,
  record: ArchiveRecord,
  change: Extract<ArchiveChange, { op: "delete" }>,
): Promise<void> {
  const config = REPLAY_TABLES[change.table];
  if (!config) return;
  await applySoftDeleteByPk(client, record, config, change.pk);
}

async function softDeleteScope(
  client: PgQueryable,
  record: ArchiveRecord,
  config: ReplayTableConfig,
  scope: Record<string, string | number>,
): Promise<void> {
  const softCol = config.softDeleteColumn ?? "deleted_at";
  const scopeCols = Object.keys(scope);
  const where = scopeCols.map((col, i) => `${quoteIdent(col)} = $${i + 1}`).join(" AND ");
  const scopeParams = scopeCols.map((col) => scope[col]);
  const seqParam = scopeCols.length + 1;
  const softParam = scopeCols.length + 2;
  const kindParam = scopeCols.length + 3;
  const keyParam = scopeCols.length + 4;
  const atParam = scopeCols.length + 5;
  await client.query(
    `UPDATE ${config.pgTable}
     SET ${quoteIdent(softCol)} = $${softParam}::timestamptz,
         archived_source_kind = $${kindParam},
         archived_source_key = $${keyParam},
         archived_source_seq = $${seqParam},
         archived_at = $${atParam}::timestamptz
     WHERE ${where}
       AND ${quoteIdent(softCol)} IS NULL
       AND (archived_source_seq IS NULL OR archived_source_seq <= $${seqParam})`,
    [
      ...scopeParams,
      record.source_seq,
      record.occurred_at,
      record.source_kind,
      record.source_key,
      record.occurred_at,
    ],
  );
}

async function applyReplaceScope(
  client: PgQueryable,
  record: ArchiveRecord,
  change: Extract<ArchiveChange, { op: "replace_scope" }>,
): Promise<void> {
  const config = REPLAY_TABLES[change.table];
  if (!config?.scopeReplace) return;
  const softCol = config.softDeleteColumn ?? "deleted_at";
  await softDeleteScope(client, record, config, change.scope);
  for (const raw of change.rows) {
    const base = config.transformRow ? config.transformRow(raw) : raw;
    const row = withArchiveMeta(record, { ...base, [softCol]: null });
    const { sql, params } = buildUpsertSql(config, row);
    await client.query(sql, params);
  }
}

export async function applyArchiveRecord(client: PgQueryable, record: ArchiveRecord): Promise<number> {
  let applied = 0;
  for (const change of record.changes) {
    if (change.op === "upsert") {
      if (!REPLAY_TABLES[change.table]) continue;
      await applyUpsert(client, record, change);
      applied += 1;
    } else if (change.op === "delete") {
      if (!REPLAY_TABLES[change.table]) continue;
      await applyDelete(client, record, change);
      applied += 1;
    } else if (change.op === "replace_scope") {
      if (!REPLAY_TABLES[change.table]) continue;
      await applyReplaceScope(client, record, change);
      applied += 1;
    }
  }
  return applied;
}
