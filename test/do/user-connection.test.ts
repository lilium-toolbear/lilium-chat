import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo } from "../helpers";

async function upgradeUserConnection(userId: string, cursors?: string): Promise<{ ws: WebSocket; stub: DurableObjectStub }> {
  const stub = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
  const qs = cursors ? `?cursors=${cursors}` : "";
  const res = await stub.fetch(new Request(`https://x/ws${qs}`, {
    headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
  }));
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return { ws, stub };
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
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

// Reads frames until a command_ack arrives — skips replay event frames that registerOnlineOnConnect
// may deliver on the same socket. Resolves with the ack's command_id (asserted) to disambiguate.
function nextAck(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for command_ack")), timeoutMs);
    const handler = (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      try {
        const f = JSON.parse(data) as { frame_type?: string };
        if (f.frame_type === "command_ack") {
          clearTimeout(t);
          ws.removeEventListener("message", handler);
          resolve(data);
        }
      } catch {
        // ignore non-JSON / non-ack frames
      }
    };
    ws.addEventListener("message", handler as EventListener);
  });
}

describe("UserConnection DO", () => {
  it("/deliver sends an event frame on the live socket and stores a probe", async () => {
    const userId = "u-uc-deliver";
    const { ws, stub } = await upgradeUserConnection(userId);

    let sessionId = "";
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance: unknown, state: { getWebSockets: () => WebSocket[] }) => {
      const firstSocket = state.getWebSockets()[0];
      expect(firstSocket).toBeDefined();
      if (!firstSocket) return;
      const att = firstSocket.deserializeAttachment() as { session_id: string };
      sessionId = att.session_id;
    });

    const eventJson = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v1",
      event_id: "e-d1",
      type: "message.created",
      channel_id: "ch-d1",
      occurred_at: "2026-06-23T00:00:00Z",
      payload: {},
    });
    // Attach the listener BEFORE /deliver: handleDeliver now sends synchronously on the 200
    // path, so the frame is dispatched during the fetch — a listener attached after would miss it.
    const receivedPromise = nextMessage(ws);
    const deliverRes = await stub.fetch(new Request("https://x/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, event_json: eventJson, membership_version_at_event: 0 }),
    }));
    expect(deliverRes.status).toBe(200);

    const received = await receivedPromise;
    expect(JSON.parse(received).event_id).toBe("e-d1");

    const probe = await (await stub.fetch(new Request("https://x/test-last-deliver"))).json() as { event_json: string | null };
    expect(probe.event_json).toContain('"event_id":"e-d1"');
    ws.close();
  });

  it("/deliver with a non-existent session_id does NOT deliver to another socket of the same user (fail-closed)", async () => {
    const userId = "u-uc-failclosed";
    const { ws, stub } = await upgradeUserConnection(userId);
    ws.accept();

    // A stale fanout row would target a session_id that no longer exists. /deliver must report
    // not_connected and NOT fall back to the live socket of the same user.
    const eventJson = JSON.stringify({
      frame_type: "event", api_version: "lilium.chat.v1", event_id: "e-stale", type: "message.created",
      channel_id: "ch-failclosed", occurred_at: "2026-06-23T00:00:00Z", payload: {},
    });
    const deliverRes = await stub.fetch(new Request("https://x/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "session-that-does-not-exist", event_json: eventJson, membership_version_at_event: 0 }),
    }));
    expect(deliverRes.status).toBe(200);
    const body = (await deliverRes.json()) as { delivered: boolean; dropped?: string };
    expect(body.delivered).toBe(false);
    expect(body.dropped).toBe("not_connected");

    // Confirm nothing was sent on the live socket: the probe must not hold the stale event.
    const probe = await (await stub.fetch(new Request("https://x/test-last-deliver"))).json() as { event_json: string | null };
    expect(probe.event_json ?? "").not.toContain('"e-stale"');
    ws.close();
  });

  it("webSocketMessage routes message.send to ChatChannel and returns committed_ack", async () => {
    const userId = "u-uc-send";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", {
      method: "POST",
      body: JSON.stringify({ title: "Lilium" }),
    }));
    await sysStub.fetch(
      new Request("https://x/internal/join", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }),
    );
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": userId },
    }))).json() as { channel_id: string }).channel_id;

    const { ws } = await upgradeUserConnection(userId);
    const cmd = JSON.stringify({
      frame_type: "command",
      command: "message.send",
      command_id: "cmd-uc-1",
      channel_id: sysId,
      payload: {
        type: "text",
        text: "hi from uc",
        reply_to_message_id: null,
        attachment_ids: [],
        mentions: [],
      },
    });

    ws.send(cmd);
    const ackRaw = await nextMessage(ws);
    const ack = JSON.parse(ackRaw);
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.status).toBe("committed");
    expect(ack.command_id).toBe("cmd-uc-1");
    expect(ack.payload.channel_id).toBe(sysId);
    expect(ack.payload.message.message_id).toBeTruthy();
    expect(ack.payload.message.sender.user.user_id).toBe(userId);
    expect(ack.payload.event_id).toBeTruthy();
    ws.close();
  });

  it("webSocketMessage returns command_error for invalid message (empty text)", async () => {
    const userId = "u-uc-err";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(
      new Request("https://x/internal/join", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }),
    );
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": userId },
    }))).json() as { channel_id: string }).channel_id;

    const { ws } = await upgradeUserConnection(userId);
    ws.send(
      JSON.stringify({
        frame_type: "command",
        command: "message.send",
        command_id: "cmd-uc-2",
        channel_id: sysId,
        payload: {
          type: "text",
          text: "   ",
          reply_to_message_id: null,
          attachment_ids: [],
          mentions: [],
        },
      }),
    );

    const errRaw = await nextMessage(ws);
    const err = JSON.parse(errRaw);
    expect(err.frame_type).toBe("command_error");
    expect(err.error.code).toBe("INVALID_MESSAGE");
    ws.close();
  });

  it("idempotent: same command_id twice → same message_id in both acks", async () => {
    const userId = "u-uc-idem";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(
      new Request("https://x/internal/join", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }),
    );
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": userId },
    }))).json() as { channel_id: string }).channel_id;

    const { ws } = await upgradeUserConnection(userId);
    const base = {
      frame_type: "command",
      command: "message.send",
      channel_id: sysId,
      payload: {
        type: "text",
        text: "dup",
        reply_to_message_id: null,
        attachment_ids: [],
        mentions: [],
      },
    };

    // v4.0: command_id is the top-level durable operation id. Same command_id + same body → same message.
    ws.send(JSON.stringify({ ...base, command_id: "c-same" }));
    const ack1 = JSON.parse(await nextAck(ws));
    ws.send(JSON.stringify({ ...base, command_id: "c-same" }));
    const ack1Retry = JSON.parse(await nextAck(ws));
    expect(ack1Retry.payload.message.message_id).toBe(ack1.payload.message.message_id);

    // A different command_id (new operation) + same body → a DIFFERENT message.
    ws.send(JSON.stringify({ ...base, command_id: "c-different" }));
    const ack2 = JSON.parse(await nextAck(ws));
    expect(ack2.payload.message.message_id).not.toBe(ack1.payload.message.message_id);
    ws.close();
  });
});
