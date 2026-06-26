import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, fakeS3PublicPath } from "../helpers";
import { setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";

function chatStub(channelId: string) {
  return getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
}

function udStub(userId: string) {
  return getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], userId);
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
  return stub;
}

async function presignFinalizeAndSend(channelId: string, userId: string, fake: FakeS3) {
  const key = `idem-attach-${userId}`;
  const presignRes = await udStub(userId).fetch(
    new Request("https://x/internal/attachment-presign", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Idempotency-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "img.png",
        mime_type: "image/png",
        size_bytes: 12345,
        width: 512,
        height: 512,
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

  const stub = chatStub(channelId);
  const sendRes = await stub.fetch(
    new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: `cmd-${userId}`,
        dedupe_principal_key: `user:${userId}`,
        type: "image",
        text: "",
        reply_to: null,
        attachment_ids: [presignBody.attachment_id],
        mentions: [],
        channel_id: channelId,
      }),
    }),
  );
  expect(sendRes.status).toBe(200);
  const sendBody = (await sendRes.json()) as { message: { message_id: string } };
  return { attachment_id: presignBody.attachment_id, message_id: sendBody.message.message_id };
}

async function presignAndFinalizeOnly(userId: string, fake: FakeS3): Promise<{ attachment_id: string; upload_url: string }> {
  const key = `idem-attach-only-${userId}`;
  const presignRes = await udStub(userId).fetch(
    new Request("https://x/internal/attachment-presign", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Idempotency-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "img.png",
        mime_type: "image/png",
        size_bytes: 12345,
        width: 512,
        height: 512,
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

describe("ChatChannel /internal/resolve-visible-attachment", () => {
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

    const res = await stub.fetch(
      new Request(`https://x/internal/resolve-visible-attachment?attachment_id=${encodeURIComponent(attachment_id)}`, {
        headers: { "X-Verified-User-Id": userId },
      }),
    );
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

    const recallRes = await stub.fetch(
      new Request("https://x/internal/message-recall", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ operation_id: "op-recall-1", message_id, channel_id: channelId }),
      }),
    );
    expect(recallRes.status).toBe(200);

    const res = await stub.fetch(
      new Request(`https://x/internal/resolve-visible-attachment?attachment_id=${encodeURIComponent(attachment_id)}`, {
        headers: { "X-Verified-User-Id": userId },
      }),
    );
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

    const res = await stub.fetch(
      new Request(`https://x/internal/resolve-visible-attachment?attachment_id=${encodeURIComponent(attachment_id)}`, {
        headers: { "X-Verified-User-Id": otherId },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns the projection for a visible sticker message attachment (sticker source)", async () => {
    const channelId = "ch-attach-sticker-src";
    const userId = "u-attach-sticker-src";
    const stub = await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalizeOnly(userId, fake);

    // Save the finalized attachment to the user's sticker library, then send a sticker message.
    const saveRes = await udStub(userId).fetch(
      new Request("https://x/internal/sticker-save", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ operation_id: `op-save-${userId}`, channel_id: channelId, attachment_id }),
      }),
    );
    expect(saveRes.status).toBe(200);
    const saveBody = (await saveRes.json()) as { sticker: { sticker_id: string } };

    const sendRes = await stub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: `cmd-sticker-${userId}`,
          dedupe_principal_key: `user:${userId}`,
          type: "sticker",
          text: "",
          reply_to: null,
          sticker_id: saveBody.sticker.sticker_id,
          attachment_ids: [],
          mentions: [],
          channel_id: channelId,
        }),
      }),
    );
    expect(sendRes.status).toBe(200);

    const res = await stub.fetch(
      new Request(`https://x/internal/resolve-visible-attachment?attachment_id=${encodeURIComponent(attachment_id)}`, {
        headers: { "X-Verified-User-Id": userId },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachment: { attachment_id: string; url: string; blurhash: string | null } };
    expect(body.attachment.attachment_id).toBe(attachment_id);
    expect(body.attachment.blurhash).toBe("LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB");
    expect((body.attachment as Record<string, unknown>).storage_key).toBeUndefined();
  });
});
