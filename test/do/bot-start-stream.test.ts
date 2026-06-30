import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import { buildBotStreamWsUrl } from "../../src/chat/stream-registry";
import { createTestChannel, enqueueBotInvocationDelivery, getNamedDo, userConnectionTestStub } from "../helpers";
import type { BotConnection } from "../../src/do/bot-connection";
import type { ChatChannel } from "../../src/do/chat-channel";
import { liveStartAndAck, upgradeUserConnection } from "../ws-helpers";

const REGISTRY = () =>
  getNamedDo(env.BOT_REGISTRY as unknown as DurableObjectNamespace, "registry");

const seededBots = new Set<string>();

async function withRegistry(
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(REGISTRY(), async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function seedBot(botId: string): Promise<void> {
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      botId,
      "owner-1",
      "Stream Bot",
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

function botConnectionStub(botId: string): DurableObjectStub<BotConnection> {
  return getNamedDo(env.BOT_CONNECTION as unknown as DurableObjectNamespace<BotConnection>, botId);
}

async function openBotConnection(botId: string): Promise<WebSocket> {
  const stub = botConnectionStub(botId);
  const res = await stub.fetch(
    new Request("https://x/bot", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": BOT_GATEWAY_API_VERSION,
        "X-Verified-Bot-Id": botId,
      },
    }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  ws.send(
    JSON.stringify({
      type: "hello",
      api_version: BOT_GATEWAY_API_VERSION,
      last_received_delivery_id: null,
    }),
  );
  await nextMessageOfType(ws, "ready");
  return ws;
}

function nextMessageOfType<T extends string>(ws: WebSocket, type: T, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const handler = (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      try {
        const frame = JSON.parse(data) as { type?: unknown };
        if (frame.type === type) {
          clearTimeout(t);
          ws.removeEventListener("message", handler);
          resolve(data);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function applyStartStreamOnChannel(input: {
  botId: string;
  channelId: string;
  clientEffectId: string;
}) {
  const botWs = await openBotConnection(input.botId);
  const stub = botConnectionStub(input.botId);
  const outboxId = `out-${crypto.randomUUID()}`;
  await enqueueBotInvocationDelivery(stub, input.botId, {
    outbox_id: outboxId,
    channel_id: input.channelId,
  });

  const deliveryFrame = JSON.parse(await nextMessageOfType(botWs, "delivery")) as { delivery_id: string };
  botWs.send(
    JSON.stringify({
      type: "delivery_result",
      api_version: BOT_GATEWAY_API_VERSION,
      delivery_id: deliveryFrame.delivery_id,
      status: "ok",
      effects: [
        {
          type: "start_stream",
          client_effect_id: input.clientEffectId,
          message: {
            type: "text",
            format: "plain",
            text: "ignored during start",
            reply_to_message_id: null,
            attachment_ids: [],
            components: [],
          },
        },
      ],
    }),
  );

  const ackRaw = await nextMessageOfType(botWs, "delivery_ack");
  return JSON.parse(ackRaw) as {
    status: string;
    effect_results?: Array<{
      type: string;
      message_id?: string;
      stream?: { ws_url: string; channel_id: string; message_id: string; expires_at: string };
    }>;
  };
}

async function setupStreamChannel(viewerUserId = "owner-1") {
  const channelId = crypto.randomUUID();
  await createTestChannel(env, { channelId, ownerId: viewerUserId });
  const { ws: browserWs } = await upgradeUserConnection(viewerUserId);
  await liveStartAndAck(browserWs, `cmd-live-${channelId}`);
  const channelStub = getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace, channelId);
  return { channelId, browserWs, channelStub, viewerUserId };
}

describe("start_stream via bot delivery_result", () => {
  it("creates registry row and returns stream.ws_url in delivery_ack", async () => {
    const botId = `bot-start-${crypto.randomUUID()}`;
    await seedBot(botId);
    const clientEffectId = `eff-start-${crypto.randomUUID()}`;
    const { channelId, channelStub } = await setupStreamChannel();

    const ack = await applyStartStreamOnChannel({ botId, channelId, clientEffectId });

    expect(ack.status).toBe("applied");
    expect(ack.effect_results?.[0]?.type).toBe("start_stream");
    const messageId = ack.effect_results?.[0]?.message_id;
    const stream = ack.effect_results?.[0]?.stream;
    expect(messageId).toBeTruthy();
    expect(stream?.ws_url).toBe(buildBotStreamWsUrl(channelId, messageId!));
    expect(stream?.channel_id).toBe(channelId);
    expect(stream?.message_id).toBe(messageId);
    expect(stream?.expires_at).toBeTruthy();

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(channelStub, async (instance: unknown) => {
      const state = (instance as { ctx: DurableObjectState }).ctx;
      const registry = state.storage.sql
        .exec("SELECT status, message_json FROM message_stream_registry WHERE channel_id=? AND message_id=?", channelId, messageId)
        .toArray()[0] as { status: string; message_json: string };
      expect(registry.status).toBe("streaming");
      const metadata = JSON.parse(registry.message_json) as { type: string; format: string };
      expect(metadata.type).toBe("text");
      expect(metadata.format).toBe("plain");

      const messageCount = state.storage.sql
        .exec("SELECT COUNT(*) AS c FROM messages WHERE message_id=?", messageId)
        .toArray()[0] as { c: number };
      expect(Number(messageCount.c)).toBe(0);

      const createdEvents = state.storage.sql
        .exec("SELECT COUNT(*) AS c FROM events WHERE event_type='message.created'")
        .toArray()[0] as { c: number };
      expect(Number(createdEvents.c)).toBe(0);
    });
  });

  it("keeps streaming message absent from HTTP history", async () => {
    const botId = `bot-hist-${crypto.randomUUID()}`;
    await seedBot(botId);
    const clientEffectId = `eff-hist-${crypto.randomUUID()}`;
    const { channelId, channelStub, viewerUserId } = await setupStreamChannel();

    const ack = await applyStartStreamOnChannel({ botId, channelId, clientEffectId });
    const messageId = ack.effect_results?.[0]?.message_id as string;

    const history = await (channelStub as DurableObjectStub<ChatChannel>).getMessages(viewerUserId, {
      before: null,
      after: null,
      limit: 10,
    });
    const found = history.items.some(
      (item) => "message" in item.payload && item.payload.message?.message_id === messageId,
    );
    expect(found).toBe(false);
  });

  it("emits live message.stream_started to browser sessions", async () => {
    const botId = `bot-live-${crypto.randomUUID()}`;
    await seedBot(botId);
    const clientEffectId = `eff-live-${crypto.randomUUID()}`;
    const { channelId, browserWs, viewerUserId } = await setupStreamChannel();

    const ack = await applyStartStreamOnChannel({ botId, channelId, clientEffectId });
    const messageId = ack.effect_results?.[0]?.message_id as string;

    const uc = userConnectionTestStub(env, viewerUserId);
    const probe = await uc.debugLastDeliver();
    expect(probe.event_json).toBeTruthy();
    const frame = JSON.parse(probe.event_json!) as {
      frame_type: string;
      type: string;
      payload: { message: { message_id: string; stream_state: string; text: string | null } };
    };
    expect(frame.frame_type).toBe("stream_event");
    expect(frame.type).toBe("message.stream_started");
    expect(frame.payload.message.message_id).toBe(messageId);
    expect(frame.payload.message.stream_state).toBe("streaming");
    expect(frame.payload.message.text).toBe("");

    browserWs.close();
  });

  it("returns cached effect_results on identical start_stream retry", async () => {
    const botId = `bot-idem-${crypto.randomUUID()}`;
    await seedBot(botId);
    const clientEffectId = `eff-idem-${crypto.randomUUID()}`;
    const { channelId, channelStub, browserWs } = await setupStreamChannel();

    const first = await applyStartStreamOnChannel({ botId, channelId, clientEffectId });
    const second = await applyStartStreamOnChannel({ botId, channelId, clientEffectId });

    expect(second.effect_results?.[0]?.message_id).toBe(first.effect_results?.[0]?.message_id);
    expect(second.effect_results?.[0]?.stream?.ws_url).toBe(first.effect_results?.[0]?.stream?.ws_url);

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(channelStub, async (instance: unknown) => {
      const state = (instance as { ctx: DurableObjectState }).ctx;
      const count = state.storage.sql
        .exec("SELECT COUNT(*) AS c FROM message_stream_registry WHERE channel_id=?", channelId)
        .toArray()[0] as { c: number };
      expect(Number(count.c)).toBe(1);
    });

    browserWs.close();
  });
});
