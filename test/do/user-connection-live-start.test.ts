import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, setupOwnedChannelForUser } from "../helpers";
import { liveStartAndAck, nextAck, nextMessage, sendHeartbeat, upgradeUserConnection } from "../ws-helpers";

async function joinTestChannel(userId: string): Promise<{ channelStub: DurableObjectStub; channelId: string }> {
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

    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);
    const dump = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Test-Only": "1", "X-Channel-Id": channelId },
    }))).json()) as { leases: Array<{ session_id: string }> };
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
    const channel = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
    await channel.fetch(new Request("https://x/internal/create-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: channelId,
        creator_user_id: ownerId,
        title: "Live add",
        topic: null,
        avatar_attachment_id: null,
        visibility: "private",
        initial_members: [],
      }),
    }));

    const { ws, stub, sessionId } = await upgradeUserConnection(memberId);
    await liveStartAndAck(ws, "cmd-live-before-add");

    await channel.fetch(new Request("https://x/internal/members-add", {
      method: "POST",
      headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotency_key: "k-live-add-member",
        channel_id: channelId,
        user_id: memberId,
        role: "member",
      }),
    }));

    const { runDurableObjectAlarm, runInDurableObject } = await import("cloudflare:test") as {
      runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void>;
      runInDurableObject: (stub: DurableObjectStub, fn: (instance: unknown, state: any) => void | Promise<void>) => Promise<void>;
    };
    await runDurableObjectAlarm(channel);

    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec("SELECT status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
        .toArray()[0] as { status: string } | undefined;
      expect(row?.status).toBe("active");
    });

    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);
    const dump = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Test-Only": "1", "X-Channel-Id": channelId },
    }))).json()) as { leases: Array<{ session_id: string; user_id: string }> };
    expect(dump.leases.some((l) => l.session_id === sessionId && l.user_id === memberId)).toBe(true);

    const send = await channel.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: "cmd-live-add-message",
        dedupe_principal_key: `user:${ownerId}`,
        type: "text",
        text: "live add delivery",
        reply_to: null,
        mentions: [],
        channel_id: channelId,
      }),
    }));
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
    const channel = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
    await channel.fetch(new Request("https://x/internal/create-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: channelId,
        creator_user_id: ownerId,
        title: "Live remove",
        topic: null,
        avatar_attachment_id: null,
        visibility: "private",
        initial_members: [],
      }),
    }));

    const { runDurableObjectAlarm, runInDurableObject } = await import("cloudflare:test") as {
      runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void>;
      runInDurableObject: (stub: DurableObjectStub, fn: (instance: unknown, state: any) => void | Promise<void>) => Promise<void>;
    };
    const first = await upgradeUserConnection(memberId);
    const second = await upgradeUserConnection(memberId);
    await liveStartAndAck(first.ws, "cmd-live-rem-1");
    await liveStartAndAck(second.ws, "cmd-live-rem-2");

    await channel.fetch(new Request("https://x/internal/members-add", {
      method: "POST",
      headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotency_key: "k-live-remove-add-member",
        channel_id: channelId,
        user_id: memberId,
        role: "member",
      }),
    }));
    await runDurableObjectAlarm(channel);

    await channel.fetch(new Request("https://x/internal/members-remove", {
      method: "POST",
      headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotency_key: "k-live-remove-member",
        channel_id: channelId,
        user_id: memberId,
      }),
    }));
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

    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);
    const dump = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Test-Only": "1", "X-Channel-Id": channelId },
    }))).json()) as { leases: Array<{ session_id: string; user_id: string }> };
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
    const dir = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], memberId);

    await dir.fetch(new Request("https://x/internal/upsert-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": memberId, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "join", channel_id: channelId, kind: "channel", membership_version: 1 }),
    }));
    await stub.fetch(new Request("https://x/internal/live-memberships-changed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ affected_user_id: memberId, reason: "member_added", changed_channel_id: channelId, membership_version: 1 }),
    }));

    let closedLeaseId = "";
    await dir.fetch(new Request("https://x/internal/upsert-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": memberId, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "leave", channel_id: channelId, kind: "channel", membership_version: 2 }),
    }));
    await stub.fetch(new Request("https://x/internal/live-memberships-changed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ affected_user_id: memberId, reason: "member_removed", changed_channel_id: channelId, membership_version: 2 }),
    }));
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec("SELECT lease_id, status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, channelId)
        .toArray()[0] as { lease_id: string; status: string } | undefined;
      expect(row?.status).toBe("closed");
      closedLeaseId = row?.lease_id ?? "";
    });

    await dir.fetch(new Request("https://x/internal/upsert-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": memberId, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "join", channel_id: channelId, kind: "channel", membership_version: 3 }),
    }));
    await stub.fetch(new Request("https://x/internal/live-memberships-changed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ affected_user_id: memberId, reason: "member_added", changed_channel_id: channelId, membership_version: 3 }),
    }));

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

    const dir = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], memberId);
    await dir.fetch(new Request("https://x/internal/upsert-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": memberId, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "join", channel_id: channelId, kind: "channel", membership_version: 1 }),
    }));

    const { ws, stub, sessionId } = await upgradeUserConnection(memberId);
    await liveStartAndAck(ws, "cmd-live-dir-fail-start");

    await dir.fetch(new Request("https://x/internal/test-my-channels-failure", {
      method: "POST",
      headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }));

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
    await dir.fetch(new Request("https://x/internal/test-my-channels-failure", {
      method: "POST",
      headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }));
  });

  it("keeps live leases after channel dissolve while my_channels retains the tombstone", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = "u-live-dis-owner";
    const memberId = "u-live-dis-member";
    const channel = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
    const { runDurableObjectAlarm, runInDurableObject } = await import("cloudflare:test") as {
      runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void>;
      runInDurableObject: (stub: DurableObjectStub, fn: (instance: unknown, state: any) => void | Promise<void>) => Promise<void>;
    };

    await channel.fetch(new Request("https://x/internal/create-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: channelId,
        creator_user_id: ownerId,
        title: "Live dissolve",
        topic: null,
        avatar_attachment_id: null,
        visibility: "private",
        initial_members: [],
      }),
    }));

    const { ws, stub, sessionId } = await upgradeUserConnection(memberId);
    await liveStartAndAck(ws, "cmd-live-dissolve");

    await channel.fetch(new Request("https://x/internal/members-add", {
      method: "POST",
      headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-live-dissolve-add", channel_id: channelId, user_id: memberId, role: "member" }),
    }));
    await runDurableObjectAlarm(channel);

    await channel.fetch(new Request("https://x/internal/dissolve", {
      method: "POST",
      headers: { "X-Verified-User-Id": ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-live-dissolve", channel_id: channelId }),
    }));
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

    const dir = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], memberId);
    const myRes = await dir.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": memberId } }));
    const myBody = await myRes.json() as { items: Array<{ channel_id: string }> };
    expect(myBody.items.some((row) => row.channel_id === channelId)).toBe(true);

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

    await channelStub.fetch(new Request("https://x/internal/test-leave", {
      method: "POST",
      headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
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
    const deliverRes = await stub.fetch(new Request("https://x/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Channel-Id": channelId },
      body: JSON.stringify({
        lease_id: leaseId,
        channel_id: channelId,
        session_id: sessionId,
        event_id: "e-member-gate",
        event_json: eventJson,
        membership_version_at_event: membershipVersion + 10,
      }),
    }));
    const body = (await deliverRes.json()) as { delivered: boolean; reason?: string };
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
    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);

    const { ws } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws, "cmd-hb-skip-live-start");

    const beforeDump = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Test-Only": "1", "X-Channel-Id": channelId },
    }))).json()) as { leases: Array<{ updated_at: string }> };
    expect(beforeDump.leases.length).toBeGreaterThan(0);
    const updatedAtBefore = beforeDump.leases[0]?.updated_at ?? "";

    sendHeartbeat(ws, "cmd-hb-skip");
    const hbRaw = await nextAck(ws);
    expect(JSON.parse(hbRaw).frame_type).toBe("command_ack");

    const afterDump = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Test-Only": "1", "X-Channel-Id": channelId },
    }))).json()) as { leases: Array<{ updated_at: string }> };
    expect(afterDump.leases[0]?.updated_at).toBe(updatedAtBefore);
    ws.close();
  });

  it("closes stale leases after member leave and does not deliver later events", async () => {
    const userId = "u-heartbeat-member";
    const { channelStub, channelId } = await joinTestChannel(userId);

    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);
    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws);

    await channelStub.fetch(new Request("https://x/internal/test-leave", {
      method: "POST",
      headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));

    const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test");
    for (let i = 0; i < 40; i++) {
      await runDurableObjectAlarm(channelStub);
      const dir = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], userId);
      const dirRes = await dir.fetch(new Request("https://x/my-channels", {
        headers: { "X-Verified-User-Id": userId },
      }));
      const items = dirRes.ok
        ? ((await dirRes.json()) as { items: Array<{ channel_id: string }> }).items ?? []
        : [];
      if (!items.some((it) => it.channel_id === channelId)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const { sendHeartbeat } = await import("../ws-helpers");
    sendHeartbeat(ws, "cmd-hb-1");
    const hbRaw = await nextAck(ws);
    expect(JSON.parse(hbRaw).frame_type).toBe("command_ack");

    const dump = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Test-Only": "1", "X-Channel-Id": channelId },
    }))).json()) as { leases: Array<{ session_id: string }> };
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
    const deliverRes = await stub.fetch(new Request("https://x/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Channel-Id": channelId },
      body: JSON.stringify({
        lease_id: leaseId,
        channel_id: channelId,
        session_id: sessionId,
        event_json: eventJson,
        membership_version_at_event: 99,
      }),
    }));
    const body = (await deliverRes.json()) as { delivered: boolean; reason?: string };
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe("lease_closed");
    ws.close();
  });
});
