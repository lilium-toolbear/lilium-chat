import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION, buildDeliveryAck } from "../../src/chat/bot-gateway-protocol";
import { createTestChannel, getNamedDo } from "../helpers";

function botConnectionStub(botId: string): DurableObjectStub {
  return getNamedDo(env.BOT_CONNECTION as unknown as DurableObjectNamespace, botId);
}

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

async function seedBot(botId: string, visibility: "private" | "official" = "private"): Promise<void> {
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      botId,
      "owner-1",
      "Delivery Bot",
      null,
      null,
      visibility,
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

async function openConnection(
  botId: string,
): Promise<{ ws: WebSocket; stub: DurableObjectStub }> {
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
  return { ws, stub };
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

function enqueuePayload(input: {
  outbox_id: string;
  channel_id: string;
  target_id?: string;
}) {
  return {
    outbox_id: input.outbox_id,
    channel_id: input.channel_id,
    kind: "command_invocation" as const,
    target_id: input.target_id ?? "inv-1",
    request_json: JSON.stringify({
      channel_id: input.channel_id,
      invocation_id: input.target_id ?? "inv-1",
      command: { name: "ask" },
      invoker: { user_id: "user-1" },
    }),
  };
}

describe("BotConnection delivery_result routing", () => {
  it("routes send_message effects to ChatChannel and returns applied delivery_ack", async () => {
    const botId = `bot-conn-effect-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    await createTestChannel(env, { channelId, ownerId: "owner-1" });
    const { ws, stub } = await openConnection(botId);
    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(ws, "ready");

    const outboxId = `out-${crypto.randomUUID()}`;
    const enq = await stub.fetch(
      new Request("https://x/internal/enqueue-delivery", {
        method: "POST",
        headers: {
          "X-Verified-Bot-Id": botId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          enqueuePayload({ outbox_id: outboxId, channel_id: channelId, target_id: "inv-e2e" }),
        ),
      }),
    );
    expect(enq.status).toBe(200);

    const deliveryFrame = JSON.parse(await nextMessageOfType(ws, "delivery")) as { delivery_id: string };
    ws.send(
      JSON.stringify({
        type: "delivery_result",
        api_version: BOT_GATEWAY_API_VERSION,
        delivery_id: deliveryFrame.delivery_id,
        status: "ok",
        effects: [
          {
            type: "send_message",
            client_effect_id: `eff-${crypto.randomUUID()}`,
            message: {
              type: "text",
              format: "plain",
              text: "via ws",
              reply_to_message_id: null,
              attachment_ids: [],
              components: [],
            },
          },
        ],
      }),
    );

    const ackRaw = await nextMessageOfType(ws, "delivery_ack");
    const ack = JSON.parse(ackRaw) as ReturnType<typeof buildDeliveryAck>;
    expect(ack.status).toBe("applied");
    expect(ack.effect_results?.[0]?.type).toBe("send_message");
    expect(ack.effect_results?.[0]?.message_id).toBeTruthy();
    ws.close();
  });

  it("rejects append_stream on main gateway with BOT_EFFECT_INVALID", async () => {
    const botId = `bot-conn-stream-${crypto.randomUUID()}`;
    const { ws, stub } = await openConnection(botId);
    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(ws, "ready");

    const channelId = crypto.randomUUID();
    await createTestChannel(env, { channelId, ownerId: "owner-1" });
    const enq = await stub.fetch(
      new Request("https://x/internal/enqueue-delivery", {
        method: "POST",
        headers: {
          "X-Verified-Bot-Id": botId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          enqueuePayload({ outbox_id: `out-${crypto.randomUUID()}`, channel_id: channelId }),
        ),
      }),
    );
    expect(enq.status).toBe(200);
    const deliveryFrame = JSON.parse(await nextMessageOfType(ws, "delivery")) as { delivery_id: string };
    ws.send(
      JSON.stringify({
        type: "delivery_result",
        api_version: BOT_GATEWAY_API_VERSION,
        delivery_id: deliveryFrame.delivery_id,
        status: "ok",
        effects: [{ type: "append_stream", client_effect_id: "eff-stream", seq: 1, delta: "x" }],
      }),
    );
    const ack = JSON.parse(await nextMessageOfType(ws, "delivery_ack")) as ReturnType<typeof buildDeliveryAck>;
    expect(ack.status).toBe("failed");
    expect(ack.error?.code).toBe("BOT_EFFECT_INVALID");
    ws.close();
  });

  it("rejects unsafe-markdown format for non-official bots", async () => {
    const botId = `bot-conn-unsafe-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    await createTestChannel(env, { channelId, ownerId: "owner-1" });
    const { ws, stub } = await openConnection(botId);
    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(ws, "ready");

    const enq = await stub.fetch(
      new Request("https://x/internal/enqueue-delivery", {
        method: "POST",
        headers: {
          "X-Verified-Bot-Id": botId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          enqueuePayload({ outbox_id: `out-${crypto.randomUUID()}`, channel_id: channelId }),
        ),
      }),
    );
    expect(enq.status).toBe(200);
    const deliveryFrame = JSON.parse(await nextMessageOfType(ws, "delivery")) as { delivery_id: string };
    ws.send(
      JSON.stringify({
        type: "delivery_result",
        api_version: BOT_GATEWAY_API_VERSION,
        delivery_id: deliveryFrame.delivery_id,
        status: "ok",
        effects: [
          {
            type: "send_message",
            client_effect_id: `eff-${crypto.randomUUID()}`,
            message: {
              type: "text",
              format: "unsafe-markdown",
              text: "external [link](https://example.com)",
              reply_to_message_id: null,
              attachment_ids: [],
              components: [],
            },
          },
        ],
      }),
    );
    const ack = JSON.parse(await nextMessageOfType(ws, "delivery_ack")) as ReturnType<typeof buildDeliveryAck>;
    expect(ack.status).toBe("failed");
    expect(ack.error?.code).toBe("BOT_EFFECT_INVALID");
    expect(ack.error?.message).toContain("unsafe-markdown");
    ws.close();
  });

  it("allows unsafe-markdown format for official bots", async () => {
    const botId = `bot-conn-official-${crypto.randomUUID()}`;
    await seedBot(botId, "official");
    const channelId = crypto.randomUUID();
    await createTestChannel(env, { channelId, ownerId: "owner-1" });
    const { ws, stub } = await openConnection(botId);
    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(ws, "ready");

    const enq = await stub.fetch(
      new Request("https://x/internal/enqueue-delivery", {
        method: "POST",
        headers: {
          "X-Verified-Bot-Id": botId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          enqueuePayload({ outbox_id: `out-${crypto.randomUUID()}`, channel_id: channelId }),
        ),
      }),
    );
    expect(enq.status).toBe(200);
    const deliveryFrame = JSON.parse(await nextMessageOfType(ws, "delivery")) as { delivery_id: string };
    ws.send(
      JSON.stringify({
        type: "delivery_result",
        api_version: BOT_GATEWAY_API_VERSION,
        delivery_id: deliveryFrame.delivery_id,
        status: "ok",
        effects: [
          {
            type: "send_message",
            client_effect_id: `eff-${crypto.randomUUID()}`,
            message: {
              type: "text",
              format: "unsafe-markdown",
              text: "official link",
              reply_to_message_id: null,
              attachment_ids: [],
              components: [],
            },
          },
        ],
      }),
    );
    const ack = JSON.parse(await nextMessageOfType(ws, "delivery_ack")) as ReturnType<typeof buildDeliveryAck>;
    expect(ack.status).toBe("applied");
    ws.close();
  });
});
