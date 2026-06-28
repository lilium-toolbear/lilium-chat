import { isoDueTable, type DueTable } from "../do/scheduler";
import { computeRetryBackoffMs } from "../do/retry-backoff";
import {
  ARCHIVE_BATCH_TARGET_BYTES,
  canonicalStringify,
  payloadByteLength,
  validateArchiveRecord,
  type ArchiveRecord,
} from "./payload";

const DEFAULT_FLUSH_LIMIT = 100;
const MAX_BATCH_MESSAGES = 100;

export function archiveOutboxDueTable(): DueTable {
  return isoDueTable("archive_outbox", "next_attempt_at", "status", "pending", async () => {
    /* scheduling only — flush is a direct call, not runDueJobs */
  });
}

export function bumpArchiveRetry(
  sql: DurableObjectState["storage"]["sql"],
  opts: {
    archiveId: string;
    nowIso: string;
    error: string;
    maxAttempts?: number;
  },
): void {
  const row = sql
    .exec("SELECT attempts, max_attempts FROM archive_outbox WHERE archive_id=?", opts.archiveId)
    .toArray()[0] as { attempts: number | null; max_attempts: number | null } | undefined;
  const attempts = row?.attempts ?? 0;
  const maxAttempts = row?.max_attempts ?? opts.maxAttempts ?? 20;
  const next = attempts + 1;

  if (next >= maxAttempts) {
    sql.exec(
      `UPDATE archive_outbox SET status='failed', attempts=?, last_error=?, updated_at=? WHERE archive_id=?`,
      next,
      opts.error,
      opts.nowIso,
      opts.archiveId,
    );
    return;
  }

  const backoffMs = computeRetryBackoffMs(next);
  const nextAttemptAt = new Date(Date.parse(opts.nowIso) + backoffMs).toISOString();
  sql.exec(
    `UPDATE archive_outbox SET status='pending', attempts=?, last_error=?, next_attempt_at=?, updated_at=? WHERE archive_id=?`,
    next,
    opts.error,
    nextAttemptAt,
    opts.nowIso,
    opts.archiveId,
  );
}

interface ParsedRow {
  archive_id: string;
  record: ArchiveRecord;
}

function buildBatches(rows: ParsedRow[]): ParsedRow[][] {
  const batches: ParsedRow[][] = [];
  let current: ParsedRow[] = [];
  let currentBytes = 0;

  for (const row of rows) {
    const bytes = payloadByteLength(canonicalStringify(row.record));
    const wouldExceedCount = current.length >= MAX_BATCH_MESSAGES;
    const wouldExceedBytes =
      current.length > 0 && currentBytes + bytes > ARCHIVE_BATCH_TARGET_BYTES;

    if (wouldExceedCount || wouldExceedBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function flushArchiveOutboxToQueue(
  ctx: DurableObjectState,
  queue: Queue<ArchiveRecord>,
  opts?: { limit?: number; now?: string },
): Promise<{ flushed: number; failed: number; remaining: number }> {
  const nowIso = opts?.now ?? new Date().toISOString();
  const limit = opts?.limit ?? DEFAULT_FLUSH_LIMIT;
  const sql = ctx.storage.sql;

  const pendingCursor = sql.exec(
    `SELECT archive_id, source_kind, source_key, source_seq, payload_json
     FROM archive_outbox
     WHERE status='pending' AND next_attempt_at <= ?
     ORDER BY source_seq ASC
     LIMIT ?`,
    nowIso,
    limit,
  );
  const pendingRows = pendingCursor.toArray() as Array<{
    archive_id: string;
    payload_json: string;
  }>;

  let flushed = 0;
  let failed = 0;

  const valid: ParsedRow[] = [];
  for (const row of pendingRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_json);
    } catch {
      sql.exec(
        `UPDATE archive_outbox SET status='failed', last_error=?, updated_at=? WHERE archive_id=?`,
        "invalid JSON",
        nowIso,
        row.archive_id,
      );
      failed += 1;
      continue;
    }
    const validation = validateArchiveRecord(parsed);
    if (!validation.ok) {
      sql.exec(
        `UPDATE archive_outbox SET status='failed', last_error=?, updated_at=? WHERE archive_id=?`,
        validation.error,
        nowIso,
        row.archive_id,
      );
      failed += 1;
      continue;
    }
    valid.push({ archive_id: row.archive_id, record: parsed as ArchiveRecord });
  }

  const batches = buildBatches(valid);
  for (const batch of batches) {
    const sendBatch = batch.map((row) => ({
      body: row.record,
      contentType: "json" as const,
    }));
    try {
      await queue.sendBatch(sendBatch);
      for (const row of batch) {
        sql.exec(
          `UPDATE archive_outbox SET status='queued', updated_at=?, last_error=NULL WHERE archive_id=?`,
          nowIso,
          row.archive_id,
        );
        flushed += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const row of batch) {
        bumpArchiveRetry(sql, { archiveId: row.archive_id, nowIso, error: msg });
        const status = sql
          .exec("SELECT status FROM archive_outbox WHERE archive_id=?", row.archive_id)
          .toArray()[0] as { status: string } | undefined;
        if (status?.status === "failed") failed += 1;
      }
    }
  }

  const remainingRow = sql
    .exec("SELECT COUNT(*) AS n FROM archive_outbox WHERE status='pending'")
    .toArray()[0] as { n: number };
  const remaining = remainingRow?.n ?? 0;

  return { flushed, failed, remaining };
}

/** Count pending archive rows (for tests / probes). */
export function countPendingArchiveOutbox(sql: DurableObjectState["storage"]["sql"]): number {
  const row = sql
    .exec("SELECT COUNT(*) AS n FROM archive_outbox WHERE status='pending'")
    .toArray()[0] as { n: number };
  return row?.n ?? 0;
}
