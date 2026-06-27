import type { IncomingCommandFrame } from "../contract/commands";
import type { Mention } from "../contract/message";
import { isRecord } from "../contract/utils";

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
  if (frame.command !== "message.send") {
    return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  }
  if (!frame.channel_id) {
    return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  }
  if (!isRecord(frame.payload)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "invalid payload", retryable: false } };
  }
  const p = frame.payload;
  const command_id = typeof frame.command_id === "string" ? frame.command_id : "";
  if (!command_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false } };
  }
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
  const mentions = parseMentions(p.mentions);
  if (type === "sticker" && mentions.length > 0) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "mentions not allowed for sticker messages", retryable: false } };
  }

  void senderUserId;
  return {
    ok: true,
    command: {
      command_id,
      type,
      text,
      reply_to: null,
      attachment_ids,
      sticker_id: sticker_id || null,
      mentions,
    },
  };
}

function requireCommandId(frame: IncomingCommandFrame): string | null {
  return typeof frame.command_id === "string" && frame.command_id ? frame.command_id : null;
}

function requireChannelId(frame: IncomingCommandFrame): string | null {
  return typeof frame.channel_id === "string" && frame.channel_id ? frame.channel_id : null;
}

export function parseMessageEditCommand(frame: IncomingCommandFrame): ParseResult<ParsedMessageEdit> {
  if (frame.command !== "message.edit") {
    return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  }
  if (!requireCommandId(frame)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false } };
  }
  if (!requireChannelId(frame)) {
    return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  }
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
  return { ok: true, command: { message_id, text } };
}

export function parseMessageRecallCommand(frame: IncomingCommandFrame): ParseResult<ParsedMessageRecall> {
  if (frame.command !== "message.recall") {
    return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  }
  if (!requireCommandId(frame)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false } };
  }
  if (!requireChannelId(frame)) {
    return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  }
  if (!isRecord(frame.payload)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "invalid payload", retryable: false } };
  }
  const message_id = typeof frame.payload.message_id === "string" ? frame.payload.message_id : "";
  if (!message_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message_id is required", retryable: false } };
  }
  return { ok: true, command: { message_id } };
}

export function parseMessageDeleteCommand(frame: IncomingCommandFrame): ParseResult<ParsedMessageDelete> {
  if (frame.command !== "message.delete") {
    return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  }
  if (!requireCommandId(frame)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false } };
  }
  if (!requireChannelId(frame)) {
    return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  }
  if (!isRecord(frame.payload)) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "invalid payload", retryable: false } };
  }
  const message_id = typeof frame.payload.message_id === "string" ? frame.payload.message_id : "";
  if (!message_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message_id is required", retryable: false } };
  }
  const reasonRaw = frame.payload.reason;
  const reason = typeof reasonRaw === "string" ? reasonRaw : null;
  return { ok: true, command: { message_id, reason } };
}
