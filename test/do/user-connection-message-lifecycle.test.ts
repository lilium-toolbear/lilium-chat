import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { addTestMember, createTestChannel, readMyChannels, sendTestMessage } from "../helpers";
import { nextAck, upgradeUserConnection } from "../ws-helpers";
import type { ChatChannel } from "../../src/do/chat-channel";

async function setupChannelAndJoin(userId: string, channelId: string): Promise<DurableObjectStub<ChatChannel>> {
  const stub = await createTestChannel(env, { channelId, ownerId: userId, title: "WS", visibility: "private" });
  const { runDurableObjectAlarm } = await import("cloudflare:test") as { runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void> };
  await runDurableObjectAlarm(stub);
  for (let i = 0; i < 100; i++) {
    const items = await readMyChannels(env, userId);
    if (items.some((m) => m.channel_id === channelId)) return stub;
    await runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("setupChannelAndJoin: my_channels row never appeared for " + userId + "/" + channelId);
}

async function seedMessage(
  stub: DurableObjectStub<ChatChannel>,
  userId: string,
  channelId: string,
  commandId: string,
  text: string,
): Promise<{ message_id: string }> {
  const send = (await (
    await sendTestMessage(stub, { userId, channelId, commandId, text })
  ).json()) as { message: { message_id: string } };
  return send.message;
}

describe("UserConnection message lifecycle WS", () => {
  it("edit: sender edits own message -> payload-bearing ack with edited projection", async () => {
    const userId = "u-ws-e1";
    const cid = "01a40010-0000-7000-8000-000000000001";
    const sysStub = await setupChannelAndJoin(userId, cid);
    const send = await seedMessage(sysStub, userId, cid, "cmd-send-ws-e1", "orig");
    const { ws } = await upgradeUserConnection(userId);
    ws.send(JSON.stringify({ frame_type: "command", command: "message.edit", command_id: "cmd-edit-ws-e1", channel_id: cid, payload: { message_id: send.message_id, text: "edited" } }));
    const ackRaw = await nextAck(ws);
    const ack = JSON.parse(ackRaw);
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.command).toBe("message.edit");
    expect(ack.command_id).toBe("cmd-edit-ws-e1");
    expect(ack.payload.message.status).toBe("edited");
    ws.close();
  });

  it("edit: non-owner editing another's message -> command_error", async () => {
    const ownerId = "u-ws-e2";
    const memberId = "u-ws-e2b";
    const cid = "01a40011-0000-7000-8000-000000000001";
    const sysStub = await setupChannelAndJoin(ownerId, cid);
    const send = await seedMessage(sysStub, ownerId, cid, "cmd-send-ws-e2", "orig");
    await addTestMember(sysStub, { actorUserId: ownerId, targetUserId: memberId, channelId: cid, idempotencyKey: "cmd-add-ws-e2" });
    const { ws } = await upgradeUserConnection(memberId);
    ws.send(JSON.stringify({
      frame_type: "command",
      command: "message.edit",
      command_id: "cmd-edit-ws-e2",
      channel_id: cid,
      payload: { message_id: send.message_id, text: "hijack" },
    }));
    const errRaw = await nextAck(ws);
    const err = JSON.parse(errRaw);
    expect(err.frame_type).toBe("command_error");
    expect(err.error.code).toBe("MESSAGE_NOT_EDITABLE");
    ws.close();
  });

  it("recall: sender recalls -> ack status recalled, text null", async () => {
    const userId = "u-ws-r1";
    const cid = "01a40020-0000-7000-8000-000000000001";
    const sysStub = await setupChannelAndJoin(userId, cid);
    const send = await seedMessage(sysStub, userId, cid, "cmd-send-ws-r1", "secret");
    const { ws } = await upgradeUserConnection(userId);
    ws.send(JSON.stringify({ frame_type: "command", command: "message.recall", command_id: "cmd-recall-ws-r1", channel_id: cid, payload: { message_id: send.message_id } }));
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
    const send = await seedMessage(sysStub, userId, cid, "cmd-send-ws-d1", "bye");
    const { ws } = await upgradeUserConnection(userId);
    ws.send(JSON.stringify({ frame_type: "command", command: "message.delete", command_id: "cmd-delete-ws-d1", channel_id: cid, payload: { message_id: send.message_id, reason: "spam" } }));
    const ack = JSON.parse(await nextAck(ws));
    expect(ack.command).toBe("message.delete");
    expect(ack.payload.message.status).toBe("deleted");
    ws.close();
  });
});
