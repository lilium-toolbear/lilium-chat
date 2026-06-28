import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, fakeS3PublicPath, createTestChannel, getTimelineMessageIdFromHistory, type TimelineHistoryItem } from "../helpers";
import { setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";

function udStub(userId: string) {
  return getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], userId);
}

function chatStub(channelId: string) {
  return getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
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
  fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });

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
    const saveBody = (await saveRes.json()) as { sticker: { sticker_id: string; attachment: { attachment_id: string; blurhash: string | null } } };
    expect(saveBody.sticker.attachment.attachment_id).toBe(attachment_id);
    expect(saveBody.sticker.attachment.blurhash).toBe("LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB");

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
        body: JSON.stringify({ sticker_id: saveBody.sticker.sticker_id, operation_id: `op-del-${userId}` }),
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
    const saveBody = (await saveRes.json()) as { sticker: { attachment: { attachment_id: string } } };
    expect(saveBody.sticker.attachment.attachment_id).toBe(attachment_id);
  });

  it("saves a channel-visible attachment from another user's sticker message", async () => {
    const channelId = "ch-sticker-visible-sticker";
    const ownerId = "u-sticker-visible-sticker-owner";
    const memberId = "u-sticker-visible-sticker-member";
    await createChannel(channelId, ownerId);
    await addMember(channelId, ownerId, memberId);
    // Owner finalizes an image and saves it to their own sticker library, then sends a sticker message.
    const { attachment_id } = await presignAndFinalize(ownerId, fake);
    const saveRes = await saveSticker(ownerId, channelId, attachment_id, `op-${ownerId}-lib`);
    expect(saveRes.status).toBe(200);
    const saveBody = (await saveRes.json()) as { sticker: { sticker_id: string } };
    const stickerId = saveBody.sticker.sticker_id;

    const sendRes = await chatStub(channelId).fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: `cmd-sticker-msg-${ownerId}`,
          dedupe_principal_key: `user:${ownerId}`,
          type: "sticker",
          text: "",
          reply_to: null,
          sticker_id: stickerId,
          attachment_ids: [],
          mentions: [],
          channel_id: channelId,
        }),
      }),
    );
    expect(sendRes.status).toBe(200);

    // Member saves the sticker from the owner's sticker message using its canonical attachment_id.
    const memberSaveRes = await saveSticker(memberId, channelId, attachment_id, `op-${memberId}-sticker-src`);
    expect(memberSaveRes.status).toBe(200);
    const memberSaveBody = (await memberSaveRes.json()) as { sticker: { attachment: { attachment_id: string } } };
    expect(memberSaveBody.sticker.attachment.attachment_id).toBe(attachment_id);
  });

  it("saves a channel-visible attachment from a public channel using client channel_id", async () => {
    const ownerId = "u-sticker-system-owner";
    const memberId = "u-sticker-system-member";
    const channelId = crypto.randomUUID();
    const channelStub = await createTestChannel(env, {
      channelId,
      ownerId,
      title: "Sticker Channel",
      visibility: "public_listed",
    });
    await channelStub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": memberId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: memberId }),
    }));

    const { attachment_id } = await presignAndFinalize(ownerId, fake);
    const sendRes = await channelStub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: `cmd-sticker-system-${ownerId}`,
          dedupe_principal_key: `user:${ownerId}`,
          type: "image",
          text: "",
          reply_to: null,
          attachment_ids: [attachment_id],
          mentions: [],
          channel_id: channelId,
        }),
      }),
    );
    expect(sendRes.status).toBe(200);

    const saveRes = await saveSticker(memberId, channelId, attachment_id, `op-${memberId}-system`);
    expect(saveRes.status).toBe(200);
    const saveBody = (await saveRes.json()) as { sticker: { attachment: { attachment_id: string } } };
    expect(saveBody.sticker.attachment.attachment_id).toBe(attachment_id);
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
    const historyBody = (await historyRes.json()) as { items: TimelineHistoryItem[] };
    const messageId = getTimelineMessageIdFromHistory(historyBody.items);

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

describe("UserDirectory sticker library limit + width/height validation + delete idempotency", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("rejects saving beyond the library limit with STICKER_LIBRARY_LIMIT_EXCEEDED", async () => {
    const userId = "u-sticker-limit";
    const channelId = "ch-sticker-limit";
    await createChannel(channelId, userId);
    const stub = udStub(userId);

    // Bulk-insert MAX_PERSONAL_STICKERS active library items to fill the library.
    const { runInDurableObject } = await import("cloudflare:test") as {
      runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
    };
    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (instance as { ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => void } } } }).ctx.storage.sql;
      for (let i = 0; i < 200; i++) {
        sql.exec(
          `INSERT INTO personal_stickers (sticker_id, user_id, attachment_id, url, mime_type, width, height, size_bytes, blurhash, created_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
          `stk-limit-${i}`,
          userId,
          `att-limit-${i}`,
          `https://s3.kuma.homes/chat/att-limit-${i}`,
          "image/png",
          128,
          128,
          4096,
          `2026-01-01T00:00:0${Math.floor(i / 100)}Z`,
        );
      }
    });

    // A new, distinct finalized attachment → should hit the limit.
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const res = await saveSticker(userId, channelId, attachment_id, `op-${userId}-limit`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("STICKER_LIBRARY_LIMIT_EXCEEDED");
  });

  it("rejects presign with non-positive width", async () => {
    const userId = "u-sticker-width";
    const res = await udStub(userId).fetch(
      new Request("https://x/internal/attachment-presign", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Idempotency-Key": "op-width", "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "img.png", mime_type: "image/png", size_bytes: 12345, width: 0, height: 128 }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects presign with negative height", async () => {
    const userId = "u-sticker-height";
    const res = await udStub(userId).fetch(
      new Request("https://x/internal/attachment-presign", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Idempotency-Key": "op-height", "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "img.png", mime_type: "image/png", size_bytes: 12345, width: 128, height: -1 }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_MESSAGE");
  });

  it("delete is idempotent: retry returns the same {sticker_id, deleted:true}", async () => {
    const userId = "u-sticker-del-idem";
    const channelId = "ch-sticker-del-idem";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const saveRes = await saveSticker(userId, channelId, attachment_id, `op-${userId}-save`);
    const saveBody = (await saveRes.json()) as { sticker: { sticker_id: string } };
    const stickerId = saveBody.sticker.sticker_id;

    const op = `op-${userId}-del`;
    const r1 = await udStub(userId).fetch(
      new Request("https://x/internal/sticker-delete", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ sticker_id: stickerId, operation_id: op }),
      }),
    );
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { sticker_id: string; deleted: boolean };
    expect(b1.sticker_id).toBe(stickerId);
    expect(b1.deleted).toBe(true);

    const r2 = await udStub(userId).fetch(
      new Request("https://x/internal/sticker-delete", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ sticker_id: stickerId, operation_id: op }),
      }),
    );
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { sticker_id: string; deleted: boolean };
    expect(b2.sticker_id).toBe(stickerId);
    expect(b2.deleted).toBe(true);
  });
});
