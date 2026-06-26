import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

describe("spike: DO WebSocket hibernation restores attachment", () => {
  it("persists X-Verified-User-Id into socket attachment and restores on wake", async () => {
    const userId = "00000000-0000-7000-8000-000000000301";
    const id = env.USER_CONNECTION.idFromName("hib-1");
    const stub = env.USER_CONNECTION.get(id);
    const res = await stub.fetch(
      new Request("https://x/ws", {
        headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
      }),
    );
    expect(res.status).toBe(101);

    const { runInDurableObject } = (await import("cloudflare:test")) as {
      runInDurableObject: (stub: any, cb: (state: unknown, sockets: { getWebSockets: () => WebSocket[] }) => Promise<void>) => Promise<void>;
    };
    await runInDurableObject(stub, async (_instance: unknown, state: { getWebSockets: () => WebSocket[] }) => {
      const sockets = state.getWebSockets();
      expect(sockets.length).toBeGreaterThanOrEqual(1);
      const socket = sockets[0];
      expect(socket).toBeDefined();
      const att = (socket as WebSocket).deserializeAttachment() as
        | { user_id: string; session_id: string; per_channel_cursors: Record<string, string> }
        | null;
      expect(att).toBeDefined();
      expect(att).not.toBeNull();
      const definedAtt = att as { user_id: string; session_id: string; per_channel_cursors: Record<string, string> };
      expect(definedAtt.user_id).toBe(userId);
      expect(definedAtt.session_id).toBeTruthy();
    });
  });

  it("rejects an upgrade without X-Verified-User-Id (401)", async () => {
    const id = env.USER_CONNECTION.idFromName("hib-2");
    const stub = env.USER_CONNECTION.get(id);
    const res = await stub.fetch(new Request("https://x/ws", { headers: { Upgrade: "websocket" } }));
    expect(res.status).toBe(401);
  });

  it("auto-responds to app-level ping without invoking webSocketMessage", async () => {
    const userId = "00000000-0000-7000-8000-000000000302";
    const stub = env.USER_CONNECTION.get(env.USER_CONNECTION.idFromName("hib-auto-ping"));
    const res = await stub.fetch(
      new Request("https://x/ws", {
        headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
      }),
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();

    const { runInDurableObject } = (await import("cloudflare:test")) as unknown as {
      runInDurableObject: (stub: unknown, cb: (instance: unknown, state: DurableObjectState) => Promise<void>) => Promise<void>;
    };
    await runInDurableObject(stub, async (_instance, state) => {
      const pair = state.getWebSocketAutoResponse();
      expect(pair).not.toBeNull();
      expect(pair?.request).toBe("ping");
      expect(pair?.response).toBe("pong");
    });

    const pong = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for pong")), 5000);
      ws.addEventListener(
        "message",
        (ev) => {
          clearTimeout(t);
          resolve(typeof ev.data === "string" ? ev.data : "");
        },
        { once: true },
      );
      ws.send("ping");
    });
    expect(pong).toBe("pong");
    ws.close();
  });
});
