import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import { createOwnedTestChannel, createTestChannel, getNamedDo } from "../helpers";
import { nextAck, upgradeUserConnection } from "../ws-helpers";
import type { BotConnection } from "../../src/do/bot-connection";
import type { ChatChannel } from "../../src/do/chat-channel";

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

async function withChannel(
  channelId: string,
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  const stub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL, channelId);
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

const STATEFUL_EXECUTION = {
  mode: "stateful" as const,
  schema_version: 1,
  definition_hash: "sha256:stateful",
  stateful: {
    mutex_scope: "channel" as const,
    default_ttl_seconds: 3600,
    max_ttl_seconds: 7200,
    listen_capability: {
      message_types: ["text"],
      include_bot_messages: false,
      include_own_messages: true,
    },
  },
};

const seededBots = new Set<string>();

async function seedBot(botId: string): Promise<void> {
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      botId,
      "owner-1",
      "Effects Bot",
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

async function seedStatefulBinding(input: {
  channelId: string;
  userId: string;
  botId: string;
  botCommandId: string;
}): Promise<void> {
  await withChannel(input.channelId, (ctx) => {
    const now = new Date().toISOString();
    ctx.storage.sql.exec(
      `INSERT INTO channel_command_bindings (
         channel_id, bot_command_id, bot_id, status, permission_override,
         command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
       ) VALUES (?, ?, ?, 'allowed', NULL, ?, NULL, ?, ?)`,
      input.channelId,
      input.botCommandId,
      input.botId,
      JSON.stringify({
        bot_command_id: input.botCommandId,
        name: "werewolf",
        aliases: [],
        description: "Stateful game",
        bot: { bot_id: input.botId, display_name: "Game Bot", avatar_url: null },
        options: [],
        default_member_permission: "member",
        execution: STATEFUL_EXECUTION,
      }),
      input.userId,
      now,
    );
    ctx.storage.sql.exec(
      "UPDATE channel_meta SET command_manifest_version=?, updated_at=? WHERE channel_id=?",
      1,
      now,
      input.channelId,
    );
  });
}

function botConnectionStub(botId: string): DurableObjectStub<BotConnection> {
  return getNamedDo(env.BOT_CONNECTION as unknown as DurableObjectNamespace<BotConnection>, botId);
}

async function openBotGateway(botId: string): Promise<{ ws: WebSocket; waitForType: (type: string) => Promise<Record<string, unknown>> }> {
  const stub = botConnectionStub(botId);
  const res = await stub.fetch(new Request("https://x/bot", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": BOT_GATEWAY_API_VERSION,
      "X-Verified-Bot-Id": botId,
    },
  }));
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const frames: Record<string, unknown>[] = [];
  ws.addEventListener("message", (ev) => {
    try {
      frames.push(JSON.parse(typeof ev.data === "string" ? ev.data : "") as Record<string, unknown>);
    } catch {
      // ignore
    }
  });
  const waitForType = async (type: string, timeoutMs = 10000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idx = frames.findIndex((frame) => frame.type === type);
      if (idx >= 0) return frames.splice(idx, 1)[0] ?? {};
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for bot frame type ${type}`);
  };
  ws.send(JSON.stringify({
    type: "hello",
    api_version: BOT_GATEWAY_API_VERSION,
    last_received_delivery_id: null,
  }));
  await waitForType("ready");
  return { ws, waitForType };
}

const openedBotSockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of openedBotSockets.splice(0)) {
    ws.close();
  }
});

describe("BotConnection session.effects routing", () => {
  it("routes session.effects send_message to ChatChannel and returns session.effects_ack", async () => {
    const userId = `effects-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `effects-bot-${crypto.randomUUID()}`;
    const botCommandId = `effects-cmd-${crypto.randomUUID()}`;

    await seedBot(botId);
    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Session Effects E2E" },
    );
    await seedStatefulBinding({ channelId, userId, botId, botCommandId });

    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);

    const sessionStartPromise = botGateway.waitForType("session.start");
    const { ws: userWs } = await upgradeUserConnection(userId);
    userWs.send(JSON.stringify({
      frame_type: "command",
      command: "command.invoke",
      command_id: `invoke-${crypto.randomUUID()}`,
      channel_id: channelId,
      payload: {
        bot_command_id: botCommandId,
        invoked_name: "werewolf",
        command_manifest_version: 1,
        options: {},
      },
    }));
    const invokeAck = JSON.parse(await nextAck(userWs)) as {
      frame_type: string;
      payload?: { session_id?: string };
    };
    expect(invokeAck.frame_type).toBe("command_ack");
    const sessionId = invokeAck.payload?.session_id as string;
    expect(sessionId).toBeTruthy();

    const sessionStart = await sessionStartPromise;
    expect(sessionStart.session_id).toBe(sessionId);

    botGateway.ws.send(JSON.stringify({
      type: "session.start_ack",
      api_version: BOT_GATEWAY_API_VERSION,
      session_id: sessionId,
    }));

    for (let i = 0; i < 40; i++) {
      let active = false;
      await withChannel(channelId, (ctx) => {
        const row = ctx.storage.sql
          .exec("SELECT status FROM stateful_command_sessions WHERE session_id=?", sessionId)
          .toArray()[0] as { status: string } | undefined;
        active = row?.status === "active";
      });
      if (active) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    botGateway.ws.send(JSON.stringify({
      type: "session.effects",
      api_version: BOT_GATEWAY_API_VERSION,
      session_id: sessionId,
      effect_seq: 1,
      effects: [
        {
          type: "send_message",
          client_effect_id: `eff-${crypto.randomUUID()}`,
          message: {
            type: "text",
            format: "plain",
            text: "from session.effects",
            reply_to_message_id: null,
            attachment_ids: [],
            components: [],
          },
        },
      ],
    }));

    const ack = await botGateway.waitForType("session.effects_ack");
    expect(ack.type).toBe("session.effects_ack");
    expect(ack.session_id).toBe(sessionId);
    expect(ack.effect_seq).toBe(1);
    expect(ack.status).toBe("applied");

    await withChannel(channelId, (ctx) => {
      const message = ctx.storage.sql
        .exec("SELECT text FROM messages WHERE channel_id=? AND text=?", channelId, "from session.effects")
        .toArray()[0] as { text: string } | undefined;
      expect(message?.text).toBe("from session.effects");

      const event = ctx.storage.sql
        .exec("SELECT event_type FROM events WHERE channel_id=? AND event_type='message.created'", channelId)
        .toArray()[0] as { event_type: string } | undefined;
      expect(event?.event_type).toBe("message.created");
    });

    userWs.close();
  });

  it("returns rejected session.effects_ack for append_stream on main gateway", async () => {
    const botId = `effects-reject-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    await createTestChannel(env, { channelId, ownerId: "owner-1" });

    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);

    await withChannel(channelId, (ctx) => {
      ctx.storage.sql.exec(
        `INSERT INTO stateful_command_sessions (
           session_id, channel_id, bot_id, bot_command_id, invocation_id, started_by_user_id,
           status, listen_rules_json, input_next_seq, input_last_acked_seq, effect_last_acked_seq,
           started_at, expires_at, closed_at, close_reason, summary_json
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 1, 0, 0, ?, ?, NULL, NULL, ?)`,
        sessionId,
        channelId,
        botId,
        "cmd-1",
        "inv-1",
        "user-1",
        JSON.stringify({ message_types: ["text"], include_bot_messages: false, include_own_messages: true }),
        "2026-06-30T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
        JSON.stringify({ command_name: "game" }),
      );
    });

    const botStub = botConnectionStub(botId);
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(botStub, async (instance: unknown) => {
      const ctx = (instance as { ctx: DurableObjectState }).ctx;
      ctx.storage.sql.exec(
        `INSERT INTO active_stateful_session_refs (session_id, channel_id, bot_id, status, updated_at)
         VALUES (?, ?, ?, 'active', ?)`,
        sessionId,
        channelId,
        botId,
        "2026-06-30T00:00:00.000Z",
      );
    });

    botGateway.ws.send(JSON.stringify({
      type: "session.effects",
      api_version: BOT_GATEWAY_API_VERSION,
      session_id: sessionId,
      effect_seq: 1,
      effects: [{ type: "append_stream", client_effect_id: "eff-bad", seq: 1, delta: "x" }],
    }));

    const ack = await botGateway.waitForType("session.effects_ack");
    expect(ack.status).toBe("rejected");
    expect(ack.error).toMatchObject({ code: "BOT_EFFECT_INVALID" });
  });
});
