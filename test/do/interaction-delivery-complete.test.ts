import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import { botDedupePrincipalKey } from "../../src/chat/stream-registry";
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

async function seedBotComponentMessage(input: {
  channelId: string;
  botId: string;
  componentId?: string;
  customId?: string;
}): Promise<{ messageId: string; componentId: string; customId: string }> {
  const messageId = crypto.randomUUID();
  const componentId = input.componentId ?? crypto.randomUUID();
  const customId = input.customId ?? "confirm";
  const component = {
    component_id: componentId,
    kind: "button",
    style: "primary",
    label: "Confirm",
    custom_id: customId,
    disabled: false,
    interaction_policy: "multi",
  };

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
}): Promise<{
  interaction_id?: string;
  event_id?: string;
}> {
  const { ws } = await upgradeUserConnection(input.userId);
  const commandId = `interaction-${crypto.randomUUID()}`;
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
    status?: string;
    payload?: { interaction_id?: string; event_id?: string };
  };
  ws.close();
  expect(frame.status).toBe("committed");
  return frame.payload ?? {};
}

const openedBotSockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of openedBotSockets.splice(0)) {
    ws.close();
  }
});

describe("interaction delivery completion", () => {
  it("marks interaction completed and emits interaction.completed after bot delivery_result", async () => {
    const userId = `delivery-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `delivery-bot-${crypto.randomUUID()}`;

    const { stub } = await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Delivery Complete" },
    );
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);
    const { messageId, componentId, customId } = await seedBotComponentMessage({ channelId, botId });
    const submitPayload = await submitInteraction({ userId, channelId, messageId, componentId, customId });
    const interactionId = submitPayload.interaction_id!;
    const outboxId = `bot_delivery:${channelId}:${interactionId}`;

    const result = await stub.botDeliveryResult({
      delivery_id: `del-${interactionId}`,
      outbox_id: outboxId,
      bot_id: botId,
      channel_id: channelId,
      effects: [],
    });
    expect(result.status).toBe("applied");

    await withChannel(channelId, (ctx) => {
      const interaction = ctx.storage.sql
        .exec("SELECT status FROM interactions WHERE interaction_id=?", interactionId)
        .toArray()[0] as { status: string } | undefined;
      expect(interaction?.status).toBe("completed");

      const completedEvent = ctx.storage.sql
        .exec(
          "SELECT event_type, payload_json FROM events WHERE event_type='interaction.completed' ORDER BY event_id DESC LIMIT 1",
        )
        .toArray()[0] as { event_type: string; payload_json: string } | undefined;
      expect(completedEvent?.event_type).toBe("interaction.completed");
      const payload = JSON.parse(completedEvent?.payload_json ?? "{}") as {
        command_id?: string;
        message?: { message_id?: string };
      };
      expect(payload.command_id).toBeTruthy();
      expect(payload.message?.message_id).toBe(messageId);
    });
  });

  it("marks interaction failed and emits interaction.failed on invalid delivery_result", async () => {
    const userId = `delivery-fail-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `delivery-fail-bot-${crypto.randomUUID()}`;

    const { stub } = await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Delivery Fail" },
    );
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);
    const { messageId, componentId, customId } = await seedBotComponentMessage({ channelId, botId });
    const submitPayload = await submitInteraction({ userId, channelId, messageId, componentId, customId });
    const interactionId = submitPayload.interaction_id!;
    const outboxId = `bot_delivery:${channelId}:${interactionId}`;

    const result = await stub.botDeliveryResult({
      delivery_id: `del-fail-${interactionId}`,
      outbox_id: outboxId,
      bot_id: botId,
      channel_id: channelId,
      effects: [{ type: "append_stream", client_effect_id: "bad", seq: 1, delta: "x" }],
    });
    expect(result.status).toBe("failed");

    await withChannel(channelId, (ctx) => {
      const interaction = ctx.storage.sql
        .exec("SELECT status, error_code FROM interactions WHERE interaction_id=?", interactionId)
        .toArray()[0] as { status: string; error_code: string | null } | undefined;
      expect(interaction?.status).toBe("failed");
      expect(interaction?.error_code).toBe("BOT_EFFECT_INVALID");

      const failedEvent = ctx.storage.sql
        .exec(
          "SELECT event_type FROM events WHERE event_type='interaction.failed' ORDER BY event_id DESC LIMIT 1",
        )
        .toArray()[0] as { event_type: string } | undefined;
      expect(failedEvent?.event_type).toBe("interaction.failed");
    });
  });
});
