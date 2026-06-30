import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  createTestChannel,
  fakeS3PublicPath,
  findTimelineMessageCreated,
  getNamedDo,
  mutateTestMessage,
  readTestMessages,
  replayTestEvents,
  sendTestMessage,
  type TimelineHistoryItem,
} from "../helpers";
import { setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";
import type { ChatChannel } from "../../src/do/chat-channel";
import type { UserDirectory } from "../../src/do/user-directory";

function chatStub(channelId: string) {
  return getNamedDo<ChatChannel>(env.CHAT_CHANNEL, channelId);
}

function udStub(userId: string) {
  return getNamedDo<UserDirectory>(env.USER_DIRECTORY, userId);
}

async function createChannel(channelId: string, ownerId: string) {
  const stub = await createTestChannel(env, { channelId, ownerId, title: "Sticker send test", visibility: "private" });
  await stub.getSummary(ownerId);
  return stub;
}

async function presignAndFinalize(userId: string, fake: FakeS3): Promise<{ attachment_id: string; upload_url: string }> {
  const key = `idem-sticker-send-${userId}`;
  const presignRes = await udStub(userId).presignUpload(userId, key, "attachment", {
    filename: "sticker.png",
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

async function saveSticker(userId: string, channelId: string, attachmentId: string): Promise<{ sticker_id: string }> {
  const res = await udStub(userId).saveSticker(userId, {
    operation_id: `op-save-${userId}-${attachmentId}`,
    channel_id: channelId,
    attachment_id: attachmentId,
  });
  return { sticker_id: res.sticker.sticker_id };
}

async function sendStickerMessage(channelId: string, senderId: string, stickerId: string, cmdId: string) {
  return sendTestMessage(chatStub(channelId), {
    userId: senderId,
    channelId,
    commandId: cmdId,
    type: "sticker",
    stickerId,
  });
}

describe("ChatChannel message.send type=sticker", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("sends a sticker message and projects the sticker in the ack", async () => {
    const userId = "u-sticker-send-1";
    const channelId = "ch-sticker-send-1";
    const stub = await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const { sticker_id } = await saveSticker(userId, channelId, attachment_id);

    const res = await sendStickerMessage(channelId, userId, sticker_id, "cmd-sticker-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      event_id: string;
      message: { type: string; sticker: { sticker_id: string; attachment_id: string; mime_type: string } | null };
    };
    expect(body.message.type).toBe("sticker");
    expect(body.message.sticker).not.toBeNull();
    expect(body.message.sticker!.sticker_id).toBe(sticker_id);
    expect(body.message.sticker!.attachment_id).toBe(attachment_id);
  });

  it("rejects a sticker message with a deleted sticker", async () => {
    const userId = "u-sticker-send-2";
    const channelId = "ch-sticker-send-2";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const { sticker_id } = await saveSticker(userId, channelId, attachment_id);

    const delRes = await udStub(userId).deleteSticker(userId, { sticker_id, operation_id: `op-del-${userId}` });
    expect(delRes.deleted).toBe(true);

    const res = await sendStickerMessage(channelId, userId, sticker_id, "cmd-sticker-2");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("STICKER_NOT_FOUND");
  });

  it("is idempotent: retry returns the same ack", async () => {
    const userId = "u-sticker-send-3";
    const channelId = "ch-sticker-send-3";
    await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const { sticker_id } = await saveSticker(userId, channelId, attachment_id);

    const r1 = await sendStickerMessage(channelId, userId, sticker_id, "cmd-sticker-3");
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { event_id: string; message: { message_id: string } };

    const r2 = await sendStickerMessage(channelId, userId, sticker_id, "cmd-sticker-3");
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { event_id: string; message: { message_id: string } };
    expect(b2.message.message_id).toBe(b1.message.message_id);
    expect(b2.event_id).toBe(b1.event_id);
  });

  it("history returns sticker snapshot", async () => {
    const userId = "u-sticker-send-5";
    const channelId = "ch-sticker-send-5";
    const stub = await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const { sticker_id } = await saveSticker(userId, channelId, attachment_id);

    const sendRes = await sendStickerMessage(channelId, userId, sticker_id, "cmd-sticker-5");
    expect(sendRes.status).toBe(200);
    const sendBody = (await sendRes.json()) as { message: { message_id: string } };

    const historyBody = await readTestMessages(stub, userId);
    const live = findTimelineMessageCreated(historyBody.items, sendBody.message.message_id);
    expect(live).toBeDefined();
    expect(live!.payload!.message!.type).toBe("sticker");
    expect(live!.payload!.message!.sticker).not.toBeNull();
    expect(live!.payload!.message!.sticker!.sticker_id).toBe(sticker_id);
  });

  it("replay returns sticker snapshot and hides it after recall", async () => {
    const userId = "u-sticker-send-6";
    const channelId = "ch-sticker-send-6";
    const stub = await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const { sticker_id } = await saveSticker(userId, channelId, attachment_id);

    const sendRes = await sendStickerMessage(channelId, userId, sticker_id, "cmd-sticker-6");
    expect(sendRes.status).toBe(200);
    const sendBody = (await sendRes.json()) as { event_id: string; message: { message_id: string } };

    const replayBody1 = await replayTestEvents(stub, userId) as { events: Array<{ event_id: string; event_json: string }> };
    const createdEvent = replayBody1.events
      .map((e) => ({ ...e, frame: JSON.parse(e.event_json) as { type: string; payload?: { message?: { message_id: string; type: string; sticker: { sticker_id: string } | null } } } }))
      .find((e) => e.frame.type === "message.created" && e.frame.payload?.message?.message_id === sendBody.message.message_id);
    expect(createdEvent).toBeDefined();
    expect(createdEvent!.frame.payload!.message!.type).toBe("sticker");
    expect(createdEvent!.frame.payload!.message!.sticker).not.toBeNull();
    expect(createdEvent!.frame.payload!.message!.sticker!.sticker_id).toBe(sticker_id);

    const recallRes = await mutateTestMessage(stub, {
      userId,
      channelId,
      messageId: sendBody.message.message_id,
      operation: "message.recall",
      operationId: "op-recall-6",
    });
    expect(recallRes.status).toBe(200);

    const replayBody2 = await replayTestEvents(stub, userId, sendBody.event_id) as { events: Array<{ event_id: string; event_json: string }> };
    const recalledEvent = replayBody2.events
      .map((e) => ({ ...e, frame: JSON.parse(e.event_json) as { type: string; payload?: { message?: { message_id: string; status: string; sticker: unknown } } } }))
      .find((e) => e.frame.type.startsWith("message.") && e.frame.payload?.message?.message_id === sendBody.message.message_id);
    expect(recalledEvent).toBeDefined();
    expect(recalledEvent!.frame.payload!.message!.status).toBe("recalled");
    expect(recalledEvent!.frame.payload!.message!.sticker).toBeNull();
  });
});
