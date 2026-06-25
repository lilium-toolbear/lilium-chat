import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo } from "../helpers";

async function setupAndSend(
  userId: string,
  channelId: string,
  text: string,
  cmdId: string,
  type = "text",
): Promise<{ stub: DurableObjectStub; messageId: string; eventId: string }> {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
  await stub.fetch(new Request("https://x/internal/create-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({
      channel_id: channelId,
      creator_user_id: userId,
      title: "LC",
      topic: null,
      avatar_attachment_id: null,
      visibility: "private",
      initial_members: [],
    }),
  }));
  const send = (await (
    await stub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: cmdId,
          dedupe_principal_key: `user:${userId}`,
          type,
          text,
          reply_to: null,
          mentions: [],
          channel_id: channelId,
        }),
      }),
    )
  ).json()) as { message: { message_id: string }; event_id: string };
  return { stub, messageId: send.message.message_id, eventId: send.event_id };
}

describe("ChatChannel message lifecycle", () => {
  it("edit: owner edits own text -> status edited, text updated, event message.updated", async () => {
    const { stub, messageId } = await setupAndSend("u-lc-1", "01a40001-0000-7000-8000-000000000001", "orig", "cmd-send-1");
    const res = await stub.fetch(new Request("https://x/internal/message-edit", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-lc-1", "Content-Type": "application/json" },
      body: JSON.stringify({ operation_id: "cmd-edit-1", message_id: messageId, text: "edited", channel_id: "01a40001-0000-7000-8000-000000000001" }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event_id: string; message: { status: string; text: string; edited_at: string | null } };
    expect(body.message.status).toBe("edited");
    expect(body.message.text).toBe("edited");
    expect(body.message.edited_at).not.toBeNull();
    expect(body.event_id).toBeTruthy();
  });

  it("edit: non-owner editing another's message -> 409", async () => {
    const { stub, messageId } = await setupAndSend("u-lc-2", "01a40002-0000-7000-8000-000000000001", "orig", "cmd-send-2");
    await stub.fetch(new Request("https://x/internal/members-add", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-lc-2", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "cmd-add-2", channel_id: "01a40002-0000-7000-8000-000000000001", user_id: "u-lc-2b", role: "member" }),
    }));
    const res = await stub.fetch(new Request("https://x/internal/message-edit", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-lc-2b", "Content-Type": "application/json" },
      body: JSON.stringify({ operation_id: "cmd-edit-2", message_id: messageId, text: "hijack", channel_id: "01a40002-0000-7000-8000-000000000001" }),
    }));
    expect(res.status).toBe(409);
  });

  it("edit: idempotent retry returns same ack", async () => {
    const { stub, messageId } = await setupAndSend("u-lc-3", "01a40003-0000-7000-8000-000000000001", "orig", "cmd-send-3");
    const body = { operation_id: "cmd-edit-3", message_id: messageId, text: "edited", channel_id: "01a40003-0000-7000-8000-000000000001" };
    const r1Res = await stub.fetch(new Request("https://x/internal/message-edit", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-lc-3", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    const r1 = (await r1Res.json()) as { event_id: string };
    const r2Res = await stub.fetch(new Request("https://x/internal/message-edit", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-lc-3", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    const r2 = (await r2Res.json()) as { event_id: string };
    expect(r1.event_id).toBe(r2.event_id);
  });

  it("recall: owner recalls own message -> status recalled, text null in projection", async () => {
    const { stub, messageId } = await setupAndSend("u-lc-4", "01a40004-0000-7000-8000-000000000001", "secret", "cmd-send-4");
    const res = await stub.fetch(new Request("https://x/internal/message-recall", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-lc-4", "Content-Type": "application/json" },
      body: JSON.stringify({ operation_id: "cmd-recall-4", message_id: messageId, channel_id: "01a40004-0000-7000-8000-000000000001" }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { status: string; text: string | null; recalled_at: string | null; mentions: unknown[] } };
    expect(body.message.status).toBe("recalled");
    expect(body.message.text).toBeNull();
    expect(body.message.mentions).toEqual([]);
    expect(body.message.recalled_at).not.toBeNull();
  });

  it("lifecycle state matrix: non-text edit and hidden message edits are rejected", async () => {
    const nonText = await setupAndSend("u-lc-5", "01a40005-0000-7000-8000-000000000001", "img", "cmd-send-5", "image");
    const text = await setupAndSend("u-lc-5", "01a40005-0000-7000-8000-000000000001", "ok", "cmd-send-5b");

    const nonTextEditRes = await nonText.stub.fetch(new Request("https://x/internal/message-edit", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-lc-5", "Content-Type": "application/json" },
      body: JSON.stringify({
        operation_id: "cmd-edit-nontext",
        message_id: nonText.messageId,
        text: "nope",
        channel_id: "01a40005-0000-7000-8000-000000000001",
      }),
    }));
    expect(nonTextEditRes.status).toBe(409);
    expect(((await nonTextEditRes.json()) as { error: { code: string } }).error.code).toBe("MESSAGE_NOT_EDITABLE");

    const recalled = (await (
      await nonText.stub.fetch(
        new Request("https://x/internal/message-recall", {
          method: "POST",
          headers: { "X-Verified-User-Id": "u-lc-5", "Content-Type": "application/json" },
          body: JSON.stringify({
            operation_id: "cmd-recall-matrix",
            message_id: text.messageId,
            channel_id: "01a40005-0000-7000-8000-000000000001",
          }),
        }),
      )
    ).json()) as { message: { message_id: string } };
    expect(recalled.message.message_id).toBe(text.messageId);

    const recalledAgainRes = await nonText.stub.fetch(new Request("https://x/internal/message-recall", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-lc-5", "Content-Type": "application/json" },
      body: JSON.stringify({
        operation_id: "cmd-recall-matrix-2",
        message_id: text.messageId,
        channel_id: "01a40005-0000-7000-8000-000000000001",
      }),
    }));
    expect(recalledAgainRes.status).toBe(409);
    expect(((await recalledAgainRes.json()) as { error: { code: string } }).error.code).toBe("MESSAGE_NOT_EDITABLE");

    const editAfterRecallRes = await nonText.stub.fetch(new Request("https://x/internal/message-edit", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-lc-5", "Content-Type": "application/json" },
      body: JSON.stringify({
        operation_id: "cmd-edit-after-recall",
        message_id: text.messageId,
        text: "nope",
        channel_id: "01a40005-0000-7000-8000-000000000001",
      }),
    }));
    expect(editAfterRecallRes.status).toBe(409);
    expect(((await editAfterRecallRes.json()) as { error: { code: string } }).error.code).toBe("MESSAGE_NOT_EDITABLE");
  });

  it("admin deletes another member's message -> sender in ack/event remains original author", async () => {
    const owner = "u-lc-6-owner";
    const member = "u-lc-6-member";
    const channelId = "01a40006-0000-7000-8000-000000000001";
    const { stub } = await setupAndSend(owner, channelId, "target-msg", "cmd-send-6");
    await stub.fetch(new Request("https://x/internal/members-add", {
      method: "POST",
      headers: { "X-Verified-User-Id": owner, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "cmd-add-6", channel_id: channelId, user_id: member, role: "member" }),
    }));
    const memberSend = (await (
      await stub.fetch(
        new Request("https://x/internal/message-send", {
          method: "POST",
          headers: { "X-Verified-User-Id": member, "Content-Type": "application/json" },
          body: JSON.stringify({
            command_id: "cmd-send-6-member",
            dedupe_principal_key: `user:${member}`,
            type: "text",
            text: "member-msg",
            reply_to: null,
            mentions: [],
            channel_id: channelId,
          }),
        }),
      )
    ).json()) as { message: { message_id: string }; event_id: string };

    const del = (await (
      await stub.fetch(new Request("https://x/internal/message-delete", {
        method: "POST",
        headers: { "X-Verified-User-Id": owner, "Content-Type": "application/json" },
        body: JSON.stringify({
          operation_id: "cmd-delete-6",
          message_id: memberSend.message.message_id,
          reason: "spam",
          channel_id: channelId,
        }),
      }))
    ).json()) as { event_id: string; message: { status: string; sender: { user?: { user_id: string } } } };
    expect(del.message.status).toBe("deleted");
    expect(del.message.sender.user?.user_id).toBe(member);

    const replay = (await (
      await stub.fetch(new Request(`https://x/internal/replay?after=`, {
        headers: { "X-Verified-User-Id": owner },
      }))
    ).json()) as { events: Array<{ event_id: string; event_json: string }> };
    const deletedFrame = replay.events.find((evt) => evt.event_id === del.event_id);
    expect(deletedFrame).toBeDefined();
    const deletedPayload = JSON.parse(deletedFrame!.event_json) as { payload: { message?: { sender?: { user?: { user_id: string } } } } };
    expect(deletedPayload.payload.message?.sender).toBeDefined();
    expect(deletedPayload.payload.message?.sender?.user?.user_id).toBe(member);

    const notice = replay.events.find((evt) => {
      const parsed = JSON.parse(evt.event_json) as {
        type: string;
        payload: { notice_kind?: string; actor?: { user_id?: string }; target_user?: { user_id?: string } };
      };
      return parsed.type === "system.notice" && parsed.payload.notice_kind === "message.deleted";
    });
    expect(notice).toBeDefined();
    const noticePayload = JSON.parse(notice!.event_json) as {
      payload: { notice_kind?: string; actor?: { user_id?: string }; target_user?: { user_id?: string } };
    };
    expect(noticePayload.payload.actor?.user_id).toBe(owner);
    expect(noticePayload.payload.target_user?.user_id).toBe(member);
  });
});
