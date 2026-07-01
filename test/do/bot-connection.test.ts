import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION, buildDeliveryAck } from "../../src/chat/bot-gateway-protocol";
import { getNamedDo, readDoSchemaVersion } from "../helpers";
import type { BotConnection } from "../../src/do/bot-connection";

function botConnectionStub(botId: string): DurableObjectStub<BotConnection> {
  return getNamedDo<BotConnection>(env.BOT_CONNECTION, botId);
}

async function openConnection(botId: string): Promise<{ ws: WebSocket; stub: DurableObjectStub<BotConnection> }> {
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
  return { ws, stub };
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for ws message")), timeoutMs);
    ws.addEventListener("message", (ev) => {
      clearTimeout(t);
      resolve(typeof ev.data === "string" ? ev.data : "");
    }, { once: true });
  });
}

function nextMessageOfType<T extends string>(ws: WebSocket, type: T, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ws frame: ${type}`)), timeoutMs);
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
        // ignore non-JSON and unrelated frames
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function withBotConnection(
  stub: DurableObjectStub,
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function waitForConnectionState(
  stub: DurableObjectStub<BotConnection>,
  expected: string,
): Promise<{ status: string; session_id: string | null }> {
  for (let i = 0; i < 20; i += 1) {
    const state = await stub.getConnectionState();
    if (state.status === expected) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return stub.getConnectionState();
}

describe("BotConnection DO (7b-connection)", () => {
  it("stores connected state and replies ready with bot_id/session_id on hello", async () => {
    const botId = `bot-ready-${crypto.randomUUID()}`;
    const { ws, stub } = await openConnection(botId);
    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    const raw = await nextMessageOfType(ws, "ready");
    const frame = JSON.parse(raw) as { bot_id: string; session_id: string; type: string };
    expect(frame.type).toBe("ready");
    expect(frame.bot_id).toBe(botId);
    expect(frame.session_id).toBeTruthy();

    const state = await stub.getConnectionState();
    expect(state.status).toBe("connected");
    expect(state.session_id).toBe(frame.session_id);
    ws.close();
  });

  it("replies pong to ping frames", async () => {
    const botId = `bot-pong-${crypto.randomUUID()}`;
    const { ws } = await openConnection(botId);
    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(ws, "ready");

    ws.send(JSON.stringify({ type: "ping", api_version: BOT_GATEWAY_API_VERSION }));
    const pongRaw = await nextMessageOfType(ws, "pong");
    const pong = JSON.parse(pongRaw) as { type: string };
    expect(pong.type).toBe("pong");
    ws.close();
  });

  it("marks connection as disconnected on websocket close", async () => {
    const botId = `bot-close-${crypto.randomUUID()}`;
    const { ws, stub } = await openConnection(botId);
    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(ws, "ready");

    ws.close();
    const state = await waitForConnectionState(stub, "disconnected");
    expect(state.status).toBe("disconnected");
  });

  it("returns disconnected for getConnectionState when offline", async () => {
    const botId = `bot-state-${crypto.randomUUID()}`;
    const { ws, stub } = await openConnection(botId);
    const initialState = await stub.getConnectionState();
    expect(initialState.status).toBe("disconnected");

    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    const ready = JSON.parse(await nextMessageOfType(ws, "ready")) as {
      session_id: string | null;
      type: string;
    };
    expect(ready.type).toBe("ready");
    const connectedState = await stub.getConnectionState();
    expect(connectedState.status).toBe("connected");
    expect(connectedState.session_id).toBeTruthy();
    ws.close();
  });

  it("closes stale connected state when no matching websocket exists", async () => {
    const botId = `bot-stale-row-${crypto.randomUUID()}`;
    const stub = botConnectionStub(botId);
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60000).toISOString();
    await readDoSchemaVersion(stub);
    await withBotConnection(stub, (ctx) => {
      ctx.storage.sql.exec(
        `INSERT INTO bot_connection_state (
          bot_id, session_id, status, connected_at, disconnected_at, last_seen_at, expires_at
        ) VALUES (?, ?, 'connected', ?, NULL, ?, ?)`,
        botId,
        "missing-session",
        now,
        now,
        future,
      );
    });

    const state = await stub.getConnectionState();
    expect(state.status).toBe("disconnected");
    expect(state.session_id).toBeNull();

    await withBotConnection(stub, (ctx) => {
      const row = ctx.storage.sql
        .exec("SELECT status, disconnected_at FROM bot_connection_state WHERE bot_id=?", botId)
        .toArray()[0] as { status: string; disconnected_at: string | null } | undefined;
      expect(row?.status).toBe("disconnected");
      expect(row?.disconnected_at).toBeTruthy();
    });
  });

  it("closes expired connected state on getConnectionState", async () => {
    const botId = `bot-expired-state-${crypto.randomUUID()}`;
    const { ws, stub } = await openConnection(botId);
    ws.send(JSON.stringify({
      type: "hello",
      api_version: BOT_GATEWAY_API_VERSION,
      last_received_delivery_id: null,
    }));
    await nextMessageOfType(ws, "ready");
    await withBotConnection(stub, (ctx) => {
      ctx.storage.sql.exec(
        "UPDATE bot_connection_state SET expires_at=? WHERE bot_id=?",
        new Date(Date.now() - 1000).toISOString(),
        botId,
      );
    });

    const state = await stub.getConnectionState();
    expect(state.status).toBe("disconnected");
    expect(state.session_id).toBeNull();
    ws.close();
  });

  it("disconnects active websocket when connection lease expires on alarm", async () => {
    const botId = `bot-expired-alarm-${crypto.randomUUID()}`;
    const { ws, stub } = await openConnection(botId);
    ws.send(JSON.stringify({
      type: "hello",
      api_version: BOT_GATEWAY_API_VERSION,
      last_received_delivery_id: null,
    }));
    const ready = JSON.parse(await nextMessageOfType(ws, "ready")) as { session_id: string };

    await withBotConnection(stub, (ctx) => {
      ctx.storage.sql.exec(
        "UPDATE bot_connection_state SET expires_at=? WHERE bot_id=? AND session_id=?",
        "2000-01-01T00:00:00.000Z",
        botId,
        ready.session_id,
      );
    });

    const { runDurableObjectAlarm } = await import("cloudflare:test");
    await runDurableObjectAlarm(stub);

    const state = await stub.getConnectionState();
    expect(state.status).toBe("disconnected");
    expect(state.session_id).toBeNull();

    await withBotConnection(stub, (ctx) => {
      const row = ctx.storage.sql
        .exec("SELECT status, disconnected_at FROM bot_connection_state WHERE bot_id=?", botId)
        .toArray()[0] as { status: string; disconnected_at: string | null } | undefined;
      expect(row?.status).toBe("disconnected");
      expect(row?.disconnected_at).toBeTruthy();
    });

    ws.close();
  });

  it("keeps the new session connected when an old socket closes", async () => {
    const botId = `bot-close-old-${crypto.randomUUID()}`;
    const first = await openConnection(botId);
    first.ws.send(JSON.stringify({
      type: "hello",
      api_version: BOT_GATEWAY_API_VERSION,
      last_received_delivery_id: null,
    }));
    const firstReady = JSON.parse(await nextMessageOfType(first.ws, "ready")) as { session_id: string };

    const second = await openConnection(botId);
    second.ws.send(JSON.stringify({
      type: "hello",
      api_version: BOT_GATEWAY_API_VERSION,
      last_received_delivery_id: null,
    }));
    const secondReady = JSON.parse(await nextMessageOfType(second.ws, "ready")) as { session_id: string };
    expect(secondReady.session_id).not.toBe(firstReady.session_id);

    first.ws.close();
    const state = await waitForConnectionState(second.stub, "connected");
    expect(state.session_id).toBe(secondReady.session_id);
    second.ws.close();
  });

  it("does not refresh the current session from an old session ping", async () => {
    const botId = `bot-stale-ping-${crypto.randomUUID()}`;
    const first = await openConnection(botId);
    first.ws.send(JSON.stringify({
      type: "hello",
      api_version: BOT_GATEWAY_API_VERSION,
      last_received_delivery_id: null,
    }));
    await nextMessageOfType(first.ws, "ready");

    const second = await openConnection(botId);
    second.ws.send(JSON.stringify({
      type: "hello",
      api_version: BOT_GATEWAY_API_VERSION,
      last_received_delivery_id: null,
    }));
    const secondReady = JSON.parse(await nextMessageOfType(second.ws, "ready")) as { session_id: string };
    const fixedExpiry = new Date(Date.now() + 30000).toISOString();
    await withBotConnection(second.stub, (ctx) => {
      ctx.storage.sql.exec(
        "UPDATE bot_connection_state SET expires_at=? WHERE bot_id=? AND session_id=?",
        fixedExpiry,
        botId,
        secondReady.session_id,
      );
    });

    first.ws.send(JSON.stringify({ type: "ping", api_version: BOT_GATEWAY_API_VERSION }));
    await nextMessageOfType(first.ws, "pong");

    await withBotConnection(second.stub, (ctx) => {
      const row = ctx.storage.sql
        .exec("SELECT session_id, expires_at FROM bot_connection_state WHERE bot_id=?", botId)
        .toArray()[0] as { session_id: string; expires_at: string } | undefined;
      expect(row?.session_id).toBe(secondReady.session_id);
      expect(row?.expires_at).toBe(fixedExpiry);
    });
    first.ws.close();
    second.ws.close();
  });

  it("replies delivery_result ack failed for unknown delivery_id", async () => {
    const botId = `bot-delivery-result-${crypto.randomUUID()}`;
    const { ws } = await openConnection(botId);
    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(ws, "ready");
    const deliveryId = `01J${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    ws.send(JSON.stringify({ type: "delivery_result", api_version: BOT_GATEWAY_API_VERSION, delivery_id: deliveryId, status: "ok", effects: [] }));
    const ack = JSON.parse(await nextMessageOfType(ws, "delivery_ack")) as ReturnType<typeof buildDeliveryAck>;
    expect(ack.type).toBe("delivery_ack");
    expect(ack.status).toBe("failed");
    expect(ack.delivery_id).toBe(deliveryId);
    expect(ack.error?.code).toBe("BOT_EFFECT_INVALID");
    ws.close();
  });
});
