import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { dumpChannelFanout, getNamedDo } from "../helpers";
import type { ChannelFanout } from "../../src/do/channel-fanout";
import type { UserConnection } from "../../src/do/user-connection";

async function seedDeliverableLease(
  uc: DurableObjectStub,
  fanout: DurableObjectStub<ChannelFanout>,
  channelId: string,
  userId: string,
  sessionId: string,
  leaseId: string,
  membershipVersion: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(uc, async (_instance: unknown, state: any) => {
    state.storage.sql.exec(
      "UPDATE live_sessions SET status='live' WHERE session_id=?",
      sessionId,
    );
    state.storage.sql.exec(
      `INSERT INTO live_channel_leases (
        session_id, channel_id, route_name, lease_id, membership_version,
        status, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, datetime('now'), datetime('now'))`,
      sessionId,
      channelId,
      channelId,
      leaseId,
      membershipVersion,
      expiresAt,
    );
  });
  await fanout.leaseUpsert({
    channel_id: channelId,
    lease_id: leaseId,
    user_id: userId,
    session_id: sessionId,
    membership_version: membershipVersion,
  });
}

describe("ChannelFanout DO", () => {
  it("direct-delivers live leases concurrently without queue writes", async () => {
    const channelId = "ch-fanout-concurrent";
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);
    const { runInDurableObject } = await import("cloudflare:test");

    await runInDurableObject(fanout, async (instance: unknown, state: any) => {
      const fanoutInstance = instance as {
        fanoutEnqueue(input: {
          channel_id: string;
          event_id: string;
          event_json: string;
          membership_version_at_event?: number;
        }): Promise<{ delivered_to: number }>;
        deliverToLease?: () => Promise<{ delivered: boolean; stale: boolean }>;
      };
      for (let i = 0; i < 4; i++) {
        state.storage.sql.exec(
          `INSERT INTO fanout_leases (
            channel_id, lease_id, user_id, session_id, membership_version,
            expires_at, created_at, updated_at, last_error
          ) VALUES (?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'), NULL)`,
          channelId,
          `lease-concurrent-${i}`,
          `u-concurrent-${i}`,
          `s-concurrent-${i}`,
          new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        );
      }

      let active = 0;
      let maxActive = 0;
      fanoutInstance.deliverToLease = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { delivered: true, stale: false };
      };

      await fanoutInstance.fanoutEnqueue({
        channel_id: channelId,
        event_id: "e-concurrent",
        event_json: JSON.stringify({
          frame_type: "event",
          api_version: "lilium.chat.v2",
          event_id: "e-concurrent",
          type: "message.created",
          channel_id: channelId,
          occurred_at: "2026-07-01T00:00:00Z",
          payload: {},
        }),
        membership_version_at_event: 0,
      });

      expect(maxActive).toBeGreaterThan(1);
      expect(
        state.storage.sql.exec("SELECT * FROM fanout_queue WHERE channel_id=?", channelId).toArray(),
      ).toEqual([]);
    });
  });

  it("direct-delivers stream frames to live leases concurrently", async () => {
    const channelId = "ch-fanout-stream-concurrent";
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);
    const { runInDurableObject } = await import("cloudflare:test");

    await runInDurableObject(fanout, async (instance: unknown, state: any) => {
      const fanoutInstance = instance as {
        fanoutDeliverStreamFrame(input: {
          channel_id: string;
          frame: unknown;
        }): Promise<{ delivered_to: number; lease_count: number }>;
        deliverStreamFrameToLease?: () => Promise<{ delivered: boolean }>;
      };
      for (let i = 0; i < 4; i++) {
        state.storage.sql.exec(
          `INSERT INTO fanout_leases (
            channel_id, lease_id, user_id, session_id, membership_version,
            expires_at, created_at, updated_at, last_error
          ) VALUES (?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'), NULL)`,
          channelId,
          `lease-stream-concurrent-${i}`,
          `u-stream-concurrent-${i}`,
          `s-stream-concurrent-${i}`,
          new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        );
      }

      let active = 0;
      let maxActive = 0;
      fanoutInstance.deliverStreamFrameToLease = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { delivered: true };
      };

      const result = await fanoutInstance.fanoutDeliverStreamFrame({
        channel_id: channelId,
        frame: { frame_type: "stream_event", seq: 1 },
      });

      expect(maxActive).toBeGreaterThan(1);
      expect(result.delivered_to).toBe(result.lease_count);
    });
  });

  it("delivers to live leases without writing fanout_queue rows", async () => {
    const channelId = "ch-fanout-1";
    const userId = "u-fanout-1";
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);

    const uc = getNamedDo<UserConnection>(env.USER_CONNECTION, userId);
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

    await seedDeliverableLease(uc, fanout, channelId, userId, sessionId, "lease-fanout-1", 3);

    const evt = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v2",
      event_id: "e-1",
      type: "message.created",
      channel_id: channelId,
      occurred_at: "2026-06-23T00:00:00Z",
      payload: {},
    });
    await fanout.fanoutEnqueue({
      channel_id: channelId,
      event_id: "e-1",
      event_json: evt,
      membership_version_at_event: 3,
    });

    const dump1 = await dumpChannelFanout(fanout, channelId);
    expect(dump1.events).toEqual([]);
    expect(dump1.queue).toEqual([]);

    const probe = await uc.debugLastDeliver();
    expect(probe.event_json).toContain('"event_id":"e-1"');

    ws.close();
  });

  it("unregister-user drops leases and fails their pending queue rows (member.left)", async () => {
    const channelId = "ch-fanout-2";
    const userId = "u-fanout-2";
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);

    await fanout.leaseUpsert({
      channel_id: channelId,
      lease_id: "lease-2",
      user_id: userId,
      session_id: "s-2",
      membership_version: 1,
    });

    await fanout.fanoutEnqueue({
      channel_id: channelId,
      event_id: "e-2",
      event_json: "{}",
      membership_version_at_event: 1,
    });

    await fanout.unregisterUser({ channel_id: channelId, user_id: userId });

    const dump = await dumpChannelFanout(fanout, channelId);

    expect(dump.leases.filter((s) => s.user_id === userId)).toEqual([]);
    expect(
      dump.queue.filter((q) => q.target_user_id === userId && q.status === "pending"),
    ).toEqual([]);
  });

  it("queues retryable delivery failures idempotently", async () => {
    const channelId = "ch-fanout-3";
    const userId = "u-fanout-3";
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);

    const uc = getNamedDo<UserConnection>(env.USER_CONNECTION, userId);
    const wsRes = await uc.fetch(new Request("https://x/ws", {
      headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
    }));
    const ws = wsRes.webSocket as WebSocket;
    ws.accept();

    let sessionId = "";
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(uc, async (_instance: unknown, state: { getWebSockets: () => WebSocket[] }) => {
      const socket = state.getWebSockets()[0];
      const att = socket?.deserializeAttachment() as { session_id?: string } | null;
      sessionId = att?.session_id ?? "";
    });
    await seedDeliverableLease(uc, fanout, channelId, userId, sessionId, "lease-3", 0);

    for (let i = 0; i < 2; i++) {
      await fanout.fanoutEnqueue({
        channel_id: channelId,
        event_id: "e-3",
        event_json: "{}",
        membership_version_at_event: 0,
      });
    }

    const dump = await dumpChannelFanout(fanout, channelId);
    expect(dump.queue.filter((q) => q.event_id === "e-3").length).toBe(1);

    ws.close();
  });
});
