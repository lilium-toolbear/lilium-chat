import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import { PLATFORM_HELP_BOT_COMMAND_ID } from "../../src/chat/platform-commands";
import { createOwnedTestChannel, getNamedDo } from "../helpers";
import { nextAck, nextMessage, upgradeUserConnection } from "../ws-helpers";

async function withChannel(
  channelId: string,
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace, channelId);
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function seedAllowedCommandBinding(input: {
  channelId: string;
  userId: string;
  botId: string;
  botCommandId: string;
  manifestVersion: number;
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
        name: "ask",
        aliases: ["ai"],
        description: "Ask bot",
        bot: { bot_id: input.botId, display_name: "Invoke Bot", avatar_url: null },
        options: [{ name: "prompt", type: "string", required: true }],
        default_member_permission: "member",
        execution: { mode: "stateless", schema_version: 1, definition_hash: "sha256:test" },
      }),
      input.userId,
      now,
    );
    ctx.storage.sql.exec(
      "UPDATE channel_meta SET command_manifest_version=?, updated_at=? WHERE channel_id=?",
      input.manifestVersion,
      now,
      input.channelId,
    );
  });
}

async function openBotGateway(botId: string): Promise<{ ws: WebSocket }> {
  const stub = getNamedDo(env.BOT_CONNECTION as unknown as DurableObjectNamespace, botId);
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
  ws.send(JSON.stringify({
    type: "hello",
    api_version: BOT_GATEWAY_API_VERSION,
    last_received_delivery_id: null,
  }));
  const ready = JSON.parse(await nextMessage(ws)) as { type: string };
  expect(ready.type).toBe("ready");
  return { ws };
}

const openedBotSockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of openedBotSockets.splice(0)) {
    ws.close();
  }
});

describe("command.invoke", () => {
  it("commits invoke, emits command.invoked, and enqueues bot delivery outbox", async () => {
    const userId = `invoke-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `invoke-bot-${crypto.randomUUID()}`;
    const botCommandId = `invoke-cmd-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Invoke Channel" },
    );
    await seedAllowedCommandBinding({
      channelId,
      userId,
      botId,
      botCommandId,
      manifestVersion: 1,
    });
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);

    const { ws } = await upgradeUserConnection(userId);
    ws.send(JSON.stringify({
      frame_type: "command",
      command: "command.invoke",
      command_id: `invoke-${crypto.randomUUID()}`,
      channel_id: channelId,
      payload: {
        bot_command_id: botCommandId,
        invoked_name: "ask",
        command_manifest_version: 1,
        options: {
          prompt: { type: "string", value: "hello" },
        },
      },
    }));

    const ack = JSON.parse(await nextAck(ws)) as {
      frame_type: string;
      command: string;
      status: string;
      payload?: {
        invocation_id?: string;
        event_id?: string;
        invocation_message?: {
          text?: string;
          command_invocation?: {
            bot_command_id?: string;
            invoked_name?: string;
          };
        };
      };
    };
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.command).toBe("command.invoke");
    expect(ack.status).toBe("committed");
    expect(ack.payload?.invocation_id).toBeTruthy();
    expect(ack.payload?.event_id).toBeTruthy();
    expect(ack.payload?.invocation_message?.text).toBe("/ask hello");
    expect(ack.payload?.invocation_message?.command_invocation?.bot_command_id).toBe(botCommandId);
    expect(ack.payload?.invocation_message?.command_invocation?.invoked_name).toBe("ask");
    const invocationId = ack.payload?.invocation_id as string;

    await withChannel(channelId, (ctx) => {
      const invocation = ctx.storage.sql
        .exec(
          "SELECT invocation_id, status FROM command_invocations WHERE invocation_id=?",
          invocationId,
        )
        .toArray()[0] as { invocation_id: string; status: string } | undefined;
      expect(invocation?.invocation_id).toBe(invocationId);
      expect(invocation?.status).toBe("pending");

      const event = ctx.storage.sql
        .exec(
          "SELECT payload_json FROM events WHERE channel_id=? AND event_type='command.invoked' ORDER BY event_id DESC LIMIT 1",
          channelId,
        )
        .toArray()[0] as { payload_json: string } | undefined;
      expect(event).toBeTruthy();
      const payload = JSON.parse(event?.payload_json ?? "{}") as { invocation?: { invocation_id?: string } };
      expect(payload.invocation?.invocation_id).toBe(invocationId);

      const outbox = ctx.storage.sql
        .exec(
          "SELECT status, invocation_id, kind FROM bot_delivery_outbox WHERE channel_id=? ORDER BY outbox_id DESC LIMIT 1",
          channelId,
        )
        .toArray()[0] as { status: string; invocation_id: string; kind: string } | undefined;
      expect(outbox?.kind).toBe("command_invocation");
      expect(outbox?.invocation_id).toBe(invocationId);
      expect(outbox?.status).toBe("pending");

      const invocationMessage = ctx.storage.sql
        .exec(
          "SELECT text, invocation_json FROM messages WHERE channel_id=? AND invocation_json IS NOT NULL",
          channelId,
        )
        .toArray()[0] as { text: string; invocation_json: string } | undefined;
      expect(invocationMessage?.text).toBe("/ask hello");
      const storedInvocation = JSON.parse(invocationMessage?.invocation_json ?? "{}") as {
        bot_command_id?: string;
        invoked_name?: string;
      };
      expect(storedInvocation.bot_command_id).toBe(botCommandId);
      expect(storedInvocation.invoked_name).toBe("ask");
    });

    ws.close();
  });

  it("platform /help bot message replies to the invocation message", async () => {
    const userId = `help-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Help Channel" },
    );

    const { ws } = await upgradeUserConnection(userId);
    ws.send(JSON.stringify({
      frame_type: "command",
      command: "command.invoke",
      command_id: `help-${crypto.randomUUID()}`,
      channel_id: channelId,
      payload: {
        bot_command_id: PLATFORM_HELP_BOT_COMMAND_ID,
        invoked_name: "help",
        command_manifest_version: 0,
        options: {},
      },
    }));

    const ack = JSON.parse(await nextAck(ws)) as {
      frame_type: string;
      command: string;
      status: string;
      payload?: {
        message?: {
          reply_to?: string | null;
          reply_snapshot?: { message_id?: string; text_preview?: string } | null;
        };
        invocation_message?: { message_id?: string; text?: string };
      };
    };
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.command).toBe("command.invoke");
    expect(ack.status).toBe("committed");
    expect(ack.payload?.invocation_message?.text).toBe("/help");
    expect(ack.payload?.message?.reply_to).toBe(ack.payload?.invocation_message?.message_id);
    expect(ack.payload?.message?.reply_snapshot?.message_id).toBe(
      ack.payload?.invocation_message?.message_id,
    );
    expect(ack.payload?.message?.reply_snapshot?.text_preview).toBe("/help");

    await withChannel(channelId, (ctx) => {
      const botMessage = ctx.storage.sql
        .exec(
          "SELECT reply_to, reply_snapshot_json FROM messages WHERE channel_id=? AND sender_bot_id IS NOT NULL",
          channelId,
        )
        .toArray()[0] as { reply_to: string; reply_snapshot_json: string } | undefined;
      expect(botMessage?.reply_to).toBe(ack.payload?.invocation_message?.message_id);
      const snapshot = JSON.parse(botMessage?.reply_snapshot_json ?? "{}") as { text_preview?: string };
      expect(snapshot.text_preview).toBe("/help");
    });

    ws.close();
  });

  it("includes reply_to context in bot delivery when invoke carries reply_to_message_id", async () => {
    const userId = `invoke-reply-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `invoke-reply-bot-${crypto.randomUUID()}`;
    const botCommandId = `invoke-reply-cmd-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Invoke Reply Channel" },
    );
    await seedAllowedCommandBinding({
      channelId,
      userId,
      botId,
      botCommandId,
      manifestVersion: 1,
    });
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);

    const { ws } = await upgradeUserConnection(userId);
    const sendCommandId = `send-${crypto.randomUUID()}`;
    ws.send(JSON.stringify({
      frame_type: "command",
      command: "message.send",
      command_id: sendCommandId,
      channel_id: channelId,
      payload: {
        type: "text",
        text: "hello",
        reply_to_message_id: null,
        attachment_ids: [],
        mentions: [],
      },
    }));
    const sendAck = JSON.parse(await nextAck(ws)) as {
      payload?: { message?: { message_id?: string } };
    };
    const targetMessageId = sendAck.payload?.message?.message_id;
    expect(targetMessageId).toBeTruthy();

    ws.send(JSON.stringify({
      frame_type: "command",
      command: "command.invoke",
      command_id: `invoke-reply-${crypto.randomUUID()}`,
      channel_id: channelId,
      payload: {
        bot_command_id: botCommandId,
        invoked_name: "ask",
        command_manifest_version: 1,
        reply_to_message_id: targetMessageId,
        options: {
          prompt: { type: "string", value: "follow up" },
        },
      },
    }));
    const ack = JSON.parse(await nextAck(ws)) as {
      status: string;
      payload?: { invocation_id?: string };
    };
    expect(ack.status).toBe("committed");

    await withChannel(channelId, (ctx) => {
      const outbox = ctx.storage.sql
        .exec(
          "SELECT request_json FROM bot_delivery_outbox WHERE channel_id=? ORDER BY outbox_id DESC LIMIT 1",
          channelId,
        )
        .toArray()[0] as { request_json: string } | undefined;
      const request = JSON.parse(outbox?.request_json ?? "{}") as {
        reply_to?: { message_id?: string; text?: string; sender?: { kind?: string } };
      };
      expect(request.reply_to?.message_id).toBe(targetMessageId);
      expect(request.reply_to?.text).toBe("hello");
      expect(request.reply_to?.sender?.kind).toBe("user");
    });

    ws.close();
  });

  it("returns BOT_OFFLINE when bot is disconnected", async () => {
    const userId = `invoke-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `invoke-bot-${crypto.randomUUID()}`;
    const botCommandId = `invoke-cmd-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Invoke Offline Channel" },
    );
    await seedAllowedCommandBinding({
      channelId,
      userId,
      botId,
      botCommandId,
      manifestVersion: 1,
    });

    const { ws } = await upgradeUserConnection(userId);
    ws.send(JSON.stringify({
      frame_type: "command",
      command: "command.invoke",
      command_id: `invoke-offline-${crypto.randomUUID()}`,
      channel_id: channelId,
      payload: {
        bot_command_id: botCommandId,
        invoked_name: "ask",
        command_manifest_version: 1,
        options: {
          prompt: { type: "string", value: "hello" },
        },
      },
    }));

    const frame = JSON.parse(await nextAck(ws)) as {
      frame_type: string;
      error?: { code?: string };
    };
    expect(frame.frame_type).toBe("command_error");
    expect(frame.error?.code).toBe("BOT_OFFLINE");

    await withChannel(channelId, (ctx) => {
      const invocations = ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM command_invocations WHERE channel_id=?", channelId)
        .toArray()[0] as { count: number };
      expect(invocations.count).toBe(0);
    });
    ws.close();
  });
});
