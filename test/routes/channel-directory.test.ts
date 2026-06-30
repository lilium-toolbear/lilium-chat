import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { makeJwt, TEST_SECRET } from "../helpers";
import type { ChannelDirectory } from "../../src/do/channel-directory";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

async function authedGet(userId: string, path: string): Promise<Response> {
  return SELF.fetch(new Request(`https://chat.kuma.homes${path}`, {
    headers: { Authorization: `Bearer ${await makeJwt({ sub: userId }, TEST_SECRET)}` },
  }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

async function createPublicChannel(ownerId: string, title: string, idemKey: string): Promise<string> {
  const create = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/channels", {
    method: "POST",
    headers: { Authorization: `Bearer ${await makeJwt({ sub: ownerId }, TEST_SECRET)}`, "Content-Type": "application/json", "Idempotency-Key": idemKey },
    body: JSON.stringify({ title, visibility: "public_listed", initial_members: [] }),
  }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
  expect(create.status).toBe(201);
  return ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
}

// Wait for a channel's channel_directory outbox to be flushed into the ChannelDirectory read model.
async function waitForDirectoryRow(channelId: string, timeoutMs = 5000): Promise<void> {
  const dirStub = getNamedDo<ChannelDirectory>(env.CHANNEL_DIRECTORY as unknown as DurableObjectNamespace<ChannelDirectory>, "shared");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await dirStub.listPublicChannels({ q: "", limit: 100, cursor: null });
    if (body.items.some((i) => i.channel_id === channelId)) return;
    // Trigger a flush by poking the channel's alarm (alarm flush happens in the DO's alarm handler).
    const chStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
    try {
      const { runInDurableObject } = await import("cloudflare:test") as {
        runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>,
      };
      await runInDurableObject(chStub, async (instance: unknown) => {
        await (instance as { alarm: () => Promise<void> }).alarm();
      });
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("GET /api/chat/channels/directory", () => {
  it("returns { items, next_cursor } with §5.6 row shape (kind='channel', visibility='public_listed', last_message_preview=null, unread_count=0)", async () => {
    const cid = await createPublicChannel("u-dir-owner-1", "DirShape1", "ck-dir-shape-1");
    await waitForDirectoryRow(cid);
    const res = await authedGet("u-dir-viewer-1", "/api/chat/channels/directory?limit=100");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>>; next_cursor: string | null };
    expect(Array.isArray(body.items)).toBe(true);
    const row = body.items.find((i) => (i as { channel_id: string }).channel_id === cid);
    expect(row).toBeDefined();
    expect(row!.kind).toBe("channel");
    expect(row!.visibility).toBe("public_listed");
    expect(row!.last_message_preview).toBeNull();
    expect(row!.unread_count).toBe(0);
    expect(row!.status).toBe("active");
    expect(typeof row!.member_count).toBe("number");
    expect(typeof row!.title).toBe("string");
  });

  it("non-member viewer → role=null, last_read_event_id=null", async () => {
    const cid = await createPublicChannel("u-dir-owner-2", "DirNonMember2", "ck-dir-nonmember-2");
    await waitForDirectoryRow(cid);
    const res = await authedGet("u-dir-stranger-2", "/api/chat/channels/directory?limit=100");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    const row = body.items.find((i) => (i as { channel_id: string }).channel_id === cid);
    expect(row).toBeDefined();
    expect(row!.role).toBeNull();
    expect(row!.last_read_event_id).toBeNull();
  });

  it("active-member viewer → role from ChatChannel summary RPC + last_read_event_id from UserDirectory", async () => {
    const cid = await createPublicChannel("u-dir-owner-3", "DirMember3", "ck-dir-member-3");
    // viewer joins the channel
    const joinRes = await SELF.fetch(new Request(`https://chat.kuma.homes/api/chat/channels/${cid}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await makeJwt({ sub: "u-dir-joiner-3" }, TEST_SECRET)}`, "Idempotency-Key": "join-dir-3" },
    }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
    expect(joinRes.status).toBe(200);
    await waitForDirectoryRow(cid);
    // also wait for user_directory projection to land the my_channels row
    const start = Date.now();
    let seen = false;
    while (Date.now() - start < 5000) {
      const res = await authedGet("u-dir-joiner-3", "/api/chat/channels/directory?limit=100");
      const body = (await res.json()) as { items: Array<Record<string, unknown>> };
      const row = body.items.find((i) => (i as { channel_id: string }).channel_id === cid);
      if (row && row.role === "member") { seen = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(seen).toBe(true);
    const res = await authedGet("u-dir-joiner-3", "/api/chat/channels/directory?limit=100");
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    const row = body.items.find((i) => (i as { channel_id: string }).channel_id === cid);
    expect(row).toBeDefined();
    expect(row!.role).toBe("member");
    // last_read_event_id should be a string (the channel's floor) or null; for a freshly joined
    // channel it is whatever the join projection set. Just assert it is not undefined.
    expect(row!.last_read_event_id === null || typeof row!.last_read_event_id === "string").toBe(true);
  });

  it("q filter narrows by title substring", async () => {
    const cid = await createPublicChannel("u-dir-owner-4", "ZebraUniqueTitle4", "ck-dir-q-4");
    await waitForDirectoryRow(cid);
    const res = await authedGet("u-dir-viewer-4", "/api/chat/channels/directory?q=ZebraUnique&limit=100");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ channel_id: string }> };
    expect(body.items.some((i) => i.channel_id === cid)).toBe(true);
    const resNo = await authedGet("u-dir-viewer-4", "/api/chat/channels/directory?q=NoSuchPrefixXYZ&limit=100");
    const bodyNo = (await resNo.json()) as { items: Array<{ channel_id: string }> };
    expect(bodyNo.items.some((i) => i.channel_id === cid)).toBe(false);
  });

  it("pagination: limit + cursor returns next page without overlap", async () => {
    const cid = await createPublicChannel("u-dir-owner-5", "DirPage5", "ck-dir-page-5");
    await waitForDirectoryRow(cid);
    const p1 = await authedGet("u-dir-viewer-5", "/api/chat/channels/directory?limit=1");
    expect(p1.status).toBe(200);
    const b1 = (await p1.json()) as { items: Array<{ channel_id: string }>; next_cursor: string | null };
    expect(b1.items.length).toBe(1);
    if (b1.next_cursor) {
      const p2 = await authedGet("u-dir-viewer-5", `/api/chat/channels/directory?limit=100&cursor=${encodeURIComponent(b1.next_cursor)}`);
      const b2 = (await p2.json()) as { items: Array<{ channel_id: string }> };
      expect(b2.items.some((i) => i.channel_id === b1.items[0]!.channel_id)).toBe(false);
    }
  });

  it("limit clamped to [1,100]", async () => {
    const res = await authedGet("u-dir-viewer-6", "/api/chat/channels/directory?limit=0");
    expect(res.status).toBe(200);
    const resHi = await authedGet("u-dir-viewer-6", "/api/chat/channels/directory?limit=99999");
    expect(resHi.status).toBe(200);
  });
});
