import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, makeJwt, TEST_SECRET } from "../helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

async function authedReq(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  idemKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await makeJwt({ sub: userId }, TEST_SECRET)}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  return SELF.fetch(new Request(`https://chat.kuma.homes${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

async function listMembers(channelId: string, viewerUserId: string): Promise<Array<{ user_id: string; role: string }>> {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
  const res = await stub.fetch(new Request("https://x/internal/members-list", { headers: { "X-Verified-User-Id": viewerUserId } }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ user_id: string; role: string }> };
  return body.items;
}

async function readReplay(channelId: string, viewerUserId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
  const res = await stub.fetch(new Request("https://x/internal/replay?after=", { headers: { "X-Verified-User-Id": viewerUserId } }));
  expect(res.status).toBe(200);
  const replay = (await res.json()) as { events: Array<{ event_json: string }> };
  return replay.events.map((evt) => JSON.parse(evt.event_json) as { type: string; payload: Record<string, unknown> });
}

describe("POST /api/chat/channels/:id/owner-transfer", () => {
  it("owner transfers to an active member; previous owner becomes admin and only one active owner exists", async () => {
    const create = await authedReq("u-ot-1", "POST", "/api/chat/channels", { title: "OT", visibility: "private", initial_members: [] }, "ck-create-ot1");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const add = await authedReq("u-ot-1", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-ot-2", role: "member" }, "ck-add-ot1");
    expect(add.status).toBe(200);

    const transfer = await authedReq("u-ot-1", "POST", `/api/chat/channels/${cid}/owner-transfer`, { target_user_id: "u-ot-2", previous_owner_role: "admin" }, "ck-transfer-ot1");
    expect(transfer.status).toBe(200);
    const body = (await transfer.json()) as {
      channel_id: string;
      previous_owner: { user_id: string; role: string };
      new_owner: { user_id: string; role: string };
    };
    expect(body.previous_owner).toEqual({ user_id: "u-ot-1", role: "admin" });
    expect(body.new_owner).toEqual({ user_id: "u-ot-2", role: "owner" });

    const members = await listMembers(cid, "u-ot-2");
    expect(members.filter((m) => m.role === "owner")).toHaveLength(1);
    expect(members.some((m) => m.user_id === "u-ot-1" && m.role === "admin")).toBe(true);
    expect(members.some((m) => m.user_id === "u-ot-2" && m.role === "owner")).toBe(true);

    const events = await readReplay(cid, "u-ot-2");
    const roleUpdated = events.filter((evt) => evt.type === "member.role_updated");
    expect(roleUpdated).toHaveLength(2);
    expect(roleUpdated.some((evt) => evt.payload.user_id === "u-ot-1" && evt.payload.before_role === "owner" && evt.payload.after_role === "admin")).toBe(true);
    expect(roleUpdated.some((evt) => evt.payload.user_id === "u-ot-2" && evt.payload.before_role === "member" && evt.payload.after_role === "owner")).toBe(true);
  });

  it("non-owner cannot transfer", async () => {
    const create = await authedReq("u-ot-3", "POST", "/api/chat/channels", { title: "OT2", visibility: "private", initial_members: [] }, "ck-create-ot2");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    await authedReq("u-ot-3", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-ot-4", role: "member" }, "ck-add-ot2");
    const res = await authedReq("u-ot-4", "POST", `/api/chat/channels/${cid}/owner-transfer`, { target_user_id: "u-ot-3", previous_owner_role: "admin" }, "ck-transfer-ot2");
    expect(res.status).toBe(403);
  });

  it("idempotent retry returns the same result", async () => {
    const create = await authedReq("u-ot-5", "POST", "/api/chat/channels", { title: "OT3", visibility: "private", initial_members: [] }, "ck-create-ot3");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    await authedReq("u-ot-5", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-ot-6", role: "member" }, "ck-add-ot3");
    const payload = { target_user_id: "u-ot-6", previous_owner_role: "admin" };
    const r1 = await authedReq("u-ot-5", "POST", `/api/chat/channels/${cid}/owner-transfer`, payload, "ck-transfer-ot3");
    const r2 = await authedReq("u-ot-5", "POST", `/api/chat/channels/${cid}/owner-transfer`, payload, "ck-transfer-ot3");
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(((await r1.json()) as { new_owner: { user_id: string } }).new_owner.user_id).toBe(((await r2.json()) as { new_owner: { user_id: string } }).new_owner.user_id);
  });

  it("old owner cannot dissolve after transfer", async () => {
    const create = await authedReq("u-ot-7", "POST", "/api/chat/channels", { title: "OT4", visibility: "private", initial_members: [] }, "ck-create-ot4");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    await authedReq("u-ot-7", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-ot-8", role: "member" }, "ck-add-ot4");
    const transfer = await authedReq("u-ot-7", "POST", `/api/chat/channels/${cid}/owner-transfer`, { target_user_id: "u-ot-8", previous_owner_role: "admin" }, "ck-transfer-ot4");
    expect(transfer.status).toBe(200);
    const dissolve = await authedReq("u-ot-7", "POST", `/api/chat/channels/${cid}/dissolve`, undefined, "ck-dissolve-old-owner");
    expect(dissolve.status).toBe(403);
  });
});
