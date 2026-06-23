import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo } from "../helpers";

describe("member.left → ChannelFanout drops the user", () => {
  it("after leave + alarm, ChannelFanout has no session for the user", async () => {
    const userId = "u-leave-1";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(
      new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }),
    );
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

    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], sysId);
    await fanout.fetch(
      new Request("https://x/register-online", {
        method: "POST",
        headers: { "X-Channel-Id": sysId, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, session_id: "s-leave-1", membership_version: 1 }),
      }),
    );

    await sysStub.fetch(
      new Request("https://x/internal/test-leave", {
        method: "POST",
        headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }),
    );

    const { runDurableObjectAlarm } = await import("cloudflare:test") as any;
    await runDurableObjectAlarm(sysStub);

    const dump = (await (await fanout.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": sysId } }))).json()) as {
      sessions: Array<{ user_id?: string }>;
    };
    expect(dump.sessions.filter((s) => s.user_id === userId)).toEqual([]);
  });

  // P0-4: the deliver gate must drop an event for a user who has left, even before unregister outbox flushes.
  it("deliver gate drops an event for a user who left, even before unregister outbox flushes", async () => {
    const userId = "u-leave-2";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(
      new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }),
    );
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

    const uc = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
    const up = await uc.fetch(new Request("https://x/ws", { headers: { Upgrade: "websocket", "X-Verified-User-Id": userId } }));
    const ws = up.webSocket as WebSocket;
    ws.accept();

    const { runInDurableObject } = await import("cloudflare:test") as any;
    let subVersion = -1;
    for (let i = 0; i < 40; i++) {
      await runInDurableObject(uc, async (_inst: unknown, state: { getWebSockets: () => WebSocket[] }) => {
        const att = (state.getWebSockets()[0] as WebSocket).deserializeAttachment() as {
          subscribed_channels?: Record<string, number>;
        } | null;
        subVersion = att?.subscribed_channels?.[sysId] ?? -1;
      });
      if (subVersion >= 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(subVersion).toBeGreaterThanOrEqual(0);

    await sysStub.fetch(
      new Request("https://x/internal/test-leave", {
        method: "POST",
        headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }),
    );

    const laterEvent = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v1",
      event_id: "e-after-leave",
      type: "message.created",
      channel_id: sysId,
      occurred_at: "2026-06-23T00:00:00Z",
      payload: {},
    });
    let sessionId = "";
    await runInDurableObject(uc, async (_inst: unknown, state: { getWebSockets: () => WebSocket[] }) => {
      sessionId = ((state.getWebSockets()[0] as WebSocket).deserializeAttachment() as { session_id: string } | null)?.session_id ?? "";
    });
    const deliverRes = await uc.fetch(
      new Request("https://x/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Channel-Id": sysId },
        body: JSON.stringify({
          session_id: sessionId,
          event_json: laterEvent,
          membership_version_at_event: subVersion + 10,
        }),
      }),
    );
    expect(deliverRes.status).toBe(200);
    const db = (await deliverRes.json()) as { delivered: boolean; dropped?: string };
    expect(db.delivered).toBe(false);
    expect(db.dropped).toBe("not_member");

    await new Promise((r) => setTimeout(r, 150));
    const probe = (await (await uc.fetch(new Request("https://x/test-last-deliver", { headers: { "X-Channel-Id": sysId } }))).json()) as {
      event_json?: string;
    };
    expect(probe.event_json ?? "").not.toContain('"e-after-leave"');
    ws.close();
  });
});
