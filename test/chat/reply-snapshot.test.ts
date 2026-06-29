import { describe, expect, it } from "vitest";

import {
  buildReplySnapshot,
  replyTextPreview,
  sanitizeReplySnapshotForBrowser,
} from "../../src/chat/reply-snapshot";
import type { MessageRow } from "../../src/contract/persisted";

function targetRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    message_id: "msg-target",
    command_id: "cmd-target",
    channel_id: "ch-1",
    sender_kind: "user",
    sender_user_id: "u-alice",
    sender_bot_id: null,
    type: "text",
    format: "plain",
    status: "normal",
    text: "hello world",
    reply_to: null,
    reply_snapshot_json: null,
    stream_state: "none",
    created_at: "t",
    updated_at: "t",
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    recalled_at: null,
    ...overrides,
  };
}

describe("reply-snapshot", () => {
  it("builds a text preview for normal messages", () => {
    expect(replyTextPreview(targetRow())).toBe("hello world");
    expect(buildReplySnapshot(targetRow(), "Alice")).toEqual({
      message_id: "msg-target",
      sender_display_name: "Alice",
      text_preview: "hello world",
      status: "normal",
    });
  });

  it("clears preview when target is deleted or recalled", () => {
    const snapshot = buildReplySnapshot(targetRow(), "Alice");
    expect(sanitizeReplySnapshotForBrowser(snapshot, "recalled")).toEqual({
      message_id: "msg-target",
      sender_display_name: "Alice",
      text_preview: "",
      status: "recalled",
    });
    expect(sanitizeReplySnapshotForBrowser(snapshot, "deleted")).toEqual({
      message_id: "msg-target",
      sender_display_name: "Alice",
      text_preview: "",
      status: "deleted",
    });
  });

  it("uses typed previews for image and sticker messages", () => {
    expect(replyTextPreview(targetRow({ type: "image", text: "" }))).toBe("[图片]");
    expect(replyTextPreview(targetRow({ type: "sticker", text: "" }))).toBe("[表情]");
  });
});
