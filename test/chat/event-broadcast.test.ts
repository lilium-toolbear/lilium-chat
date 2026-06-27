import { describe, it, expect } from "vitest";
import { buildEventFrame, buildMessageCreatedPayload, resolveSenderForLiveBroadcast } from "../../src/chat/event-broadcast";
import type { MessageProjectionEventPayload } from "../../src/contract/events";

describe("buildEventFrame", () => {
  it("produces the contract §10.4 envelope shape", () => {
    const f = buildEventFrame({
      event_id: "01J...",
      type: "message.created",
      channel_id: "ch-1",
      occurred_at: "2026-06-21T05:30:00Z",
      payload: { message: { message_id: "m-1" } } as MessageProjectionEventPayload,
    });
    expect(f).toEqual({
      frame_type: "event",
      api_version: "lilium.chat.v1",
      event_id: "01J...",
      type: "message.created",
      channel_id: "ch-1",
      occurred_at: "2026-06-21T05:30:00Z",
      payload: { message: { message_id: "m-1" } },
    });
  });
});

describe("buildMessageCreatedPayload", () => {
  it("projects sender as a reference, not a UserSummary (persisted shape)", () => {
    const p = buildMessageCreatedPayload({
      message_id: "m-1",
      command_id: "cm-1",
      channel_id: "ch-1",
      sender_kind: "user",
      sender_user_id: "u-1",
      sender_bot_id: null,
      status: "normal",
      created_at: "2026-06-21T05:30:00Z",
      updated_at: "2026-06-21T05:30:00Z",
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
      recalled_at: null,
      stream_state: "none",
      reply_to: null,
      reply_snapshot_json: null,
      type: "text",
      format: "plain",
      text: "hello",
    });
    expect(p.message).toMatchObject({
      message_id: "m-1",
      command_id: "cm-1",
      channel_id: "ch-1",
      status: "normal",
      created_at: "2026-06-21T05:30:00Z",
      type: "text",
    });
    // PERSISTED payload: sender is a ref, NOT a resolved UserSummary
    expect(p.message).toHaveProperty("sender");
    expect(p.message.sender).toEqual({ kind: "user", user_id: "u-1", bot_id: null });
    // no display_name / avatar_url in the persisted payload
    expect(JSON.stringify(p)).not.toContain("display_name");
  });
});

describe("resolveSenderForLiveBroadcast", () => {
  it("replaces the sender ref with a resolved UserSummary on the live broadcast payload", async () => {
    // We test against a fake env whose LILIUM_DB resolve returns a known summary.
    // resolveUserSummaries is sourced from src/profile/resolve; in this unit test we
    // inject a stub by calling resolveSenderForLiveBroadcast with a resolver function.
    const persisted = buildMessageCreatedPayload({
      message_id: "m-1", command_id: "cm-1", channel_id: "ch-1",
      sender_kind: "user", sender_user_id: "u-1", sender_bot_id: null,
      status: "normal", created_at: "2026-06-21T05:30:00Z", updated_at: "2026-06-21T05:30:00Z",
      edited_at: null, deleted_at: null, deleted_by: null, recalled_at: null, stream_state: "none", reply_to: null,
      reply_snapshot_json: null, type: "text", format: "plain", text: "hello",
    });
    const live = await resolveSenderForLiveBroadcast(
      persisted,
      async () => new Map([["u-1", { user_id: "u-1", display_name: "Alice", avatar_url: "https://x/a.png" }]]),
    );
    const sender = (live.message as Record<string, unknown>).sender as Record<string, unknown>;
    expect(sender.kind).toBe("user");
    expect(sender).toHaveProperty("user");
    expect((sender.user as Record<string, unknown>).display_name).toBe("Alice");
    expect((sender.user as Record<string, unknown>).avatar_url).toBe("https://x/a.png");
  });

  it("falls back to a user-<shortid> summary when the sender is not in pg", async () => {
    const persisted = buildMessageCreatedPayload({
      message_id: "m-2", command_id: "cm-2", channel_id: "ch-1",
      sender_kind: "user", sender_user_id: "u-ghost", sender_bot_id: null,
      status: "normal", created_at: "2026-06-21T05:30:00Z", updated_at: "2026-06-21T05:30:00Z",
      edited_at: null, deleted_at: null, deleted_by: null, recalled_at: null, stream_state: "none", reply_to: null,
      reply_snapshot_json: null, type: "text", format: "plain", text: "hi",
    });
    const live = await resolveSenderForLiveBroadcast(
      persisted,
      async () => new Map(), // nothing resolved
    );
    const sender = (live.message as Record<string, unknown>).sender as Record<string, unknown>;
    expect((sender.user as Record<string, unknown>).display_name).toBe("user-u-ghost");
  });
});
