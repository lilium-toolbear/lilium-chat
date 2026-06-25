import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { setTestS3Client, type S3Client } from "../../src/s3/presign";

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
        title: "Sticker send test",
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

async function presignAndFinalize(userId: string, fake: FakeS3): Promise<{ attachment_id: string; upload_url: string }> {
  const key = `idem-sticker-send-${userId}`;
  const presignRes = await udStub(userId).fetch(
    new Request("https://x/internal/attachment-presign", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Idempotency-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "sticker.png",
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

async function saveSticker(userId: string, channelId: string, attachmentId: string): Promise<{ sticker_id: string }> {
  const res = await udStub(userId).fetch(
    new Request("https://x/internal/sticker-save", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ operation_id: `op-save-${userId}-${attachmentId}`, channel_id: channelId, attachment_id: attachmentId }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sticker: { sticker_id: string } };
  return { sticker_id: body.sticker.sticker_id };
}

async function sendStickerMessage(channelId: string, senderId: string, stickerId: string, cmdId: string) {
  return chatStub(channelId).fetch(
    new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": senderId, "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: cmdId,
        dedupe_principal_key: `user:${senderId}`,
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

    const delRes = await udStub(userId).fetch(
      new Request("https://x/internal/sticker-delete", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ sticker_id }),
      }),
    );
    expect(delRes.status).toBe(200);

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

  it("recall hides the sticker in the projection", async () => {
    const userId = "u-sticker-send-4";
    const channelId = "ch-sticker-send-4";
    const stub = await createChannel(channelId, userId);
    const { attachment_id } = await presignAndFinalize(userId, fake);
    const { sticker_id } = await saveSticker(userId, channelId, attachment_id);

    const sendRes = await sendStickerMessage(channelId, userId, sticker_id, "cmd-sticker-4");
    expect(sendRes.status).toBe(200);
    const sendBody = (await sendRes.json()) as { message: { message_id: string } };

    const recallRes = await stub.fetch(
      new Request("https://x/internal/message-recall", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ operation_id: "op-recall", message_id: sendBody.message.message_id, channel_id: channelId }),
      }),
    );
    expect(recallRes.status).toBe(200);
    const recallBody = (await recallRes.json()) as { message: { status: string; sticker: unknown } };
    expect(recallBody.message.status).toBe("recalled");
    expect(recallBody.message.sticker).toBeNull();
  });
});
