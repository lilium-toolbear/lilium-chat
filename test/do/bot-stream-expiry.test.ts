import { afterAll, afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import {
  buildBotStreamAppend,
  buildBotStreamFinalize,
  buildBotStreamHello,
  parseBotStreamAppendAck,
  parseBotStreamError,
  parseBotStreamReady,
} from "../../src/chat/bot-stream-protocol";
import { BOT_STREAM_API_VERSION } from "../../src/contract/bot-stream";
import { computeAbandonedTextHash, computeFinalizeRequestHash } from "../../src/chat/stream-registry";
import { hashBotToken } from "../../src/auth/bot";
import { botStreamDoName } from "../../src/do/bot-stream-connection";
import { createTestChannel, drainPoolWorkerTeardown, expectDoRpcError, getNamedDo } from "../helpers";
import type { ChannelFanout } from "../../src/do/channel-fanout";
import type { UserConnection } from "../../src/do/user-connection";
import type { ChatChannel } from "../../src/do/chat-channel";
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

function channelStub(channelId: string): DurableObjectStub<ChatChannel> {
  return getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace<ChatChannel>, channelId);
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
  await stub.enqueueDelivery(input.botId, {
    outbox_id: outboxId,
    channel_id: input.channelId,
    kind: "command_invocation",
    target_id: "inv-stream",
    request_json: JSON.stringify({
      channel_id: input.channelId,
      invocation_id: "inv-stream",
      command: { name: "ask" },
      invoker: { user_id: "owner-1" },
    }),
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

async function forceStreamExpiry(channelId: string, messageId: string): Promise<void> {
  const past = new Date(Date.now() - 60_000).toISOString();
  const pastMs = Date.now() - 10_000;
  const { runInDurableObject } = await import("cloudflare:test");

  await runInDurableObject(channelStub(channelId), async (_instance: unknown, state: any) => {
    state.storage.sql.exec(
      "UPDATE message_stream_registry SET expires_at=? WHERE channel_id=? AND message_id=?",
      past,
      channelId,
      messageId,
    );
  });

  await runInDurableObject(streamStub(channelId, messageId), async (instance: unknown, state: any) => {
    state.storage.sql.exec(
      "UPDATE stream_state SET expires_at=? WHERE channel_id=? AND message_id=?",
      past,
      channelId,
      messageId,
    );
    state.storage.sql.exec(
      "INSERT INTO stream_due_jobs (job_kind, due_at_ms, status) VALUES ('expiry', ?, 'pending') ON CONFLICT(job_kind) DO UPDATE SET due_at_ms=excluded.due_at_ms, status='pending'",
      pastMs,
    );
    await (instance as { alarm: () => Promise<void> }).alarm();
  });

  await runInDurableObject(channelStub(channelId), async (instance: unknown) => {
    await (instance as { alarm: () => Promise<void> }).alarm();
  });
}

async function appendAndFlush(
  ws: WebSocket,
  channelId: string,
  messageId: string,
  deltas: Array<{ seq: number; delta: string }>,
): Promise<number> {
  for (const { seq, delta } of deltas) {
    ws.send(JSON.stringify(buildBotStreamAppend({ seq, delta })));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const ackPromise = nextMessageOfType(ws, "append_ack");
  await triggerStreamAlarm(channelId, messageId);
  const ack = parseBotStreamAppendAck(await ackPromise);
  return ack.ack_seq;
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
    state.storage.sql.exec("UPDATE live_sessions SET status='live' WHERE session_id=?", sessionId);
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

describe("BotStreamConnection expiry and abandon", () => {
  it("allows disconnect and reconnect before expiry with resume at ack_seq + 1", async () => {
    const botId = `bot-exp-reconnect-${crypto.randomUUID()}`;
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
    const ackSeq = await appendAndFlush(ws1, channelId, messageId, [{ seq: 1, delta: "hi" }]);
    expect(ackSeq).toBe(1);
    ws1.close();

    const { ws: ws2, ready } = await openStreamWs({ botId, channelId, messageId, expiresAt });
    expect(ready.ack_seq).toBe(1);
    ws2.send(JSON.stringify(buildBotStreamAppend({ seq: 2, delta: " there" })));
    const ack2Promise = nextMessageOfType(ws2, "append_ack");
    await triggerStreamAlarm(channelId, messageId);
    const ack2 = parseBotStreamAppendAck(await ack2Promise);
    expect(ack2.ack_seq).toBe(2);

    browserWs.close();
    ws2.close();
  });

  it("expires empty buffer with live-only cleanup and no history row", async () => {
    const botId = `bot-exp-empty-${crypto.randomUUID()}`;
    await seedBot({ botId, token: `tok-${botId}` });
    const { channelId, browserWs, viewerUserId } = await setupStreamChannel();
    const ack = await applyStartStream({
      botId,
      channelId,
      clientEffectId: `eff-${crypto.randomUUID()}`,
    });
    const messageId = ack.effect_results?.[0]?.message_id as string;

    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT as unknown as DurableObjectNamespace<ChannelFanout>, channelId);
    const uc = getNamedDo<UserConnection>(env.USER_CONNECTION as unknown as DurableObjectNamespace<UserConnection>, viewerUserId);
    const wsRes = await uc.fetch(
      new Request("https://x/ws", { headers: { Upgrade: "websocket", "X-Verified-User-Id": viewerUserId } }),
    );
    const browserConn = wsRes.webSocket as WebSocket;
    browserConn.accept();
    await liveStartAndAck(browserConn, `cmd-exp-empty-${channelId}`);

    let sessionId = "";
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(uc, async (_instance: unknown, state: any) => {
      const socket = state.getWebSockets()[0];
      const att = socket?.deserializeAttachment() as { session_id?: string } | null;
      sessionId = att?.session_id ?? "";
    });
    await seedDeliverableLease(uc, fanout, channelId, viewerUserId, sessionId, `lease-exp-empty-${channelId}`);

    await forceStreamExpiry(channelId, messageId);

    const probe = await uc.debugLastDeliver();
    expect(probe.event_json).toBeTruthy();
    const frame = JSON.parse(probe.event_json!) as { frame_type: string; type: string; payload: { message_id: string } };
    expect(frame.frame_type).toBe("stream_event");
    expect(frame.type).toBe("message.stream_abandon_cleanup");
    expect(frame.payload.message_id).toBe(messageId);

    await runInDurableObject(channelStub(channelId), async (instance: unknown) => {
      const ctx = (instance as { ctx: DurableObjectState }).ctx;
      const registry = ctx.storage.sql
        .exec(
          "SELECT status FROM message_stream_registry WHERE channel_id=? AND message_id=?",
          channelId,
          messageId,
        )
        .toArray()[0] as { status: string };
      expect(registry.status).toBe("abandoned");

      const messageCount = ctx.storage.sql
        .exec("SELECT COUNT(*) AS c FROM messages WHERE message_id=?", messageId)
        .toArray()[0] as { c: number };
      expect(Number(messageCount.c)).toBe(0);

      const eventCount = ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS c FROM events WHERE event_type IN ('message.stream_abandoned', 'message.created') AND payload_json LIKE ?",
          `%${messageId}%`,
        )
        .toArray()[0] as { c: number };
      expect(Number(eventCount.c)).toBe(0);
    });

    browserWs.close();
    browserConn.close();
  });

  it("persists abandoned/failed message when expiry has flushed partial text", async () => {
    const botId = `bot-exp-partial-${crypto.randomUUID()}`;
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
      { seq: 1, delta: "partial " },
      { seq: 2, delta: "text" },
    ]);
    ws.close();

    await forceStreamExpiry(channelId, messageId);

    const partial = "partial text";
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(channelStub(channelId), async (instance: unknown) => {
      const ctx = (instance as { ctx: DurableObjectState }).ctx;
      const message = ctx.storage.sql
        .exec("SELECT text, stream_state, status FROM messages WHERE message_id=?", messageId)
        .toArray()[0] as { text: string; stream_state: string; status: string };
      expect(message.text).toBe(partial);
      expect(message.stream_state).toBe("abandoned");
      expect(message.status).toBe("failed");

      const event = ctx.storage.sql
        .exec(
          "SELECT event_type FROM events WHERE event_type='message.stream_abandoned' AND payload_json LIKE ?",
          `%${messageId}%`,
        )
        .toArray()[0] as { event_type: string };
      expect(event.event_type).toBe("message.stream_abandoned");

      const createdCount = ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS c FROM events WHERE event_type='message.created' AND payload_json LIKE ?",
          `%${messageId}%`,
        )
        .toArray()[0] as { c: number };
      expect(Number(createdCount.c)).toBe(0);
    });

    browserWs.close();
  });

  it("rejects finalize after persisted abandon without changing partial message", async () => {
    const botId = `bot-exp-fin-reject-${crypto.randomUUID()}`;
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
    await appendAndFlush(ws, channelId, messageId, [{ seq: 1, delta: "keep me" }]);

    const past = new Date(Date.now() - 60_000).toISOString();
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(channelStub(channelId), async (_instance: unknown, state: any) => {
      state.storage.sql.exec(
        "UPDATE message_stream_registry SET expires_at=? WHERE channel_id=? AND message_id=?",
        past,
        channelId,
        messageId,
      );
    });
    await runInDurableObject(streamStub(channelId, messageId), async (_instance: unknown, state: any) => {
      state.storage.sql.exec(
        "UPDATE stream_state SET expires_at=? WHERE channel_id=? AND message_id=?",
        past,
        channelId,
        messageId,
      );
    });

    const errPromise = nextMessageOfType(ws, "stream_error");
    ws.send(JSON.stringify(buildBotStreamFinalize({ final_seq: 1 })));
    const err = parseBotStreamError(await errPromise);
    expect(err.code).toBe("BOT_STREAM_EXPIRED");

    await forceStreamExpiry(channelId, messageId);

    const finalizeHash = await computeFinalizeRequestHash({
      final_seq: 1,
      resolved_text: "keep me",
      components: [],
      attachment_ids: [],
    });
    await expectDoRpcError(
      () => channelStub(channelId).streamFinalize({
        channel_id: channelId,
        message_id: messageId,
        bot_id: botId,
        resolved_text: "keep me",
        finalize_request_hash: finalizeHash,
        final_seq: 1,
        components: [],
        attachment_ids: [],
      }),
      "BOT_STREAM_EXPIRED",
    );

    await runInDurableObject(channelStub(channelId), async (instance: unknown) => {
      const ctx = (instance as { ctx: DurableObjectState }).ctx;
      const message = ctx.storage.sql
        .exec("SELECT text, stream_state, status FROM messages WHERE message_id=?", messageId)
        .toArray()[0] as { text: string; stream_state: string; status: string };
      expect(message.text).toBe("keep me");
      expect(message.stream_state).toBe("abandoned");
      expect(message.status).toBe("failed");
    });

    browserWs.close();
    ws.close();
  });

  it("is idempotent when abandon expiry is repeated", async () => {
    const botId = `bot-exp-idem-${crypto.randomUUID()}`;
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
    ws.close();

    await forceStreamExpiry(channelId, messageId);

    const partial = "same";
    const abandonedTextHash = await computeAbandonedTextHash(partial);
    const abandonBody = {
      channel_id: channelId,
      message_id: messageId,
      bot_id: botId,
      resolved_partial: partial,
      abandoned_text_hash: abandonedTextHash,
    };

    const firstBody = await channelStub(channelId).streamAbandon(abandonBody);
    const secondBody = await channelStub(channelId).streamAbandon(abandonBody);
    if ("event_id" in firstBody && "event_id" in secondBody) {
      expect(secondBody.event_id).toBe(firstBody.event_id);
    }

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(channelStub(channelId), async (instance: unknown) => {
      const ctx = (instance as { ctx: DurableObjectState }).ctx;
      const eventCount = ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS c FROM events WHERE event_type='message.stream_abandoned' AND payload_json LIKE ?",
          `%${messageId}%`,
        )
        .toArray()[0] as { c: number };
      expect(Number(eventCount.c)).toBe(1);
    });

    browserWs.close();
  });
});
