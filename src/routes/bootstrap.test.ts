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
  it("returns empty channels for a new user with no memberships", async () => {
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
    expect(body.channels).toEqual([]);
    expect(body.active_channel).toBeNull();
    expect(body.event_state.per_channel).toEqual({});
    expect(body.messages.items).toEqual([]);
  });

  it("is idempotent — second bootstrap still returns empty channels", async () => {
    const uid = "00000000-0000-7000-8000-000000000102";
    const token = await makeJwt({ sub: uid });
    const r1 = await bootstrap(token);
    const b1 = await r1.json() as { channels: unknown[] };
    const r2 = await bootstrap(token);
    const b2 = await r2.json() as { channels: unknown[] };
    expect(b1.channels).toEqual([]);
    expect(b2.channels).toEqual([]);
  });

  it("rejects machine token + managed session (carry from Phase 0)", async () => {
    const machine = await makeJwt({ sub: "u1", client_id: "c1" });
    expect((await bootstrap(machine)).status).toBe(401);
    const managed = await makeJwt({ sub: "u1", owner_user_id: "other" });
    expect((await bootstrap(managed)).status).toBe(403);
  });
});
