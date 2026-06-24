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

describe("POST /api/chat/channels", () => {
  it("creates a channel and returns 201 { channel, membership }", async () => {
    const res = await authedReq("u-create-1", "POST", "/api/chat/channels", {
      title: "Route Channel", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [],
    }, "client-key-create-1");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { channel: { channel_id: string; kind: string }; membership: { role: string } };
    expect(body.channel.kind).toBe("channel");
    expect(body.membership.role).toBe("owner");
  });

  it("is idempotent: same Idempotency-Key returns the same channel_id", async () => {
    const r1 = await authedReq("u-create-2", "POST", "/api/chat/channels", { title: "Idem", visibility: "private", initial_members: [] }, "client-key-idem");
    const b1 = (await r1.json()) as { channel: { channel_id: string } };
    const r2 = await authedReq("u-create-2", "POST", "/api/chat/channels", { title: "Idem", visibility: "private", initial_members: [] }, "client-key-idem");
    const b2 = (await r2.json()) as { channel: { channel_id: string } };
    expect(b2.channel.channel_id).toBe(b1.channel.channel_id);
  });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/channels", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("returns 422 for missing title", async () => {
    const res = await authedReq("u-create-3", "POST", "/api/chat/channels", { visibility: "private" }, "client-key-notitle");
    expect(res.status).toBe(422);
  });
});

describe("PATCH /api/chat/channels/:id", () => {
  it("updates a channel the caller owns", async () => {
    const create = await authedReq("u-patch-1", "POST", "/api/chat/channels", { title: "Before", visibility: "private", initial_members: [] }, "ck-patch-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-patch-1", "PATCH", `/api/chat/channels/${cid}`, { title: "After" }, "ck-patch-1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channel: { title: string } }).channel.title).toBe("After");
  });

  it("returns 404 CHANNEL_NOT_FOUND for a random channel_id", async () => {
    const res = await authedReq("u-patch-2", "PATCH", "/api/chat/channels/0199eeee-0000-7000-8000-000000000001", { title: "X" }, "ck-patch-2");
    expect(res.status).toBe(404);
  });
});
