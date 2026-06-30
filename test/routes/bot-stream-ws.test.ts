import { afterAll, afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import { buildBotStreamHello, parseBotStreamReady } from "../../src/chat/bot-stream-protocol";
import { BOT_STREAM_API_VERSION } from "../../src/contract/bot-stream";
import { hashBotToken } from "../../src/auth/bot";
import { createTestChannel, drainPoolWorkerTeardown, enqueueBotInvocationDelivery, getNamedDo } from "../helpers";
import type { BotConnection } from "../../src/do/bot-connection";
import { liveStartAndAck, upgradeUserConnection } from "../ws-helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown) => Promise<Response> | Response;
};

const REGISTRY = () =>
  getNamedDo(env.BOT_REGISTRY as unknown as DurableObjectNamespace, "registry");

const seededBotIds = new Set<string>();

async function withRegistry(
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(REGISTRY(), async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function seedBot(opts: {
  botId: string;
  token: string;
  scopes?: string[];
}): Promise<void> {
  const tokenHash = await hashBotToken(opts.token);
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      opts.botId,
      "owner-1",
      "Stream Bot",
      null,
      null,
      "private",
      "active",
      "2026-06-30T00:00:00.000Z",
      "2026-06-30T00:00:00.000Z",
    );
    ctx.storage.sql.exec(
      `INSERT INTO bot_tokens (token_id, bot_id, name, token_hash, scopes_json, created_at, expires_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `tok-${opts.botId}`,
      opts.botId,
      "default",
      tokenHash,
      JSON.stringify(opts.scopes ?? ["chat:runtime:connect", "chat:messages:write"]),
      "2026-06-30T00:00:00.000Z",
      null,
      null,
      null,
    );
  });
  seededBotIds.add(opts.botId);
}

async function cleanupBot(botId: string): Promise<void> {
  await withRegistry((ctx) => {
    ctx.storage.sql.exec("DELETE FROM bot_tokens WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_apps WHERE bot_id=?", botId);
  });
  seededBotIds.delete(botId);
}

afterEach(async () => {
  for (const botId of [...seededBotIds]) await cleanupBot(botId);
});

afterAll(async () => {
  await drainPoolWorkerTeardown();
});

function botConnectionStub(botId: string): DurableObjectStub<BotConnection> {
  return getNamedDo(env.BOT_CONNECTION as unknown as DurableObjectNamespace<BotConnection>, botId);
}

async function nextMessageOfType(ws: WebSocket, type: string, timeoutMs = 3000): Promise<string> {
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

async function applyStartStream(input: {
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
            text: "",
            reply_to_message_id: null,
            attachment_ids: [],
            components: [],
          },
        },
      ],
    }),
  );

  const ackRaw = await nextMessageOfType(botWs, "delivery_ack");
  botWs.close();
  return JSON.parse(ackRaw) as {
    effect_results?: Array<{
      message_id?: string;
      stream?: { ws_url: string; expires_at: string; channel_id: string; message_id: string };
    }>;
  };
}

async function setupStreamChannel() {
  const channelId = crypto.randomUUID();
  await createTestChannel(env, { channelId, ownerId: "owner-1" });
  const { ws: browserWs } = await upgradeUserConnection("owner-1");
  await liveStartAndAck(browserWs, `cmd-live-${channelId}`);
  const channelStub = getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace, channelId);
  return { channelId, browserWs, channelStub };
}

async function streamWsUpgrade(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": BOT_STREAM_API_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch(
    new Request(`https://chat.kuma.homes${path}`, { method: "GET", headers }),
    env,
  );
}

describe("GET /api/chat/bot/channels/:channel_id/streams/:message_id/ws", () => {
  it("upgrades after start_stream and returns ready frame on hello", async () => {
    const botId = `bot-stream-ws-${crypto.randomUUID()}`;
    const token = `tok-${crypto.randomUUID()}`;
    await seedBot({ botId, token });
    const clientEffectId = `eff-ws-${crypto.randomUUID()}`;
    const { channelId, browserWs } = await setupStreamChannel();

    const ack = await applyStartStream({ botId, channelId, clientEffectId });
    const messageId = ack.effect_results?.[0]?.message_id as string;
    const stream = ack.effect_results?.[0]?.stream;
    expect(stream?.ws_url).toBeTruthy();

    const res = await streamWsUpgrade(stream!.ws_url, token);
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe(BOT_STREAM_API_VERSION);

    const ws = res.webSocket as WebSocket;
    ws.accept();
    ws.send(JSON.stringify(buildBotStreamHello()));
    const readyRaw = await nextMessageOfType(ws, "ready");
    const ready = parseBotStreamReady(readyRaw);
    expect(ready.channel_id).toBe(channelId);
    expect(ready.message_id).toBe(messageId);
    expect(ready.expires_at).toBe(stream!.expires_at);
    expect(ready.ack_seq).toBe(0);

    ws.close();
    browserWs.close();
  });

  it("returns 404 BOT_STREAM_NOT_FOUND for wrong bot before upgrade", async () => {
    const ownerBotId = `bot-owner-${crypto.randomUUID()}`;
    const otherBotId = `bot-other-${crypto.randomUUID()}`;
    const ownerToken = `tok-owner-${crypto.randomUUID()}`;
    const otherToken = `tok-other-${crypto.randomUUID()}`;
    await seedBot({ botId: ownerBotId, token: ownerToken });
    await seedBot({ botId: otherBotId, token: otherToken });
    const { channelId, browserWs } = await setupStreamChannel();

    const ack = await applyStartStream({
      botId: ownerBotId,
      channelId,
      clientEffectId: `eff-wrong-${crypto.randomUUID()}`,
    });
    const wsUrl = ack.effect_results?.[0]?.stream?.ws_url as string;

    const res = await streamWsUpgrade(wsUrl, otherToken);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BOT_STREAM_NOT_FOUND");

    browserWs.close();
  });

  it("returns 403 BOT_SCOPE_DENIED when chat:messages:write is missing", async () => {
    const botId = `bot-noscope-${crypto.randomUUID()}`;
    const token = `tok-noscope-${crypto.randomUUID()}`;
    await seedBot({ botId, token, scopes: ["chat:runtime:connect"] });
    const { channelId, browserWs } = await setupStreamChannel();

    const ack = await applyStartStream({
      botId,
      channelId,
      clientEffectId: `eff-scope-${crypto.randomUUID()}`,
    });
    const wsUrl = ack.effect_results?.[0]?.stream?.ws_url as string;

    const res = await streamWsUpgrade(wsUrl, token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BOT_SCOPE_DENIED");

    browserWs.close();
  });

  it("returns 404 BOT_STREAM_NOT_FOUND when registry row is missing", async () => {
    const botId = `bot-missing-${crypto.randomUUID()}`;
    const token = `tok-missing-${crypto.randomUUID()}`;
    await seedBot({ botId, token });
    const channelId = crypto.randomUUID();
    await createTestChannel(env, { channelId, ownerId: "owner-1" });
    const messageId = crypto.randomUUID();

    const res = await streamWsUpgrade(
      `/api/chat/bot/channels/${channelId}/streams/${messageId}/ws`,
      token,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BOT_STREAM_NOT_FOUND");
  });

  it("returns 410 BOT_STREAM_EXPIRED when registry is expired", async () => {
    const botId = `bot-expired-${crypto.randomUUID()}`;
    const token = `tok-expired-${crypto.randomUUID()}`;
    await seedBot({ botId, token });
    const clientEffectId = `eff-exp-${crypto.randomUUID()}`;
    const { channelId, channelStub, browserWs } = await setupStreamChannel();

    const ack = await applyStartStream({ botId, channelId, clientEffectId });
    const messageId = ack.effect_results?.[0]?.message_id as string;
    const wsUrl = ack.effect_results?.[0]?.stream?.ws_url as string;

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(channelStub, async (instance: unknown) => {
      const ctx = (instance as { ctx: DurableObjectState }).ctx;
      ctx.storage.sql.exec(
        "UPDATE message_stream_registry SET expires_at=? WHERE channel_id=? AND message_id=?",
        new Date(Date.now() - 60_000).toISOString(),
        channelId,
        messageId,
      );
    });

    const res = await streamWsUpgrade(wsUrl, token);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BOT_STREAM_EXPIRED");

    browserWs.close();
  });
});
