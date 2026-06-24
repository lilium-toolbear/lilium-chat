import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

async function setupChannelAndJoin(userId: string, channelId: string) {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
  await stub.fetch(new Request("https://x/internal/create-channel", {
    method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: channelId, creator_user_id: userId, title: "M", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }),
  }));
  // flush the join outbox so my_channels is populated before WS upgrade
  const { runDurableObjectAlarm } = await import("cloudflare:test") as any;
  await runDurableObjectAlarm(stub);
  // Robustness: the user_directory join outbox may lag under load; poll my_channels until the row
  // is active (same pattern as the member-left-unsubscribe fix). Re-flush the alarm if needed.
  const dir = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], userId);
  for (let i = 0; i < 100; i++) {
    const myRes = await dir.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    if (myRes.ok) {
      const items = ((await myRes.json()) as { items: Array<{ channel_id: string }> }).items;
      if (items.some((m) => m.channel_id === channelId)) return stub;
    }
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("setupChannelAndJoin: my_channels row never appeared for " + userId + "/" + channelId);
}

async function upgrade(userId: string) {
  const stub = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
  const res = await stub.fetch(new Request("https://x/ws", { headers: { Upgrade: "websocket", "X-Verified-User-Id": userId } }));
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return { ws, stub };
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    ws.addEventListener("message", (ev) => { clearTimeout(t); resolve(typeof ev.data === "string" ? ev.data : ""); }, { once: true });
  });
}

describe("UserConnection channel.mark_read", () => {
  it("advances floor and acks {channel_id, last_read_event_id, unread_count} with no event_id", async () => {
    const userId = "u-mr-1";
    const cid = "01970001-0000-7000-8000-000000000011";
    await setupChannelAndJoin(userId, cid);
    const { ws } = await upgrade(userId);
    ws.send(JSON.stringify({
      frame_type: "command", command: "channel.mark_read", command_id: "cmd-mr-1", channel_id: cid,
      payload: { last_read_event_id: "01J00000000000000000000000" },
    }));
    const ackRaw = await nextMessage(ws);
    const ack = JSON.parse(ackRaw);
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.command_id).toBe("cmd-mr-1");
    expect(ack.status).toBe("committed");
    expect(ack.payload.channel_id).toBe(cid);
    expect(ack.payload.last_read_event_id).toBe("01J00000000000000000000000");
    expect(ack.payload.unread_count).toBe(0);
    expect(ack.payload.event_id).toBeUndefined();
    ws.close();
  });

  it("broadcasts a read_state_updated frame to the user's other session", async () => {
    const userId = "u-mr-2";
    const cid = "01970002-0000-7000-8000-000000000011";
    await setupChannelAndJoin(userId, cid);
    // two sessions for the same user
    const { ws: wsA } = await upgrade(userId);
    const { ws: wsB } = await upgrade(userId);
    // wsA sends mark_read; wsB should receive a read_state_updated frame (best-effort)
    wsA.send(JSON.stringify({
      frame_type: "command", command: "channel.mark_read", command_id: "cmd-mr-2", channel_id: cid,
      payload: { last_read_event_id: "01J00000000000000000000010" },
    }));
    // drain wsA's ack
    await nextMessage(wsA);
    // wsB: receive either the read_state_updated frame (first message might be replay events; poll)
    let got = "";
    try { got = await nextMessage(wsB, 3000); } catch { got = ""; }
    // wsB may have received replay frames on connect first; keep polling until read_state_updated or timeout
    for (let i = 0; i < 20 && !got.includes("read_state_updated"); i++) {
      try { got = await nextMessage(wsB, 500); } catch { break; }
    }
    expect(got).toContain("read_state_updated");
    wsA.close(); wsB.close();
  });

  it("is monotonic: stale cursor returns the stored floor, not the request cursor", async () => {
    const userId = "u-mr-3";
    const cid = "01970003-0000-7000-8000-000000000011";
    await setupChannelAndJoin(userId, cid);
    const { ws } = await upgrade(userId);
    ws.send(JSON.stringify({ frame_type: "command", command: "channel.mark_read", command_id: "cmd-mr-3a", channel_id: cid, payload: { last_read_event_id: "01Jzzzzzzzzzzzzzzzzzzzzzz" } }));
    await nextMessage(ws);
    ws.send(JSON.stringify({ frame_type: "command", command: "channel.mark_read", command_id: "cmd-mr-3b", channel_id: cid, payload: { last_read_event_id: "01Jaaaaaaaaaaaaaaaaaaaaaaa" } }));
    const ackRaw2 = await nextMessage(ws);
    const ack2 = JSON.parse(ackRaw2);
    expect(ack2.payload.last_read_event_id).toBe("01Jzzzzzzzzzzzzzzzzzzzzzz");
    ws.close();
  });
});
