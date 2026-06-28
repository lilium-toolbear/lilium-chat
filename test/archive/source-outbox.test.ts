import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { appendArchiveRecordSync } from "../../src/archive/source-outbox";
import { encodeArchiveId } from "../../src/archive/payload";
import { ARCHIVE_MAX_PAYLOAD_BYTES } from "../../src/archive/payload";
import { ApiError } from "../../src/errors";

function dmStub(name: string) {
  return getNamedDo(env.DM_DIRECTORY as unknown as DurableObjectNamespace, name);
}

describe("appendArchiveRecordSync", () => {
  it("increments archive_seq monotonically", async () => {
    const stub = dmStub(`archive-seq-${crypto.randomUUID()}`);
    const pairKey = "a:b";
    const { runInDurableObject } = await import("cloudflare:test");

    await runInDurableObject(stub, async (_inst, state) => {
      const s = state as DurableObjectState;
      const now = "2026-06-28T00:00:00.000Z";
      const r1 = appendArchiveRecordSync(s, {
        sourceKind: "dm_directory",
        sourceKey: pairKey,
        occurredAt: now,
        businessEventIds: [],
        buildChanges: (seq) => [
          {
            op: "upsert",
            table: "chat_dm_pairs",
            pk: { pair_key: pairKey },
            row_version: `source_seq:${seq}`,
            after: { pair_key: pairKey },
          },
        ],
      });
      const r2 = appendArchiveRecordSync(s, {
        sourceKind: "dm_directory",
        sourceKey: pairKey,
        occurredAt: now,
        businessEventIds: [],
        buildChanges: (seq) => [
          {
            op: "upsert",
            table: "chat_dm_pairs",
            pk: { pair_key: pairKey },
            row_version: `source_seq:${seq}`,
            after: { pair_key: pairKey },
          },
        ],
      });
      expect(r1.source_seq).toBe(1);
      expect(r2.source_seq).toBe(2);
      expect(r1.archive_id).toBe(encodeArchiveId("dm_directory", pairKey, 1));
    });
  });

  it("throws ARCHIVE_RECORD_TOO_LARGE before insert", async () => {
    const stub = dmStub(`archive-oversize-${crypto.randomUUID()}`);
    const { runInDurableObject } = await import("cloudflare:test");

    await runInDurableObject(stub, async (_inst, state) => {
      const s = state as DurableObjectState;
      const big = "x".repeat(ARCHIVE_MAX_PAYLOAD_BYTES);
      expect(() =>
        appendArchiveRecordSync(s, {
          sourceKind: "dm_directory",
          sourceKey: "a:b",
          occurredAt: "2026-06-28T00:00:00.000Z",
          businessEventIds: [],
          buildChanges: () => [
            {
              op: "upsert",
              table: "chat_dm_pairs",
              pk: { pair_key: "a:b" },
              row_version: "source_seq:1",
              after: { blob: big },
            },
          ],
        }),
      ).toThrow(ApiError);

      const count = s.storage.sql
        .exec("SELECT COUNT(*) AS n FROM archive_outbox")
        .toArray()[0] as { n: number };
      expect(count.n).toBe(0);
    });
  });

  it("is atomic with business rows inside transactionSync", async () => {
    const stub = dmStub(`archive-atomic-${crypto.randomUUID()}`);
    const { runInDurableObject } = await import("cloudflare:test");

    await runInDurableObject(stub, async (_inst, state) => {
      const s = state as DurableObjectState;
      const pairKey = "u1:u2";
      try {
        s.storage.transactionSync(() => {
          s.storage.sql.exec(
            `INSERT INTO dm_pairs (pair_key, user_low, user_high, channel_id, created_by, status, created_at, updated_at)
             VALUES (?, 'u1', 'u2', ?, 'u1', 'creating', ?, ?)`,
            pairKey,
            crypto.randomUUID(),
            "2026-06-28T00:00:00.000Z",
            "2026-06-28T00:00:00.000Z",
          );
          appendArchiveRecordSync(s, {
            sourceKind: "dm_directory",
            sourceKey: pairKey,
            occurredAt: "2026-06-28T00:00:00.000Z",
            businessEventIds: [],
            buildChanges: (seq) => [
              {
                op: "upsert",
                table: "chat_dm_pairs",
                pk: { pair_key: pairKey },
                row_version: `source_seq:${seq}`,
                after: { pair_key: pairKey },
              },
            ],
          });
          throw new Error("rollback");
        });
      } catch {
        // expected
      }
      const pairs = s.storage.sql.exec("SELECT COUNT(*) AS n FROM dm_pairs").toArray()[0] as { n: number };
      const archive = s.storage.sql.exec("SELECT COUNT(*) AS n FROM archive_outbox").toArray()[0] as { n: number };
      expect(pairs.n).toBe(0);
      expect(archive.n).toBe(0);
    });
  });
});
