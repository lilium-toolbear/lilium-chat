import type { ArchiveChange, ArchiveRecord } from "../archive/payload.js";
import type { PgQueryable } from "./pg-writer.js";

interface ReplayTableConfig {
  pgTable: string;
  pk: string[];
  replaceScopeColumns?: string[];
  jsonColumns?: ReadonlySet<string>;
  transformRow?: (row: Record<string, unknown>) => Record<string, unknown>;
}

const REPLAY_TABLES: Record<string, ReplayTableConfig> = {
  chat_messages: {
    pgTable: "chat.messages",
    pk: ["message_id"],
    jsonColumns: new Set(["reply_snapshot_json"]),
  },
  chat_events: {
    pgTable: "chat.events",
    pk: ["event_id"],
    jsonColumns: new Set(["payload"]),
    transformRow: (row) => {
      const next = { ...row };
      if (next.payload_json !== undefined && next.payload === undefined) {
        const raw = next.payload_json;
        next.payload = typeof raw === "string" ? JSON.parse(raw) : raw;
        delete next.payload_json;
      }
      return next;
    },
  },
  chat_mentions: {
    pgTable: "chat.mentions",
    pk: ["message_id", "start_index", "end_index"],
    replaceScopeColumns: ["message_id"],
  },
  chat_message_attachments: {
    pgTable: "chat.message_attachments",
    pk: ["message_id", "attachment_id"],
    replaceScopeColumns: ["message_id"],
  },
  chat_message_stickers: {
    pgTable: "chat.message_stickers",
    pk: ["message_id"],
    replaceScopeColumns: ["message_id"],
  },
};

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

async function applyReplaceScope(
  client: PgQueryable,
  record: ArchiveRecord,
  change: Extract<ArchiveChange, { op: "replace_scope" }>,
): Promise<void> {
  const config = REPLAY_TABLES[change.table];
  if (!config?.replaceScopeColumns) return;
  const scopeCols = config.replaceScopeColumns;
  const where = scopeCols.map((col, i) => `${quoteIdent(col)} = $${i + 1}`).join(" AND ");
  const scopeParams = scopeCols.map((col) => change.scope[col]);
  await client.query(
    `DELETE FROM ${config.pgTable}
     WHERE ${where}
       AND (archived_source_seq IS NULL OR archived_source_seq <= $${scopeCols.length + 1})`,
    [...scopeParams, record.source_seq],
  );
  for (const raw of change.rows) {
    const base = config.transformRow ? config.transformRow(raw) : raw;
    const row = withArchiveMeta(record, base);
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
    } else if (change.op === "replace_scope") {
      if (!REPLAY_TABLES[change.table]) continue;
      await applyReplaceScope(client, record, change);
      applied += 1;
    }
  }
  return applied;
}
