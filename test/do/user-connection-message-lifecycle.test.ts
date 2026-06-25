import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

async function setupChannelAndJoin(userId: string, channelId: string) {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
  await stub.fetch(new Request("https://x/internal/create-channel", {
    method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: channelId, creator_user_id: userId, title: "WS", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }),
  }));
  const { runDurableObjectAlarm } = await import("cloudflare:test") as any;
  await runDurableObjectAlarm(stub);
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

// minimal helpers (copy from user-connection.test.ts pattern)
async function upgrade(userId: string) {
  const stub = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
  const res = await stub.fetch(new Request("https://x/ws", { headers: { Upgrade: "websocket", "X-Verified-User-Id": userId } }));
  const ws = res.webSocket as WebSocket; ws.accept(); return { ws, stub };
}
function nextAck(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const h = (ev: MessageEvent) => { try { const f = JSON.parse(typeof ev.data === "string" ? ev.data : ""); if (f.frame_type === "command_ack" || f.frame_type === "command_error") { clearTimeout(t); ws.removeEventListener("message", h); resolve(typeof ev.data === "string" ? ev.data : ""); } } catch {} };
    ws.addEventListener("message", h as EventListener);
  });
}

describe("UserConnection message lifecycle WS", () => {
  it("edit: sender edits own message -> payload-bearing ack with edited projection", async () => {
    const userId = "u-ws-e1";
    const cid = "01a40010-0000-7000-8000-000000000001";
    const sysStub = await setupChannelAndJoin(userId, cid);
    const send = await (await sysStub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ command_id: "cmd-send-ws-e1", dedupe_principal_key: `user:${userId}`, type: "text", text: "orig", reply_to: null, mentions: [], channel_id: cid }) }))).json() as { message: { message_id: string } };
    const { ws } = await upgrade(userId);
    ws.send(JSON.stringify({ frame_type: "command", command: "message.edit", command_id: "cmd-edit-ws-e1", channel_id: cid, payload: { message_id: send.message.message_id, text: "edited" } }));
    const ackRaw = await nextAck(ws);
    const ack = JSON.parse(ackRaw);
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.command).toBe("message.edit");
    expect(ack.command_id).toBe("cmd-edit-ws-e1");
    expect(ack.payload.message.status).toBe("edited");
    ws.close();
  });

  it("recall: sender recalls -> ack status recalled, text null", async () => {
    const userId = "u-ws-r1";
    const cid = "01a40020-0000-7000-8000-000000000001";
    const sysStub = await setupChannelAndJoin(userId, cid);
    const send = await (await sysStub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ command_id: "cmd-send-ws-r1", dedupe_principal_key: `user:${userId}`, type: "text", text: "secret", reply_to: null, mentions: [], channel_id: cid }) }))).json() as { message: { message_id: string } };
    const { ws } = await upgrade(userId);
    ws.send(JSON.stringify({ frame_type: "command", command: "message.recall", command_id: "cmd-recall-ws-r1", channel_id: cid, payload: { message_id: send.message.message_id } }));
    const ack = JSON.parse(await nextAck(ws));
    expect(ack.command).toBe("message.recall");
    expect(ack.payload.message.status).toBe("recalled");
    expect(ack.payload.message.text).toBeNull();
    ws.close();
  });

  it("delete: owner deletes own message -> ack status deleted", async () => {
    const userId = "u-ws-d1";
    const cid = "01a40030-0000-7000-8000-000000000001";
    const sysStub = await setupChannelAndJoin(userId, cid);
    const send = await (await sysStub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ command_id: "cmd-send-ws-d1", dedupe_principal_key: `user:${userId}`, type: "text", text: "bye", reply_to: null, mentions: [], channel_id: cid }) }))).json() as { message: { message_id: string } };
    const { ws } = await upgrade(userId);
    ws.send(JSON.stringify({ frame_type: "command", command: "message.delete", command_id: "cmd-delete-ws-d1", channel_id: cid, payload: { message_id: send.message.message_id, reason: "spam" } }));
    const ack = JSON.parse(await nextAck(ws));
    expect(ack.command).toBe("message.delete");
    expect(ack.payload.message.status).toBe("deleted");
    ws.close();
  });
});
