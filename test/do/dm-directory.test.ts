import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { canonicalDmPairKey } from "../../src/chat/dm-pair";
import { getNamedDo } from "../helpers";

const USER_A = "00000000-0000-7000-8000-000000000201";
const USER_B = "00000000-0000-7000-8000-000000000202";

async function getOrCreateDm(userA: string, userB: string, createdBy: string) {
  const { pair_key } = canonicalDmPairKey(userA, userB);
  const stub = getNamedDo(env.DM_DIRECTORY as unknown as DurableObjectNamespace, pair_key);
  const res = await stub.fetch(new Request("https://x/internal/get-or-create-dm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_a: userA, user_b: userB, created_by: createdBy }),
  }));
  return { res, stub, pair_key };
}

describe("DMDirectory /internal/get-or-create-dm", () => {
  it("first get-or-create inserts creating row and returns channel_id", async () => {
    const { res } = await getOrCreateDm(USER_A, USER_B, USER_A);
    expect(res.status).toBe(200);
    const body = await res.json() as { channel_id: string; status: string; created: boolean };
    expect(body.channel_id).toBeTruthy();
    expect(body.status).toBe("creating");
    expect(body.created).toBe(true);
  });

  it("second call for same pair returns same channel_id", async () => {
    const r1 = await getOrCreateDm(USER_A, USER_B, USER_A);
    const b1 = await r1.res.json() as { channel_id: string };
    const r2 = await getOrCreateDm(USER_A, USER_B, USER_A);
    const b2 = await r2.res.json() as { channel_id: string; created: boolean };
    expect(b2.channel_id).toBe(b1.channel_id);
    expect(b2.created).toBe(false);
  });

  it("A→B and B→A converge to same channel_id via canonical pair_key", async () => {
    const ab = await getOrCreateDm(USER_A, USER_B, USER_A);
    const abBody = await ab.res.json() as { channel_id: string };
    const ba = await getOrCreateDm(USER_B, USER_A, USER_B);
    const baBody = await ba.res.json() as { channel_id: string };
    expect(baBody.channel_id).toBe(abBody.channel_id);
  });

  it("complete-dm marks active and repeat is no-op", async () => {
    const { res, stub, pair_key } = await getOrCreateDm(USER_A, USER_B, USER_A);
    const body = await res.json() as { channel_id: string; status: string };
    expect(body.status).toBe("creating");

    const complete1 = await stub.fetch(new Request("https://x/internal/complete-dm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pair_key, channel_id: body.channel_id }),
    }));
    expect(complete1.status).toBe(200);

    const after = await getOrCreateDm(USER_A, USER_B, USER_A);
    const afterBody = await after.res.json() as { channel_id: string; status: string };
    expect(afterBody.status).toBe("active");

    const complete2 = await stub.fetch(new Request("https://x/internal/complete-dm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pair_key, channel_id: body.channel_id }),
    }));
    expect(complete2.status).toBe(200);
  });
});
