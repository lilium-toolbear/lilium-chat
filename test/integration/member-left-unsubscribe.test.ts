import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { dumpChannelFanout, getNamedDo, setupOwnedChannelForUser } from "../helpers";
import { liveStartAndAck } from "../ws-helpers";
import type { ChannelFanout } from "../../src/do/channel-fanout";
import type { ChatChannel } from "../../src/do/chat-channel";
import type { UserConnection } from "../../src/do/user-connection";

async function joinTestChannel(userId: string): Promise<{ channelStub: DurableObjectStub<ChatChannel>; channelId: string }> {
  const { stub, channelId } = await setupOwnedChannelForUser(env, userId, { title: "Lilium", visibility: "public_listed" });
  return { channelStub: stub, channelId };
}

describe("member.left → ChannelFanout drops the user", () => {
  it("after leave + alarm, ChannelFanout has no lease for the user", async () => {
    const userId = "u-leave-1";
    const { channelStub, channelId } = await joinTestChannel(userId);
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);
    await fanout.leaseUpsert({
      channel_id: channelId,
      user_id: userId,
      session_id: "s-leave-1",
      lease_id: "lease-leave-1",
      membership_version: 1,
    });

    await channelStub.debugLeaveMember({ user_id: userId });

    const { runDurableObjectAlarm } = await import("cloudflare:test") as { runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void> };
    let drained = false;
    for (let i = 0; i < 60; i++) {
      await runDurableObjectAlarm(channelStub);
      const dump = await dumpChannelFanout(fanout, channelId);
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

    const uc = getNamedDo<UserConnection>(env.USER_CONNECTION, userId);
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

    await channelStub.debugLeaveMember({ user_id: userId });
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
    const db = await uc.deliver({
      lease_id: leaseId,
      channel_id: channelId,
      session_id: sessionId,
      event_json: laterEvent,
      membership_version_at_event: membershipVersion + 10,
    });
    expect(db.delivered).toBe(false);
    expect(db.reason).toBe("membership_not_active");

    await new Promise((r) => setTimeout(r, 150));
    const probe = await uc.debugLastDeliver();
    expect(probe.event_json ?? "").not.toContain('"e-after-leave"');
    ws.close();
  });

  it("stale fanout row targeting a gone session does NOT deliver to the user's new socket", async () => {
    const userId = "u-leave-3";
    const { channelId } = await joinTestChannel(userId);

    const uc = getNamedDo<UserConnection>(env.USER_CONNECTION, userId);
    const up = await uc.fetch(new Request("https://x/ws", { headers: { Upgrade: "websocket", "X-Verified-User-Id": userId } }));
    const ws = up.webSocket as WebSocket;
    ws.accept();

    const staleEvent = JSON.stringify({
      frame_type: "event", api_version: "lilium.chat.v2", event_id: "e-stale-session", type: "message.created",
      channel_id: channelId, occurred_at: "2026-06-23T00:00:00Z", payload: {},
    });
    const db = await uc.deliver({
      session_id: "old-session-gone",
      channel_id: channelId,
      lease_id: "old-lease",
      event_json: staleEvent,
      membership_version_at_event: 0,
    });
    expect(db.delivered).toBe(false);
    expect(db.reason).toBe("session_not_found");

    await new Promise((r) => setTimeout(r, 150));
    const probe = await uc.debugLastDeliver();
    expect(probe.event_json ?? "").not.toContain('"e-stale-session"');
    ws.close();
  });
});
