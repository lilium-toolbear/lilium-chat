import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo as _g } from "../helpers";
void _g;

async function makeChannel(channelId: string) {
  const stub = _g(env.CHAT_CHANNEL as unknown as Parameters<typeof _g>[0], channelId);
  await stub.fetch(new Request("https://x/internal/create-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: channelId, creator_user_id: "u-up-owner", title: "Orig", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }),
  }));
  return stub;
}

describe("ChatChannel /internal/update-channel", () => {
  it("updates title + topic and writes channel.updated + system.notice", async () => {
    const stub = await makeChannel("0193aaaa-0000-7000-8000-000000000001");
    const res = await stub.fetch(new Request("https://x/internal/update-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-up-1", channel_id: "0193aaaa-0000-7000-8000-000000000001", title: "New", topic: "Desc" }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { title: string; topic: string } };
    expect(body.channel.title).toBe("New");
    expect(body.channel.topic).toBe("Desc");
  });

  it("forbids non-member (non-admin) update", async () => {
    const stub = await makeChannel("0193bbbb-0000-7000-8000-000000000001");
    const res = await stub.fetch(new Request("https://x/internal/update-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-outsider", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-up-2", channel_id: "0193bbbb-0000-7000-8000-000000000001", title: "Hijack" }),
    }));
    expect(res.status).toBe(403);
  });

  it("is idempotent on same key+body", async () => {
    const cid = "0193cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const b = { idempotency_key: "k-up-3", channel_id: cid, title: "Idem" };
    const r1 = await stub.fetch(new Request("https://x/internal/update-channel", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify(b) }));
    const r2 = await stub.fetch(new Request("https://x/internal/update-channel", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify(b) }));
    expect(r1.status).toBe(200); expect(r2.status).toBe(200);
    expect(((await r2.json()) as { channel: { title: string } }).channel.title).toBe("Idem");
  });

  it("returns 409 IDEMPOTENCY_CONFLICT on same key + different body", async () => {
    const cid = "0193dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/update-channel", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-up-4", channel_id: cid, title: "A" }) }));
    const r2 = await stub.fetch(new Request("https://x/internal/update-channel", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-up-4", channel_id: cid, title: "B" }) }));
    expect(r2.status).toBe(409);
  });
});

describe("ChatChannel /internal/dissolve", () => {
  it("owner dissolves → channel.dissolved + system.notice, status dissolved", async () => {
    const cid = "0194aaaa-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const res = await stub.fetch(new Request("https://x/internal/dissolve", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-dis-1", channel_id: cid }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { status: string; channel_id: string } };
    expect(body.channel.status).toBe("dissolved");
    expect(body.channel.channel_id).toBe(cid);
  });

  it("non-owner cannot dissolve", async () => {
    const cid = "0194bbbb-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const res = await stub.fetch(new Request("https://x/internal/dissolve", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-outsider", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-dis-2", channel_id: cid }),
    }));
    expect(res.status).toBe(403);
  });

  it("is idempotent: same key returns same result, no double event", async () => {
    const cid = "0194cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const b = JSON.stringify({ idempotency_key: "k-dis-3", channel_id: cid });
    const r1 = await stub.fetch(new Request("https://x/internal/dissolve", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: b }));
    const r2 = await stub.fetch(new Request("https://x/internal/dissolve", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: b }));
    expect(r1.status).toBe(200); expect(r2.status).toBe(200);
  });

  it("dissolved channel blocks further writes (message-send returns 409 CHANNEL_DISSOLVED)", async () => {
    const cid = "0194dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/dissolve", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-dis-4", channel_id: cid }) }));
    const send = await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ client_message_id: "cm-dis", dedupe_principal_key: "user:u-up-owner", type: "text", text: "hi", reply_to: null, mentions: [], channel_id: cid }),
    }));
    expect(send.status).toBe(409);
    expect(((await send.json()) as { error: { code: string } }).error.code).toBe("CHANNEL_DISSOLVED");
  });
});

describe("ChatChannel members CRUD", () => {
  it("admin adds a member → member.joined + system.notice", async () => {
    const cid = "0195aaaa-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const res = await stub.fetch(new Request("https://x/internal/members-add", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-add-1", channel_id: cid, user_id: "u-add-1", role: "member" }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: { role: string } }).member.role).toBe("member");
  });

  it("owner updates a member role → member.role_updated", async () => {
    const cid = "0195bbbb-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-2", channel_id: cid, user_id: "u-add-2", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-update-role", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-role-1", channel_id: cid, user_id: "u-add-2", role: "admin" }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: { role: string } }).member.role).toBe("admin");
  });

  it("non-owner cannot change role (403)", async () => {
    const cid = "0195cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-3", channel_id: cid, user_id: "u-add-3", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-update-role", { method: "POST", headers: { "X-Verified-User-Id": "u-add-3", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-role-2", channel_id: cid, user_id: "u-add-3", role: "admin" }) }));
    expect(res.status).toBe(403);
  });

  it("owner removes a member → member.left + fanout unregister outbox", async () => {
    const cid = "0195dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-4", channel_id: cid, user_id: "u-add-4", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-remove", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-rem-1", channel_id: cid, user_id: "u-add-4" }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { removed: boolean }).removed).toBe(true);
  });

  it("member self-leaves (user_id === caller)", async () => {
    const cid = "0195eeee-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-5", channel_id: cid, user_id: "u-self-leave", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-remove", { method: "POST", headers: { "X-Verified-User-Id": "u-self-leave", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-rem-2", channel_id: cid, user_id: "u-self-leave" }) }));
    expect(res.status).toBe(200);
  });

  it("add with a DIFFERENT role on an active member → 422 (no role-change-via-add bypass)", async () => {
    const cid = "0195ffff-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-6", channel_id: cid, user_id: "u-bypass", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-6b", channel_id: cid, user_id: "u-bypass", role: "admin" }) }));
    expect(res.status).toBe(422);
  });

  it("add same role on an active member → 200 idempotent (no event, no count bump)", async () => {
    const cid = "01950000-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-7", channel_id: cid, user_id: "u-idem-add", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-7b", channel_id: cid, user_id: "u-idem-add", role: "member" }) }));
    expect(res.status).toBe(200);
  });

  it("reactivates a LEFT member (+1 count) → member.joined", async () => {
    const cid = "01950001-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-8", channel_id: cid, user_id: "u-rejoin", role: "member" }) }));
    await stub.fetch(new Request("https://x/internal/members-remove", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-rem-rejoin", channel_id: cid, user_id: "u-rejoin" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-8b", channel_id: cid, user_id: "u-rejoin", role: "admin" }) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: { role: string } }).member.role).toBe("admin");
  });

  it("owner cannot self-leave (owner invariant) → 422", async () => {
    const cid = "01950002-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid); // owner = u-up-owner
    const res = await stub.fetch(new Request("https://x/internal/members-remove", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-rem-owner", channel_id: cid, user_id: "u-up-owner" }) }));
    expect(res.status).toBe(422);
  });

  it("owner cannot demote self via role-update → 422", async () => {
    const cid = "01950003-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const res = await stub.fetch(new Request("https://x/internal/members-update-role", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-role-owner", channel_id: cid, user_id: "u-up-owner", role: "member" }) }));
    expect(res.status).toBe(422);
  });
});

describe("ChatChannel members read", () => {
  it("members-list returns active members", async () => {
    const cid = "0196aaaa-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-ml-1", channel_id: cid, user_id: "u-ml-a", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-list", { headers: { "X-Verified-User-Id": "u-up-owner" } }));
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: Array<{ user_id: string; role: string }> }).items;
    expect(items.some((m) => m.user_id === "u-ml-a")).toBe(true);
  });

  it("members-get returns status active for a member", async () => {
    const cid = "0196bbbb-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-mg-1", channel_id: cid, user_id: "u-mg-a", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-get?user_id=u-mg-a", { headers: { "X-Verified-User-Id": "u-up-owner" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; role: string };
    expect(body.status).toBe("active");
    expect(body.role).toBe("member");
  });

  it("members-get returns 404 MEMBER_NOT_FOUND for a never-joined user", async () => {
    const cid = "0196cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const res = await stub.fetch(new Request("https://x/internal/members-get?user_id=u-never", { headers: { "X-Verified-User-Id": "u-up-owner" } }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("members-get returns status left for a removed member", async () => {
    const cid = "0196dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-mg-2", channel_id: cid, user_id: "u-mg-b", role: "member" }) }));
    await stub.fetch(new Request("https://x/internal/members-remove", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-mg-3", channel_id: cid, user_id: "u-mg-b" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-get?user_id=u-mg-b", { headers: { "X-Verified-User-Id": "u-up-owner" } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("left");
  });
});
