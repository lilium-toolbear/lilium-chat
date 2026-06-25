import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { setTestS3Client, type S3Client } from "../../src/s3/presign";

function udStub(userId: string) {
  return getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], userId);
}

function chatStub(channelId: string) {
  return getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
}

class FakeS3 implements S3Client {
  objects = new Map<string, { contentType: string; contentLength: number }>();

  async sign(input: string | URL, init?: RequestInit & { aws?: any }): Promise<Request> {
    const url = new URL(input instanceof URL ? input.toString() : input);
    url.searchParams.set("X-Amz-Fake", "signed");
    return new Request(url, init);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const u = new URL(input instanceof Request ? input.url : input.toString());
    const method = input instanceof Request ? input.method : (init?.method ?? "GET");
    if (method === "HEAD") {
      const obj = this.objects.get(u.pathname);
      if (!obj) return new Response("Not Found", { status: 404 });
      return new Response(new ArrayBuffer(0), {
        status: 200,
        headers: { "Content-Type": obj.contentType, "Content-Length": String(obj.contentLength) },
      });
    }
    return new Response("ok", { status: 200 });
  }
}

async function insertSticker(stub: ReturnType<typeof udStub>, values: {
  sticker_id: string;
  user_id: string;
  attachment_id: string;
  url: string;
  mime_type: string;
  width?: number;
  height?: number;
  size_bytes: number;
  created_at: string;
  deleted_at?: string;
}) {
  const { runInDurableObject } = await import("cloudflare:test") as {
    runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
  };
  await runInDurableObject(stub, async (instance: unknown) => {
    const sql = (instance as { ctx: { storage: { sql: { exec: (query: string, ...params: unknown[]) => void } } } }).ctx.storage.sql;
    sql.exec(
      `INSERT INTO personal_stickers (
        sticker_id, user_id, attachment_id, url, mime_type, width, height, size_bytes, created_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values.sticker_id,
      values.user_id,
      values.attachment_id,
      values.url,
      values.mime_type,
      values.width ?? null,
      values.height ?? null,
      values.size_bytes,
      values.created_at,
      values.deleted_at ?? null,
    );
  });
}

async function createChannel(channelId: string, ownerId: string) {
  const stub = chatStub(channelId);
  const res = await stub.fetch(
    new Request("https://x/internal/create-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: channelId,
        creator_user_id: ownerId,
        title: "Sticker source",
        topic: null,
        avatar_attachment_id: null,
        visibility: "private",
        initial_members: [],
      }),
    }),
  );
  expect(res.status).toBe(200);
}

async function addMember(channelId: string, ownerId: string, memberId: string) {
  const res = await chatStub(channelId).fetch(
    new Request("https://x/internal/members-add", {
      method: "POST",
      headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: `idem-add-${channelId}-${memberId}`, channel_id: channelId, user_id: memberId, role: "member" }),
    }),
  );
  expect(res.status).toBe(200);
}

async function presignAndFinalize(userId: string, fake: FakeS3): Promise<{ attachment_id: string; upload_url: string }> {
  const key = `idem-sticker-${userId}`;
  const presignRes = await udStub(userId).fetch(
    new Request("https://x/internal/attachment-presign", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Idempotency-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "img.png",
        mime_type: "image/png",
        size_bytes: 12345,
        width: 128,
        height: 128,
        blurhash: "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
      }),
    }),
  );
  expect(presignRes.status).toBe(200);
  const presignBody = (await presignRes.json()) as { attachment_id: string; upload_url: string };
  fake.objects.set(new URL(presignBody.upload_url).pathname, { contentType: "image/png", contentLength: 12345 });

  const finalizeRes = await udStub(userId).fetch(
    new Request("https://x/internal/attachment-finalize", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Idempotency-Key": `${key}-fin`, "Content-Type": "application/json" },
      body: JSON.stringify({ attachment_id: presignBody.attachment_id }),
    }),
  );
  expect(finalizeRes.status).toBe(200);
  return presignBody;
}

async function sendImageMessage(channelId: string, senderId: string, attachmentId: string) {
  const res = await chatStub(channelId).fetch(
    new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": senderId, "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: `cmd-sticker-${senderId}`,
        dedupe_principal_key: `user:${senderId}`,
        type: "image",
        text: "",
        reply_to: null,
        attachment_ids: [attachmentId],
        mentions: [],
        channel_id: channelId,
      }),
    }),
  );
  expect(res.status).toBe(200);
}

async function saveSticker(userId: string, channelId: string, attachmentId: string, operationId: string) {
  return udStub(userId).fetch(
    new Request("https://x/internal/sticker-save", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ operation_id: operationId, channel_id: channelId, attachment_id: attachmentId }),
    }),
  );
}

describe("UserDirectory personal_stickers + /internal/sticker-resolve", () => {
  it("resolves an owned active sticker", async () => {
    const userId = "u-sticker-resolve-1";
    const stub = udStub(userId);
    await insertSticker(stub, {
      sticker_id: "s1",
      user_id: userId,
      attachment_id: "a1",
      url: "https://s3.kuma.homes/chat/a1",
      mime_type: "image/png",
      width: 128,
      height: 128,
      size_bytes: 4096,
      created_at: "2026-01-01T00:00:00.000Z",
    });

    const res = await stub.fetch(
      new Request("https://x/internal/sticker-resolve?sticker_id=s1", { headers: { "X-Verified-User-Id": userId } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sticker_id: string; attachment_id: string; url: string; width: number; height: number };
    expect(body.sticker_id).toBe("s1");
    expect(body.attachment_id).toBe("a1");
    expect(body.width).toBe(128);
    expect(body.height).toBe(128);
  });

  it("returns 404 for a deleted sticker", async () => {
    const userId = "u-sticker-resolve-2";
    const stub = udStub(userId);
    await insertSticker(stub, {
      sticker_id: "s2",
      user_id: userId,
      attachment_id: "a2",
      url: "https://s3.kuma.homes/chat/a2",
      mime_type: "image/png",
      size_bytes: 4096,
      created_at: "2026-01-01T00:00:00.000Z",
      deleted_at: "2026-01-02T00:00:00.000Z",
    });

    const res = await stub.fetch(
      new Request("https://x/internal/sticker-resolve?sticker_id=s2", { headers: { "X-Verified-User-Id": userId } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("STICKER_NOT_FOUND");
  });

  it("returns 404 for another user's sticker", async () => {
    const ownerId = "u-sticker-resolve-3-owner";
    const otherId = "u-sticker-resolve-3-other";
    const stub = udStub(ownerId);
    await insertSticker(stub, {
      sticker_id: "s3",
      user_id: ownerId,
      attachment_id: "a3",
      url: "https://s3.kuma.homes/chat/a3",
      mime_type: "image/png",
      size_bytes: 4096,
      created_at: "2026-01-01T00:00:00.000Z",
    });

    const res = await stub.fetch(
      new Request("https://x/internal/sticker-resolve?sticker_id=s3", { headers: { "X-Verified-User-Id": otherId } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("STICKER_NOT_FOUND");
  });
});

describe("UserDirectory /internal/sticker-save + /internal/sticker-list + /internal/sticker-delete", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("saves an owned finalized attachment and lists it", async () => {
    const userId = "u-sticker-save-own";
    const channelId = "ch-sticker-save-own";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);

    const saveRes = await saveSticker(userId, channelId, attachment_id, `op-${userId}-save`);
    expect(saveRes.status).toBe(200);
    const saveBody = (await saveRes.json()) as { sticker: { sticker_id: string; attachment_id: string } };
    expect(saveBody.sticker.attachment_id).toBe(attachment_id);

    const listRes = await udStub(userId).fetch(
      new Request("https://x/internal/sticker-list?limit=10", { headers: { "X-Verified-User-Id": userId } }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { items: Array<{ sticker_id: string }>; next_cursor: string | null };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]!.sticker_id).toBe(saveBody.sticker.sticker_id);

    const delRes = await udStub(userId).fetch(
      new Request("https://x/internal/sticker-delete", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ sticker_id: saveBody.sticker.sticker_id }),
      }),
    );
    expect(delRes.status).toBe(200);

    const listAfterRes = await udStub(userId).fetch(
      new Request("https://x/internal/sticker-list?limit=10", { headers: { "X-Verified-User-Id": userId } }),
    );
    const listAfterBody = (await listAfterRes.json()) as { items: Array<unknown> };
    expect(listAfterBody.items).toHaveLength(0);
  });

  it("is idempotent: retry returns the same sticker_id", async () => {
    const userId = "u-sticker-idem";
    const channelId = "ch-sticker-idem";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const op = `op-${userId}-idem`;

    const r1 = await saveSticker(userId, channelId, attachment_id, op);
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { sticker: { sticker_id: string } };

    const r2 = await saveSticker(userId, channelId, attachment_id, op);
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { sticker: { sticker_id: string } };
    expect(b2.sticker.sticker_id).toBe(b1.sticker.sticker_id);
  });

  it("saves a channel-visible attachment from another user's image message", async () => {
    const channelId = "ch-sticker-visible";
    const ownerId = "u-sticker-visible-owner";
    const memberId = "u-sticker-visible-member";
    await createChannel(channelId, ownerId);
    await addMember(channelId, ownerId, memberId);
    const { attachment_id } = await presignAndFinalize(ownerId, fake);
    await sendImageMessage(channelId, ownerId, attachment_id);

    const saveRes = await saveSticker(memberId, channelId, attachment_id, `op-${memberId}-visible`);
    expect(saveRes.status).toBe(200);
    const saveBody = (await saveRes.json()) as { sticker: { attachment_id: string } };
    expect(saveBody.sticker.attachment_id).toBe(attachment_id);
  });

  it("rejects saving a recalled source message attachment via channel-visible path", async () => {
    const channelId = "ch-sticker-recalled";
    const ownerId = "u-sticker-recalled-owner";
    const memberId = "u-sticker-recalled-member";
    await createChannel(channelId, ownerId);
    await addMember(channelId, ownerId, memberId);
    const { attachment_id } = await presignAndFinalize(ownerId, fake);
    await sendImageMessage(channelId, ownerId, attachment_id);

    const historyRes = await chatStub(channelId).fetch(
      new Request("https://x/internal/messages?limit=10", { headers: { "X-Verified-User-Id": ownerId } }),
    );
    expect(historyRes.status).toBe(200);
    const historyBody = (await historyRes.json()) as { items: Array<{ message_id: string }> };
    const messageId = historyBody.items[0]!.message_id;

    const recallRes = await chatStub(channelId).fetch(
      new Request("https://x/internal/message-recall", {
        method: "POST",
        headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
        body: JSON.stringify({ operation_id: "op-recall", message_id: messageId, channel_id: channelId }),
      }),
    );
    expect(recallRes.status).toBe(200);

    const saveRes = await saveSticker(memberId, channelId, attachment_id, `op-${memberId}-recalled`);
    expect(saveRes.status).toBe(422);
    const saveBody = (await saveRes.json()) as { error: { code: string } };
    expect(saveBody.error.code).toBe("INVALID_STICKER_SOURCE");
  });
});
