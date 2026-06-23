import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../../test/helpers";

async function call(path: string, userId = "00000000-0000-7000-8000-000000000301"): Promise<Response> {
  const a = (await import("../index")).default;
  const token = await makeJwt({ sub: userId });
  return a.fetch(
    new Request(`https://chat.kuma.homes${path}`, { headers: { Authorization: `Bearer ${token}` } }),
    { ...env, JWT_SECRET: TEST_SECRET } as typeof env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as any,
  );
}

async function bootstrapFirst(userId: string): Promise<string> {
  const a = (await import("../index")).default;
  const token = await makeJwt({ sub: userId });
  const r = await a.fetch(
    new Request("https://chat.kuma.homes/api/chat/bootstrap", { headers: { Authorization: `Bearer ${token}` } }),
    { ...env, JWT_SECRET: TEST_SECRET } as typeof env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as any,
  );
  const b = await r.json() as { channels: Array<{ channel_id: string }> };
  return b.channels[0]!.channel_id;
}

describe("GET /api/chat/channels/{id}/messages", () => {
  it("returns empty page + null cursor for fresh system channel", async () => {
    const uid = "00000000-0000-7000-8000-000000000301";
    const cid = await bootstrapFirst(uid);
    const res = await call(`/api/chat/channels/${cid}/messages`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; next_cursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("rejects 404 for unknown channel", async () => {
    const res = await call("/api/chat/channels/nonexistent-channel-id/messages");
    expect(res.status).toBe(404);
  });
});
