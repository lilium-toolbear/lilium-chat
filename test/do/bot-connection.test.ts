import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION, buildDeliveryAck } from "../../src/chat/bot-gateway-protocol";
import { getNamedDo } from "../helpers";

function botConnectionStub(botId: string): DurableObjectStub {
  return getNamedDo(env.BOT_CONNECTION as unknown as DurableObjectNamespace, botId);
}

async function openConnection(botId: string): Promise<{ ws: WebSocket; stub: DurableObjectStub }> {
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

async function waitForConnectionState(
  stub: DurableObjectStub,
  expected: string,
): Promise<{ status: string; session_id: string | null }> {
  for (let i = 0; i < 20; i += 1) {
    const res = await stub.fetch(new Request("https://x/internal/connection-state"));
    const state = (await res.json()) as { status: string; session_id: string | null };
    if (state.status === expected) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const finalRes = await stub.fetch(new Request("https://x/internal/connection-state"));
  return (await finalRes.json()) as { status: string; session_id: string | null };
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

    const stateRes = await stub.fetch(new Request("https://x/internal/connection-state"));
    const state = (await stateRes.json()) as { status: string; session_id: string | null };
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

  it("returns disconnected for /internal/connection-state when offline", async () => {
    const botId = `bot-state-${crypto.randomUUID()}`;
    const { ws, stub } = await openConnection(botId);
    const initial = await stub.fetch(new Request("https://x/internal/connection-state"));
    const initialState = (await initial.json()) as { status: string; session_id: string | null };
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
    const connected = await stub.fetch(new Request("https://x/internal/connection-state"));
    const connectedState = (await connected.json()) as { status: string; session_id: string | null };
    expect(connectedState.status).toBe("connected");
    expect(connectedState.session_id).toBeTruthy();
    ws.close();
  });

  it("replies delivery_result ack failed when delivery_result not implemented", async () => {
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
