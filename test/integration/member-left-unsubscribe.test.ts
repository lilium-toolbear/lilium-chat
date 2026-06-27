import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo, setupOwnedChannelForUser } from "../helpers";
import { liveStartAndAck } from "../ws-helpers";

async function joinTestChannel(userId: string): Promise<{ channelStub: DurableObjectStub; channelId: string }> {
  const { stub, channelId } = await setupOwnedChannelForUser(env, userId, { title: "Lilium", visibility: "public_listed" });
  return { channelStub: stub, channelId };
}

describe("member.left → ChannelFanout drops the user", () => {
  it("after leave + alarm, ChannelFanout has no lease for the user", async () => {
    const userId = "u-leave-1";
    const { channelStub, channelId } = await joinTestChannel(userId);
    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);
    await fanout.fetch(
      new Request("https://x/lease-upsert", {
        method: "POST",
        headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, session_id: "s-leave-1", lease_id: "lease-leave-1", membership_version: 1 }),
      }),
    );

    await channelStub.fetch(
      new Request("https://x/internal/test-leave", {
        method: "POST",
        headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }),
    );

    const { runDurableObjectAlarm } = await import("cloudflare:test") as { runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void> };
    let drained = false;
    for (let i = 0; i < 60; i++) {
      await runDurableObjectAlarm(channelStub);
      const dump = (await (await fanout.fetch(new Request("https://x/dump", { headers: { "X-Test-Only": "1", "X-Channel-Id": channelId } }))).json()) as {
        leases: Array<{ user_id?: string }>;
      };
      if (dump.leases.filter((s) => s.user_id === userId).length === 0) {
        drained = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(drained).toBe(true);
  });

  it("deliver gate drops an event for a user who left, even before unregister outbox flushes", async () => {
    const userId = "u-leave-2";
    const { channelStub, channelId } = await joinTestChannel(userId);

    const uc = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
    const up = await uc.fetch(new Request("https://x/ws", { headers: { Upgrade: "websocket", "X-Verified-User-Id": userId } }));
    const ws = up.webSocket as WebSocket;
    ws.accept();
    await liveStartAndAck(ws);

    let sessionId = "";
    let leaseId = "";
    let membershipVersion = 0;
    const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test");
    await runInDurableObject(uc, async (_inst: unknown, state: any) => {
      const socket = state.getWebSockets()[0] as WebSocket;
      sessionId = (socket.deserializeAttachment() as { session_id: string }).session_id;
      const row = state.storage.sql
        .exec(
          "SELECT lease_id, membership_version FROM live_channel_leases WHERE session_id=? AND channel_id=?",
          sessionId,
          channelId,
        )
        .toArray()[0] as { lease_id: string; membership_version: number } | undefined;
      leaseId = row?.lease_id ?? "";
      membershipVersion = row?.membership_version ?? 0;
    });
    expect(leaseId).toBeTruthy();

    await channelStub.fetch(
      new Request("https://x/internal/test-leave", {
        method: "POST",
        headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }),
    );
    await runDurableObjectAlarm(channelStub);

    const laterEvent = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v2",
      event_id: "e-after-leave",
      type: "message.created",
      channel_id: channelId,
      occurred_at: "2026-06-23T00:00:00Z",
      payload: {},
    });
    const deliverRes = await uc.fetch(
      new Request("https://x/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Channel-Id": channelId },
        body: JSON.stringify({
          lease_id: leaseId,
          channel_id: channelId,
          session_id: sessionId,
          event_json: laterEvent,
          membership_version_at_event: membershipVersion + 10,
        }),
      }),
    );
    expect(deliverRes.status).toBe(200);
    const db = (await deliverRes.json()) as { delivered: boolean; reason?: string };
    expect(db.delivered).toBe(false);
    expect(db.reason).toBe("membership_not_active");

    await new Promise((r) => setTimeout(r, 150));
    const probe = (await (await uc.fetch(new Request("https://x/test-last-deliver", { headers: { "X-Test-Only": "1", "X-Channel-Id": channelId } }))).json()) as {
      event_json?: string;
    };
    expect(probe.event_json ?? "").not.toContain('"e-after-leave"');
    ws.close();
  });

  it("stale fanout row targeting a gone session does NOT deliver to the user's new socket", async () => {
    const userId = "u-leave-3";
    const { channelId } = await joinTestChannel(userId);

    const uc = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
    const up = await uc.fetch(new Request("https://x/ws", { headers: { Upgrade: "websocket", "X-Verified-User-Id": userId } }));
    const ws = up.webSocket as WebSocket;
    ws.accept();

    const staleEvent = JSON.stringify({
      frame_type: "event", api_version: "lilium.chat.v2", event_id: "e-stale-session", type: "message.created",
      channel_id: channelId, occurred_at: "2026-06-23T00:00:00Z", payload: {},
    });
    const deliverRes = await uc.fetch(new Request("https://x/deliver", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Channel-Id": channelId },
      body: JSON.stringify({
        session_id: "old-session-gone",
        channel_id: channelId,
        lease_id: "old-lease",
        event_json: staleEvent,
        membership_version_at_event: 0,
      }),
    }));
    expect(deliverRes.status).toBe(200);
    const db = (await deliverRes.json()) as { delivered: boolean; reason?: string };
    expect(db.delivered).toBe(false);
    expect(db.reason).toBe("session_not_found");

    await new Promise((r) => setTimeout(r, 150));
    const probe = (await (await uc.fetch(new Request("https://x/test-last-deliver", { headers: { "X-Test-Only": "1", "X-Channel-Id": channelId } }))).json()) as { event_json?: string };
    expect(probe.event_json ?? "").not.toContain('"e-stale-session"');
    ws.close();
  });
});
