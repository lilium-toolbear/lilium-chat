import { describe, expect, it } from "vitest";
import { projectCommandInvokeReplyContext } from "../../src/chat/command-invoke-reply";
import type { MessageRow } from "../../src/contract/persisted";

function makeRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    message_id: "msg-1",
    command_id: "cmd-1",
    channel_id: "ch-1",
    sender_kind: "user",
    sender_user_id: "user-1",
    sender_bot_id: null,
    sender_bot_display_name: null,
    sender_bot_avatar_url: null,
    type: "text",
    format: "plain",
    status: "normal",
    text: "hello",
    reply_to: null,
    reply_snapshot_json: null,
    stream_state: "none",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    recalled_at: null,
    invocation_json: null,
    ...overrides,
  };
}

describe("projectCommandInvokeReplyContext", () => {
  it("projects sender and text for a visible text message", () => {
    const projected = projectCommandInvokeReplyContext(makeRow(), {
      user_id: "user-1",
      display_name: "Alice",
      avatar_url: null,
    });
    expect(projected).toMatchObject({
      message_id: "msg-1",
      type: "text",
      status: "normal",
      text: "hello",
      sender: {
        kind: "user",
        user: {
          user_id: "user-1",
          display_name: "Alice",
          avatar_url: null,
        },
      },
    });
  });

  it("hides text for deleted or recalled messages", () => {
    const deleted = projectCommandInvokeReplyContext(makeRow({ status: "deleted" }), null);
    expect(deleted.text).toBeNull();
    expect(deleted.status).toBe("deleted");
  });
});
