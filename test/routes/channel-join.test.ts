import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

async function authedReq(userId: string, method: string, path: string, body?: unknown, idemKey?: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await makeJwt({ sub: userId }, TEST_SECRET)}` };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; }
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  return SELF.fetch(new Request(`https://chat.kuma.homes${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

async function createPublicChannel(ownerId: string, title: string, idemKey: string): Promise<string> {
  const create = await authedReq(ownerId, "POST", "/api/chat/channels", {
    title, visibility: "public_listed", initial_members: [],
  }, idemKey);
  expect(create.status).toBe(201);
  return ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
}

async function createPrivateChannel(ownerId: string, title: string, idemKey: string): Promise<string> {
  const create = await authedReq(ownerId, "POST", "/api/chat/channels", {
    title, visibility: "private", initial_members: [],
  }, idemKey);
  expect(create.status).toBe(201);
  return ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
}

describe("POST /api/chat/channels/:channel_id/join", () => {
  it("public join (fresh) → 200 { channel, membership } with membership.role='member'", async () => {
    const cid = await createPublicChannel("u-join-owner-1", "PubRoute1", "ck-join-pub-1");
    const res = await authedReq("u-join-joiner-1", "POST", `/api/chat/channels/${cid}/join`, undefined, "join-key-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { channel_id: string; kind: string; visibility: string; title: string }; membership: { role: string; joined_at: string } };
    expect(body.channel.channel_id).toBe(cid);
    expect(body.channel.kind).toBe("channel");
    expect(body.channel.visibility).toBe("public_listed");
    expect(body.membership.role).toBe("member");
    expect(typeof body.membership.joined_at).toBe("string");
  });

  it("private → 403 FORBIDDEN", async () => {
    const cid = await createPrivateChannel("u-join-owner-2", "PrivRoute2", "ck-join-priv-2");
    const res = await authedReq("u-join-stranger-2", "POST", `/api/chat/channels/${cid}/join`, undefined, "join-key-2");
    expect(res.status).toBe(403);
    const e = (await res.json()) as { error: { code: string } };
    expect(e.error.code).toBe("FORBIDDEN");
  });

  it("dissolved → 409 CHANNEL_DISSOLVED", async () => {
    const cid = await createPublicChannel("u-join-owner-3", "DissolveRoute3", "ck-join-dis-3");
    await authedReq("u-join-owner-3", "POST", `/api/chat/channels/${cid}/dissolve`, undefined, "ck-dissolve-3");
    const res = await authedReq("u-join-stranger-3", "POST", `/api/chat/channels/${cid}/join`, undefined, "join-key-3");
    expect(res.status).toBe(409);
    const e = (await res.json()) as { error: { code: string } };
    expect(e.error.code).toBe("CHANNEL_DISSOLVED");
  });

  it("already-active-member → 200 with existing joined_at AND existing role (already-owner joining returns membership.role='owner')", async () => {
    const cid = await createPublicChannel("u-join-owner-4", "AlreadyRoute4", "ck-join-already-4");
    // owner joins own channel → already-active no-op
    const res = await authedReq("u-join-owner-4", "POST", `/api/chat/channels/${cid}/join`, undefined, "join-key-4");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { membership: { role: string; joined_at: string } };
    expect(body.membership.role).toBe("owner");
  });

  it("missing Idempotency-Key → 422 INVALID_MESSAGE (codebase convention)", async () => {
    const cid = await createPublicChannel("u-join-owner-5", "NoKeyRoute5", "ck-join-nokey-5");
    const headers: Record<string, string> = { Authorization: `Bearer ${await makeJwt({ sub: "u-join-stranger-5" }, TEST_SECRET)}` };
    const res = await SELF.fetch(new Request(`https://chat.kuma.homes/api/chat/channels/${cid}/join`, {
      method: "POST", headers,
    }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
    expect(res.status).toBe(422);
    const e = (await res.json()) as { error: { code: string } };
    expect(e.error.code).toBe("INVALID_MESSAGE");
  });

  it("duplicate Idempotency-Key → cached (assert cached membership.role matches the first call)", async () => {
    const cid = await createPublicChannel("u-join-owner-6", "CacheRoute6", "ck-join-cache-6");
    const r1 = await authedReq("u-join-joiner-6", "POST", `/api/chat/channels/${cid}/join`, undefined, "join-key-6");
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { membership: { role: string; joined_at: string } };
    const r2 = await authedReq("u-join-joiner-6", "POST", `/api/chat/channels/${cid}/join`, undefined, "join-key-6");
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { membership: { role: string; joined_at: string } };
    expect(b2.membership.role).toBe(b1.membership.role);
    expect(b2.membership.joined_at).toBe(b1.membership.joined_at);
  });

  it("rejoin of a left former-admin → membership.role='member' (reset)", async () => {
    const cid = await createPublicChannel("u-join-owner-7", "RejoinRoute7", "ck-join-rejoin-7");
    // add a member as admin
    await authedReq("u-join-owner-7", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-join-rejoiner-7", role: "admin" }, "ck-add-admin-7");
    // owner removes them
    await authedReq("u-join-owner-7", "DELETE", `/api/chat/channels/${cid}/members/u-join-rejoiner-7`, undefined, "ck-remove-admin-7");
    // rejoin via the public join endpoint
    const res = await authedReq("u-join-rejoiner-7", "POST", `/api/chat/channels/${cid}/join`, undefined, "join-key-rejoin-7");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { membership: { role: string } };
    expect(body.membership.role).toBe("member");
  });

  it("response shape is { channel, membership }", async () => {
    const cid = await createPublicChannel("u-join-owner-8", "ShapeRoute8", "ck-join-shape-8");
    const res = await authedReq("u-join-joiner-8", "POST", `/api/chat/channels/${cid}/join`, undefined, "join-key-8");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: unknown; membership: unknown };
    expect(body.channel).toBeDefined();
    expect(body.membership).toBeDefined();
  });
});
