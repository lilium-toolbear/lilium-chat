import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo } from "../helpers";

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

function encodeCursors(map: Record<string, string>): string {
  return btoa(JSON.stringify(map)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("hibernation wake: cursors restore + replay", () => {
  it("reconnecting with a stale cursor replays events after it", async () => {
    const userId = "u-hib-1";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    await sysStub.fetch(
      new Request("https://x/internal/join", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }),
    );
    const { runDurableObjectAlarm } = (await import("cloudflare:test")) as any;
    await runDurableObjectAlarm(sysStub);

    const summary = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json()) as {
      channel_id: string;
      last_event_id: string | null;
    };
    const sysId = summary.channel_id;
    const staleCursor = summary.last_event_id ?? "0";

    const dirStub = env.USER_DIRECTORY.getByName(userId);
    const dirRes = await dirStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const dir = (await dirRes.json()) as { items: Array<{ channel_id: string }> };
    expect(dir.items.find((m) => m.channel_id === sysId)).toBeDefined();

    const send = (await (
      await sysStub.fetch(
        new Request("https://x/internal/message-send", {
          method: "POST",
          headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
          body: JSON.stringify({
            command_id: "cm-hib-1",
            dedupe_principal_key: `user:${userId}`,
            type: "text",
            text: "before reconnect",
            reply_to: null,
            mentions: [],
            channel_id: sysId,
          }),
        }),
      )
    ).json()) as { event_id: string };

    const uc = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
    const res = await uc.fetch(new Request(`https://x/ws?cursors=${encodeCursors({ [sysId]: staleCursor })}`, {
      headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
    }));
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();

    const evRaw = await nextMessage(ws);
    const ev = JSON.parse(evRaw) as { frame_type: string; event_id: string };
    expect(ev.frame_type).toBe("event");
    expect(ev.event_id).toBe(send.event_id);
    ws.close();
  });

  it("serializeAttachment round-trips per_channel_cursors (the eviction safety property)", async () => {
    const userId = "u-hib-2";
    const uc = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
    const cursors = encodeCursors({ "ch-x": "01JCURSOR" });
    const res = await uc.fetch(new Request(`https://x/ws?cursors=${cursors}`, {
      headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
    }));
    expect(res.status).toBe(101);

    const { runInDurableObject } = (await import("cloudflare:test")) as any;
    await runInDurableObject(
      uc,
      async (_instance: unknown, state: { getWebSockets: () => WebSocket[] }) => {
        const socket = state.getWebSockets()[0];
        expect(socket).toBeDefined();
        if (!socket) return;
        const att = socket.deserializeAttachment() as { per_channel_cursors: Record<string, string> } | null;
        expect(att?.per_channel_cursors["ch-x"]).toBe("01JCURSOR");
      },
    );

    (res.webSocket as WebSocket).accept();
    (res.webSocket as WebSocket).close();
  });
});
