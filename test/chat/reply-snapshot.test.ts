import { describe, expect, it } from "vitest";

import {
  buildReplySnapshot,
  loadReplySnapshotMedia,
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

function mockSql(rowsByQuery: Record<string, unknown[]>) {
  return {
    exec: (query: string, ...params: unknown[]) => ({
      toArray: () => {
        const key = query.replace(/\s+/g, " ").trim();
        if (key.startsWith("SELECT url, blurhash, width, height FROM message_stickers")) {
          return rowsByQuery.sticker ?? [];
        }
        if (key.includes("FROM message_attachments")) {
          return rowsByQuery.image ?? [];
        }
        if (key.startsWith("SELECT status FROM messages")) {
          return rowsByQuery.status ?? [];
        }
        void params;
        return [];
      },
    }),
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

  it("truncates long text previews", () => {
    const longText = "a".repeat(150);
    expect(replyTextPreview(targetRow({ text: longText }))).toBe(`${"a".repeat(120)}…`);
  });

  it("clears preview when target is deleted or recalled", () => {
    const snapshot = buildReplySnapshot(targetRow(), "Alice");
    expect(sanitizeReplySnapshotForBrowser(snapshot, "recalled")).toEqual({
      message_id: "msg-target",
      sender_display_name: "Alice",
      text_preview: "",
      status: "recalled",
      media_preview: null,
    });
    expect(sanitizeReplySnapshotForBrowser(snapshot, "deleted")).toEqual({
      message_id: "msg-target",
      sender_display_name: "Alice",
      text_preview: "",
      status: "deleted",
      media_preview: null,
    });
  });

  it("falls back to typed labels when media preview is unavailable", () => {
    expect(replyTextPreview(targetRow({ type: "image", text: "" }))).toBe("[图片]");
    expect(replyTextPreview(targetRow({ type: "sticker", text: "" }))).toBe("[表情]");
  });

  it("loads sticker and image media previews for reply snapshots", () => {
    const stickerMedia = loadReplySnapshotMedia(
      mockSql({
        sticker: [{
          url: "https://example.test/sticker.png",
          blurhash: "hash",
          width: 128,
          height: 128,
        }],
      }),
      "msg-target",
      "sticker",
    );
    expect(stickerMedia).toEqual({
      kind: "sticker",
      url: "https://example.test/sticker.png",
      blurhash: "hash",
      width: 128,
      height: 128,
    });

    const imageMedia = loadReplySnapshotMedia(
      mockSql({
        image: [{
          url: "https://example.test/image.png",
          blurhash: null,
          width: 640,
          height: 480,
        }],
      }),
      "msg-target",
      "image",
    );
    expect(imageMedia).toEqual({
      kind: "image",
      url: "https://example.test/image.png",
      blurhash: null,
      width: 640,
      height: 480,
    });

    expect(buildReplySnapshot(targetRow({ type: "sticker", text: "" }), "Alice", {
      mediaPreview: stickerMedia,
    })).toEqual({
      message_id: "msg-target",
      sender_display_name: "Alice",
      text_preview: "",
      status: "normal",
      media_preview: stickerMedia,
    });
  });
});
