import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET, getNamedDo } from "../helpers";
const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

interface FanoutDump {
  sessions: Array<{ user_id?: string }>;
}

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error("timeout"));
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

describe("e2e: message.send → committed_ack → message.created self-receive", () => {
  it("delivers ack then event to the sender over WS", async () => {
    const userId = "u-e2e-1";
    const token = await makeJwt({ sub: userId }, TEST_SECRET);
    const testEnv = { ...env, JWT_SECRET: TEST_SECRET };

    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    await sysStub.fetch(
      new Request("https://x/internal/join", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }),
    );
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as {
      channel_id: string;
    }).channel_id;

    const res = await SELF.fetch(
      new Request("https://chat.kuma.homes/api/chat/ws", {
        headers: {
          Upgrade: "websocket",
          Origin: "https://lilium.kuma.homes",
          "Sec-WebSocket-Protocol": `lilium.chat.v1, bearer.${token}`,
        },
      }),
      testEnv as typeof env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();

    const fanoutStub = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], sysId);
    let registered = false;
    for (let i = 0; i < 40; i++) {
      const dumpResponse = await fanoutStub.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": sysId } }));
      const dump = (await dumpResponse.json()) as FanoutDump;
      if (dump.sessions.some((s) => s.user_id === userId)) {
        registered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(registered).toBe(true);

    ws.send(JSON.stringify({
      frame_type: "command",
      command: "message.send",
      command_id: "cmd-e2e-1",
      channel_id: sysId,
      payload: {
        client_message_id: "cm-e2e-1",
        type: "text",
        text: "hello e2e",
        reply_to_message_id: null,
        attachment_ids: [],
        mentions: [],
      },
    }));

    const ackRaw = await nextMessage(ws);
    const ack = JSON.parse(ackRaw) as { frame_type: string; status: string; event_id?: string; message_id?: string };
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.status).toBe("committed");
    expect(ack.message_id).toBeTruthy();
    const eventId = ack.event_id;
    expect(eventId).toBeTruthy();

    const nextEvent = nextMessage(ws);
    const { runDurableObjectAlarm } = await import("cloudflare:test") as { runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void> };
    await runDurableObjectAlarm(sysStub);
    await runDurableObjectAlarm(fanoutStub);
    const evRaw = await nextEvent;
    const ev = JSON.parse(evRaw) as { frame_type: string; type: string; event_id: string; channel_id: string };
    expect(ev.frame_type).toBe("event");
    expect(ev.type).toBe("message.created");
    expect(ev.event_id).toBe(eventId);
    expect(ev.channel_id).toBe(sysId);
    ws.close();
  });
});
