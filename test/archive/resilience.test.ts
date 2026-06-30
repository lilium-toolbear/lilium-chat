import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createOwnedTestChannel } from "../helpers";
import { RUNTIME_TABLE_BLACKLIST } from "../../src/archive/payload";
import { canonicalDmPairKey } from "../../src/chat/dm-pair";
import type { DMDirectory } from "../../src/do/dm-directory";

describe("archive resilience", () => {
  it("create-channel commits business rows and archive_outbox together", async () => {
    const userId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const { stub } = await createOwnedTestChannel(env, userId, { channelId });

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_inst, state) => {
      const s = state as DurableObjectState;
      const meta = s.storage.sql
        .exec("SELECT channel_id FROM channel_meta WHERE channel_id=?", channelId)
        .toArray();
      expect(meta.length).toBe(1);

      const archive = s.storage.sql
        .exec("SELECT COUNT(*) AS n FROM archive_outbox")
        .toArray()[0] as { n: number };
      expect(archive.n).toBeGreaterThan(0);
    });
  });

  it("runtime tables never appear in archive payloads", async () => {
    const userId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const { stub } = await createOwnedTestChannel(env, userId, { channelId });

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_inst, state) => {
      const s = state as DurableObjectState;
      const rows = s.storage.sql
        .exec("SELECT payload_json FROM archive_outbox")
        .toArray() as Array<{ payload_json: string }>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as { changes: Array<{ table: string }> };
        for (const change of payload.changes) {
          for (const banned of RUNTIME_TABLE_BLACKLIST) {
            expect(change.table).not.toBe(banned);
            expect(change.table.startsWith(banned)).toBe(false);
          }
        }
      }
    });
  });
});

describe("dm directory archive", () => {
  it("get-or-create-dm appends archive only on insert", async () => {
    const { getNamedDo } = await import("../helpers");
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const { pair_key } = canonicalDmPairKey(userA, userB);
    const stub = getNamedDo<DMDirectory>(env.DM_DIRECTORY as unknown as DurableObjectNamespace<DMDirectory>, pair_key);

    const body1 = await stub.getOrCreateDm({ user_a: userA, user_b: userB, created_by: userA });
    expect(body1.created).toBe(true);

    const { runInDurableObject } = await import("cloudflare:test");
    let countAfterCreate = 0;
    await runInDurableObject(stub, async (instance: unknown) => {
      const ctx = (instance as { ctx: DurableObjectState }).ctx;
      const row = ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM archive_outbox").toArray()[0] as { n: number };
      countAfterCreate = row.n;
    });
    expect(countAfterCreate).toBeGreaterThanOrEqual(1);

    await stub.getOrCreateDm({ user_a: userA, user_b: userB, created_by: userA });

    await runInDurableObject(stub, async (instance: unknown) => {
      const ctx = (instance as { ctx: DurableObjectState }).ctx;
      const row = ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM archive_outbox").toArray()[0] as { n: number };
      expect(row.n).toBe(countAfterCreate);
    });
  });
});
