import { expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "./helpers";

export async function upgradeUserConnection(
  userId: string,
): Promise<{ ws: WebSocket; stub: DurableObjectStub; sessionId: string }> {
  const stub = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
  const res = await stub.fetch(new Request("https://x/ws", {
    headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
  }));
  expect(res.status).toBe(101);
  expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("lilium.chat.v2");
  const ws = res.webSocket as WebSocket;
  ws.accept();

  let sessionId = "";
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stub, async (_instance: unknown, state: { getWebSockets: () => WebSocket[] }) => {
    const socket = state.getWebSockets()[0];
    if (!socket) return;
    const att = socket.deserializeAttachment() as { session_id?: string } | null;
    sessionId = att?.session_id ?? "";
  });
  expect(sessionId).toBeTruthy();
  return { ws, stub, sessionId };
}

export function sendLiveStart(ws: WebSocket, commandId = "cmd-live-start"): void {
  ws.send(JSON.stringify({
    frame_type: "command",
    command: "session.live_start",
    command_id: commandId,
    payload: {},
  }));
}

export function sendHeartbeat(ws: WebSocket, commandId = "cmd-heartbeat"): void {
  ws.send(JSON.stringify({
    frame_type: "command",
    command: "session.heartbeat",
    command_id: commandId,
    payload: {},
  }));
}

export function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error("timeout waiting for ws message"));
    }, timeoutMs);
    ws.addEventListener(
      "message",
      (ev) => {
        clearTimeout(t);
        resolve(typeof ev.data === "string" ? ev.data : "");
      },
      { once: true },
    );
  });
}

export function nextAck(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for command_ack")), timeoutMs);
    const handler = (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      try {
        const f = JSON.parse(data) as { frame_type?: string };
        if (f.frame_type === "command_ack" || f.frame_type === "command_error") {
          clearTimeout(t);
          ws.removeEventListener("message", handler);
          resolve(data);
        }
      } catch {
        // ignore non-JSON frames
      }
    };
    ws.addEventListener("message", handler as EventListener);
  });
}

export async function liveStartAndAck(ws: WebSocket, commandId = "cmd-live-start"): Promise<Record<string, unknown>> {
  sendLiveStart(ws, commandId);
  const raw = await nextAck(ws);
  const ack = JSON.parse(raw) as { frame_type: string; status?: string; payload?: Record<string, unknown> };
  expect(ack.frame_type).toBe("command_ack");
  return ack.payload ?? {};
}
