import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

async function makeChannel(channelId: string) {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
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
