import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { computeEffectRequestHash } from "../../src/chat/bot-effects";
import { createTestChannel, expectDoRpcError, fakeS3PublicPath, getNamedDo } from "../helpers";
import { setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";

const REGISTRY = () =>
  getNamedDo(env.BOT_REGISTRY as unknown as DurableObjectNamespace, "registry");

async function withRegistry(
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(REGISTRY(), async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

const seededBots = new Set<string>();

async function seedBot(botId: string, displayName = "Effect Bot"): Promise<void> {
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      botId,
      "owner-1",
      displayName,
      null,
      null,
      "private",
      "active",
      "2026-06-30T00:00:00.000Z",
      "2026-06-30T00:00:00.000Z",
    );
  });
  seededBots.add(botId);
}

afterEach(async () => {
  for (const botId of seededBots) {
    await withRegistry((ctx) => {
      ctx.storage.sql.exec("DELETE FROM bot_apps WHERE bot_id=?", botId);
    });
  }
  seededBots.clear();
});

async function withDoState(
  stub: DurableObjectStub,
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

function sendMessageEffect(clientEffectId: string, text: string) {
  return {
    type: "send_message",
    client_effect_id: clientEffectId,
    message: {
      type: "text",
      format: "plain",
      text,
      reply_to_message_id: null,
      attachment_ids: [],
      components: [],
    },
  };
}

function sendImageMessageEffect(clientEffectId: string, attachmentIds: string[]) {
  return {
    type: "send_message",
    client_effect_id: clientEffectId,
    message: {
      type: "image",
      format: "plain",
      text: "",
      reply_to_message_id: null,
      attachment_ids: attachmentIds,
      components: [],
    },
  };
}

async function seedBotBinding(channelId: string, botId: string, userId: string): Promise<void> {
  await withDoState(getNamedDo(env.CHAT_CHANNEL, channelId), (ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO channel_command_bindings (
         channel_id, bot_command_id, bot_id, status, permission_override,
         command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
       ) VALUES (?, ?, ?, 'allowed', NULL, ?, NULL, ?, ?)`,
      channelId,
      `${botId}-cmd`,
      botId,
      JSON.stringify({ bot_command_id: `${botId}-cmd`, name: "upload", aliases: [] }),
      userId,
      new Date().toISOString(),
    );
  });
}

async function presignAndFinalizeBotAttachment(
  stub: DurableObjectStub,
  channelId: string,
  botId: string,
  fake: FakeS3,
  idempotencyKey: string,
): Promise<string> {
  const presign = await stub.botAttachmentPresign({
    channel_id: channelId,
    bot_id: botId,
    idempotency_key: idempotencyKey,
    filename: "img.png",
    mime_type: "image/png",
    size_bytes: 5000,
    width: 100,
    height: 100,
  });
  fake.objects.set(fakeS3PublicPath(presign.attachment_id), { contentType: "image/png", contentLength: 5000 });
  await stub.botAttachmentFinalize({
    channel_id: channelId,
    bot_id: botId,
    attachment_id: presign.attachment_id,
  });
  return presign.attachment_id;
}

describe("ChatChannel botDeliveryResult RPC", () => {
  let fake: FakeS3;

  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("applies send_message and returns effect_results", async () => {
    const botId = `bot-effect-send-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const stub = await createTestChannel(env, { channelId, ownerId: "owner-1" });
    const effect = sendMessageEffect("eff-send-1", "from bot");
    const body = await stub.botDeliveryResult({
      delivery_id: "del-1",
      outbox_id: "out-1",
      bot_id: botId,
      channel_id: channelId,
      effects: [effect],
    });
    expect(body.status).toBe("applied");
    if (body.status !== "applied") return;
    const sendResult = body.effect_results.find((r) => r.type === "send_message");
    expect(sendResult?.type).toBe("send_message");
    if (sendResult?.type !== "send_message") return;
    expect(sendResult.message_id).toBeTruthy();
    expect(sendResult.event_id).toBeTruthy();

    await withDoState(stub, (ctx) => {
      const message = ctx.storage.sql
        .exec("SELECT sender_kind, sender_bot_id, text FROM messages WHERE message_id=?", sendResult.message_id)
        .toArray()[0] as { sender_kind: string; sender_bot_id: string; text: string };
      expect(message.sender_kind).toBe("bot");
      expect(message.sender_bot_id).toBe(botId);
      expect(message.text).toBe("from bot");
    });
  });

  it("is idempotent on client_effect_id", async () => {
    const botId = `bot-effect-idem-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const stub = await createTestChannel(env, { channelId, ownerId: "owner-1" });
    const effect = sendMessageEffect("eff-idem", "same");
    const payload = {
      delivery_id: "del-a",
      outbox_id: "out-a",
      bot_id: botId,
      channel_id: channelId,
      effects: [effect],
    };
    const first = await stub.botDeliveryResult(payload);
    expect(first.status).toBe("applied");

    const second = await stub.botDeliveryResult({
      ...payload,
      delivery_id: "del-b",
      outbox_id: "out-b",
    });
    expect(second.status).toBe("applied");
    if (first.status !== "applied" || second.status !== "applied") return;
    const firstSend = first.effect_results.find((r) => r.type === "send_message");
    const secondSend = second.effect_results.find((r) => r.type === "send_message");
    expect(firstSend?.type).toBe("send_message");
    expect(secondSend?.type).toBe("send_message");
    if (firstSend?.type !== "send_message" || secondSend?.type !== "send_message") return;

    expect(secondSend.message_id).toBe(firstSend.message_id);
    expect(secondSend.event_id).toBe(firstSend.event_id);
  });

  it("returns BOT_EFFECT_CONFLICT when client_effect_id is reused with different body", async () => {
    const botId = `bot-effect-conflict-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const stub = await createTestChannel(env, { channelId, ownerId: "owner-1" });
    const base = {
      delivery_id: "del-c",
      outbox_id: "out-c",
      bot_id: botId,
      channel_id: channelId,
    };
    const first = sendMessageEffect("eff-conflict", "first");
    await stub.botDeliveryResult({ ...base, effects: [first] });
    const secondEffect = sendMessageEffect("eff-conflict", "different");
    expect(computeEffectRequestHash(first)).not.toBe(computeEffectRequestHash(secondEffect));
    await expectDoRpcError(
      () => stub.botDeliveryResult({ ...base, delivery_id: "del-c2", effects: [secondEffect] }),
      "BOT_EFFECT_CONFLICT",
    );
  });

  it("rejects append_stream with BOT_EFFECT_INVALID", async () => {
    const botId = `bot-effect-stream-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const stub = await createTestChannel(env, { channelId, ownerId: "owner-1" });
    const body = await stub.botDeliveryResult({
      delivery_id: "del-s",
      outbox_id: "out-s",
      bot_id: botId,
      channel_id: channelId,
      effects: [{ type: "append_stream", client_effect_id: "eff-stream", seq: 1, delta: "x" }],
    });
    expect(body.status).toBe("failed");
    if (body.status !== "failed") return;
    expect(body.error.code).toBe("BOT_EFFECT_INVALID");
  });

  it("applies send_message type=image after presign+finalize round-trip", async () => {
    const botId = `bot-effect-img-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const ownerId = "owner-1";
    const stub = await createTestChannel(env, { channelId, ownerId });
    await seedBotBinding(channelId, botId, ownerId);
    const attachmentId = await presignAndFinalizeBotAttachment(stub, channelId, botId, fake, "idem-roundtrip");

    const effect = sendImageMessageEffect("eff-img-send", [attachmentId]);
    const body = await stub.botDeliveryResult({
      delivery_id: "del-img",
      outbox_id: "out-img",
      bot_id: botId,
      channel_id: channelId,
      effects: [effect],
    });
    expect(body.status).toBe("applied");
    if (body.status !== "applied") return;
    const sendResult = body.effect_results.find((r) => r.type === "send_message");
    expect(sendResult?.type).toBe("send_message");
    if (sendResult?.type !== "send_message") return;

    await withDoState(stub, (ctx) => {
      const message = ctx.storage.sql
        .exec("SELECT type, text FROM messages WHERE message_id=?", sendResult.message_id)
        .toArray()[0] as { type: string; text: string };
      expect(message.type).toBe("image");
      expect(message.text).toBe("");

      const links = ctx.storage.sql
        .exec(
          "SELECT attachment_id FROM message_attachments WHERE message_id=?",
          sendResult.message_id,
        )
        .toArray() as Array<{ attachment_id: string }>;
      expect(links.map((row) => row.attachment_id)).toEqual([attachmentId]);
    });
  });

  it("rejects send_message with attachment from wrong channel", async () => {
    const botId = `bot-effect-wrong-ch-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelA = crypto.randomUUID();
    const channelB = crypto.randomUUID();
    const ownerId = "owner-1";
    const stubA = await createTestChannel(env, { channelId: channelA, ownerId });
    const stubB = await createTestChannel(env, { channelId: channelB, ownerId });
    await seedBotBinding(channelA, botId, ownerId);
    await seedBotBinding(channelB, botId, ownerId);
    const attachmentId = await presignAndFinalizeBotAttachment(stubA, channelA, botId, fake, "idem-wrong-ch");

    const body = await stubB.botDeliveryResult({
      delivery_id: "del-wrong-ch",
      outbox_id: "out-wrong-ch",
      bot_id: botId,
      channel_id: channelB,
      effects: [sendImageMessageEffect("eff-wrong-ch", [attachmentId])],
    });
    expect(body.status).toBe("failed");
    if (body.status !== "failed") return;
    expect(body.error.code).toBe("BOT_EFFECT_INVALID");
  });

  it("rejects send_message with pending attachment", async () => {
    const botId = `bot-effect-pending-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const ownerId = "owner-1";
    const stub = await createTestChannel(env, { channelId, ownerId });
    await seedBotBinding(channelId, botId, ownerId);
    const presign = await stub.botAttachmentPresign({
      channel_id: channelId,
      bot_id: botId,
      idempotency_key: "idem-pending",
      filename: "img.png",
      mime_type: "image/png",
      size_bytes: 5000,
    });

    const body = await stub.botDeliveryResult({
      delivery_id: "del-pending",
      outbox_id: "out-pending",
      bot_id: botId,
      channel_id: channelId,
      effects: [sendImageMessageEffect("eff-pending", [presign.attachment_id])],
    });
    expect(body.status).toBe("failed");
    if (body.status !== "failed") return;
    expect(body.error.code).toBe("BOT_EFFECT_INVALID");
  });

  it("rejects send_message with user-owned attachment", async () => {
    const botId = `bot-effect-user-att-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const ownerId = "owner-1";
    const stub = await createTestChannel(env, { channelId, ownerId });
    await seedBotBinding(channelId, botId, ownerId);
    const userAttachmentId = `user-att-${crypto.randomUUID()}`;

    await withDoState(stub, (ctx) => {
      ctx.storage.sql.exec(
        `INSERT INTO attachments (
          attachment_id, owner_user_id, owner_bot_id, channel_id, kind, filename, mime_type, size_bytes,
          width, height, storage_key, url, status, created_at
        ) VALUES (?, ?, NULL, NULL, 'image', 'u.png', 'image/png', 1, 1, 1, 'k', 'https://x/u.png', 'finalized', ?)`,
        userAttachmentId,
        ownerId,
        new Date().toISOString(),
      );
    });

    const body = await stub.botDeliveryResult({
      delivery_id: "del-user-att",
      outbox_id: "out-user-att",
      bot_id: botId,
      channel_id: channelId,
      effects: [sendImageMessageEffect("eff-user-att", [userAttachmentId])],
    });
    expect(body.status).toBe("failed");
    if (body.status !== "failed") return;
    expect(body.error.code).toBe("BOT_EFFECT_INVALID");
  });
});
