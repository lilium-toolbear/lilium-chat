import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { OUTBOX_MAX_ATTEMPTS } from "../../src/contract/outbox";
import { bumpFanoutRetry } from "../../src/do/channel-fanout/fanout-scheduler";
import { computeRetryBackoffMs } from "../../src/do/shared/retry-backoff";
import type { ChannelFanout } from "../../src/do/channel-fanout";
import { getNamedDo } from "../helpers";

describe("fanout scheduler retry", () => {
  it("computeRetryBackoffMs doubles with each attempt", () => {
    expect(computeRetryBackoffMs(0)).toBe(1000);
    expect(computeRetryBackoffMs(1)).toBe(2000);
    expect(computeRetryBackoffMs(2)).toBe(4000);
  });

  it("bumpFanoutRetry transitions to dead_letter when max attempts reached", async () => {
    const channelId = "ch-fanout-retry-dl";
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);
    const queueId = "q-dead-letter-1";
    const nowIso = "2026-06-28T00:00:00.000Z";

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(fanout, async (_instance: unknown, state: unknown) => {
      const s = state as DurableObjectState;
      s.storage.sql.exec(
        `INSERT INTO fanout_queue (
          queue_id, channel_id, event_id, target_session_id, target_user_id,
          target_lease_id, status, attempts, max_attempts, next_attempt_at, created_at
        ) VALUES (?, ?, 'e-1', 's-1', 'u-1', NULL, 'pending', ?, ?, ?, ?)`,
        queueId,
        channelId,
        OUTBOX_MAX_ATTEMPTS - 1,
        OUTBOX_MAX_ATTEMPTS,
        nowIso,
        nowIso,
      );
      bumpFanoutRetry(s, queueId, nowIso, "deliver failed");
      const row = s.storage.sql
        .exec("SELECT status, attempts, last_error, failed_at FROM fanout_queue WHERE queue_id=?", queueId)
        .toArray()[0] as { status: string; attempts: number; last_error: string; failed_at: string };
      expect(row.status).toBe("dead_letter");
      expect(row.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
      expect(row.last_error).toBe("deliver failed");
      expect(row.failed_at).toBe(nowIso);
    });
  });

  it("bumpFanoutRetry keeps pending with exponential backoff under max attempts", async () => {
    const channelId = "ch-fanout-retry-pending";
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);
    const queueId = "q-retry-pending-1";
    const nowIso = "2026-06-28T00:00:00.000Z";

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(fanout, async (_instance: unknown, state: unknown) => {
      const s = state as DurableObjectState;
      s.storage.sql.exec(
        `INSERT INTO fanout_queue (
          queue_id, channel_id, event_id, target_session_id, target_user_id,
          target_lease_id, status, attempts, max_attempts, next_attempt_at, created_at
        ) VALUES (?, ?, 'e-2', 's-2', 'u-2', NULL, 'pending', 0, ?, ?, ?)`,
        queueId,
        channelId,
        OUTBOX_MAX_ATTEMPTS,
        nowIso,
        nowIso,
      );
      bumpFanoutRetry(s, queueId, nowIso, "transient failure");
      const row = s.storage.sql
        .exec("SELECT status, attempts, last_error, next_attempt_at FROM fanout_queue WHERE queue_id=?", queueId)
        .toArray()[0] as { status: string; attempts: number; last_error: string; next_attempt_at: string };
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe("transient failure");
      expect(row.next_attempt_at).toBe(new Date(Date.parse(nowIso) + 1000).toISOString());
    });
  });
});
