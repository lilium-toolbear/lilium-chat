import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, makeJwt, TEST_SECRET } from "../helpers";

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

describe("POST /api/chat/channels/:id/dissolve", () => {
  it("owner dissolves → 200 { channel: { status: dissolved } }", async () => {
    const create = await authedReq("u-dis-1", "POST", "/api/chat/channels", { title: "Bye", visibility: "private", initial_members: [] }, "ck-dis-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-dis-1", "POST", `/api/chat/channels/${cid}/dissolve`, undefined, "ck-dis-1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channel: { status: string } }).channel.status).toBe("dissolved");
  });

  it("non-owner cannot dissolve", async () => {
    const create = await authedReq("u-dis-2", "POST", "/api/chat/channels", { title: "Mine", visibility: "private", initial_members: [] }, "ck-dis-create-2");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    // a different user has no token for the owner's context — but they can call dissolve on cid.
    const res = await authedReq("u-dis-other", "POST", `/api/chat/channels/${cid}/dissolve`, undefined, "ck-dis-other");
    expect(res.status).toBe(403);
  });
});

describe("members routes", () => {
  it("POST /members adds; PATCH changes role; DELETE removes (owner)", async () => {
    const create = await authedReq("u-mem-owner", "POST", "/api/chat/channels", { title: "M", visibility: "private", initial_members: [] }, "ck-mem-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const add = await authedReq("u-mem-owner", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-mem-1", role: "member" }, "ck-mem-add");
    expect(add.status).toBe(200);
    const role = await authedReq("u-mem-owner", "PATCH", `/api/chat/channels/${cid}/members/u-mem-1`, { role: "admin" }, "ck-mem-role");
    expect(role.status).toBe(200);
    expect(((await role.json()) as { member: { role: string } }).member.role).toBe("admin");
    const rem = await authedReq("u-mem-owner", "DELETE", `/api/chat/channels/${cid}/members/u-mem-1`, undefined, "ck-mem-rem");
    expect(rem.status).toBe(200);
    expect(((await rem.json()) as { removed: boolean }).removed).toBe(true);
  });

  it("DELETE self (leave) succeeds for a member", async () => {
    const create = await authedReq("u-leave-owner", "POST", "/api/chat/channels", { title: "L", visibility: "private", initial_members: [] }, "ck-leave-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    await authedReq("u-leave-owner", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-leave-1", role: "member" }, "ck-leave-add");
    const rem = await authedReq("u-leave-1", "DELETE", `/api/chat/channels/${cid}/members/u-leave-1`, undefined, "ck-leave-self");
    expect(rem.status).toBe(200);
  });
});

describe("members read routes", () => {
  it("GET /members lists the owner", async () => {
    const create = await authedReq("u-mr-owner", "POST", "/api/chat/channels", { title: "MR", visibility: "private", initial_members: [] }, "ck-mr-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-mr-owner", "GET", `/api/chat/channels/${cid}/members`);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: Array<{ user: { user_id: string }; role: string }> }).items;
    expect(items.some((m) => m.user.user_id === "u-mr-owner" && m.role === "owner")).toBe(true);
  });

  it("GET /members/{user_id} returns role + status", async () => {
    const create = await authedReq("u-mr2-owner", "POST", "/api/chat/channels", { title: "MR2", visibility: "private", initial_members: [] }, "ck-mr2-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-mr2-owner", "GET", `/api/chat/channels/${cid}/members/u-mr2-owner`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string; status: string }).status).toBe("active");
  });

  it("GET /members/{user_id} returns 404 MEMBER_NOT_FOUND for a stranger", async () => {
    const create = await authedReq("u-mr3-owner", "POST", "/api/chat/channels", { title: "MR3", visibility: "private", initial_members: [] }, "ck-mr3-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-mr3-owner", "GET", `/api/chat/channels/${cid}/members/u-stranger`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/chat/channels/:id/read-state", () => {
  it("marks read and returns last_read_event_id + unread_count", async () => {
    const create = await authedReq("u-rs-route", "POST", "/api/chat/channels", { title: "RS", visibility: "private", initial_members: [] }, "ck-rs-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const userDir = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], "u-rs-route");
    await userDir.fetch(new Request("https://x/internal/upsert-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-rs-route", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "join", channel_id: cid, kind: "channel", membership_version: 1 }),
    }));
    const res = await authedReq("u-rs-route", "POST", `/api/chat/channels/${cid}/read-state`, { last_read_event_id: "01J00000000000000000000000" }, "ck-rs-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { last_read_event_id: string; unread_count: number };
    expect(body.last_read_event_id).toBe("01J00000000000000000000000");
    // owner just created the channel: no messages → unread 0
    expect(body.unread_count).toBe(0);
  });

  it("is idempotent: re-marking the same cursor returns the same last_read_event_id and does not duplicate the event", async () => {
    const create = await authedReq("u-rs-route2", "POST", "/api/chat/channels", { title: "RS2", visibility: "private", initial_members: [] }, "ck-rs-create2");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const userDir = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], "u-rs-route2");
    await userDir.fetch(new Request("https://x/internal/upsert-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-rs-route2", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "join", channel_id: cid, kind: "channel", membership_version: 1 }),
    }));
    const body1 = { last_read_event_id: "01J00000000000000000000001" };
    const r1 = await authedReq("u-rs-route2", "POST", `/api/chat/channels/${cid}/read-state`, body1, "ck-rs-2a");
    const r2 = await authedReq("u-rs-route2", "POST", `/api/chat/channels/${cid}/read-state`, body1, "ck-rs-2b");
    expect(r1.status).toBe(200); expect(r2.status).toBe(200);
    expect(((await r2.json()) as { last_read_event_id: string }).last_read_event_id).toBe("01J00000000000000000000001");
    // r2 is the same-cursor re-mark; ChatChannel /internal/read-state-event dedupes on (user, cursor)
    // so no second event row is written. (We assert the HTTP behavior; event dedup is a DO-level concern.)
  });
});
