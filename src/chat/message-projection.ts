import type { MessageRow } from "../do/chat-channel";
import type { UserSummary } from "./event-broadcast";

// The ONE shared Browser-visible message projection (v4.0 addendum J).
// Used by history pagination, message.send ack, message.created event,
// and (Phase 4) edit/recall/delete acks/events + context read.
// Deleted/recalled safety filtering lives HERE — callers must not re-filter.
//
// Caller composes the inputs the builder cannot derive from a single row:
//   - senderSummary: pre-resolved via resolveUserSummaries (before the txn for in-txn ack/event)
//   - mentions / attachments / components: the caller already has them (send: from the request body;
//     history/replay: from the mentions table / attachments table). When Phase 5/7 land, extend
//     THIS builder's opts — never build a second ad-hoc serializer.
export interface MessageMention {
  user_id: string;
  start: number;
  end: number;
}

export function projectMessageForBrowser(
  row: MessageRow,
  opts: {
    senderSummary?: UserSummary | null;
    mentions?: MessageMention[];
    attachments?: unknown[];
    sticker?: { sticker_id: string; attachment_id: string; url: string; mime_type: string; width: number | null; height: number | null; size_bytes: number } | null;
    components?: unknown[];
  } = {},
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
    attachments: hidden ? [] : (opts.attachments ?? []),
    sticker: hidden ? null : (opts.sticker ?? null),
    components: hidden ? [] : (opts.components ?? []),
    mentions: hidden ? [] : (opts.mentions ?? []),
    created_at: row.created_at,
    updated_at: row.updated_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
    recalled_at: row.recalled_at,
  };
}
