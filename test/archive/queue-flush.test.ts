import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { appendArchiveRecordSync } from "../../src/archive/source-outbox";
import { flushArchiveOutboxToQueue } from "../../src/archive/queue-flush";
import type { ArchiveRecord } from "../../src/archive/payload";

function dmStub(name: string) {
  return getNamedDo(env.DM_DIRECTORY as unknown as DurableObjectNamespace, name);
}

function makeFakeQueue(opts?: { fail?: boolean }) {
  const sent: Array<{ body: ArchiveRecord; contentType: string }> = [];
  return {
    sent,
    sendBatch: vi.fn(async (batch: Array<{ body: ArchiveRecord; contentType: string }>) => {
      if (opts?.fail) throw new Error("queue unavailable");
      sent.push(...batch);
    }),
  } as unknown as Queue<ArchiveRecord> & { sent: typeof sent; sendBatch: ReturnType<typeof vi.fn> };
}

describe("flushArchiveOutboxToQueue", () => {
  it("marks rows queued on sendBatch success", async () => {
    const stub = dmStub(`archive-flush-${crypto.randomUUID()}`);
    const queue = makeFakeQueue();
    const { runInDurableObject } = await import("cloudflare:test");

    await runInDurableObject(stub, async (_inst, state) => {
      const s = state as DurableObjectState;
      const now = "2026-06-28T00:00:00.000Z";
      appendArchiveRecordSync(s, {
        sourceKind: "dm_directory",
        sourceKey: "a:b",
        occurredAt: now,
        businessEventIds: [],
        buildChanges: (seq) => [
          {
            op: "upsert",
            table: "chat_dm_pairs",
            pk: { pair_key: "a:b" },
            row_version: `source_seq:${seq}`,
            after: { pair_key: "a:b" },
          },
        ],
      });

      const result = await flushArchiveOutboxToQueue(s, queue, { now });
      expect(result.flushed).toBe(1);
      expect(queue.sendBatch).toHaveBeenCalledTimes(1);
      const batch = queue.sendBatch.mock.calls[0]![0] as Array<{ body: ArchiveRecord; contentType: string }>;
      expect(batch[0]!.contentType).toBe("json");
      expect(batch[0]!.body.source_kind).toBe("dm_directory");

      const row = s.storage.sql
        .exec("SELECT status FROM archive_outbox LIMIT 1")
        .toArray()[0] as { status: string };
      expect(row.status).toBe("queued");
    });
  });

  it("keeps rows pending with backoff on sendBatch failure", async () => {
    const stub = dmStub(`archive-flush-fail-${crypto.randomUUID()}`);
    const queue = makeFakeQueue({ fail: true });
    const { runInDurableObject } = await import("cloudflare:test");

    await runInDurableObject(stub, async (_inst, state) => {
      const s = state as DurableObjectState;
      const now = "2026-06-28T00:00:00.000Z";
      appendArchiveRecordSync(s, {
        sourceKind: "dm_directory",
        sourceKey: "c:d",
        occurredAt: now,
        businessEventIds: [],
        buildChanges: (seq) => [
          {
            op: "upsert",
            table: "chat_dm_pairs",
            pk: { pair_key: "c:d" },
            row_version: `source_seq:${seq}`,
            after: { pair_key: "c:d" },
          },
        ],
      });

      await flushArchiveOutboxToQueue(s, queue, { now });
      const row = s.storage.sql
        .exec("SELECT status, attempts, next_attempt_at FROM archive_outbox LIMIT 1")
        .toArray()[0] as { status: string; attempts: number; next_attempt_at: string };
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at).toBe(new Date(Date.parse(now) + 2000).toISOString());
    });
  });
});
