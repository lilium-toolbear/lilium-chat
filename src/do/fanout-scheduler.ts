import { computeRetryBackoffMs } from "./retry-backoff";
import { OUTBOX_MAX_ATTEMPTS } from "../contract/outbox";
// Mirrors ChatChannel's outbox scheduler (scheduleOutboxAlarm / bumpOutboxRetry) but
// targets fanout_queue rows.

export function scheduleFanoutAlarm(ctx: DurableObjectState, nowIso: string): Promise<void> {
  return (async () => {
    const row = ctx.storage.sql
      .exec("SELECT MIN(next_attempt_at) AS due FROM fanout_queue WHERE status='pending'")
      .toArray()[0] as { due: string | null } | undefined;
    const due = row?.due ?? null;
    if (due === null) {
      await ctx.storage.deleteAlarm();
      return;
    }

    const dueMs = Date.parse(due);
    if (Number.isNaN(dueMs)) {
      await ctx.storage.deleteAlarm();
      return;
    }

    const current = await ctx.storage.getAlarm();
    if (current === null || dueMs < current) {
      await ctx.storage.setAlarm(dueMs);
      return;
    }

    void nowIso;
  })();
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
