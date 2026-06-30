import type { IncomingCommandFrame } from "../contract/commands";
import type { Mention } from "../contract/message";
import { isRecord } from "../contract/utils";
import { parseChannelCommandFrame } from "./ws-command-frame";

export interface ParsedMessageSend {
  command_id: string;
  type: "text" | "image" | "sticker";
  text: string;
  reply_to: string | null;
  attachment_ids: string[];
  sticker_id: string | null;
  mentions: Mention[];
}

export interface ParsedMessageEdit {
  channel_id: string;
  message_id: string;
  text: string;
}

export interface ParsedMessageRecall {
  channel_id: string;
  message_id: string;
}

export interface ParsedMessageDelete {
  channel_id: string;
  message_id: string;
  reason: string | null;
}

export type ParseResult<T> =
  | { ok: true; command: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

export function dedupePrincipalKeyForUser(userId: string): string {
  return `user:${userId}`;
}

function parseMentions(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return [];
  const mentions: Mention[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const user_id = typeof item.user_id === "string" ? item.user_id : "";
    if (!user_id) continue;
    mentions.push({
      user_id,
      start: typeof item.start === "number" ? item.start : 0,
      end: typeof item.end === "number" ? item.end : 0,
    });
  }
  return mentions;
}

export function parseMessageSendCommand(frame: IncomingCommandFrame, senderUserId: string): ParseResult<ParsedMessageSend> {
  const scoped = parseChannelCommandFrame(frame, "message.send");
  if (!scoped.ok) return scoped;
  if (!isRecord(frame.payload)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "invalid payload", retryable: false } };
  }
  const p = frame.payload;
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
  const reply_to =
    typeof reply_to_message_id === "string" && reply_to_message_id.length > 0
      ? reply_to_message_id
      : null;
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
  const mentions = parseMentions(p.mentions);
  if (type === "sticker" && mentions.length > 0) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "mentions not allowed for sticker messages", retryable: false } };
  }

  void senderUserId;
  return {
    ok: true,
    command: {
      command_id: scoped.frame.command_id,
      type,
      text,
      reply_to,
      attachment_ids,
      sticker_id: sticker_id || null,
      mentions,
    },
  };
}

export function parseMessageEditCommand(frame: IncomingCommandFrame): ParseResult<ParsedMessageEdit> {
  const scoped = parseChannelCommandFrame(frame, "message.edit");
  if (!scoped.ok) return scoped;
  if (!isRecord(frame.payload)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "invalid payload", retryable: false } };
  }
  const message_id = typeof frame.payload.message_id === "string" ? frame.payload.message_id : "";
  if (!message_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message_id is required", retryable: false } };
  }
  const text = typeof frame.payload.text === "string" ? frame.payload.text : "";
  if (text.trim() === "") {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message text is empty", retryable: false } };
  }
  return { ok: true, command: { channel_id: scoped.frame.channel_id, message_id, text } };
}

export function parseMessageRecallCommand(frame: IncomingCommandFrame): ParseResult<ParsedMessageRecall> {
  const scoped = parseChannelCommandFrame(frame, "message.recall");
  if (!scoped.ok) return scoped;
  if (!isRecord(frame.payload)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "invalid payload", retryable: false } };
  }
  const message_id = typeof frame.payload.message_id === "string" ? frame.payload.message_id : "";
  if (!message_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message_id is required", retryable: false } };
  }
  return { ok: true, command: { channel_id: scoped.frame.channel_id, message_id } };
}

export function parseMessageDeleteCommand(frame: IncomingCommandFrame): ParseResult<ParsedMessageDelete> {
  const scoped = parseChannelCommandFrame(frame, "message.delete");
  if (!scoped.ok) return scoped;
  if (!isRecord(frame.payload)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "invalid payload", retryable: false } };
  }
  const message_id = typeof frame.payload.message_id === "string" ? frame.payload.message_id : "";
  if (!message_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message_id is required", retryable: false } };
  }
  const reasonRaw = frame.payload.reason;
  const reason = typeof reasonRaw === "string" ? reasonRaw : null;
  return { ok: true, command: { channel_id: scoped.frame.channel_id, message_id, reason } };
}
