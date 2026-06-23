import type { CommandFrame } from "../ws/frames";

export interface ParsedMessageSend {
  client_message_id: string;
  type: "text";
  text: string;
  reply_to: string | null;
  attachment_ids: string[];
  mentions: Array<{ user_id: string; start: number; end: number }>;
}

export type ParseResult =
  | { ok: true; command: ParsedMessageSend }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

export function dedupePrincipalKeyForUser(userId: string): string {
  return `user:${userId}`;
}

export function parseMessageSendCommand(frame: CommandFrame, senderUserId: string): ParseResult {
  if (frame.command !== "message.send") {
    return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  }
  if (!frame.channel_id) {
    return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  }
  const p = frame.payload as Record<string, unknown>;
  const client_message_id = typeof p.client_message_id === "string" ? p.client_message_id : "";
  if (!client_message_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "client_message_id is required", retryable: false } };
  }
  // Phase 2 is text-only. image messages (Phase 5) and reply_to (Phase 4) are rejected here
  // so we never persist incomplete rows (no reply_snapshot_json, no attachment owner/finalized check).
  const type = typeof p.type === "string" ? p.type : "text";
  if (type !== "text") {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: `unsupported type: ${type} (Phase 2 supports text only)`, retryable: false } };
  }
  const text = typeof p.text === "string" ? p.text : "";
  if (text.trim() === "") {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message text is empty", retryable: false } };
  }
  const reply_to_message_id = p.reply_to_message_id;
  if (typeof reply_to_message_id === "string" && reply_to_message_id.length > 0) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "reply_to_message_id not supported in Phase 2", retryable: false } };
  }
  const attachment_ids = Array.isArray(p.attachment_ids) ? p.attachment_ids.filter((a): a is string => typeof a === "string") : [];
  if (attachment_ids.length > 0) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "attachment_ids not supported in Phase 2 (text only)", retryable: false } };
  }
  const mentionsRaw = Array.isArray(p.mentions) ? p.mentions : [];
  const mentions = mentionsRaw
    .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
    .map((m) => ({
      user_id: typeof m.user_id === "string" ? m.user_id : "",
      start: typeof m.start === "number" ? m.start : 0,
      end: typeof m.end === "number" ? m.end : 0,
    }))
    .filter((m) => m.user_id);

  void senderUserId; // sender identity comes from the authenticated socket, not the payload
  return { ok: true, command: { client_message_id, type: "text", text, reply_to: null, attachment_ids: [], mentions } };
}

