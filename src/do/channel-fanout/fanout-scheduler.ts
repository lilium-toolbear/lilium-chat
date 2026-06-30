import { computeRetryBackoffMs } from "../shared/retry-backoff";
import { OUTBOX_MAX_ATTEMPTS } from "../../contract/outbox";
import { scheduleNextAlarm, isoDueTable, type DueTable } from "../shared/scheduler";

/** Schedules the earliest pending fanout_queue retry (ISO next_attempt_at). */
export function scheduleFanoutAlarm(ctx: DurableObjectState, _nowIso?: string): Promise<void> {
  void _nowIso;
  const dueTables: DueTable[] = [
    isoDueTable("fanout_queue", "next_attempt_at", "status", "pending", async () => Promise.resolve()),
  ];
  return scheduleNextAlarm(ctx, dueTables, { respectExistingAlarm: true });
}

export function bumpFanoutRetry(
  ctx: DurableObjectState,
  queueId: string,
  nowIso: string,
  error: string,
): void {
  const row = ctx.storage.sql
    .exec("SELECT attempts, max_attempts FROM fanout_queue WHERE queue_id=?", queueId)
    .toArray()[0] as { attempts: number | null; max_attempts: number | null } | undefined;
  const attempts = row?.attempts ?? 0;
  const maxAttempts = row?.max_attempts ?? OUTBOX_MAX_ATTEMPTS;
  const next = attempts + 1;

  if (next >= maxAttempts) {
    ctx.storage.sql.exec(
      "UPDATE fanout_queue SET status='dead_letter', attempts=?, last_error=?, failed_at=? WHERE queue_id=?",
      next,
      error,
      nowIso,
      queueId,
    );
    return;
  }

  const backoffMs = computeRetryBackoffMs(attempts);
  ctx.storage.sql.exec(
    "UPDATE fanout_queue SET status='pending', attempts=?, last_error=?, next_attempt_at=? WHERE queue_id=?",
    next,
    error,
    new Date(Date.parse(nowIso) + backoffMs).toISOString(),
    queueId,
  );
}
