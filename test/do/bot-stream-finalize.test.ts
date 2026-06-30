import { afterAll, afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import {
  buildBotStreamAppend,
  buildBotStreamFinalize,
  buildBotStreamHello,
  parseBotStreamAppendAck,
  parseBotStreamError,
  parseBotStreamFinalizedAck,
  parseBotStreamReady,
} from "../../src/chat/bot-stream-protocol";
import { BOT_STREAM_API_VERSION } from "../../src/contract/bot-stream";
import { hashBotToken } from "../../src/auth/bot";
import { botStreamDoName } from "../../src/do/bot-stream-connection";
import { createTestChannel, drainPoolWorkerTeardown, enqueueBotInvocationDelivery, getNamedDo } from "../helpers";
import type { BotConnection } from "../../src/do/bot-connection";
import { liveStartAndAck, upgradeUserConnection } from "../ws-helpers";

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

afterEach(async () => {
  for (const botId of [...seededBotIds]) {
    await withRegistry((ctx) => {
      ctx.storage.sql.exec("DELETE FROM bot_tokens WHERE bot_id=?", botId);
      ctx.storage.sql.exec("DELETE FROM bot_apps WHERE bot_id=?", botId);
    });
  }
  seededBotIds.clear();
});

afterAll(async () => {
  await drainPoolWorkerTeardown();
});

function botConnectionStub(botId: string): DurableObjectStub<BotConnection> {
  return getNamedDo(env.BOT_CONNECTION as unknown as DurableObjectNamespace<BotConnection>, botId);
}

function streamStub(channelId: string, messageId: string): DurableObjectStub {
  return getNamedDo(
    env.BOT_STREAM_CONNECTION as unknown as DurableObjectNamespace,
    botStreamDoName(channelId, messageId),
  );
}

function channelStub(channelId: string): DurableObjectStub {
  return getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace, channelId);
}

async function nextMessageOfType(ws: WebSocket, type: string, timeoutMs = 5000): Promise<string> {
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
  const stub = botConnectionStub(input.botId);
  const outboxId = `out-${crypto.randomUUID()}`;
  await enqueueBotInvocationDelivery(stub, input.botId, {
    outbox_id: outboxId,
    channel_id: input.channelId,
  });
  const botWs = await openBotConnection(input.botId);

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
      stream?: { ws_url: string; expires_at: string };
    }>;
  };
}

async function setupStreamChannel(viewerUserId = "owner-1") {
  const channelId = crypto.randomUUID();
  await createTestChannel(env, { channelId, ownerId: viewerUserId });
  const { ws: browserWs } = await upgradeUserConnection(viewerUserId);
  await liveStartAndAck(browserWs, `cmd-live-${channelId}`);
  return { channelId, browserWs, viewerUserId };
}

async function openStreamWs(input: {
  botId: string;
  channelId: string;
  messageId: string;
  expiresAt: string;
}): Promise<{ ws: WebSocket; ready: ReturnType<typeof parseBotStreamReady> }> {
  const stub = streamStub(input.channelId, input.messageId);
  const res = await stub.fetch(
    new Request("https://x/", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": BOT_STREAM_API_VERSION,
        "X-Verified-Bot-Id": input.botId,
        "X-Channel-Id": input.channelId,
        "X-Message-Id": input.messageId,
        "X-Stream-Expires-At": input.expiresAt,
      },
    }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  ws.send(JSON.stringify(buildBotStreamHello()));
  const readyRaw = await nextMessageOfType(ws, "ready");
  return { ws, ready: parseBotStreamReady(readyRaw) };
}

async function triggerStreamAlarm(channelId: string, messageId: string): Promise<void> {
  const stub = streamStub(channelId, messageId);
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stub, async (instance: unknown, state: any) => {
    const ago = Date.now() - 10_000;
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment() as Record<string, unknown> | null;
      if (!att) continue;
      ws.serializeAttachment({
        ...att,
        last_flush_at_ms: ago,
        fanout_due_at_ms: ago,
      });
    }
    state.storage.sql.exec("UPDATE stream_due_jobs SET due_at_ms=? WHERE status='pending'", ago);
    await (instance as { alarm: () => Promise<void> }).alarm();
  });
}

async function yieldToStreamDo(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function appendAndFlush(
  ws: WebSocket,
  channelId: string,
  messageId: string,
  deltas: Array<{ seq: number; delta: string }>,
): Promise<number> {
  for (const { seq, delta } of deltas) {
    ws.send(JSON.stringify(buildBotStreamAppend({ seq, delta })));
    await yieldToStreamDo();
  }
  const ackPromise = nextMessageOfType(ws, "append_ack");
  await triggerStreamAlarm(channelId, messageId);
  const ack = parseBotStreamAppendAck(await ackPromise);
  return ack.ack_seq;
}

describe("BotStreamConnection finalize", () => {
  it("finalizes with one stream_finalized event and no message.created", async () => {
    const botId = `bot-fin-${crypto.randomUUID()}`;
    await seedBot({ botId, token: `tok-${botId}` });
    const { channelId, browserWs } = await setupStreamChannel();
    const ack = await applyStartStream({
      botId,
      channelId,
      clientEffectId: `eff-${crypto.randomUUID()}`,
    });
    const messageId = ack.effect_results?.[0]?.message_id as string;
    const expiresAt = ack.effect_results?.[0]?.stream?.expires_at as string;

    const { ws } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    const ackSeq = await appendAndFlush(ws, channelId, messageId, [
      { seq: 1, delta: "hello " },
      { seq: 2, delta: "world" },
    ]);
    expect(ackSeq).toBe(2);

    const resolvedText = "hello world";

    const finPromise = nextMessageOfType(ws, "finalized_ack");
    ws.send(JSON.stringify(buildBotStreamFinalize({ final_seq: 2, components: [], attachment_ids: [] })));
    const finAck = parseBotStreamFinalizedAck(await finPromise);
    expect(finAck.message_id).toBe(messageId);
    expect(finAck.event_id).toBeTruthy();

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(channelStub(channelId), async (instance: unknown) => {
      const ctx = (instance as { ctx: DurableObjectState }).ctx;
      const event = ctx.storage.sql
        .exec("SELECT event_type FROM events WHERE event_id=?", finAck.event_id)
        .toArray()[0] as { event_type: string };
      expect(event.event_type).toBe("message.stream_finalized");

      const createdCount = ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS c FROM events WHERE event_type='message.created' AND payload_json LIKE ?",
          `%${messageId}%`,
        )
        .toArray()[0] as { c: number };
      expect(Number(createdCount.c)).toBe(0);

      const message = ctx.storage.sql
        .exec("SELECT text, stream_state FROM messages WHERE message_id=?", messageId)
        .toArray()[0] as { text: string; stream_state: string };
      expect(message.text).toBe(resolvedText);
      expect(message.stream_state).toBe("final");
    });

    browserWs.close();
  });

  it("returns BOT_STREAM_SEQUENCE_GAP when final_seq exceeds received_seq", async () => {
    const botId = `bot-fin-gap-${crypto.randomUUID()}`;
    await seedBot({ botId, token: `tok-${botId}` });
    const { channelId, browserWs } = await setupStreamChannel();
    const ack = await applyStartStream({
      botId,
      channelId,
      clientEffectId: `eff-${crypto.randomUUID()}`,
    });
    const messageId = ack.effect_results?.[0]?.message_id as string;
    const expiresAt = ack.effect_results?.[0]?.stream?.expires_at as string;

    const { ws } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    await appendAndFlush(ws, channelId, messageId, [{ seq: 1, delta: "a" }]);

    const errPromise = nextMessageOfType(ws, "stream_error");
    ws.send(JSON.stringify(buildBotStreamFinalize({ final_seq: 3 })));
    const err = parseBotStreamError(await errPromise);
    expect(err.code).toBe("BOT_STREAM_SEQUENCE_GAP");

    browserWs.close();
    ws.close();
  });

  it("returns BOT_STREAM_CONFLICT when final_seq is behind received_seq", async () => {
    const botId = `bot-fin-conflict-${crypto.randomUUID()}`;
    await seedBot({ botId, token: `tok-${botId}` });
    const { channelId, browserWs } = await setupStreamChannel();
    const ack = await applyStartStream({
      botId,
      channelId,
      clientEffectId: `eff-${crypto.randomUUID()}`,
    });
    const messageId = ack.effect_results?.[0]?.message_id as string;
    const expiresAt = ack.effect_results?.[0]?.stream?.expires_at as string;

    const { ws } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    await appendAndFlush(ws, channelId, messageId, [
      { seq: 1, delta: "a" },
      { seq: 2, delta: "b" },
    ]);

    const errPromise = nextMessageOfType(ws, "stream_error");
    ws.send(JSON.stringify(buildBotStreamFinalize({ final_seq: 1 })));
    const err = parseBotStreamError(await errPromise);
    expect(err.code).toBe("BOT_STREAM_CONFLICT");

    browserWs.close();
    ws.close();
  });

  it("is idempotent when finalize is repeated with the same request", async () => {
    const botId = `bot-fin-idem-${crypto.randomUUID()}`;
    await seedBot({ botId, token: `tok-${botId}` });
    const { channelId, browserWs } = await setupStreamChannel();
    const ack = await applyStartStream({
      botId,
      channelId,
      clientEffectId: `eff-${crypto.randomUUID()}`,
    });
    const messageId = ack.effect_results?.[0]?.message_id as string;
    const expiresAt = ack.effect_results?.[0]?.stream?.expires_at as string;

    const { ws } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    await appendAndFlush(ws, channelId, messageId, [{ seq: 1, delta: "done" }]);

    const fin1Promise = nextMessageOfType(ws, "finalized_ack");
    ws.send(JSON.stringify(buildBotStreamFinalize({ final_seq: 1 })));
    const fin1 = parseBotStreamFinalizedAck(await fin1Promise);

    const { ws: ws2 } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    const fin2Promise = nextMessageOfType(ws2, "finalized_ack");
    ws2.send(JSON.stringify(buildBotStreamFinalize({ final_seq: 1 })));
    const fin2 = parseBotStreamFinalizedAck(await fin2Promise);
    expect(fin2).toEqual(fin1);

    browserWs.close();
    ws.close();
    ws2.close();
  });

  it("returns BOT_STREAM_CONFLICT when components differ but text matches", async () => {
    const botId = `bot-fin-comp-${crypto.randomUUID()}`;
    await seedBot({ botId, token: `tok-${botId}` });
    const { channelId, browserWs } = await setupStreamChannel();
    const ack = await applyStartStream({
      botId,
      channelId,
      clientEffectId: `eff-${crypto.randomUUID()}`,
    });
    const messageId = ack.effect_results?.[0]?.message_id as string;
    const expiresAt = ack.effect_results?.[0]?.stream?.expires_at as string;

    const { ws } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    await appendAndFlush(ws, channelId, messageId, [{ seq: 1, delta: "same" }]);

    const componentsA = [
      {
        component_id: "c1",
        kind: "button",
        style: "primary",
        custom_id: "btn-1",
        label: "OK",
      },
    ];
    const fin1Promise = nextMessageOfType(ws, "finalized_ack");
    ws.send(JSON.stringify(buildBotStreamFinalize({ final_seq: 1, components: componentsA })));
    await fin1Promise;

    const { ws: ws2 } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    const errPromise = nextMessageOfType(ws2, "stream_error");
    ws2.send(
      JSON.stringify(
        buildBotStreamFinalize({
          final_seq: 1,
          components: [{ ...componentsA[0], label: "Different" }],
        }),
      ),
    );
    const err = parseBotStreamError(await errPromise);
    expect(err.code).toBe("BOT_STREAM_CONFLICT");

    browserWs.close();
    ws.close();
    ws2.close();
  });

  it("rejects attachment_ids on finalize", async () => {
    const botId = `bot-fin-att-${crypto.randomUUID()}`;
    await seedBot({ botId, token: `tok-${botId}` });
    const { channelId, browserWs } = await setupStreamChannel();
    const ack = await applyStartStream({
      botId,
      channelId,
      clientEffectId: `eff-${crypto.randomUUID()}`,
    });
    const messageId = ack.effect_results?.[0]?.message_id as string;
    const expiresAt = ack.effect_results?.[0]?.stream?.expires_at as string;

    const { ws } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    await appendAndFlush(ws, channelId, messageId, [{ seq: 1, delta: "x" }]);

    const errPromise = nextMessageOfType(ws, "stream_error");
    ws.send(JSON.stringify(buildBotStreamFinalize({ final_seq: 1, attachment_ids: ["att-1"] })));
    const err = parseBotStreamError(await errPromise);
    expect(err.code).toBe("BOT_EFFECT_INVALID");

    browserWs.close();
    ws.close();
  });
});
