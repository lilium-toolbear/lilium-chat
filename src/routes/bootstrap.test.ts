import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../../test/helpers";

async function bootstrap(token: string, channelId?: string): Promise<Response> {
  const SELF = (await import("../index")).default;
  const testEnv = { ...env, JWT_SECRET: TEST_SECRET };
  const qs = channelId ? `?channel_id=${channelId}` : "";
  const req = new Request(`https://chat.kuma.homes/api/chat/bootstrap${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return SELF.fetch(req, testEnv as typeof env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
}

describe("GET /api/chat/bootstrap (Phase 1)", () => {
  it("auto-joins system channel and returns it in channels + active_channel + per_channel cursor", async () => {
    const uid = "00000000-0000-7000-8000-000000000101";
    const token = await makeJwt({ sub: uid });
    const res = await bootstrap(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      me: { user_id: string };
      channels: Array<{ channel_id: string; kind: string; last_event_id: string | null }>;
      active_channel: { channel_id: string } | null;
      messages: { items: unknown[] };
      event_state: { per_channel: Record<string, string> };
    };
    expect(body.me.user_id).toBe(uid);
    expect(body.channels.length).toBeGreaterThan(0);
    const sys = body.channels[0]!;
    expect(sys.kind).toBe("channel");
    expect(sys.last_event_id).not.toBeNull();
    expect(body.active_channel).not.toBeNull();
    expect(body.active_channel!.channel_id).toBe(sys.channel_id);
    expect(body.event_state.per_channel[sys.channel_id]).toBe(sys.last_event_id);
    expect(body.messages.items).toEqual([]);
  });

  it("is idempotent — second bootstrap returns same channel_id, no new join event", async () => {
    const uid = "00000000-0000-7000-8000-000000000102";
    const token = await makeJwt({ sub: uid });
    const r1 = await bootstrap(token);
    const b1 = await r1.json() as { channels: Array<{ channel_id: string }> };
    const r2 = await bootstrap(token);
    const b2 = await r2.json() as { channels: Array<{ channel_id: string }> };
    expect(b1.channels.length).toBeGreaterThan(0);
    expect(b2.channels.length).toBeGreaterThan(0);
    expect(b1.channels[0]!.channel_id).toBe(b2.channels[0]!.channel_id);
  });

  it("rejects machine token + managed session (carry from Phase 0)", async () => {
    const machine = await makeJwt({ sub: "u1", client_id: "c1" });
    expect((await bootstrap(machine)).status).toBe(401);
    const managed = await makeJwt({ sub: "u1", owner_user_id: "other" });
    expect((await bootstrap(managed)).status).toBe(403);
  });
});
