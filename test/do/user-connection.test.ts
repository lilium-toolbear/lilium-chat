import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo } from "../helpers";
import { liveStartAndAck, nextAck, nextMessage, upgradeUserConnection } from "../ws-helpers";

async function joinSystemChannel(userId: string): Promise<{ sysId: string; sysStub: DurableObjectStub }> {
  const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
  await sysStub.fetch(new Request("https://x/internal/maybe-create-system", {
    method: "POST",
    body: JSON.stringify({ title: "Lilium" }),
  }));
  await sysStub.fetch(
    new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }),
  );
  const { runDurableObjectAlarm } = await import("cloudflare:test") as { runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void> };
  await runDurableObjectAlarm(sysStub);
  const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", {
    headers: { "X-Verified-User-Id": userId },
  }))).json() as { channel_id: string }).channel_id;
  return { sysId, sysStub };
}

describe("UserConnection DO", () => {
  it("/deliver sends an event frame on the live socket and stores a probe", async () => {
    const userId = "u-uc-deliver";
    const { sysId } = await joinSystemChannel(userId);
    const { ws, stub, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws);

    let leaseId = "";
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const row = state.storage.sql
        .exec(
          "SELECT lease_id FROM live_channel_leases WHERE session_id=? AND channel_id=?",
          sessionId,
          sysId,
        )
        .toArray()[0] as { lease_id: string } | undefined;
      leaseId = row?.lease_id ?? "";
    });
    expect(leaseId).toBeTruthy();

    const eventJson = JSON.stringify({
      frame_type: "event",
      api_version: "lilium.chat.v2",
      event_id: "e-d1",
      type: "message.created",
      channel_id: sysId,
      occurred_at: "2026-06-23T00:00:00Z",
      payload: {},
    });
    const receivedPromise = nextMessage(ws);
    const deliverRes = await stub.fetch(new Request("https://x/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Channel-Id": sysId },
      body: JSON.stringify({
        lease_id: leaseId,
        channel_id: sysId,
        session_id: sessionId,
        event_id: "e-d1",
        event_json: eventJson,
        membership_version_at_event: 0,
      }),
    }));
    expect(deliverRes.status).toBe(200);

    const received = await receivedPromise;
    expect(JSON.parse(received).event_id).toBe("e-d1");

    const probe = await (await stub.fetch(new Request("https://x/test-last-deliver"))).json() as { event_json: string | null };
    expect(probe.event_json).toContain('"event_id":"e-d1"');
    ws.close();
  });

  it("/deliver with a non-existent session_id does NOT deliver to another socket of the same user (fail-closed)", async () => {
    const userId = "u-uc-failclosed";
    const { sysId } = await joinSystemChannel(userId);
    const { ws, stub } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws);

    const eventJson = JSON.stringify({
      frame_type: "event", api_version: "lilium.chat.v2", event_id: "e-stale", type: "message.created",
      channel_id: sysId, occurred_at: "2026-06-23T00:00:00Z", payload: {},
    });
    const deliverRes = await stub.fetch(new Request("https://x/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Channel-Id": sysId },
      body: JSON.stringify({
        session_id: "session-that-does-not-exist",
        channel_id: sysId,
        lease_id: "missing-lease",
        event_json: eventJson,
        membership_version_at_event: 0,
      }),
    }));
    expect(deliverRes.status).toBe(200);
    const body = (await deliverRes.json()) as { delivered: boolean; reason?: string };
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe("session_not_found");

    const probe = await (await stub.fetch(new Request("https://x/test-last-deliver"))).json() as { event_json: string | null };
    expect(probe.event_json ?? "").not.toContain('"e-stale"');
    ws.close();
  });

  it("webSocketMessage routes message.send to ChatChannel and returns committed_ack", async () => {
    const userId = "u-uc-send";
    const { sysId } = await joinSystemChannel(userId);

    const { ws } = await upgradeUserConnection(userId);
    const cmd = JSON.stringify({
      frame_type: "command",
      command: "message.send",
      command_id: "cmd-uc-1",
      channel_id: sysId,
      payload: {
        type: "text",
        text: "hi from uc",
        reply_to_message_id: null,
        attachment_ids: [],
        mentions: [],
      },
    });

    ws.send(cmd);
    const ackRaw = await nextMessage(ws);
    const ack = JSON.parse(ackRaw);
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.status).toBe("committed");
    expect(ack.command_id).toBe("cmd-uc-1");
    expect(ack.payload.channel_id).toBe(sysId);
    expect(ack.payload.message.message_id).toBeTruthy();
    expect(ack.payload.message.sender.user.user_id).toBe(userId);
    expect(ack.payload.event_id).toBeTruthy();
    ws.close();
  });

  it("webSocketMessage returns command_error for invalid message (empty text)", async () => {
    const userId = "u-uc-err";
    const { sysId } = await joinSystemChannel(userId);

    const { ws } = await upgradeUserConnection(userId);
    ws.send(
      JSON.stringify({
        frame_type: "command",
        command: "message.send",
        command_id: "cmd-uc-2",
        channel_id: sysId,
        payload: {
          type: "text",
          text: "   ",
          reply_to_message_id: null,
          attachment_ids: [],
          mentions: [],
        },
      }),
    );

    const errRaw = await nextMessage(ws);
    const err = JSON.parse(errRaw);
    expect(err.frame_type).toBe("command_error");
    expect(err.error.code).toBe("INVALID_MESSAGE");
    ws.close();
  });

  it("idempotent: same command_id twice → same message_id in both acks", async () => {
    const userId = "u-uc-idem";
    const { sysId } = await joinSystemChannel(userId);

    const { ws } = await upgradeUserConnection(userId);
    const base = {
      frame_type: "command",
      command: "message.send",
      channel_id: sysId,
      payload: {
        type: "text",
        text: "dup",
        reply_to_message_id: null,
        attachment_ids: [],
        mentions: [],
      },
    };

    ws.send(JSON.stringify({ ...base, command_id: "c-same" }));
    const ack1 = JSON.parse(await nextAck(ws));
    ws.send(JSON.stringify({ ...base, command_id: "c-same" }));
    const ack1Retry = JSON.parse(await nextAck(ws));
    expect(ack1Retry.payload.message.message_id).toBe(ack1.payload.message.message_id);

    ws.send(JSON.stringify({ ...base, command_id: "c-different" }));
    const ack2 = JSON.parse(await nextAck(ws));
    expect(ack2.payload.message.message_id).not.toBe(ack1.payload.message.message_id);
    ws.close();
  });
});
