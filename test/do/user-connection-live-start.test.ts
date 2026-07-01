import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  addTestMember,
  createTestChannel,
  dumpChannelFanout,
  getNamedDo,
  readMyChannels,
  removeTestMember,
  sendTestMessage,
  setupOwnedChannelForUser,
} from "../helpers";
import { liveStartAndAck, nextAck, nextMessage, sendHeartbeat, upgradeUserConnection } from "../ws-helpers";
import type { ChannelFanout } from "../../src/do/channel-fanout";
import type { ChatChannel } from "../../src/do/chat-channel";
import type { UserDirectory } from "../../src/do/user-directory";

async function joinTestChannel(userId: string): Promise<{ channelStub: DurableObjectStub<ChatChannel>; channelId: string }> {
  const { stub, channelId } = await setupOwnedChannelForUser(env, userId, { title: "Lilium", visibility: "public_listed" });
  return { channelStub: stub, channelId };
}

async function nextEventFrame(ws: WebSocket, eventId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 5; i++) {
    const frame = JSON.parse(await nextMessage(ws)) as Record<string, unknown>;
    if (frame.frame_type === "event" && frame.event_id === eventId) return frame;
  }
  throw new Error(`event ${eventId} not received`);
}

describe("UserConnection session.live_start", () => {
  it("registers fanout leases for active channels without replay", async () => {
    const userId = "u-live-start";
    const { channelStub, channelId } = await joinTestChannel(userId);

    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    const payload = await liveStartAndAck(ws, "cmd-ls-1");
    expect(payload.session_id).toBe(sessionId);
    expect(payload.subscribed_channel_count).toBeGreaterThanOrEqual(1);

    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);
    const dump = await dumpChannelFanout(fanout, channelId);
    expect(dump.leases.some((l) => l.session_id === sessionId)).toBe(true);

    await liveStartAndAck(ws, "cmd-ls-2");
    const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const rows = state.storage.sql
        .exec("SELECT channel_id FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
        .toArray();
      expect(rows.length).toBe(1);
    });

    ws.close();
  });

  it("resyncs an existing live session after another user adds the member", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = "u-live-add-owner";
    const memberId = "u-live-add-member";
    const channel = await createTestChannel(env, { channelId, ownerId, title: "Live add", visibility: "private" });

    const { ws, stub, sessionId } = await upgradeUserConnection(memberId);
    await liveStartAndAck(ws, "cmd-live-before-add");

    await addTestMember(channel, { actorUserId: ownerId, targetUserId: memberId, channelId, idempotencyKey: "k-live-add-member" });

    const { runDurableObjectAlarm, runInDurableObject } = await import("cloudflare:test") as {
      runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void>;
      runInDurableObject: (stub: DurableObjectStub, fn: (instance: unknown, state: any) => void | Promise<void>) => Promise<void>;
    };
    let status = "";
    for (let i = 0; i < 5; i++) {
      await runDurableObjectAlarm(channel);
      await runInDurableObject(stub, async (_instance: unknown, state: any) => {
        const row = state.storage.sql
          .exec("SELECT status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
          .toArray()[0] as { status: string } | undefined;
        status = row?.status ?? "";
      });
      if (status === "active") break;
    }
    expect(status).toBe("active");

    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);
    const dump = await dumpChannelFanout(fanout, channelId);
    expect(dump.leases.some((l) => l.session_id === sessionId && l.user_id === memberId)).toBe(true);

    const send = await sendTestMessage(channel, { userId: ownerId, channelId, commandId: "cmd-live-add-message", text: "live add delivery" });
    expect(send.status).toBe(200);
    const sent = await send.json() as { event_id: string };
    const delivered = nextEventFrame(ws, sent.event_id);
    await runDurableObjectAlarm(channel);
    await runDurableObjectAlarm(fanout);
    const event = await delivered;
    expect(event.channel_id).toBe(channelId);
    expect(event.type).toBe("message.created");

    ws.close();
  });

  it("closes all live session leases after another user removes the member", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = "u-live-rem-owner";
    const memberId = "u-live-rem-member";
    const channel = await createTestChannel(env, { channelId, ownerId, title: "Live remove", visibility: "private" });

    const { runDurableObjectAlarm, runInDurableObject } = await import("cloudflare:test") as {
      runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void>;
      runInDurableObject: (stub: DurableObjectStub, fn: (instance: unknown, state: any) => void | Promise<void>) => Promise<void>;
    };
    const first = await upgradeUserConnection(memberId);
    const second = await upgradeUserConnection(memberId);
    await liveStartAndAck(first.ws, "cmd-live-rem-1");
    await liveStartAndAck(second.ws, "cmd-live-rem-2");

    await addTestMember(channel, { actorUserId: ownerId, targetUserId: memberId, channelId, idempotencyKey: "k-live-remove-add-member" });
    await runDurableObjectAlarm(channel);

    await removeTestMember(channel, { actorUserId: ownerId, targetUserId: memberId, channelId, idempotencyKey: "k-live-remove-member" });
    await runDurableObjectAlarm(channel);

    await runInDurableObject(first.stub, async (_instance: unknown, state: any) => {
      const rows = state.storage.sql
        .exec("SELECT session_id, status FROM live_channel_leases WHERE channel_id=? ORDER BY session_id", channelId)
        .toArray() as Array<{ session_id: string; status: string }>;
      expect(rows).toEqual(expect.arrayContaining([
        { session_id: first.sessionId, status: "closed" },
        { session_id: second.sessionId, status: "closed" },
      ]));
    });

    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);
    const dump = await dumpChannelFanout(fanout, channelId);
    expect(dump.leases.filter((l) => l.user_id === memberId)).toHaveLength(0);

    first.ws.close();
    second.ws.close();
  });

  it("reopens a previously closed channel lease with a fresh lease id", async () => {
    const channelId = crypto.randomUUID();
    const memberId = "u-live-rejoin-member";
    const { runInDurableObject } = await import("cloudflare:test") as {
      runInDurableObject: (stub: DurableObjectStub, fn: (instance: unknown, state: any) => void | Promise<void>) => Promise<void>;
    };

    const { ws, stub, sessionId } = await upgradeUserConnection(memberId);
    await liveStartAndAck(ws, "cmd-live-rejoin-1");
    const dir = getNamedDo<UserDirectory>(env.USER_DIRECTORY, memberId);

    await dir.upsertChannelProjection(memberId, { action: "join", channel_id: channelId, kind: "channel", membership_version: 1 });
    await stub.liveMembershipsChanged({ affected_user_id: memberId, reason: "member_added", changed_channel_id: channelId, membership_version: 1 });

    let closedLeaseId = "";
    await dir.upsertChannelProjection(memberId, { action: "leave", channel_id: channelId, kind: "channel", membership_version: 2 });
    await stub.liveMembershipsChanged({ affected_user_id: memberId, reason: "member_removed", changed_channel_id: channelId, membership_version: 2 });
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec("SELECT lease_id, status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
        .toArray()[0] as { lease_id: string; status: string } | undefined;
      expect(row?.status).toBe("closed");
      closedLeaseId = row?.lease_id ?? "";
    });

    await dir.upsertChannelProjection(memberId, { action: "join", channel_id: channelId, kind: "channel", membership_version: 3 });
    await stub.liveMembershipsChanged({ affected_user_id: memberId, reason: "member_added", changed_channel_id: channelId, membership_version: 3 });

    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec("SELECT lease_id, status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
        .toArray()[0] as { lease_id: string; status: string } | undefined;
      expect(row?.status).toBe("active");
      expect(row?.lease_id).not.toBe(closedLeaseId);
    });

    ws.close();
  });

  it("does not close leases when my-channels reload fails during heartbeat", async () => {
    const channelId = crypto.randomUUID();
    const memberId = "u-live-dir-fail-member";
    const { runInDurableObject } = await import("cloudflare:test") as {
      runInDurableObject: (stub: DurableObjectStub, fn: (instance: unknown, state: any) => void | Promise<void>) => Promise<void>;
    };

    const dir = getNamedDo<UserDirectory>(env.USER_DIRECTORY, memberId);
    await dir.upsertChannelProjection(memberId, { action: "join", channel_id: channelId, kind: "channel", membership_version: 1 });

    const { ws, stub, sessionId } = await upgradeUserConnection(memberId);
    await liveStartAndAck(ws, "cmd-live-dir-fail-start");

    await dir.debugSetMyChannelsFailure(true);

    sendHeartbeat(ws, "cmd-live-dir-fail-heartbeat");
    const raw = await nextAck(ws);
    const frame = JSON.parse(raw) as { frame_type: string; error?: { code: string; retryable: boolean } };
    expect(frame.frame_type).toBe("command_error");
    expect(frame.error?.code).toBe("CHAT_WORKER_UNAVAILABLE");
    expect(frame.error?.retryable).toBe(true);

    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec("SELECT status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
        .toArray()[0] as { status: string } | undefined;
      expect(row?.status).toBe("active");
    });

    ws.close();
    await dir.debugSetMyChannelsFailure(false);
  });

  it("closes websocket session when active lease expires", async () => {
    const userId = "u-live-lease-expire";
    const { channelId } = await joinTestChannel(userId);
    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws, "cmd-live-lease-expire-start");

    const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test") as {
      runInDurableObject: (stub: DurableObjectStub, fn: (instance: unknown, state: any) => void | Promise<void>) => Promise<void>;
      runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void>;
    };

    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      state.storage.sql.exec(
        "UPDATE live_channel_leases SET expires_at=? WHERE session_id=? AND channel_id=?",
        "2000-01-01T00:00:00.000Z",
        sessionId,
        channelId,
      );
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const session = state.storage.sql
        .exec("SELECT status, close_reason FROM live_sessions WHERE session_id=?", sessionId)
        .toArray()[0] as { status: string; close_reason: string } | undefined;
      expect(session?.status).toBe("closed");
      expect(session?.close_reason).toBe("lease_expired");

      const lease = state.storage.sql
        .exec("SELECT status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
        .toArray()[0] as { status: string } | undefined;
      expect(lease?.status).toBe("closed");
    });

    ws.close();
  });

  it("closes expired active leases for non-live sessions without rescheduling past alarm", async () => {
    const userId = "u-live-lease-expire-stale";
    const { channelId } = await joinTestChannel(userId);
    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws, "cmd-live-lease-expire-stale-start");

    const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test") as {
      runInDurableObject: (stub: DurableObjectStub, fn: (instance: unknown, state: any) => void | Promise<void>) => Promise<void>;
      runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void>;
    };

    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      state.storage.sql.exec("UPDATE live_sessions SET status='closed' WHERE session_id=?", sessionId);
      state.storage.sql.exec(
        "UPDATE live_channel_leases SET expires_at=? WHERE session_id=? AND channel_id=?",
        "2000-01-01T00:00:00.000Z",
        sessionId,
        channelId,
      );
      await state.storage.setAlarm(Date.parse("2000-01-01T00:00:00.000Z"));
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const lease = state.storage.sql
        .exec("SELECT status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
        .toArray()[0] as { status: string } | undefined;
      expect(lease?.status).toBe("closed");
      expect(await state.storage.getAlarm()).toBeNull();
    });

    ws.close();
  });

  it("keeps live leases after channel dissolve while my_channels retains the tombstone", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = "u-live-dis-owner";
    const memberId = "u-live-dis-member";
    const channel = await createTestChannel(env, { channelId, ownerId, title: "Live dissolve", visibility: "private" });
    const { runDurableObjectAlarm, runInDurableObject } = await import("cloudflare:test") as {
      runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void>;
      runInDurableObject: (stub: DurableObjectStub, fn: (instance: unknown, state: any) => void | Promise<void>) => Promise<void>;
    };

    const { ws, stub, sessionId } = await upgradeUserConnection(memberId);
    await liveStartAndAck(ws, "cmd-live-dissolve");

    await addTestMember(channel, { actorUserId: ownerId, targetUserId: memberId, channelId, idempotencyKey: "k-live-dissolve-add" });
    await runDurableObjectAlarm(channel);

    await channel.dissolveChannel({ user_id: ownerId, idempotency_key: "k-live-dissolve", channel_id: channelId });
    let status = "";
    for (let i = 0; i < 5; i++) {
      await runDurableObjectAlarm(channel);
      await runInDurableObject(stub, async (_instance: unknown, state: any) => {
        const row = state.storage.sql
          .exec("SELECT status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
          .toArray()[0] as { status: string } | undefined;
        status = row?.status ?? "";
      });
      if (status === "active") break;
    }
    expect(status).toBe("active");

    const myItems = await readMyChannels(env, memberId);
    expect(myItems.some((row) => row.channel_id === channelId)).toBe(true);

    ws.close();
  });
});

describe("UserConnection /deliver membership gate", () => {
  it("returns membership_not_active and closes local lease when user left", async () => {
    const userId = "u-deliver-member";
    const { channelStub, channelId } = await joinTestChannel(userId);

    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws);

    let leaseId = "";
    let membershipVersion = 0;
    const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
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

    await channelStub.debugLeaveMember({ user_id: userId });
    await runDurableObjectAlarm(channelStub);

    const eventJson = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v2",
      event_id: "e-member-gate",
      type: "message.created",
      channel_id: channelId,
      occurred_at: "2026-06-27T00:00:00Z",
      payload: {},
    });
    const body = await stub.deliver({
      lease_id: leaseId,
      channel_id: channelId,
      session_id: sessionId,
      event_id: "e-member-gate",
      event_json: eventJson,
      membership_version_at_event: membershipVersion + 10,
    });
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe("membership_not_active");

    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec("SELECT status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
        .toArray()[0] as { status: string } | undefined;
      expect(row?.status).toBe("closed");
    });
    ws.close();
  });
});

describe("UserConnection session.heartbeat membership", () => {
  it("does not refresh fanout leases when TTL is still fresh", async () => {
    const userId = "u-heartbeat-skip-upsert";
    const { channelId } = await joinTestChannel(userId);
    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);

    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws, "cmd-hb-skip-live-start");

    const beforeDump = await dumpChannelFanout(fanout, channelId);
    expect(beforeDump.leases.length).toBeGreaterThan(0);
    const updatedAtBefore = beforeDump.leases[0]?.updated_at ?? "";

    const freshLastSeenAt = new Date(Date.now() + 60_000).toISOString();
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      state.storage.sql.exec(
        "UPDATE live_sessions SET last_seen_at=? WHERE session_id=?",
        freshLastSeenAt,
        sessionId,
      );
    });

    sendHeartbeat(ws, "cmd-hb-skip");
    const hbRaw = await nextAck(ws);
    expect(JSON.parse(hbRaw).frame_type).toBe("command_ack");

    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec("SELECT last_seen_at FROM live_sessions WHERE session_id=?", sessionId)
        .toArray()[0] as { last_seen_at: string } | undefined;
      expect(row?.last_seen_at).toBe(freshLastSeenAt);
    });

    const afterDump = await dumpChannelFanout(fanout, channelId);
    expect(afterDump.leases[0]?.updated_at).toBe(updatedAtBefore);
    ws.close();
  });

  it("refreshes live session last_seen_at after heartbeat interval", async () => {
    const userId = "u-heartbeat-refresh-session";
    await joinTestChannel(userId);

    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws, "cmd-hb-refresh-live-start");

    const staleLastSeenAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      state.storage.sql.exec(
        "UPDATE live_sessions SET last_seen_at=? WHERE session_id=?",
        staleLastSeenAt,
        sessionId,
      );
    });

    sendHeartbeat(ws, "cmd-hb-refresh");
    const hbRaw = await nextAck(ws);
    expect(JSON.parse(hbRaw).frame_type).toBe("command_ack");

    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec("SELECT last_seen_at FROM live_sessions WHERE session_id=?", sessionId)
        .toArray()[0] as { last_seen_at: string } | undefined;
      expect(row?.last_seen_at).not.toBe(staleLastSeenAt);
    });

    ws.close();
  });

  it("closes stale leases after member leave and does not deliver later events", async () => {
    const userId = "u-heartbeat-member";
    const { channelStub, channelId } = await joinTestChannel(userId);

    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);
    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws);

    await channelStub.debugLeaveMember({ user_id: userId });

    const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test");
    for (let i = 0; i < 40; i++) {
      await runDurableObjectAlarm(channelStub);
      const items = await readMyChannels(env, userId);
      if (!items.some((it) => it.channel_id === channelId)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const { sendHeartbeat } = await import("../ws-helpers");
    sendHeartbeat(ws, "cmd-hb-1");
    const hbRaw = await nextAck(ws);
    expect(JSON.parse(hbRaw).frame_type).toBe("command_ack");

    const dump = await dumpChannelFanout(fanout, channelId);
    expect(dump.leases.some((l) => l.session_id === sessionId)).toBe(false);

    let leaseId = "";
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec("SELECT lease_id, status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
        .toArray()[0] as { lease_id: string; status: string } | undefined;
      leaseId = row?.lease_id ?? "";
      expect(row?.status).toBe("closed");
    });

    const eventJson = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v2",
      event_id: "e-after-hb",
      type: "message.created",
      channel_id: channelId,
      occurred_at: "2026-06-27T00:00:00Z",
      payload: {},
    });
    const body = await stub.deliver({
      lease_id: leaseId,
      channel_id: channelId,
      session_id: sessionId,
      event_json: eventJson,
      membership_version_at_event: 99,
    });
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe("lease_closed");
    ws.close();
  });
});
