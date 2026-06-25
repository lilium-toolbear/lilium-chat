import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo } from "../helpers";

describe("ChannelFanout DO", () => {
  it("registers online, enqueues an event, and delivers to UserConnection on alarm", async () => {
    const channelId = "ch-fanout-1";
    const userId = "u-fanout-1";
    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);

    const uc = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
    const wsRes = await uc.fetch(new Request("https://x/ws", {
      headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
    }));
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket as WebSocket;
    ws.accept();

    let sessionId = "";
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(uc, async (_instance: unknown, state: { getWebSockets: () => WebSocket[] }) => {
      const socket = state.getWebSockets()[0];
      expect(socket).toBeDefined();
      if (!socket) return;
      const att = socket.deserializeAttachment() as { session_id?: string } | null;
      sessionId = att?.session_id ?? "";
    });
    expect(sessionId).toBeTruthy();

    const reg = await fanout.fetch(new Request("https://x/register-online", {
      method: "POST",
      headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, session_id: sessionId, membership_version: 3 }),
    }));
    expect(reg.status).toBe(200);

    const evt = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v1",
      event_id: "e-1",
      type: "message.created",
      channel_id: channelId,
      occurred_at: "2026-06-23T00:00:00Z",
      payload: {},
    });
    const enq = await fanout.fetch(new Request("https://x/fanout-enqueue", {
      method: "POST",
      headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: "e-1", event_json: evt, membership_version_at_event: 3 }),
    }));
    expect(enq.status).toBe(200);

    const dump1 = (await (await fanout.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": channelId } }))).json()) as {
      sessions: Array<{ session_id: string }>;
      queue: Array<{ target_session_id: string; status: string }>;
    };
    expect(dump1.queue.length).toBe(1);
    expect(dump1.queue.at(0)?.status).toBe("pending");

    const { runDurableObjectAlarm } = await import("cloudflare:test") as any;
    await runDurableObjectAlarm(fanout);

    // Poll for 'delivered'. Under CI load the UserConnection sub-fetch inside the alarm can
    // throw transiently (DO rpc / environment-teardown timing), which routes through
    // bumpFanoutRetry → status stays 'pending' with a 1s backoff. Re-running the alarm after
    // the backoff retries the delivery. This mirrors the poll-then-retry pattern used in
    // member-left-unsubscribe.test.ts and setupChannelAndJoin helpers.
    let delivered = false;
    for (let i = 0; i < 60; i++) {
      const dump2 = (await (await fanout.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": channelId } }))).json()) as {
        queue: Array<{ target_session_id: string; status: string; attempts?: number; last_error?: string | null; next_attempt_at?: string }>;
      };
      const row = dump2.queue.at(0);
      if (row?.status === "delivered") {
        delivered = true;
        break;
      }
      if (row?.status === "dead_letter") {
        throw new Error(`fanout dead_letter: attempts=${row.attempts} last_error=${JSON.stringify(row.last_error)}`);
      }
      // Re-flush the alarm so a pending row whose next_attempt_at has come due is retried.
      await runDurableObjectAlarm(fanout);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(delivered).toBe(true);

    const probe = (await (await uc.fetch(new Request("https://x/test-last-deliver"))).json()) as { event_json: string | null };
    expect(probe.event_json).toContain('"event_id":"e-1"');

    ws.close();
  });

  it("unregister-user drops sessions and fails their pending queue rows (member.left)", async () => {
    const channelId = "ch-fanout-2";
    const userId = "u-fanout-2";
    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);

    await fanout.fetch(new Request("https://x/register-online", {
      method: "POST",
      headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, session_id: "s-2", membership_version: 1 }),
    }));

    await fanout.fetch(new Request("https://x/fanout-enqueue", {
      method: "POST",
      headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: "e-2", event_json: "{}", membership_version_at_event: 1 }),
    }));

    const drop = await fanout.fetch(new Request("https://x/unregister-user", {
      method: "POST",
      headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    expect(drop.status).toBe(200);

    const dump = (await (await fanout.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": channelId } }))).json()) as {
      sessions: Array<{ user_id: string }>;
      queue: Array<{ target_user_id: string; status: string }>;
    };

    expect(dump.sessions.filter((s: any) => s.user_id === userId)).toEqual([]);
    expect(
      dump.queue.filter((q: any) => q.target_user_id === userId && q.status === "pending"),
    ).toEqual([]);
  });

  it("fanout-enqueue is idempotent on event_id (second enqueue does not double the queue)", async () => {
    const channelId = "ch-fanout-3";
    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);

    await fanout.fetch(new Request("https://x/register-online", {
      method: "POST",
      headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "u-3", session_id: "s-3", membership_version: 0 }),
    }));

    for (let i = 0; i < 2; i++) {
      await fanout.fetch(new Request("https://x/fanout-enqueue", {
        method: "POST",
        headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: "e-3", event_json: "{}", membership_version_at_event: 0 }),
      }));
    }

    const dump = (await (await fanout.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": channelId } }))).json()) as {
      queue: Array<{ event_id: string }>;
    };
    expect(dump.queue.filter((q: any) => q.event_id === "e-3").length).toBe(1);
  });
});
