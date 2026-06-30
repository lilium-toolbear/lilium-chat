import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { computeEffectRequestHash } from "../../src/chat/bot-effects";
import { createTestChannel, expectDoRpcError, getNamedDo } from "../helpers";

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

describe("ChatChannel botDeliveryResult RPC", () => {
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
});
