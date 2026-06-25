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
        headers: {
          "Content-Type": obj.contentType,
          "Content-Length": String(obj.contentLength),
        },
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
        title: "Image test",
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
  const stub = udStub(userId);
  const key = `idem-img-${userId}`;
  const presignRes = await stub.fetch(
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

  const finalizeRes = await stub.fetch(
    new Request("https://x/internal/attachment-finalize", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Idempotency-Key": `${key}-fin`, "Content-Type": "application/json" },
      body: JSON.stringify({ attachment_id: presignBody.attachment_id }),
    }),
  );
  expect(finalizeRes.status).toBe(200);
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

    const res = await stub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: "cmd-img-1",
          dedupe_principal_key: `user:${userId}`,
          type: "image",
          text: "",
          reply_to: null,
          attachment_ids: [attachment_id],
          mentions: [],
          channel_id: channelId,
        }),
      }),
    );
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

    const sendRes = await stub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: "cmd-img-hist",
          dedupe_principal_key: `user:${userId}`,
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
    const sendBody = (await sendRes.json()) as {
      event_id: string;
      message: { message_id: string; attachments: Array<{ attachment_id: string; blurhash: string }> };
    };
    expect(sendBody.message.attachments).toHaveLength(1);

    const historyRes = await stub.fetch(
      new Request("https://x/internal/messages?limit=10", { headers: { "X-Verified-User-Id": userId } }),
    );
    expect(historyRes.status).toBe(200);
    const historyBody = (await historyRes.json()) as {
      items: Array<{ message_id: string }>;
      attachments: Record<string, Array<{ attachment_id: string }>>;
    };
    expect(historyBody.items).toHaveLength(1);
    expect(historyBody.items[0]!.message_id).toBe(sendBody.message.message_id);
    expect(historyBody.attachments[sendBody.message.message_id]).toHaveLength(1);
    expect(historyBody.attachments[sendBody.message.message_id]![0]!.attachment_id).toBe(attachment_id);

    const replayRes = await stub.fetch(
      new Request("https://x/internal/replay?after=", { headers: { "X-Verified-User-Id": userId } }),
    );
    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as { events: Array<{ event_type: string; event_json: string }> };
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
    const presignRes = await udStub(userId).fetch(
      new Request("https://x/internal/attachment-presign", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Idempotency-Key": "idem-img-2", "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "img.png", mime_type: "image/png", size_bytes: 12345 }),
      }),
    );
    expect(presignRes.status).toBe(200);
    const presignBody = (await presignRes.json()) as { attachment_id: string };
    // do not finalize

    const res = await stub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: "cmd-img-2",
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
    expect(res.status).toBe(415);
  });

  it("rejects image message without attachment_ids", async () => {
    const channelId = "ch-img-3";
    const userId = "u-img-3";
    const stub = await createChannel(channelId, userId);

    const res = await stub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: "cmd-img-3",
          dedupe_principal_key: `user:${userId}`,
          type: "image",
          text: "",
          reply_to: null,
          attachment_ids: [],
          mentions: [],
          channel_id: channelId,
        }),
      }),
    );
    expect(res.status).toBe(422);
  });
});
