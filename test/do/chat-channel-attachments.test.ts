import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  createTestChannel,
  expectDoRpcError,
  fakeS3PublicPath,
  getNamedDo,
  mutateTestMessage,
  rpcResolveVisibleAttachment,
  sendTestMessage,
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
  const stub = await createTestChannel(env, { channelId, ownerId, title: "Sticker source", visibility: "private" });
  await stub.getSummary(ownerId);
  return stub;
}

async function presignFinalizeAndSend(channelId: string, userId: string, fake: FakeS3) {
  const key = `idem-attach-${userId}`;
  const presignRes = await udStub(userId).presignUpload(userId, key, "attachment", {
    filename: "img.png",
    mime_type: "image/png",
    size_bytes: 12345,
    width: 512,
    height: 512,
    blurhash: "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
  });
  const presignBody = presignRes;
  fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });

  const finalizeRes = await udStub(userId).finalizeUpload(userId, `${key}-fin`, { attachment_id: presignBody.attachment_id });
  expect(finalizeRes.attachment.attachment_id).toBe(presignBody.attachment_id);

  const stub = chatStub(channelId);
  const sendRes = await sendTestMessage(stub, {
    userId,
    channelId,
    commandId: `cmd-${userId}`,
    type: "image",
    attachmentIds: [presignBody.attachment_id],
  });
  expect(sendRes.status).toBe(200);
  const sendBody = (await sendRes.json()) as { message: { message_id: string } };
  return { attachment_id: presignBody.attachment_id, message_id: sendBody.message.message_id };
}

async function presignAndFinalizeOnly(userId: string, fake: FakeS3): Promise<{ attachment_id: string; upload_url: string }> {
  const key = `idem-attach-only-${userId}`;
  const presignRes = await udStub(userId).presignUpload(userId, key, "attachment", {
    filename: "img.png",
    mime_type: "image/png",
    size_bytes: 12345,
    width: 512,
    height: 512,
    blurhash: "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
  });
  const presignBody = presignRes;
  fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });

  const finalizeRes = await udStub(userId).finalizeUpload(userId, `${key}-fin`, { attachment_id: presignBody.attachment_id });
  expect(finalizeRes.attachment.attachment_id).toBe(presignBody.attachment_id);
  return presignBody;
}

describe("ChatChannel resolve visible attachment RPC", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("returns the projection for a visible image message attachment", async () => {
    const channelId = "ch-attach-1";
    const userId = "u-attach-1";
    const stub = await createChannel(channelId, userId);
    const { attachment_id } = await presignFinalizeAndSend(channelId, userId, fake);

    const res = await rpcResolveVisibleAttachment(stub, { user_id: userId, attachment_id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachment: { attachment_id: string; url: string; mime_type: string; width: number; height: number; size_bytes: number };
    };
    expect(body.attachment.attachment_id).toBe(attachment_id);
    expect(body.attachment.mime_type).toBe("image/png");
    expect(body.attachment.width).toBe(512);
    expect((body.attachment as Record<string, unknown>).storage_key).toBeUndefined();
  });

  it("returns INVALID_STICKER_SOURCE after the source message is recalled", async () => {
    const channelId = "ch-attach-2";
    const userId = "u-attach-2";
    const stub = await createChannel(channelId, userId);
    const { attachment_id, message_id } = await presignFinalizeAndSend(channelId, userId, fake);

    await mutateTestMessage(stub, {
      userId,
      channelId,
      messageId: message_id,
      operation: "message.recall",
      operationId: "op-recall-1",
    });

    const res = await rpcResolveVisibleAttachment(stub, { user_id: userId, attachment_id });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_STICKER_SOURCE");
  });

  it("returns FORBIDDEN for a non-member", async () => {
    const channelId = "ch-attach-3";
    const ownerId = "u-attach-3-owner";
    const otherId = "u-attach-3-other";
    const stub = await createChannel(channelId, ownerId);
    const { attachment_id } = await presignFinalizeAndSend(channelId, ownerId, fake);

    await expectDoRpcError(
      () => stub.resolveVisibleAttachment({ user_id: otherId, attachment_id }),
      "FORBIDDEN",
    );
  });

  it("returns the projection for a visible sticker message attachment (sticker source)", async () => {
    const channelId = "ch-attach-sticker-src";
    const userId = "u-attach-sticker-src";
    const stub = await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalizeOnly(userId, fake);

    const saveRes = await udStub(userId).saveSticker(userId, {
      operation_id: `op-save-${userId}`,
      channel_id: channelId,
      attachment_id,
    });
    const saveBody = saveRes;

    await sendTestMessage(stub, {
      userId,
      channelId,
      commandId: `cmd-sticker-${userId}`,
      type: "sticker",
      stickerId: saveBody.sticker.sticker_id,
    });

    const res = await rpcResolveVisibleAttachment(stub, { user_id: userId, attachment_id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachment: { attachment_id: string; url: string; blurhash: string | null } };
    expect(body.attachment.attachment_id).toBe(attachment_id);
    expect(body.attachment.blurhash).toBe("LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB");
    expect((body.attachment as Record<string, unknown>).storage_key).toBeUndefined();
  });
});
