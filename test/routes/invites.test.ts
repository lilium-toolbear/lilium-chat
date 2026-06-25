import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

async function authedReq(userId: string, method: string, path: string, body?: unknown, idemKey?: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await makeJwt({ sub: userId }, TEST_SECRET)}` };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (idemKey) {
    headers["Idempotency-Key"] = idemKey;
  }
  return SELF.fetch(new Request(`https://chat.kuma.homes${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

describe("POST /api/chat/channels/:id/invites", () => {
  it("creates invite with contract fields and invite_url", async () => {
    const create = await authedReq("u-invite-create-1", "POST", "/api/chat/channels", {
      title: "Invite room",
      visibility: "private",
      initial_members: [],
    }, "invite-create-channel-1");
    expect(create.status).toBe(201);
    const createBody = (await create.json()) as { channel: { channel_id: string } };

    const res = await authedReq("u-invite-create-1", "POST", `/api/chat/channels/${createBody.channel.channel_id}/invites`, {
      expires_in_seconds: 3600,
      max_uses: null,
    }, "invite-create-key-1");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { invite_code: string; invite_url: string; expires_at: string; max_uses: number | null };
    expect(body.invite_code).toBeTypeOf("string");
    expect(body.invite_code.length).toBeGreaterThan(0);
    expect(body.invite_url).toBe(`https://chat.kuma.homes/api/chat/invites/${body.invite_code}`);
    expect(body.max_uses).toBeNull();
    expect(typeof body.expires_at).toBe("string");
    const expiresAt = Date.parse(body.expires_at);
    const now = Date.now();
    expect(expiresAt).toBeGreaterThan(now);
    expect(expiresAt).toBeLessThan(now + 2 * 3600 * 1000);
  });

  it("is idempotent for the same Idempotency-Key", async () => {
    const create = await authedReq("u-invite-create-2", "POST", "/api/chat/channels", {
      title: "Invite room",
      visibility: "private",
      initial_members: [],
    }, "invite-create-channel-2");
    const createBody = (await create.json()) as { channel: { channel_id: string } };

    const req = {
      expires_in_seconds: 3600,
      max_uses: null,
    };

    const r1 = await authedReq("u-invite-create-2", "POST", `/api/chat/channels/${createBody.channel.channel_id}/invites`, req, "invite-create-key-idem");
    const b1 = (await r1.json()) as { invite_code: string; invite_url: string; expires_at: string; max_uses: number | null };

    const r2 = await authedReq("u-invite-create-2", "POST", `/api/chat/channels/${createBody.channel.channel_id}/invites`, req, "invite-create-key-idem");
    const b2 = (await r2.json()) as { invite_code: string; invite_url: string; expires_at: string; max_uses: number | null };

    expect(r2.status).toBe(200);
    expect(b2.invite_code).toBe(b1.invite_code);
    expect(b2.expires_at).toBe(b1.expires_at);
    expect(b2.max_uses).toBeNull();
  });
});
