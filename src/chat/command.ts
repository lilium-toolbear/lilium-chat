import type { CommandFrame } from "../ws/frames";

export interface ParsedMessageSend {
  command_id: string;
  type: "text" | "image" | "sticker";
  text: string;
  reply_to: string | null;
  attachment_ids: string[];
  sticker_id: string | null;
  mentions: Array<{ user_id: string; start: number; end: number }>;
}

export interface ParsedMessageEdit {
  message_id: string;
  text: string;
}

export interface ParsedMessageRecall {
  message_id: string;
}

export interface ParsedMessageDelete {
  message_id: string;
  reason: string | null;
}

export type ParseResult<T> =
  | { ok: true; command: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

export function dedupePrincipalKeyForUser(userId: string): string {
  return `user:${userId}`;
}

export function parseMessageSendCommand(frame: CommandFrame, senderUserId: string): ParseResult<ParsedMessageSend> {
  if (frame.command !== "message.send") {
    return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  }
  if (!frame.channel_id) {
    return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  }
  const p = frame.payload as Record<string, unknown>;
  // v4.0: command_id is a TOP-LEVEL frame field (the durable operation id), NOT a payload field.
  // A v2.6-compliant client sends {command_id: "op-1", payload: {type, text, ...}}; it must NOT
  // put command_id in the payload. Read the operation id from the frame; ignore any payload
  // command_id (do not use it, do not reject for its presence).
  const command_id = typeof frame.command_id === "string" ? frame.command_id : "";
  if (!command_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false } };
  }
  // Phase 2 supports text; Phase 5 adds image; Phase E adds sticker.
  const type = typeof p.type === "string" ? p.type : "text";
  if (type !== "text" && type !== "image" && type !== "sticker") {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: `unsupported type: ${type}`, retryable: false } };
  }
  const text = typeof p.text === "string" ? p.text : "";
  if (type === "text" && text.trim() === "") {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message text is empty", retryable: false } };
  }
  if (type === "sticker" && text !== "") {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "sticker message text must be empty", retryable: false } };
  }
  const reply_to_message_id = p.reply_to_message_id;
  if (typeof reply_to_message_id === "string" && reply_to_message_id.length > 0) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "reply_to_message_id not supported", retryable: false } };
  }
  const attachment_ids = Array.isArray(p.attachment_ids) ? p.attachment_ids.filter((a): a is string => typeof a === "string") : [];
  const sticker_id = typeof p.sticker_id === "string" ? p.sticker_id : "";
  if (type === "image") {
    if (attachment_ids.length === 0) {
      return { ok: false, error: { code: "INVALID_MESSAGE", message: "image message requires attachment_ids", retryable: false } };
    }
  } else if (type === "sticker") {
    if (!sticker_id) {
      return { ok: false, error: { code: "INVALID_MESSAGE", message: "sticker message requires sticker_id", retryable: false } };
    }
    if (attachment_ids.length > 0) {
      return { ok: false, error: { code: "INVALID_MESSAGE", message: "attachment_ids not allowed for sticker messages", retryable: false } };
    }
  } else if (attachment_ids.length > 0) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "attachment_ids not allowed for text messages", retryable: false } };
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
  if (type === "sticker" && mentions.length > 0) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "mentions not allowed for sticker messages", retryable: false } };
  }

  void senderUserId; // sender identity comes from the authenticated socket, not the payload
  return { ok: true, command: { command_id, type, text, reply_to: null, attachment_ids, sticker_id: sticker_id || null, mentions } };
}

function requireCommandId(frame: CommandFrame): string | null {
  return typeof frame.command_id === "string" && frame.command_id ? frame.command_id : null;
}

function requireChannelId(frame: CommandFrame): string | null {
  return typeof frame.channel_id === "string" && frame.channel_id ? frame.channel_id : null;
}

export function parseMessageEditCommand(frame: CommandFrame): ParseResult<ParsedMessageEdit> {
  if (frame.command !== "message.edit") {
    return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  }
  if (!requireCommandId(frame)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false } };
  }
  if (!requireChannelId(frame)) {
    return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  }
  const p = frame.payload as Record<string, unknown>;
  const message_id = typeof p.message_id === "string" ? p.message_id : "";
  if (!message_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message_id is required", retryable: false } };
  }
  const text = typeof p.text === "string" ? p.text : "";
  if (text.trim() === "") {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message text is empty", retryable: false } };
  }
  return { ok: true, command: { message_id, text } };
}

export function parseMessageRecallCommand(frame: CommandFrame): ParseResult<ParsedMessageRecall> {
  if (frame.command !== "message.recall") {
    return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  }
  if (!requireCommandId(frame)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false } };
  }
  if (!requireChannelId(frame)) {
    return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  }
  const p = frame.payload as Record<string, unknown>;
  const message_id = typeof p.message_id === "string" ? p.message_id : "";
  if (!message_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message_id is required", retryable: false } };
  }
  return { ok: true, command: { message_id } };
}

export function parseMessageDeleteCommand(frame: CommandFrame): ParseResult<ParsedMessageDelete> {
  if (frame.command !== "message.delete") {
    return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  }
  if (!requireCommandId(frame)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false } };
  }
  if (!requireChannelId(frame)) {
    return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  }
  const p = frame.payload as Record<string, unknown>;
  const message_id = typeof p.message_id === "string" ? p.message_id : "";
  if (!message_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message_id is required", retryable: false } };
  }
  const reasonRaw = p.reason;
  const reason = typeof reasonRaw === "string" ? reasonRaw : null;
  return { ok: true, command: { message_id, reason } };
}
