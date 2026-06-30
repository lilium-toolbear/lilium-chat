import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";

import {
  addTestMember,
  createTestChannel,
  fakeS3PublicPath,
  findTimelineMessageCreated,
  getNamedDo,
  mutateTestMessage,
  readTestMessages,
  replayTestEvents,
  sendTestMessage,
  type TimelineHistoryItem,
} from "../helpers";
import { setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";
import type { ChatChannel } from "../../src/do/chat-channel";
import type { UserDirectory } from "../../src/do/user-directory";

function udStub(userId: string) {
  return getNamedDo<UserDirectory>(env.USER_DIRECTORY, userId);
}

async function presignAndFinalize(userId: string, fake: FakeS3): Promise<string> {
  const key = `idem-lc-${userId}`;
  const presignRes = await udStub(userId).presignUpload(userId, key, "attachment", {
    filename: "img.png",
    mime_type: "image/png",
    size_bytes: 12345,
    width: 1,
    height: 1,
  });
  const presignBody = presignRes;
  fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });

  const finalizeRes = await udStub(userId).finalizeUpload(userId, `${key}-fin`, { attachment_id: presignBody.attachment_id });
  expect(finalizeRes.attachment.attachment_id).toBe(presignBody.attachment_id);
  return presignBody.attachment_id;
}

async function setupAndSend(
  userId: string,
  channelId: string,
  text: string,
  cmdId: string,
  type = "text",
  attachmentId?: string,
): Promise<{ stub: DurableObjectStub<ChatChannel>; messageId: string; eventId: string }> {
  const stub = await createTestChannel(env, { channelId, ownerId: userId, title: "LC", visibility: "private" });
  const send = (await (
    await sendTestMessage(stub, {
      userId,
      channelId,
      commandId: cmdId,
      type,
      text,
      attachmentIds: attachmentId ? [attachmentId] : [],
    })
  ).json()) as { message: { message_id: string }; event_id: string };
  return { stub, messageId: send.message.message_id, eventId: send.event_id };
}

describe("ChatChannel message lifecycle", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });
  it("edit: owner edits own text -> status edited, text updated, event message.updated", async () => {
    const { stub, messageId } = await setupAndSend("u-lc-1", "01a40001-0000-7000-8000-000000000001", "orig", "cmd-send-1");
    const res = await mutateTestMessage(stub, {
      userId: "u-lc-1",
      channelId: "01a40001-0000-7000-8000-000000000001",
      messageId,
      operation: "message.edit",
      operationId: "cmd-edit-1",
      text: "edited",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event_id: string; message: { status: string; text: string; edited_at: string | null } };
    expect(body.message.status).toBe("edited");
    expect(body.message.text).toBe("edited");
    expect(body.message.edited_at).not.toBeNull();
    expect(body.event_id).toBeTruthy();
  });

  it("edit: non-owner editing another's message -> 409", async () => {
    const { stub, messageId } = await setupAndSend("u-lc-2", "01a40002-0000-7000-8000-000000000001", "orig", "cmd-send-2");
    await addTestMember(stub, {
      actorUserId: "u-lc-2",
      targetUserId: "u-lc-2b",
      channelId: "01a40002-0000-7000-8000-000000000001",
      idempotencyKey: "cmd-add-2",
    });
    const res = await mutateTestMessage(stub, {
      userId: "u-lc-2b",
      channelId: "01a40002-0000-7000-8000-000000000001",
      messageId,
      operation: "message.edit",
      operationId: "cmd-edit-2",
      text: "hijack",
    });
    expect(res.status).toBe(409);
  });

  it("edit: idempotent retry returns same ack", async () => {
    const { stub, messageId } = await setupAndSend("u-lc-3", "01a40003-0000-7000-8000-000000000001", "orig", "cmd-send-3");
    const body = {
      userId: "u-lc-3",
      channelId: "01a40003-0000-7000-8000-000000000001",
      messageId,
      operation: "message.edit" as const,
      operationId: "cmd-edit-3",
      text: "edited",
    };
    const r1Res = await mutateTestMessage(stub, body);
    const r1 = (await r1Res.json()) as { event_id: string };
    const r2Res = await mutateTestMessage(stub, body);
    const r2 = (await r2Res.json()) as { event_id: string };
    expect(r1.event_id).toBe(r2.event_id);
  });

  it('recall: owner recalls own message -> status recalled, text null in projection', async () => {
    const { stub, messageId } = await setupAndSend("u-lc-4", "01a40004-0000-7000-8000-000000000001", "secret", "cmd-send-4");
    const res = await mutateTestMessage(stub, {
      userId: "u-lc-4",
      channelId: "01a40004-0000-7000-8000-000000000001",
      messageId,
      operation: "message.recall",
      operationId: "cmd-recall-4",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { status: string; text: string | null; recalled_at: string | null; mentions: unknown[] } };
    expect(body.message.status).toBe("recalled");
    expect(body.message.text).toBeNull();
    expect(body.message.mentions).toEqual([]);
    expect(body.message.recalled_at).not.toBeNull();
  });

  it("history excludes recalled and deleted message.created events", async () => {
    const channelId = "01a40004b-0000-7000-8000-000000000001";
    const recalled = await setupAndSend("u-lc-4b", channelId, "recalled-msg", "cmd-send-4b");
    const deleted = await setupAndSend("u-lc-4b", channelId, "deleted-msg", "cmd-send-4c");

    const recallRes = await mutateTestMessage(recalled.stub, {
      userId: "u-lc-4b",
      channelId,
      messageId: recalled.messageId,
      operation: "message.recall",
      operationId: "cmd-recall-4b",
    });
    expect(recallRes.status).toBe(200);

    const deleteRes = await mutateTestMessage(deleted.stub, {
      userId: "u-lc-4b",
      channelId,
      messageId: deleted.messageId,
      operation: "message.delete",
      operationId: "cmd-delete-4b",
    });
    expect(deleteRes.status).toBe(200);

    const historyBody = await readTestMessages(recalled.stub, "u-lc-4b");
    expect(findTimelineMessageCreated(historyBody.items, recalled.messageId)).toBeUndefined();
    expect(findTimelineMessageCreated(historyBody.items, deleted.messageId)).toBeUndefined();
  });

  it("lifecycle state matrix: non-text edit and hidden message edits are rejected", async () => {
    const attachmentId = await presignAndFinalize("u-lc-5", fake);
    const nonText = await setupAndSend("u-lc-5", "01a40005-0000-7000-8000-000000000001", "img", "cmd-send-5", "image", attachmentId);
    const text = await setupAndSend("u-lc-5", "01a40005-0000-7000-8000-000000000001", "ok", "cmd-send-5b");

    const nonTextEditRes = await mutateTestMessage(nonText.stub, {
      userId: "u-lc-5",
      channelId: "01a40005-0000-7000-8000-000000000001",
      messageId: nonText.messageId,
      operation: "message.edit",
      operationId: "cmd-edit-nontext",
      text: "nope",
    });
    expect(nonTextEditRes.status).toBe(409);
    expect(((await nonTextEditRes.json()) as { error: { code: string } }).error.code).toBe("MESSAGE_NOT_EDITABLE");

    const recalled = (await (
      await mutateTestMessage(nonText.stub, {
        userId: "u-lc-5",
        channelId: "01a40005-0000-7000-8000-000000000001",
        messageId: text.messageId,
        operation: "message.recall",
        operationId: "cmd-recall-matrix",
      })
    ).json()) as { message: { message_id: string } };
    expect(recalled.message.message_id).toBe(text.messageId);

    const recalledAgainRes = await mutateTestMessage(nonText.stub, {
      userId: "u-lc-5",
      channelId: "01a40005-0000-7000-8000-000000000001",
      messageId: text.messageId,
      operation: "message.recall",
      operationId: "cmd-recall-matrix-2",
    });
    expect(recalledAgainRes.status).toBe(409);
    expect(((await recalledAgainRes.json()) as { error: { code: string } }).error.code).toBe("MESSAGE_NOT_EDITABLE");

    const editAfterRecallRes = await mutateTestMessage(nonText.stub, {
      userId: "u-lc-5",
      channelId: "01a40005-0000-7000-8000-000000000001",
      messageId: text.messageId,
      operation: "message.edit",
      operationId: "cmd-edit-after-recall",
      text: "nope",
    });
    expect(editAfterRecallRes.status).toBe(409);
    expect(((await editAfterRecallRes.json()) as { error: { code: string } }).error.code).toBe("MESSAGE_NOT_EDITABLE");
  });

  it("admin deletes another member's message -> sender in ack/event remains original author", async () => {
    const owner = "u-lc-6-owner";
    const member = "u-lc-6-member";
    const channelId = "01a40006-0000-7000-8000-000000000001";
    const { stub } = await setupAndSend(owner, channelId, "target-msg", "cmd-send-6");
    await addTestMember(stub, { actorUserId: owner, targetUserId: member, channelId, idempotencyKey: "cmd-add-6" });
    const memberSend = (await (
      await sendTestMessage(stub, { userId: member, channelId, commandId: "cmd-send-6-member", text: "member-msg" })
    ).json()) as { message: { message_id: string }; event_id: string };

    const del = (await (
      await mutateTestMessage(stub, {
        userId: owner,
        channelId,
        messageId: memberSend.message.message_id,
        operation: "message.delete",
        operationId: "cmd-delete-6",
        reason: "spam",
      })
    ).json()) as { event_id: string; message: { status: string; sender: { user?: { user_id: string } } } };
    expect(del.message.status).toBe("deleted");
    expect(del.message.sender.user?.user_id).toBe(member);

    const replay = await replayTestEvents(stub, owner);
    const deletedFrame = replay.events.find((evt) => evt.event_id === del.event_id);
    expect(deletedFrame).toBeDefined();
    const deletedPayload = JSON.parse(deletedFrame!.event_json) as { payload: { message?: { sender?: { user?: { user_id: string } } } } };
    expect(deletedPayload.payload.message?.sender).toBeDefined();
    expect(deletedPayload.payload.message?.sender?.user?.user_id).toBe(member);
  });

  // P0-2 regression: edit after send-with-mention must preserve mentions in the ack projection.
  it("P0-2: edit a message that has mentions -> ack projection preserves mentions", async () => {
    const userId = "u-lc-p02";
    const cid = "0199aa01-0000-7000-8000-000000000001";
    const stub = await createTestChannel(env, { channelId: cid, ownerId: userId, title: "M2", visibility: "private" });
    // send a message WITH a mention
    const send = await (await sendTestMessage(stub, {
      userId,
      channelId: cid,
      commandId: "cmd-send-p02",
      text: "hi @bob",
      mentions: [{ user_id: "u-bob", start: 3, end: 6 }],
    })).json() as { message: { message_id: string; mentions: Array<{ user_id: string }> } };
    expect(send.message.mentions).toHaveLength(1);
    expect(send.message.mentions[0]?.user_id).toBe("u-bob");

    // edit — text changes, mentions should be preserved (not dropped to [])
    const editRes = await mutateTestMessage(stub, {
      userId,
      channelId: cid,
      messageId: send.message.message_id,
      operation: "message.edit",
      operationId: "cmd-edit-p02",
      text: "edited @bob",
    });
    expect(editRes.status).toBe(200);
    const editAck = (await editRes.json()) as { message: { mentions: Array<{ user_id: string }> } };
    expect(editAck.message.mentions).toHaveLength(1);
    expect(editAck.message.mentions[0]?.user_id).toBe("u-bob");
  });

  // P0-1 regression: concurrent same command_id — the second (in-txn cached) branch must return
  // {channel_id, event_id, message}, NOT the full command_ack JSON frame.
  it("P0-1: in-txn cached branch returns {channel_id, event_id, message} shape (not full ack frame)", async () => {
    const userId = "u-lc-p01";
    const cid = "0199bb02-0000-7000-8000-000000000001";
    const stub = await createTestChannel(env, { channelId: cid, ownerId: userId, title: "M3", visibility: "private" });
    const send = await (await sendTestMessage(stub, { userId, channelId: cid, commandId: "cmd-send-p01", text: "orig" })).json() as {
      message: { message_id: string };
    };

    // two concurrent edits with the SAME command_id + same body — both should return the internal shape
    const [r1, r2] = await Promise.all([
      mutateTestMessage(stub, { userId, channelId: cid, messageId: send.message.message_id, operation: "message.edit", operationId: "cmd-edit-p01", text: "edited" }),
      mutateTestMessage(stub, { userId, channelId: cid, messageId: send.message.message_id, operation: "message.edit", operationId: "cmd-edit-p01", text: "edited" }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { channel_id: string; event_id: string; message: Record<string, unknown> };
    const b2 = (await r2.json()) as { channel_id: string; event_id: string; message: Record<string, unknown> };
    // both must have the internal shape (channel_id/event_id/message at top level), NOT frame_type:"command_ack"
    expect(b1.channel_id).toBe(cid);
    expect(b1.event_id).toBeTruthy();
    expect(b1.message).toBeTruthy();
    expect(b2.channel_id).toBe(cid);
    expect(b2.event_id).toBe(b1.event_id); // cached returns same event_id
    // critical: b2 must NOT be a full ack frame (no frame_type field)
    expect(b1 as unknown as { frame_type?: string }).not.toHaveProperty("frame_type");
    expect(b2 as unknown as { frame_type?: string }).not.toHaveProperty("frame_type");
  });
});
