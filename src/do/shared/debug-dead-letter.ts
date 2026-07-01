type SyncSql = DurableObjectState["storage"]["sql"];

type OutboxTable = "projection_outbox" | "bot_delivery_outbox";

/** Mark stale pending outbox rows as dead_letter (ops recovery; not for normal request paths). */
export function deadLetterStaleOutboxRows(
  sql: SyncSql,
  opts: {
    table: OutboxTable;
    olderThan: string;
    nowIso: string;
    reason: string;
    dryRun: boolean;
  },
): number {
  const row = sql
    .exec(
      `SELECT COUNT(*) AS c FROM ${opts.table} WHERE status='pending' AND next_attempt_at <= ?`,
      opts.olderThan,
    )
    .toArray()[0] as { c: number } | undefined;
  const matched = row?.c ?? 0;
  if (!opts.dryRun && matched > 0) {
    sql.exec(
      `UPDATE ${opts.table} SET status='dead_letter', updated_at=?, failed_at=?, last_error=? WHERE status='pending' AND next_attempt_at <= ?`,
      opts.nowIso,
      opts.nowIso,
      opts.reason,
      opts.olderThan,
    );
  }
  return matched;
}

/** Mark stale pending archive_outbox rows as failed (archive uses failed, not dead_letter). */
export function failStaleArchiveOutboxRows(
  sql: SyncSql,
  opts: {
    olderThan: string;
    nowIso: string;
    reason: string;
    dryRun: boolean;
  },
): number {
  const row = sql
    .exec(
      "SELECT COUNT(*) AS c FROM archive_outbox WHERE status='pending' AND next_attempt_at <= ?",
      opts.olderThan,
    )
    .toArray()[0] as { c: number } | undefined;
  const matched = row?.c ?? 0;
  if (!opts.dryRun && matched > 0) {
    sql.exec(
      "UPDATE archive_outbox SET status='failed', updated_at=?, last_error=? WHERE status='pending' AND next_attempt_at <= ?",
      opts.nowIso,
      opts.reason,
      opts.olderThan,
    );
  }
  return matched;
}
