import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { canonicalDmPairKey } from "../../src/chat/dm-pair";
import { getNamedDo } from "../helpers";
import type { DMDirectory } from "../../src/do/dm-directory";

const USER_A = "00000000-0000-7000-8000-000000000201";
const USER_B = "00000000-0000-7000-8000-000000000202";

async function getOrCreateDm(userA: string, userB: string, createdBy: string) {
  const { pair_key } = canonicalDmPairKey(userA, userB);
  const stub = getNamedDo<DMDirectory>(env.DM_DIRECTORY as unknown as DurableObjectNamespace<DMDirectory>, pair_key);
  const body = await stub.getOrCreateDm({ user_a: userA, user_b: userB, created_by: createdBy });
  return { body, stub, pair_key };
}

describe("DMDirectory RPC", () => {
  it("first get-or-create inserts creating row and returns channel_id", async () => {
    const { body } = await getOrCreateDm(USER_A, USER_B, USER_A);
    expect(body.channel_id).toBeTruthy();
    expect(body.status).toBe("creating");
    expect(body.created).toBe(true);
  });

  it("second call for same pair returns same channel_id", async () => {
    const r1 = await getOrCreateDm(USER_A, USER_B, USER_A);
    const r2 = await getOrCreateDm(USER_A, USER_B, USER_A);
    expect(r2.body.channel_id).toBe(r1.body.channel_id);
    expect(r2.body.created).toBe(false);
  });

  it("A→B and B→A converge to same channel_id via canonical pair_key", async () => {
    const ab = await getOrCreateDm(USER_A, USER_B, USER_A);
    const ba = await getOrCreateDm(USER_B, USER_A, USER_B);
    expect(ba.body.channel_id).toBe(ab.body.channel_id);
  });

  it("complete-dm marks active and repeat is no-op", async () => {
    const { body, stub, pair_key } = await getOrCreateDm(USER_A, USER_B, USER_A);
    expect(body.status).toBe("creating");

    await expect(stub.completeDm({ pair_key, channel_id: body.channel_id })).resolves.toBeUndefined();

    const after = await getOrCreateDm(USER_A, USER_B, USER_A);
    expect(after.body.status).toBe("active");

    await expect(stub.completeDm({ pair_key, channel_id: body.channel_id })).resolves.toBeUndefined();
  });
});
