import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  addTestMember,
  createTestChannel,
  fakeS3PublicPath,
  getNamedDo,
  getTimelineMessageIdFromHistory,
  joinTestChannel,
  mutateTestMessage,
  readTestMessages,
  sendTestMessage,
  type TimelineHistoryItem,
} from "../helpers";
import { setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";
import type { ChatChannel } from "../../src/do/chat-channel";
import type { UserDirectory } from "../../src/do/user-directory";

function udStub(userId: string) {
  return getNamedDo<UserDirectory>(env.USER_DIRECTORY, userId);
}

function chatStub(channelId: string) {
  return getNamedDo<ChatChannel>(env.CHAT_CHANNEL, channelId);
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
  const stub = await createTestChannel(env, { channelId, ownerId, title: "Sticker source", visibility: "private" });
  await stub.getSummary(ownerId);
}

async function addMember(channelId: string, ownerId: string, memberId: string) {
  await addTestMember(chatStub(channelId), {
    actorUserId: ownerId,
    targetUserId: memberId,
    channelId,
    idempotencyKey: `idem-add-${channelId}-${memberId}`,
  });
}

async function presignAndFinalize(userId: string, fake: FakeS3): Promise<{ attachment_id: string; upload_url: string }> {
  const key = `idem-sticker-${userId}`;
  const presignRes = await udStub(userId).presignUpload(userId, key, "attachment", {
    filename: "img.png",
    mime_type: "image/png",
    size_bytes: 12345,
    width: 128,
    height: 128,
    blurhash: "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
  });
  const presignBody = presignRes;
  fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });

  const finalizeRes = await udStub(userId).finalizeUpload(userId, `${key}-fin`, { attachment_id: presignBody.attachment_id });
  expect(finalizeRes.attachment.attachment_id).toBe(presignBody.attachment_id);
  return presignBody;
}

async function sendImageMessage(channelId: string, senderId: string, attachmentId: string) {
  const res = await sendTestMessage(chatStub(channelId), {
    userId: senderId,
    channelId,
    commandId: `cmd-sticker-${senderId}`,
    type: "image",
    attachmentIds: [attachmentId],
  });
  expect(res.status).toBe(200);
}

async function saveSticker(userId: string, channelId: string, attachmentId: string, operationId: string) {
  return udStub(userId).saveSticker(userId, { operation_id: operationId, channel_id: channelId, attachment_id: attachmentId });
}

async function expectRemoteCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ${code}`);
  } catch (err) {
    expect((err as { remote?: unknown }).remote).toBe(true);
    expect((err as { code?: unknown }).code).toBe(code);
  }
}

describe("UserDirectory personal_stickers + resolveSticker RPC", () => {
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

    const body = await stub.resolveSticker(userId, "s1");
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

    await expectRemoteCode(() => stub.resolveSticker(userId, "s2"), "STICKER_NOT_FOUND");
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

    await expectRemoteCode(() => stub.resolveSticker(otherId, "s3"), "STICKER_NOT_FOUND");
  });
});

describe("UserDirectory sticker save/list/delete RPC", () => {
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
    const saveBody = saveRes;
    expect(saveBody.sticker.attachment.attachment_id).toBe(attachment_id);
    expect(saveBody.sticker.attachment.blurhash).toBe("LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB");

    const listBody = await udStub(userId).listStickers(userId, { limit: 10, cursor: null });
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]!.sticker_id).toBe(saveBody.sticker.sticker_id);

    const delRes = await udStub(userId).deleteSticker(userId, {
      sticker_id: saveBody.sticker.sticker_id,
      operation_id: `op-del-${userId}`,
    });
    expect(delRes.deleted).toBe(true);

    const listAfterBody = await udStub(userId).listStickers(userId, { limit: 10, cursor: null });
    expect(listAfterBody.items).toHaveLength(0);
  });

  it("is idempotent: retry returns the same sticker_id", async () => {
    const userId = "u-sticker-idem";
    const channelId = "ch-sticker-idem";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const op = `op-${userId}-idem`;

    const r1 = await saveSticker(userId, channelId, attachment_id, op);

    const r2 = await saveSticker(userId, channelId, attachment_id, op);
    expect(r2.sticker.sticker_id).toBe(r1.sticker.sticker_id);
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
    expect(saveRes.sticker.attachment.attachment_id).toBe(attachment_id);
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
    const stickerId = saveRes.sticker.sticker_id;

    const sendRes = await sendTestMessage(chatStub(channelId), {
      userId: ownerId,
      channelId,
      commandId: `cmd-sticker-msg-${ownerId}`,
      type: "sticker",
      stickerId,
    });
    expect(sendRes.status).toBe(200);

    // Member saves the sticker from the owner's sticker message using its canonical attachment_id.
    const memberSaveRes = await saveSticker(memberId, channelId, attachment_id, `op-${memberId}-sticker-src`);
    expect(memberSaveRes.sticker.attachment.attachment_id).toBe(attachment_id);
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
    await joinTestChannel(channelStub, memberId);

    const { attachment_id } = await presignAndFinalize(ownerId, fake);
    const sendRes = await sendTestMessage(channelStub, {
      userId: ownerId,
      channelId,
      commandId: `cmd-sticker-system-${ownerId}`,
      type: "image",
      attachmentIds: [attachment_id],
    });
    expect(sendRes.status).toBe(200);

    const saveRes = await saveSticker(memberId, channelId, attachment_id, `op-${memberId}-system`);
    expect(saveRes.sticker.attachment.attachment_id).toBe(attachment_id);
  });

  it("rejects saving a recalled source message attachment via channel-visible path", async () => {
    const channelId = "ch-sticker-recalled";
    const ownerId = "u-sticker-recalled-owner";
    const memberId = "u-sticker-recalled-member";
    await createChannel(channelId, ownerId);
    await addMember(channelId, ownerId, memberId);
    const { attachment_id } = await presignAndFinalize(ownerId, fake);
    await sendImageMessage(channelId, ownerId, attachment_id);

    const historyBody = await readTestMessages(chatStub(channelId), ownerId);
    const messageId = getTimelineMessageIdFromHistory(historyBody.items);

    const recallRes = await mutateTestMessage(chatStub(channelId), {
      userId: ownerId,
      channelId,
      messageId,
      operation: "message.recall",
      operationId: "op-recall",
    });
    expect(recallRes.status).toBe(200);

    await expectRemoteCode(
      () => saveSticker(memberId, channelId, attachment_id, `op-${memberId}-recalled`),
      "INVALID_STICKER_SOURCE",
    );
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
    await expectRemoteCode(
      () => saveSticker(userId, channelId, attachment_id, `op-${userId}-limit`),
      "STICKER_LIBRARY_LIMIT_EXCEEDED",
    );
  });

  it("rejects presign with non-positive width", async () => {
    const userId = "u-sticker-width";
    await expectRemoteCode(
      () => udStub(userId).presignUpload(userId, "op-width", "attachment", {
        filename: "img.png",
        mime_type: "image/png",
        size_bytes: 12345,
        width: 0,
        height: 128,
      }),
      "INVALID_MESSAGE",
    );
  });

  it("rejects presign with negative height", async () => {
    const userId = "u-sticker-height";
    await expectRemoteCode(
      () => udStub(userId).presignUpload(userId, "op-height", "attachment", {
        filename: "img.png",
        mime_type: "image/png",
        size_bytes: 12345,
        width: 128,
        height: -1,
      }),
      "INVALID_MESSAGE",
    );
  });

  it("delete is idempotent: retry returns the same {sticker_id, deleted:true}", async () => {
    const userId = "u-sticker-del-idem";
    const channelId = "ch-sticker-del-idem";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const saveRes = await saveSticker(userId, channelId, attachment_id, `op-${userId}-save`);
    const stickerId = saveRes.sticker.sticker_id;

    const op = `op-${userId}-del`;
    const r1 = await udStub(userId).deleteSticker(userId, { sticker_id: stickerId, operation_id: op });
    expect(r1.sticker_id).toBe(stickerId);
    expect(r1.deleted).toBe(true);

    const r2 = await udStub(userId).deleteSticker(userId, { sticker_id: stickerId, operation_id: op });
    expect(r2.sticker_id).toBe(stickerId);
    expect(r2.deleted).toBe(true);
  });
});
