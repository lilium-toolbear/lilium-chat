import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  createTestChannel,
  fakeS3PublicPath,
  findTimelineMessageCreated,
  getNamedDo,
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
  const stub = await createTestChannel(env, { channelId, ownerId, title: "Image test", visibility: "private" });
  await stub.getSummary(ownerId);
  return stub;
}

async function presignAndFinalize(userId: string, fake: FakeS3): Promise<{ attachment_id: string; upload_url: string }> {
  const stub = udStub(userId);
  const key = `idem-img-${userId}`;
  const presignRes = await stub.presignUpload(userId, key, "attachment", {
    filename: "img.png",
    mime_type: "image/png",
    size_bytes: 12345,
    width: 512,
    height: 512,
    blurhash: "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
  });
  const presignBody = presignRes;
  fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });

  const finalizeRes = await stub.finalizeUpload(userId, `${key}-fin`, { attachment_id: presignBody.attachment_id });
  expect(finalizeRes.attachment.attachment_id).toBe(presignBody.attachment_id);
  return presignBody;
}

describe("ChatChannel message.send type=image", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("sends an image message with a finalized attachment projection", async () => {
    const channelId = "ch-img-1";
    const userId = "u-img-1";
    const stub = await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);

    const res = await sendTestMessage(stub, {
      userId,
      channelId,
      commandId: "cmd-img-1",
      type: "image",
      attachmentIds: [attachment_id],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { attachments: Array<{ attachment_id: string; blurhash: string }> } };
    expect(body.message.attachments).toHaveLength(1);
    const att = body.message.attachments[0]!;
    expect(att.attachment_id).toBe(attachment_id);
    expect(att.blurhash).toBe("LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB");
  });

  it("history and replay include the image attachment projection", async () => {
    const channelId = "ch-img-hist";
    const userId = "u-img-hist";
    const stub = await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);

    const sendRes = await sendTestMessage(stub, {
      userId,
      channelId,
      commandId: "cmd-img-hist",
      type: "image",
      attachmentIds: [attachment_id],
    });
    expect(sendRes.status).toBe(200);
    const sendBody = (await sendRes.json()) as {
      event_id: string;
      message: { message_id: string; attachments: Array<{ attachment_id: string; blurhash: string }> };
    };
    expect(sendBody.message.attachments).toHaveLength(1);

    const historyBody = await readTestMessages(stub, userId);
    const historyCreated = findTimelineMessageCreated(historyBody.items, sendBody.message.message_id);
    expect(historyCreated).toBeDefined();
    expect(historyCreated!.payload!.message!.attachments).toHaveLength(1);
    expect(historyCreated!.payload!.message!.attachments![0]!.attachment_id).toBe(attachment_id);

    const replayBody = await replayTestEvents(stub, userId);
    const created = replayBody.events.find((e) => {
      const frame = JSON.parse(e.event_json) as { type: string; payload?: { message?: { message_id: string } } };
      return frame.type === "message.created" && frame.payload?.message?.message_id === sendBody.message.message_id;
    });
    expect(created).toBeDefined();
    const event = JSON.parse(created!.event_json) as {
      payload: { message: { attachments: Array<{ attachment_id: string }> } };
    };
    expect(event.payload.message.attachments).toHaveLength(1);
    expect(event.payload.message.attachments[0]!.attachment_id).toBe(attachment_id);
  });

  it("rejects image message with a non-finalized attachment", async () => {
    const channelId = "ch-img-2";
    const userId = "u-img-2";
    const stub = await createChannel(channelId, userId);
    const presignRes = await udStub(userId).presignUpload(userId, "idem-img-2", "attachment", {
      filename: "img.png",
      mime_type: "image/png",
      size_bytes: 12345,
    });
    const presignBody = presignRes;
    // do not finalize

    const res = await sendTestMessage(stub, {
      userId,
      channelId,
      commandId: "cmd-img-2",
      type: "image",
      attachmentIds: [presignBody.attachment_id],
    });
    expect(res.status).toBe(415);
  });

  it("rejects image message without attachment_ids", async () => {
    const channelId = "ch-img-3";
    const userId = "u-img-3";
    const stub = await createChannel(channelId, userId);

    const res = await sendTestMessage(stub, { userId, channelId, commandId: "cmd-img-3", type: "image" });
    expect(res.status).toBe(422);
  });
});
