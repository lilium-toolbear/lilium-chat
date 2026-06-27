import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET, setupOwnedChannelForUser } from "../../test/helpers";

async function call(path: string, userId = "00000000-0000-7000-8000-000000000301"): Promise<Response> {
  const a = (await import("../index")).default;
  const token = await makeJwt({ sub: userId });
  return a.fetch(
    new Request(`https://chat.kuma.homes${path}`, { headers: { Authorization: `Bearer ${token}` } }),
    { ...env, JWT_SECRET: TEST_SECRET } as typeof env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as any,
  );
}

describe("GET /api/chat/channels/{id}/messages", () => {
  it("returns empty page + null cursor for a fresh channel", async () => {
    const uid = "00000000-0000-7000-8000-000000000301";
    const { channelId } = await setupOwnedChannelForUser(env, uid);
    const res = await call(`/api/chat/channels/${channelId}/messages`, uid);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; next_cursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("returns seeded messages via GET after internal send", async () => {
    const uid = "00000000-0000-7000-8000-000000000302";
    const { channelId, stub } = await setupOwnedChannelForUser(env, uid);
    const sendRes = await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": uid, "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: "cmd-route-msg-1",
        dedupe_principal_key: `user:${uid}`,
        type: "text",
        text: "hello route test",
        reply_to: null,
        mentions: [],
        channel_id: channelId,
      }),
    }));
    expect(sendRes.status).toBe(200);

    const res = await call(`/api/chat/channels/${channelId}/messages`, uid);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ text: string | null }>; next_cursor: string | null };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.some((m) => m.text === "hello route test")).toBe(true);
  });

  it("rejects 404 for unknown channel", async () => {
    const res = await call("/api/chat/channels/nonexistent-channel-id/messages");
    expect(res.status).toBe(404);
  });
});
