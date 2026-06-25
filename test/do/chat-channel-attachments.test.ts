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
  fake.objects.set(new URL(presignBody.upload_url).pathname, { contentType: "image/png", contentLength: 12345 });

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
});
