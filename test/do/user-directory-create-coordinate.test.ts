import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

const CREATOR = "u-coord-creator";

async function coordinate(overrides: Record<string, unknown> = {}) {
  const stub = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], CREATOR);
  const body = {
    idempotency_key: "key-1",
    title: "Coord Channel",
    topic: null,
    avatar_attachment_id: null,
    visibility: "private",
    initial_members: [{ user_id: "u-coord-init", role: "member" }],
    ...overrides,
  };
  const res = await stub.fetch(new Request("https://x/internal/channel-create-coordinate", {
    method: "POST",
    headers: { "X-Verified-User-Id": CREATOR, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { res, stub, body };
}

describe("UserDirectory /internal/channel-create-coordinate", () => {
  it("first call creates the channel and returns channel + owner membership", async () => {
    const { res } = await coordinate();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { channel_id: string; kind: string }; membership: { role: string } };
    expect(body.channel.kind).toBe("channel");
    expect(body.membership.role).toBe("owner");
    expect(body.channel.channel_id).toBeTruthy();
  });

  it("same key + same body returns the SAME channel_id (cached)", async () => {
    const r1 = await coordinate({ idempotency_key: "key-dup" });
    const b1 = (await r1.res.json()) as { channel: { channel_id: string } };
    const r2 = await coordinate({ idempotency_key: "key-dup" });
    const b2 = (await r2.res.json()) as { channel: { channel_id: string } };
    expect(b2.channel.channel_id).toBe(b1.channel.channel_id);
  });

  it("same key + different body returns 409 IDEMPOTENCY_CONFLICT", async () => {
    await coordinate({ idempotency_key: "key-conflict", title: "First" });
    const r2 = await coordinate({ idempotency_key: "key-conflict", title: "Different" });
    expect(r2.res.status).toBe(409);
    const body2 = await r2.res.json() as { error: { code: string } };
    expect(body2.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
