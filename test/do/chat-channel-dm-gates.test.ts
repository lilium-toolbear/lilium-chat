import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createTestDmChannel } from "../helpers";

const USER_A = "00000000-0000-7000-8000-000000000701";
const USER_B = "00000000-0000-7000-8000-000000000702";

async function seedDm(): Promise<{ stub: DurableObjectStub; channelId: string }> {
  return createTestDmChannel(env, USER_A, USER_B, USER_A);
}

describe("ChatChannel DM management gates", () => {
  it("rejects update-channel on dm with UNSUPPORTED_CHANNEL_KIND", async () => {
    const { stub, channelId } = await seedDm();
    const res = await stub.fetch(new Request("https://x/internal/update-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_A, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k1", channel_id: channelId, title: "nope" }),
    }));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_CHANNEL_KIND");
  });

  it("rejects dissolve on dm", async () => {
    const { stub, channelId } = await seedDm();
    const res = await stub.fetch(new Request("https://x/internal/dissolve", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_A, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k2", channel_id: channelId }),
    }));
    expect(res.status).toBe(409);
  });

  it("rejects join on dm", async () => {
    const { stub } = await seedDm();
    const res = await stub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": "00000000-0000-7000-8000-000000000799", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "00000000-0000-7000-8000-000000000799" }),
    }));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_CHANNEL_KIND");
  });

  it("rejects members-add on dm", async () => {
    const { stub, channelId } = await seedDm();
    const res = await stub.fetch(new Request("https://x/internal/members-add", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_A, "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotency_key: "k3",
        channel_id: channelId,
        user_id: "00000000-0000-7000-8000-000000000799",
        role: "member",
      }),
    }));
    expect(res.status).toBe(409);
  });
});
