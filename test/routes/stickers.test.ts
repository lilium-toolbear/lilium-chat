import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  addTestMember,
  createTestChannel,
  fakeS3PublicPath,
  getNamedDo,
  getTimelineMessageIdFromHistory,
  makeJwt,
  mutateTestMessage,
  readTestMessages,
  sendTestMessage,
  TEST_SECRET,
  type TimelineHistoryItem,
} from "../helpers";
import { setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";
import type { ChatChannel } from "../../src/do/chat-channel";
import type { UserDirectory } from "../../src/do/user-directory";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

function chatStub(channelId: string) {
  return getNamedDo<ChatChannel>(env.CHAT_CHANNEL, channelId);
}

function udStub(userId: string) {
  return getNamedDo<UserDirectory>(env.USER_DIRECTORY, userId);
}

async function authedReq(userId: string, method: string, path: string, body?: unknown, idemKey?: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await makeJwt({ sub: userId }, TEST_SECRET)}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  return SELF.fetch(new Request(`https://chat.kuma.homes${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

async function createChannel(channelId: string, ownerId: string) {
  const stub = await createTestChannel(env, { channelId, ownerId, title: "Sticker route test", visibility: "private" });
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
  const key = `idem-sticker-route-${userId}`;
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
    commandId: `cmd-sticker-route-${senderId}`,
    type: "image",
    attachmentIds: [attachmentId],
  });
  expect(res.status).toBe(200);
}

describe("Sticker library HTTP routes", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("POST /api/chat/stickers saves an owned finalized attachment", async () => {
    const userId = "u-sticker-route-own";
    const channelId = "ch-sticker-route-own";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);

    const res = await authedReq(userId, "POST", "/api/chat/stickers", {
      channel_id: channelId,
      attachment_id,
    }, `op-${userId}-save`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sticker: { sticker_id: string; attachment: { attachment_id: string; blurhash: string | null } } };
    expect(body.sticker.attachment.attachment_id).toBe(attachment_id);
    expect(body.sticker.attachment.blurhash).toBe("LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB");
  });

  it("GET /api/chat/stickers lists saved stickers", async () => {
    const userId = "u-sticker-route-list";
    const channelId = "ch-sticker-route-list";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);

    await authedReq(userId, "POST", "/api/chat/stickers", { channel_id: channelId, attachment_id }, `op-${userId}-save`);
    const listRes = await authedReq(userId, "GET", "/api/chat/stickers?limit=10");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { items: Array<{ sticker_id: string }> };
    expect(listBody.items).toHaveLength(1);
  });

  it("DELETE /api/chat/stickers/:sticker_id removes a sticker and is idempotent", async () => {
    const userId = "u-sticker-route-del";
    const channelId = "ch-sticker-route-del";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);

    const saveRes = await authedReq(userId, "POST", "/api/chat/stickers", { channel_id: channelId, attachment_id }, `op-${userId}-save`);
    const saveBody = (await saveRes.json()) as { sticker: { sticker_id: string } };

    const delOp = `op-${userId}-del`;
    const delRes = await authedReq(userId, "DELETE", `/api/chat/stickers/${saveBody.sticker.sticker_id}`, undefined, delOp);
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { sticker_id: string; deleted: boolean };
    expect(delBody.deleted).toBe(true);

    // Idempotent retry returns the same result.
    const delRes2 = await authedReq(userId, "DELETE", `/api/chat/stickers/${saveBody.sticker.sticker_id}`, undefined, delOp);
    expect(delRes2.status).toBe(200);
    const delBody2 = (await delRes2.json()) as { sticker_id: string; deleted: boolean };
    expect(delBody2.deleted).toBe(true);

    const listRes = await authedReq(userId, "GET", "/api/chat/stickers?limit=10");
    const listBody = (await listRes.json()) as { items: Array<unknown> };
    expect(listBody.items).toHaveLength(0);
  });

  it("rejects DELETE without Idempotency-Key", async () => {
    const userId = "u-sticker-route-del-nokey";
    const channelId = "ch-sticker-route-del-nokey";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const saveRes = await authedReq(userId, "POST", "/api/chat/stickers", { channel_id: channelId, attachment_id }, `op-${userId}-save`);
    const saveBody = (await saveRes.json()) as { sticker: { sticker_id: string } };

    const delRes = await authedReq(userId, "DELETE", `/api/chat/stickers/${saveBody.sticker.sticker_id}`);
    expect(delRes.status).toBe(422);
  });

  it("saves a channel-visible attachment from another member's image message", async () => {
    const channelId = "ch-sticker-route-visible";
    const ownerId = "u-sticker-route-owner";
    const memberId = "u-sticker-route-member";
    await createChannel(channelId, ownerId);
    await addMember(channelId, ownerId, memberId);
    const { attachment_id } = await presignAndFinalize(ownerId, fake);
    await sendImageMessage(channelId, ownerId, attachment_id);

    const res = await authedReq(memberId, "POST", "/api/chat/stickers", {
      channel_id: channelId,
      attachment_id,
    }, `op-${memberId}-visible`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sticker: { attachment: { attachment_id: string } } };
    expect(body.sticker.attachment.attachment_id).toBe(attachment_id);
  });

  it("saves a channel-visible attachment from another member's sticker message", async () => {
    const channelId = "ch-sticker-route-sticker-src";
    const ownerId = "u-sticker-route-sticker-owner";
    const memberId = "u-sticker-route-sticker-member";
    await createChannel(channelId, ownerId);
    await addMember(channelId, ownerId, memberId);
    const { attachment_id } = await presignAndFinalize(ownerId, fake);

    // Owner saves the finalized attachment to their own library, then sends a sticker message.
    const saveRes = await authedReq(ownerId, "POST", "/api/chat/stickers", { channel_id: channelId, attachment_id }, `op-${ownerId}-lib`);
    expect(saveRes.status).toBe(200);
    const saveBody = (await saveRes.json()) as { sticker: { sticker_id: string } };

    const sendRes = await sendTestMessage(chatStub(channelId), {
      userId: ownerId,
      channelId,
      commandId: `cmd-sticker-route-msg-${ownerId}`,
      type: "sticker",
      stickerId: saveBody.sticker.sticker_id,
    });
    expect(sendRes.status).toBe(200);

    // Member saves the sticker from the owner's sticker message using its canonical attachment_id.
    const res = await authedReq(memberId, "POST", "/api/chat/stickers", {
      channel_id: channelId,
      attachment_id,
    }, `op-${memberId}-sticker-src`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sticker: { attachment: { attachment_id: string } } };
    expect(body.sticker.attachment.attachment_id).toBe(attachment_id);
  });

  it("is idempotent on retry", async () => {
    const userId = "u-sticker-route-idem";
    const channelId = "ch-sticker-route-idem";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const op = `op-${userId}-idem`;

    const r1 = await authedReq(userId, "POST", "/api/chat/stickers", { channel_id: channelId, attachment_id }, op);
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { sticker: { sticker_id: string } };

    const r2 = await authedReq(userId, "POST", "/api/chat/stickers", { channel_id: channelId, attachment_id }, op);
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { sticker: { sticker_id: string } };
    expect(b2.sticker.sticker_id).toBe(b1.sticker.sticker_id);
  });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/stickers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: "x", attachment_id: "y" }),
    }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
    expect(res.status).toBe(401);
  });

  it("returns 422 for missing fields", async () => {
    const res = await authedReq("u-sticker-route-422", "POST", "/api/chat/stickers", {}, "op-422");
    expect(res.status).toBe(422);
  });

  it("rejects saving a recalled source message attachment", async () => {
    const channelId = "ch-sticker-route-recalled";
    const ownerId = "u-sticker-route-recalled-owner";
    const memberId = "u-sticker-route-recalled-member";
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

    const res = await authedReq(memberId, "POST", "/api/chat/stickers", {
      channel_id: channelId,
      attachment_id,
    }, `op-${memberId}-recalled`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_STICKER_SOURCE");
  });
});
