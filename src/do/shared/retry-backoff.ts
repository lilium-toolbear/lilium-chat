import { OUTBOX_MAX_ATTEMPTS } from "../../contract/outbox";

type SyncSql = DurableObjectState["storage"]["sql"];

export function computeRetryBackoffMs(attempts: number): number {
  return 1000 * Math.pow(2, attempts);
}

export function bumpQueueRetry(
  sql: SyncSql,
  opts: {
    table: string;
    idColumn: string;
    id: string;
    nowIso: string;
    error: string;
    maxAttempts?: number;
  },
): void {
  const row = sql
    .exec(`SELECT attempts, max_attempts FROM ${opts.table} WHERE ${opts.idColumn}=?`, opts.id)
    .toArray()[0] as { attempts: number | null; max_attempts: number | null } | undefined;
  const attempts = row?.attempts ?? 0;
  const maxAttempts = row?.max_attempts ?? opts.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
  const next = attempts + 1;

  if (next >= maxAttempts) {
    sql.exec(
      `UPDATE ${opts.table} SET status='dead_letter', attempts=?, last_error=?, failed_at=?, updated_at=? WHERE ${opts.idColumn}=?`,
      next,
      opts.error,
      opts.nowIso,
      opts.nowIso,
      opts.id,
    );
    return;
  }

  const backoffMs = computeRetryBackoffMs(next);
  const nextAttemptAt = new Date(Date.parse(opts.nowIso) + backoffMs).toISOString();
  sql.exec(
    `UPDATE ${opts.table} SET status='pending', attempts=?, last_error=?, next_attempt_at=?, updated_at=? WHERE ${opts.idColumn}=?`,
    next,
    opts.error,
    nextAttemptAt,
    opts.nowIso,
    opts.id,
  );
}
