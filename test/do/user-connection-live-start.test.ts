import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { liveStartAndAck, nextAck, upgradeUserConnection } from "../ws-helpers";

describe("UserConnection session.live_start", () => {
  it("registers fanout leases for active channels without replay", async () => {
    const userId = "u-live-start";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", {
      method: "POST", body: JSON.stringify({ title: "Lilium" }),
    }));
    await sysStub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const { runDurableObjectAlarm } = await import("cloudflare:test") as { runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void> };
    await runDurableObjectAlarm(sysStub);
    const sysId = ((await (await sysStub.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": userId },
    }))).json()) as { channel_id: string }).channel_id;

    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    const payload = await liveStartAndAck(ws, "cmd-ls-1");
    expect(payload.session_id).toBe(sessionId);
    expect(payload.subscribed_channel_count).toBeGreaterThanOrEqual(1);

    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], sysId);
    const dump = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Channel-Id": sysId },
    }))).json()) as { leases: Array<{ session_id: string }> };
    expect(dump.leases.some((l) => l.session_id === sessionId)).toBe(true);

    await liveStartAndAck(ws, "cmd-ls-2");
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const rows = state.storage.sql
        .exec("SELECT channel_id FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, sysId)
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
      headers: { "X-Channel-Id": channelId },
    }))).json()) as { leases: Array<{ session_id: string; user_id: string }> };
    expect(dump.leases.some((l) => l.session_id === sessionId && l.user_id === memberId)).toBe(true);

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
      headers: { "X-Channel-Id": channelId },
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

  it("closes affected member leases after channel dissolve", async () => {
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
      if (status === "closed") break;
    }
    expect(status).toBe("closed");

    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);
    let remainingLeaseCount = 0;
    for (let i = 0; i < 5; i++) {
      const dump = (await (await fanout.fetch(new Request("https://x/dump", {
        headers: { "X-Channel-Id": channelId },
      }))).json()) as { leases: Array<{ user_id: string }> };
      remainingLeaseCount = dump.leases.filter((l) => l.user_id === memberId).length;
      if (remainingLeaseCount === 0) break;
      await runDurableObjectAlarm(fanout);
    }
    expect(remainingLeaseCount).toBe(0);

    ws.close();
  });
});

describe("UserConnection /deliver membership gate", () => {
  it("returns membership_not_active and closes local lease when user left", async () => {
    const userId = "u-deliver-member";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", {
      method: "POST", body: JSON.stringify({ title: "Lilium" }),
    }));
    await sysStub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const { runDurableObjectAlarm } = await import("cloudflare:test") as { runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void> };
    await runDurableObjectAlarm(sysStub);
    const sysId = ((await (await sysStub.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": userId },
    }))).json()) as { channel_id: string }).channel_id;

    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws);

    let leaseId = "";
    let membershipVersion = 0;
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec(
          "SELECT lease_id, membership_version FROM live_channel_leases WHERE session_id=? AND channel_id=?",
          sessionId,
          sysId,
        )
        .toArray()[0] as { lease_id: string; membership_version: number } | undefined;
      leaseId = row?.lease_id ?? "";
      membershipVersion = row?.membership_version ?? 0;
    });

    await sysStub.fetch(new Request("https://x/internal/test-leave", {
      method: "POST",
      headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    await runDurableObjectAlarm(sysStub);

    const eventJson = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v2",
      event_id: "e-member-gate",
      type: "message.created",
      channel_id: sysId,
      occurred_at: "2026-06-27T00:00:00Z",
      payload: {},
    });
    const deliverRes = await stub.fetch(new Request("https://x/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Channel-Id": sysId },
      body: JSON.stringify({
        lease_id: leaseId,
        channel_id: sysId,
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
        .exec("SELECT status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, sysId)
        .toArray()[0] as { status: string } | undefined;
      expect(row?.status).toBe("closed");
    });
    ws.close();
  });
});

describe("UserConnection session.heartbeat membership", () => {
  it("closes stale leases after member leave and does not deliver later events", async () => {
    const userId = "u-heartbeat-member";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", {
      method: "POST", body: JSON.stringify({ title: "Lilium" }),
    }));
    await sysStub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const { runDurableObjectAlarm } = await import("cloudflare:test") as { runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void> };
    await runDurableObjectAlarm(sysStub);
    const sysId = ((await (await sysStub.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": userId },
    }))).json()) as { channel_id: string }).channel_id;

    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], sysId);
    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws);

    await sysStub.fetch(new Request("https://x/internal/test-leave", {
      method: "POST",
      headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));

    for (let i = 0; i < 40; i++) {
      await runDurableObjectAlarm(sysStub);
      const dir = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], userId);
      const dirRes = await dir.fetch(new Request("https://x/my-channels", {
        headers: { "X-Verified-User-Id": userId },
      }));
      const items = dirRes.ok
        ? ((await dirRes.json()) as { items: Array<{ channel_id: string }> }).items ?? []
        : [];
      if (!items.some((it) => it.channel_id === sysId)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const { sendHeartbeat } = await import("../ws-helpers");
    sendHeartbeat(ws, "cmd-hb-1");
    const hbRaw = await nextAck(ws);
    expect(JSON.parse(hbRaw).frame_type).toBe("command_ack");

    const dump = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Channel-Id": sysId },
    }))).json()) as { leases: Array<{ session_id: string }> };
    expect(dump.leases.some((l) => l.session_id === sessionId)).toBe(false);

    let leaseId = "";
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec("SELECT lease_id, status FROM live_channel_leases WHERE session_id=? AND channel_id=?", sessionId, sysId)
        .toArray()[0] as { lease_id: string; status: string } | undefined;
      leaseId = row?.lease_id ?? "";
      expect(row?.status).toBe("closed");
    });

    const eventJson = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v2",
      event_id: "e-after-hb",
      type: "message.created",
      channel_id: sysId,
      occurred_at: "2026-06-27T00:00:00Z",
      payload: {},
    });
    const deliverRes = await stub.fetch(new Request("https://x/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Channel-Id": sysId },
      body: JSON.stringify({
        lease_id: leaseId,
        channel_id: sysId,
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
