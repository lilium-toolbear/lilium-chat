import { afterAll, afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import {
  buildBotStreamAppend,
  buildBotStreamHello,
  parseBotStreamAppendAck,
  parseBotStreamError,
  parseBotStreamReady,
} from "../../src/chat/bot-stream-protocol";
import { validateAppendSeq } from "../../src/chat/stream-seq";
import { BOT_STREAM_API_VERSION } from "../../src/contract/bot-stream";
import { hashBotToken } from "../../src/auth/bot";
import { botStreamDoName } from "../../src/do/bot-stream-connection";
import { createTestChannel, drainPoolWorkerTeardown, enqueueBotInvocationDelivery, getNamedDo, userConnectionTestStub } from "../helpers";
import type { BotConnection } from "../../src/do/bot-connection";
import type { ChannelFanout } from "../../src/do/channel-fanout";
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
    const now = Date.now();
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
    // Restore flush/fanout clocks so a later append on the same socket does not
    // immediately re-flush because last_flush_at_ms was left in the past.
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment() as Record<string, unknown> | null;
      if (!att) continue;
      ws.serializeAttachment({
        ...att,
        last_flush_at_ms: now,
        fanout_due_at_ms: 0,
      });
    }
  });
}

async function yieldToStreamDo(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function seedDeliverableLease(
  uc: DurableObjectStub,
  fanout: DurableObjectStub<ChannelFanout>,
  channelId: string,
  userId: string,
  sessionId: string,
  leaseId: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(uc, async (_instance: unknown, state: any) => {
    state.storage.sql.exec(
      "UPDATE live_sessions SET status='live' WHERE session_id=?",
      sessionId,
    );
    state.storage.sql.exec(
      `INSERT INTO live_channel_leases (
        session_id, channel_id, route_name, lease_id, membership_version,
        status, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, datetime('now'), datetime('now'))
      ON CONFLICT(session_id, channel_id) DO UPDATE SET
        lease_id=excluded.lease_id,
        membership_version=excluded.membership_version,
        status='active',
        expires_at=excluded.expires_at,
        updated_at=datetime('now')`,
      sessionId,
      channelId,
      channelId,
      leaseId,
      1,
      expiresAt,
    );
  });
  await fanout.leaseUpsert({
    channel_id: channelId,
    lease_id: leaseId,
    user_id: userId,
    session_id: sessionId,
    membership_version: 1,
    expires_at: expiresAt,
  });
}

describe("stream-seq validation", () => {
  it("detects durable no-op, accept, gap, and unacked duplicate", () => {
    expect(validateAppendSeq({ seq: 1, ackSeq: 2, receivedSeq: 2 }).kind).toBe("durable_noop");
    expect(validateAppendSeq({ seq: 3, ackSeq: 1, receivedSeq: 2 }).kind).toBe("accept");
    expect(validateAppendSeq({ seq: 5, ackSeq: 1, receivedSeq: 2 }).kind).toBe("sequence_gap");
    expect(validateAppendSeq({ seq: 2, ackSeq: 1, receivedSeq: 3 }).kind).toBe("unacked_duplicate");
  });
});

describe("BotStreamConnection append", () => {
  it("acks seq 1..N after durable flush", async () => {
    const botId = `bot-append-${crypto.randomUUID()}`;
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
    ws.send(JSON.stringify(buildBotStreamAppend({ seq: 1, delta: "a" })));
    ws.send(JSON.stringify(buildBotStreamAppend({ seq: 2, delta: "b" })));
    ws.send(JSON.stringify(buildBotStreamAppend({ seq: 3, delta: "c" })));
    await yieldToStreamDo();
    const ackPromise = nextMessageOfType(ws, "append_ack");
    await triggerStreamAlarm(channelId, messageId);
    const ackRaw = await ackPromise;
    const appendAck = parseBotStreamAppendAck(ackRaw);
    expect(appendAck.ack_seq).toBe(3);

    const dump = (await (
      await streamStub(channelId, messageId).fetch(
        new Request("https://x/dump", { headers: { "X-Test-Only": "1" } }),
      )
    ).json()) as { stream_state: Array<{ flushed_text: string; ack_seq: number }> };
    expect(dump.stream_state[0]?.flushed_text).toBe("abc");
    expect(Number(dump.stream_state[0]?.ack_seq)).toBe(3);

    ws.close();
    browserWs.close();
  });

  it("reconnect resumes at ready.ack_seq without duplicating buffer", async () => {
    const botId = `bot-reconnect-${crypto.randomUUID()}`;
    await seedBot({ botId, token: `tok-${botId}` });
    const { channelId, browserWs } = await setupStreamChannel();
    const ack = await applyStartStream({
      botId,
      channelId,
      clientEffectId: `eff-${crypto.randomUUID()}`,
    });
    const messageId = ack.effect_results?.[0]?.message_id as string;
    const expiresAt = ack.effect_results?.[0]?.stream?.expires_at as string;

    const { ws: ws1 } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    const ack1Promise = nextMessageOfType(ws1, "append_ack");
    ws1.send(JSON.stringify(buildBotStreamAppend({ seq: 1, delta: "hello" })));
    await yieldToStreamDo();
    await triggerStreamAlarm(channelId, messageId);
    const ack1 = parseBotStreamAppendAck(await ack1Promise);
    expect(ack1.ack_seq).toBe(1);

    ws1.send(JSON.stringify(buildBotStreamAppend({ seq: 2, delta: "!" })));
    await yieldToStreamDo();
    const preReconnect = (await (
      await streamStub(channelId, messageId).fetch(
        new Request("https://x/dump", { headers: { "X-Test-Only": "1" } }),
      )
    ).json()) as { stream_state: Array<{ flushed_text: string; ack_seq: number }> };
    expect(preReconnect.stream_state[0]?.flushed_text).toBe("hello");
    expect(Number(preReconnect.stream_state[0]?.ack_seq)).toBe(1);

    ws1.close();

    const { ws: ws2, ready } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    expect(ready.ack_seq).toBe(1);

    const ack2Promise = nextMessageOfType(ws2, "append_ack");
    ws2.send(JSON.stringify(buildBotStreamAppend({ seq: 2, delta: "!" })));
    await yieldToStreamDo();
    await triggerStreamAlarm(channelId, messageId);
    const ack2 = parseBotStreamAppendAck(await ack2Promise);
    expect(ack2.ack_seq).toBe(2);

    const dump = (await (
      await streamStub(channelId, messageId).fetch(
        new Request("https://x/dump", { headers: { "X-Test-Only": "1" } }),
      )
    ).json()) as { stream_state: Array<{ flushed_text: string }> };
    expect(dump.stream_state[0]?.flushed_text).toBe("hello!");

    ws2.close();
    browserWs.close();
  });

  it("returns BOT_STREAM_SEQUENCE_GAP for skipped seq", async () => {
    const botId = `bot-gap-${crypto.randomUUID()}`;
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
    ws.send(JSON.stringify(buildBotStreamAppend({ seq: 1, delta: "a" })));
    await yieldToStreamDo();
    const ack1Promise = nextMessageOfType(ws, "append_ack");
    await triggerStreamAlarm(channelId, messageId);
    await ack1Promise;

    const gapPromise = nextMessageOfType(ws, "stream_error");
    ws.send(JSON.stringify(buildBotStreamAppend({ seq: 3, delta: "c" })));
    const errRaw = await gapPromise;
    const err = parseBotStreamError(errRaw);
    expect(err.code).toBe("BOT_STREAM_SEQUENCE_GAP");
    expect(err.retryable).toBe(true);

    ws.close();
    browserWs.close();
  });

  it("returns BOT_STREAM_CONFLICT for duplicate unacked seq with different delta", async () => {
    const botId = `bot-conflict-${crypto.randomUUID()}`;
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
    ws.send(JSON.stringify(buildBotStreamAppend({ seq: 1, delta: "first" })));
    await yieldToStreamDo();

    const errPromise = nextMessageOfType(ws, "stream_error");
    ws.send(JSON.stringify(buildBotStreamAppend({ seq: 1, delta: "second" })));
    const errRaw = await errPromise;
    const err = parseBotStreamError(errRaw);
    expect(err.code).toBe("BOT_STREAM_CONFLICT");

    ws.close();
    browserWs.close();
  });

  it("batches live message.stream_delta frames via ChannelFanout", async () => {
    const botId = `bot-fanout-${crypto.randomUUID()}`;
    await seedBot({ botId, token: `tok-${botId}` });
    const { channelId, browserWs, viewerUserId } = await setupStreamChannel();
    browserWs.close();
    const ack = await applyStartStream({
      botId,
      channelId,
      clientEffectId: `eff-${crypto.randomUUID()}`,
    });
    const messageId = ack.effect_results?.[0]?.message_id as string;
    const expiresAt = ack.effect_results?.[0]?.stream?.expires_at as string;

    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT as unknown as DurableObjectNamespace<ChannelFanout>, channelId);
    const uc = getNamedDo(env.USER_CONNECTION as unknown as DurableObjectNamespace, viewerUserId);
    const wsRes = await uc.fetch(
      new Request("https://x/ws", { headers: { Upgrade: "websocket", "X-Verified-User-Id": viewerUserId } }),
    );
    const browserConn = wsRes.webSocket as WebSocket;
    browserConn.accept();
    await liveStartAndAck(browserConn, `cmd-fanout-${channelId}`);

    let sessionId = "";
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(uc, async (_instance: unknown, state: any) => {
      const socket = state.getWebSockets()[0];
      const att = socket?.deserializeAttachment() as { session_id?: string } | null;
      sessionId = att?.session_id ?? "";
    });
    await seedDeliverableLease(uc, fanout, channelId, viewerUserId, sessionId, `lease-${channelId}`);

    const { ws: streamWs } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    streamWs.send(JSON.stringify(buildBotStreamAppend({ seq: 1, delta: "aa" })));
    streamWs.send(JSON.stringify(buildBotStreamAppend({ seq: 2, delta: "bb" })));
    await yieldToStreamDo();
    await triggerStreamAlarm(channelId, messageId);

    const probe = await userConnectionTestStub(env, viewerUserId).debugLastDeliver();
    expect(probe.event_json).toBeTruthy();
    const frame = JSON.parse(probe.event_json!) as {
      frame_type: string;
      type: string;
      stream_seq: number;
      payload: { message_id: string; delta: string };
    };
    expect(frame.frame_type).toBe("stream_event");
    expect(frame.type).toBe("message.stream_delta");
    expect(frame.payload.message_id).toBe(messageId);
    expect(frame.payload.delta).toBe("aabb");
    expect(frame.stream_seq).toBe(2);

    streamWs.close();
    browserConn.close();
  });
});
