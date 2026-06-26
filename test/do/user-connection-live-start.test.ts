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
