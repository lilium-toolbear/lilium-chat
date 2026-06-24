import type { MessageRow } from "../do/chat-channel";
import type { UserSummary } from "./event-broadcast";

// The ONE shared Browser-visible message projection (v4.0 addendum J).
// Used by history pagination, message.send ack, message.created event,
// and (Phase 4) edit/recall/delete acks/events + context read.
// Deleted/recalled safety filtering lives HERE — callers must not re-filter.
export function projectMessageForBrowser(
  row: MessageRow,
  opts: { senderSummary?: UserSummary | null } = {},
): Record<string, unknown> {
  const hidden = row.status === "deleted" || row.status === "recalled";

  let replySnapshot: unknown = null;
  if (row.reply_snapshot_json) {
    try { replySnapshot = JSON.parse(row.reply_snapshot_json); } catch { replySnapshot = null; }
  }

  // Sender projection. Persisted payloads store sender as a ref (_user_id); the live
  // ack/event projection resolves UserSummary at output time (design §3.5).
  let sender: Record<string, unknown>;
  if (row.sender_kind === "user" && row.sender_user_id) {
    const u = opts.senderSummary ?? {
      user_id: row.sender_user_id,
      display_name: `user-${row.sender_user_id.slice(0, 8)}`,
      avatar_url: null,
    };
    sender = { kind: "user", user: u };
  } else if (row.sender_kind === "bot") {
    sender = { kind: "bot", bot_id: row.sender_bot_id };
  } else {
    sender = { kind: row.sender_kind };
  }

  return {
    message_id: row.message_id,
    command_id: row.command_id,
    channel_id: row.channel_id,
    sender,
    type: row.type,
    format: row.format,
    status: row.status,
    stream_state: row.stream_state,
    text: hidden ? null : row.text,
    reply_to: row.reply_to,
    reply_snapshot: replySnapshot,
    attachments: [],   // Phase 5
    components: [],   // Phase 7
    mentions: hidden ? [] : [],  // mentions resolved per-message at the call site (Phase 2 reads them separately); hidden => []
    created_at: row.created_at,
    updated_at: row.updated_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
    recalled_at: row.recalled_at,
  };
}
