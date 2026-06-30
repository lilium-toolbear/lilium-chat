import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { dumpChannelFanout, getNamedDo } from "../helpers";
import type { ChannelFanout } from "../../src/do/channel-fanout";

describe("ChannelFanout leases", () => {
  it("upserts leases through RPC", async () => {
    const channelId = "ch-leases-rpc";
    const userId = "u-leases-rpc";
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);

    const upsert = await fanout.leaseUpsert({
      channel_id: channelId,
      lease_id: "lease-rpc",
      user_id: userId,
      session_id: "s-rpc",
      membership_version: 2,
    });
    expect(upsert.ok).toBe(true);

    const dump = await dumpChannelFanout(fanout, channelId);
    expect(dump.leases).toContainEqual(expect.objectContaining({ lease_id: "lease-rpc", user_id: userId }));
  });

  it("removes stale fanout leases on enqueue", async () => {
    const channelId = "ch-leases-1";
    const userId = "u-leases-1";
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);

    await fanout.leaseUpsert({
      channel_id: channelId,
      lease_id: "lease-1",
      user_id: userId,
      session_id: "s-1",
      membership_version: 2,
    });

    const evt = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v2",
      event_id: "e-lease-1",
      type: "message.created",
      channel_id: channelId,
      occurred_at: "2026-06-27T00:00:00Z",
      payload: {},
    });
    await fanout.fanoutEnqueue({
      channel_id: channelId,
      event_id: "e-lease-1",
      event_json: evt,
      membership_version_at_event: 2,
    });

    const dump = await dumpChannelFanout(fanout, channelId);
    expect(dump.leases.some((l) => l.lease_id === "lease-1")).toBe(false);
    expect(dump.queue).toEqual([]);
  });

  it("deletes stale fanout lease when deliver returns membership_not_active", async () => {
    const channelId = "ch-leases-stale";
    const userId = "u-leases-stale";
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);
    const uc = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);

    const wsRes = await uc.fetch(new Request("https://x/ws", {
      headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
    }));
    const ws = wsRes.webSocket as WebSocket;
    ws.accept();

    let sessionId = "";
    const { runInDurableObject } = await import("cloudflare:test");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await runInDurableObject(uc, async (_instance: unknown, state: any) => {
      const socket = state.getWebSockets()[0];
      const att = socket?.deserializeAttachment() as { session_id?: string } | null;
      sessionId = att?.session_id ?? "";
      state.storage.sql.exec(
        `UPDATE live_sessions SET status='live' WHERE session_id=?`,
        sessionId,
      );
      state.storage.sql.exec(
        `INSERT INTO live_channel_leases (
          session_id, channel_id, route_name, lease_id, membership_version,
          status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 'active', ?, datetime('now'), datetime('now'))`,
        sessionId,
        channelId,
        channelId,
        "lease-stale",
        expiresAt,
      );
    });

    await fanout.leaseUpsert({
      channel_id: channelId,
      lease_id: "lease-stale",
      user_id: userId,
      session_id: sessionId,
      membership_version: 1,
    });

    const evt = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v2",
      event_id: "e-stale",
      type: "message.created",
      channel_id: channelId,
      occurred_at: "2026-06-27T00:00:00Z",
      payload: {},
    });
    await fanout.fanoutEnqueue({
      channel_id: channelId,
      event_id: "e-stale",
      event_json: evt,
      membership_version_at_event: 99,
    });

    const { runDurableObjectAlarm } = await import("cloudflare:test") as { runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void> };
    let leaseGone = false;
    for (let i = 0; i < 40; i++) {
      await runDurableObjectAlarm(fanout);
      const dump = await dumpChannelFanout(fanout, channelId);
      if (!dump.leases.some((l) => l.lease_id === "lease-stale")) {
        leaseGone = true;
        expect(dump.queue).toEqual([]);
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(leaseGone).toBe(true);
    ws.close();
  });
});
