import type { MessageLifecycleStatus, ReplySnapshot } from "../contract/message";
import type { MessageRow } from "../contract/persisted";
import { fallbackUserDisplayName } from "../contract/primitives";
import {
  PLATFORM_BOT_DISPLAY_NAME,
  PLATFORM_BOT_ID,
} from "./platform-commands";

const PREVIEW_MAX_LEN = 120;

export function replyTargetSenderDisplayName(target: MessageRow): string {
  if (target.sender_kind === "user" && target.sender_user_id) {
    return fallbackUserDisplayName(target.sender_user_id);
  }
  if (target.sender_kind === "bot" && target.sender_bot_id) {
    return target.sender_bot_display_name
      ?? (target.sender_bot_id === PLATFORM_BOT_ID ? PLATFORM_BOT_DISPLAY_NAME : target.sender_bot_id);
  }
  return "系统";
}

export function replyTextPreview(target: Pick<MessageRow, "type" | "text" | "status">): string {
  if (target.status === "deleted" || target.status === "recalled") {
    return "";
  }
  if (target.type === "image") return "[图片]";
  if (target.type === "sticker") return "[表情]";
  const text = (target.text ?? "").trim();
  if (!text) return "";
  if (text.length <= PREVIEW_MAX_LEN) return text;
  return `${text.slice(0, PREVIEW_MAX_LEN)}…`;
}

export function buildReplySnapshot(target: MessageRow, senderDisplayName: string): ReplySnapshot {
  return {
    message_id: target.message_id,
    sender_display_name: senderDisplayName,
    text_preview: replyTextPreview(target),
    status: target.status as MessageLifecycleStatus,
  };
}

export function parseStoredReplySnapshot(raw: string | null): ReplySnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReplySnapshot;
  } catch {
    return null;
  }
}

export function sanitizeReplySnapshotForBrowser(
  snapshot: ReplySnapshot | null,
  targetStatus: string | null | undefined,
): ReplySnapshot | null {
  if (!snapshot) return null;
  if (targetStatus === "deleted" || targetStatus === "recalled") {
    return {
      ...snapshot,
      status: targetStatus,
      text_preview: "",
    };
  }
  if (targetStatus && targetStatus !== snapshot.status) {
    return { ...snapshot, status: targetStatus as MessageLifecycleStatus };
  }
  return snapshot;
}

export function collectReplyTargetIds(rows: Array<{ reply_to: string | null }>): string[] {
  return [...new Set(rows.map((row) => row.reply_to).filter((id): id is string => typeof id === "string" && id.length > 0))];
}

export type ReplyTargetStatusLookup = {
  get: (messageId: string) => string | undefined;
};

export function buildReplyTargetStatusLookup(
  sql: { exec: (query: string, ...params: unknown[]) => { toArray: () => unknown[] } },
  replyTargetIds: string[],
): ReplyTargetStatusLookup {
  const statusById = new Map<string, string>();
  for (const messageId of replyTargetIds) {
    const row = sql
      .exec("SELECT status FROM messages WHERE message_id=?", messageId)
      .toArray()[0] as { status: string } | undefined;
    if (row?.status) statusById.set(messageId, row.status);
  }
  return {
    get: (messageId: string) => statusById.get(messageId),
  };
}
