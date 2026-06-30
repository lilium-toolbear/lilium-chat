import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import { botDedupePrincipalKey } from "../../src/chat/stream-registry";
import { createOwnedTestChannel, createTestChannel, getNamedDo } from "../helpers";
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

type InteractionPolicy = "multi" | "per_user_once" | "exclusive" | "targeted";

async function seedBotComponentMessage(input: {
  channelId: string;
  botId: string;
  policy?: InteractionPolicy;
  targetUserId?: string;
  componentId?: string;
  customId?: string;
}): Promise<{ messageId: string; componentId: string; customId: string }> {
  const messageId = crypto.randomUUID();
  const componentId = input.componentId ?? crypto.randomUUID();
  const customId = input.customId ?? "confirm";
  const component: Record<string, unknown> = {
    component_id: componentId,
    kind: "button",
    style: "primary",
    label: "Confirm",
    custom_id: customId,
    disabled: false,
  };
  if (input.policy) {
    component.interaction_policy = input.policy;
    if (input.policy === "targeted" && input.targetUserId) {
      component.target_user_id = input.targetUserId;
    }
  }

  await withChannel(input.channelId, (ctx) => {
    const now = new Date().toISOString();
    ctx.storage.sql.exec(
      `INSERT INTO messages (
         message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id, sender_bot_id,
         sender_bot_display_name, sender_bot_avatar_url, type, format, status, text,
         reply_to, reply_snapshot_json, components_json, stream_state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'bot', NULL, ?, ?, NULL, 'text', 'plain', 'normal', ?, NULL, NULL, ?, 'none', ?, ?)`,
      messageId,
      `bot-msg-${messageId}`,
      botDedupePrincipalKey(input.botId),
      input.channelId,
      input.botId,
      "Interaction Bot",
      "Pick one",
      JSON.stringify([component]),
      now,
      now,
    );
  });

  return { messageId, componentId, customId };
}

async function submitInteraction(input: {
  userId: string;
  channelId: string;
  messageId: string;
  componentId: string;
  customId: string;
  commandId?: string;
}): Promise<{
  frame_type: string;
  command?: string;
  status?: string;
  payload?: { interaction_id?: string; event_id?: string; channel_id?: string };
  error?: { code?: string; message?: string };
}> {
  const { ws } = await upgradeUserConnection(input.userId);
  const commandId = input.commandId ?? `interaction-${crypto.randomUUID()}`;
  ws.send(JSON.stringify({
    frame_type: "command",
    command: "interaction.submit",
    command_id: commandId,
    channel_id: input.channelId,
    payload: {
      message_id: input.messageId,
      component_id: input.componentId,
      custom_id: input.customId,
      value: true,
    },
  }));
  const frame = JSON.parse(await nextAck(ws)) as {
    frame_type: string;
    command?: string;
    status?: string;
    payload?: { interaction_id?: string; event_id?: string; channel_id?: string };
    error?: { code?: string; message?: string };
  };
  ws.close();
  return frame;
}

const openedBotSockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of openedBotSockets.splice(0)) {
    ws.close();
  }
});

describe("interaction.submit", () => {
  it("commits interaction, emits interaction.created, and enqueues message_interaction outbox", async () => {
    const userId = `interaction-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `interaction-bot-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Interaction Channel" },
    );
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);
    const { messageId, componentId, customId } = await seedBotComponentMessage({ channelId, botId, policy: "multi" });

    const ack = await submitInteraction({ userId, channelId, messageId, componentId, customId });
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.command).toBe("interaction.submit");
    expect(ack.status).toBe("committed");
    expect(ack.payload?.interaction_id).toBeTruthy();
    expect(ack.payload?.event_id).toBeTruthy();

    await withChannel(channelId, (ctx) => {
      const interaction = ctx.storage.sql
        .exec(
          "SELECT interaction_id, status FROM interactions WHERE interaction_id=?",
          ack.payload?.interaction_id,
        )
        .toArray()[0] as { interaction_id: string; status: string } | undefined;
      expect(interaction?.status).toBe("pending");

      const outbox = ctx.storage.sql
        .exec(
          "SELECT kind, interaction_id, status FROM bot_delivery_outbox WHERE channel_id=? ORDER BY outbox_id DESC LIMIT 1",
          channelId,
        )
        .toArray()[0] as { kind: string; interaction_id: string; status: string } | undefined;
      expect(outbox?.kind).toBe("message_interaction");
      expect(outbox?.interaction_id).toBe(ack.payload?.interaction_id);
      expect(outbox?.status).toBe("pending");
    });
  });

  it("multi policy allows multiple users to submit", async () => {
    const ownerId = `multi-owner-${crypto.randomUUID()}`;
    const otherUserId = `multi-other-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `multi-bot-${crypto.randomUUID()}`;

    await createTestChannel(env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">, {
      channelId,
      ownerId,
      title: "Multi Policy",
      initial_members: [{ user_id: otherUserId, role: "member" }],
    });
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);
    const { messageId, componentId, customId } = await seedBotComponentMessage({ channelId, botId, policy: "multi" });

    const first = await submitInteraction({ userId: ownerId, channelId, messageId, componentId, customId });
    const second = await submitInteraction({ userId: otherUserId, channelId, messageId, componentId, customId });
    expect(first.status).toBe("committed");
    expect(second.status).toBe("committed");
    expect(first.payload?.interaction_id).not.toBe(second.payload?.interaction_id);
  });

  it("per_user_once returns INTERACTION_ALREADY_SUBMITTED on duplicate user submit", async () => {
    const userId = `once-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `once-bot-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Per User Once" },
    );
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);
    const { messageId, componentId, customId } = await seedBotComponentMessage({
      channelId,
      botId,
      policy: "per_user_once",
    });

    const first = await submitInteraction({ userId, channelId, messageId, componentId, customId });
    expect(first.status).toBe("committed");

    const second = await submitInteraction({ userId, channelId, messageId, componentId, customId });
    expect(second.frame_type).toBe("command_error");
    expect(second.error?.code).toBe("INTERACTION_ALREADY_SUBMITTED");
  });

  it("exclusive locks component atomically and returns COMPONENT_ALREADY_USED for second user", async () => {
    const ownerId = `exclusive-owner-${crypto.randomUUID()}`;
    const otherUserId = `exclusive-other-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `exclusive-bot-${crypto.randomUUID()}`;

    await createTestChannel(env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">, {
      channelId,
      ownerId,
      title: "Exclusive Policy",
      initial_members: [{ user_id: otherUserId, role: "member" }],
    });
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);
    const { messageId, componentId, customId } = await seedBotComponentMessage({
      channelId,
      botId,
      policy: "exclusive",
    });

    const first = await submitInteraction({ userId: ownerId, channelId, messageId, componentId, customId });
    expect(first.status).toBe("committed");

    await withChannel(channelId, (ctx) => {
      const message = ctx.storage.sql
        .exec("SELECT components_json FROM messages WHERE message_id=?", messageId)
        .toArray()[0] as { components_json: string } | undefined;
      const components = JSON.parse(message?.components_json ?? "[]") as Array<{ component_id: string; disabled: boolean }>;
      expect(components[0]?.disabled).toBe(true);
    });

    const second = await submitInteraction({ userId: otherUserId, channelId, messageId, componentId, customId });
    expect(second.frame_type).toBe("command_error");
    expect(second.error?.code).toBe("COMPONENT_ALREADY_USED");
  });

  it("targeted returns INTERACTION_FORBIDDEN_TARGET for non-target user", async () => {
    const ownerId = `target-owner-${crypto.randomUUID()}`;
    const targetUserId = `target-user-${crypto.randomUUID()}`;
    const otherUserId = `target-other-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `target-bot-${crypto.randomUUID()}`;

    await createTestChannel(env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">, {
      channelId,
      ownerId,
      title: "Targeted Policy",
      initial_members: [
        { user_id: targetUserId, role: "member" },
        { user_id: otherUserId, role: "member" },
      ],
    });
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);
    const { messageId, componentId, customId } = await seedBotComponentMessage({
      channelId,
      botId,
      policy: "targeted",
      targetUserId,
    });

    const denied = await submitInteraction({ userId: otherUserId, channelId, messageId, componentId, customId });
    expect(denied.frame_type).toBe("command_error");
    expect(denied.error?.code).toBe("INTERACTION_FORBIDDEN_TARGET");

    const allowed = await submitInteraction({ userId: targetUserId, channelId, messageId, componentId, customId });
    expect(allowed.status).toBe("committed");
  });

  it("returns cached committed_ack for idempotent retry with same command_id", async () => {
    const userId = `idem-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `idem-bot-${crypto.randomUUID()}`;
    const commandId = `idem-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Idempotent Interaction" },
    );
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);
    const { messageId, componentId, customId } = await seedBotComponentMessage({ channelId, botId, policy: "multi" });

    const first = await submitInteraction({
      userId,
      channelId,
      messageId,
      componentId,
      customId,
      commandId,
    });
    const second = await submitInteraction({
      userId,
      channelId,
      messageId,
      componentId,
      customId,
      commandId,
    });
    expect(first.payload?.interaction_id).toBe(second.payload?.interaction_id);
    expect(first.payload?.event_id).toBe(second.payload?.event_id);

    await withChannel(channelId, (ctx) => {
      const count = ctx.storage.sql
        .exec("SELECT COUNT(*) AS c FROM interactions WHERE message_id=?", messageId)
        .toArray()[0] as { c: number };
      expect(count.c).toBe(1);
    });
  });

  it("returns BOT_OFFLINE when bot is disconnected and does not persist interaction", async () => {
    const userId = `offline-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `offline-bot-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Offline Bot Interaction" },
    );
    const { messageId, componentId, customId } = await seedBotComponentMessage({ channelId, botId, policy: "multi" });

    const frame = await submitInteraction({ userId, channelId, messageId, componentId, customId });
    expect(frame.frame_type).toBe("command_error");
    expect(frame.error?.code).toBe("BOT_OFFLINE");

    await withChannel(channelId, (ctx) => {
      const count = ctx.storage.sql
        .exec("SELECT COUNT(*) AS c FROM interactions WHERE message_id=?", messageId)
        .toArray()[0] as { c: number };
      expect(count.c).toBe(0);
    });
  });
});
