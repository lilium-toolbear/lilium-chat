import type { ArchiveRecord } from "../archive/payload.js";
import type { PgQueryable } from "./pg-writer.js";
import { applyArchiveRecord } from "./replay.js";

export interface DrainSourceKey {
  source_kind: string;
  source_key: string;
}

interface PendingArchiveRow {
  archive_id: string;
  payload: unknown;
}

function uniqueSources(records: readonly ArchiveRecord[]): DrainSourceKey[] {
  const seen = new Map<string, DrainSourceKey>();
  for (const record of records) {
    const key = `${record.source_kind}\0${record.source_key}`;
    if (!seen.has(key)) {
      seen.set(key, { source_kind: record.source_kind, source_key: record.source_key });
    }
  }
  return [...seen.values()];
}

async function lockWatermark(
  client: PgQueryable,
  sourceKind: string,
  sourceKey: string,
): Promise<number> {
  const existing = await client.query(
    `SELECT last_applied_seq
     FROM chat_archive_source_watermarks
     WHERE source_kind = $1 AND source_key = $2
     FOR UPDATE`,
    [sourceKind, sourceKey],
  );
  const rows = (existing as { rows?: Array<{ last_applied_seq: string | number }> }).rows ?? [];
  if (rows.length > 0) {
    return Number(rows[0]!.last_applied_seq);
  }
  await client.query(
    `INSERT INTO chat_archive_source_watermarks (source_kind, source_key, last_applied_seq)
     VALUES ($1, $2, 0)
     ON CONFLICT (source_kind, source_key) DO NOTHING`,
    [sourceKind, sourceKey],
  );
  const locked = await client.query(
    `SELECT last_applied_seq
     FROM chat_archive_source_watermarks
     WHERE source_kind = $1 AND source_key = $2
     FOR UPDATE`,
    [sourceKind, sourceKey],
  );
  const lockedRows = (locked as { rows?: Array<{ last_applied_seq: string | number }> }).rows ?? [];
  return Number(lockedRows[0]?.last_applied_seq ?? 0);
}

async function fetchNextPending(
  client: PgQueryable,
  sourceKind: string,
  sourceKey: string,
  nextSeq: number,
): Promise<PendingArchiveRow | null> {
  const result = await client.query(
    `SELECT archive_id, payload
     FROM chat_archive_records
     WHERE source_kind = $1
       AND source_key = $2
       AND source_seq = $3
       AND applied_at IS NULL`,
    [sourceKind, sourceKey, nextSeq],
  );
  const rows = (result as { rows?: PendingArchiveRow[] }).rows ?? [];
  return rows[0] ?? null;
}

function parseRecordPayload(payload: unknown): ArchiveRecord {
  if (typeof payload === "string") {
    return JSON.parse(payload) as ArchiveRecord;
  }
  return payload as ArchiveRecord;
}

export async function drainSource(
  client: PgQueryable,
  sourceKind: string,
  sourceKey: string,
  maxRecords = 1000,
): Promise<number> {
  let drained = 0;
  for (let i = 0; i < maxRecords; i += 1) {
    await client.query("BEGIN");
    let archiveId: string | null = null;
    try {
      const lastApplied = await lockWatermark(client, sourceKind, sourceKey);
      const pending = await fetchNextPending(client, sourceKind, sourceKey, lastApplied + 1);
      if (!pending) {
        await client.query("COMMIT");
        break;
      }
      archiveId = pending.archive_id;
      const record = parseRecordPayload(pending.payload);
      await applyArchiveRecord(client, record);
      await client.query(
        `UPDATE chat_archive_records
         SET applied_at = now(), apply_error = NULL
         WHERE archive_id = $1`,
        [archiveId],
      );
      await client.query(
        `UPDATE chat_archive_source_watermarks
         SET last_applied_seq = $3, updated_at = now()
         WHERE source_kind = $1 AND source_key = $2`,
        [sourceKind, sourceKey, record.source_seq],
      );
      await client.query("COMMIT");
      drained += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      if (archiveId) {
        await client.query(
          `UPDATE chat_archive_records SET apply_error = $2 WHERE archive_id = $1`,
          [archiveId, String(err)],
        );
      }
      throw err;
    }
  }
  return drained;
}

export async function drainAffectedSources(
  client: PgQueryable,
  records: readonly ArchiveRecord[],
  maxRecordsPerSource = 1000,
): Promise<number> {
  let total = 0;
  for (const source of uniqueSources(records)) {
    total += await drainSource(client, source.source_kind, source.source_key, maxRecordsPerSource);
  }
  return total;
}

export async function drainAllPendingSources(
  client: PgQueryable,
  maxRecordsPerSource = 1000,
): Promise<number> {
  const result = await client.query(
    `SELECT DISTINCT source_kind, source_key
     FROM chat_archive_records
     WHERE applied_at IS NULL
     ORDER BY source_kind, source_key`,
  );
  const rows = (result as { rows?: DrainSourceKey[] }).rows ?? [];
  let total = 0;
  for (const row of rows) {
    total += await drainSource(client, row.source_kind, row.source_key, maxRecordsPerSource);
  }
  return total;
}
