import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../../test/helpers";

async function bootstrap(token: string): Promise<Response> {
  // SELF fetch through the Worker entry so middleware (CORS, request_id, auth) runs.
  const SELF = (await import("../index")).default;
  const testEnv = { ...env, JWT_SECRET: TEST_SECRET };
  const req = new Request("https://chat.kuma.homes/api/chat/bootstrap", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return SELF.fetch(req, testEnv as typeof env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
}

describe("GET /api/chat/bootstrap", () => {
  it("rejects unauthenticated with UNAUTHORIZED 401", async () => {
    const res = await bootstrap("");
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects machine token with MACHINE_TOKEN_NOT_ALLOWED", async () => {
    const token = await makeJwt({ sub: "u1", client_id: "c1" });
    const res = await bootstrap(token);
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("MACHINE_TOKEN_NOT_ALLOWED");
  });

  it("rejects managed session with SESSION_NOT_ALLOWED 403", async () => {
    const token = await makeJwt({ sub: "u1", managed_session: true });
    const res = await bootstrap(token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("SESSION_NOT_ALLOWED");
  });

  it("returns empty bootstrap shape for a self-session (channels empty, per_channel cursors)", async () => {
    // NOTE: this hits resolveUserSummaries which will try a real Hyperdrive conn.
    // For Phase 0 unit test, we stub resolve by monkeypatching is heavy; instead
    // assert the SHAPE with a self-session and accept that `me.display_name` is
    // the fallback when the (non-existent in CI) Hyperdrive returns nothing.
    const token = await makeJwt({ sub: "00000000-0000-7000-8000-000000000101" });
    const res = await bootstrap(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toMatch(/^req_/);
    const body = (await res.json()) as any;
    expect(body.channels).toEqual([]);
    expect(body.active_channel).toBe(null);
    expect(body.messages).toEqual({ items: [], next_cursor: null });
    expect(body.event_state).toEqual({ per_channel: {} });
    expect(body.me.user_id).toBe("00000000-0000-7000-8000-000000000101");
    // fallback display_name (Hyperdrive absent in CI) must not be the raw user_id as-is
    expect(body.me.display_name).toMatch(/^user-/);
    expect(body.me.avatar_url).toBe(null);
  });
});
