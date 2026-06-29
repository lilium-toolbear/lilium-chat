import type {
  MessageLifecycleStatus,
  ReplySnapshot,
  ReplySnapshotMediaPreview,
} from "../contract/message";
import type { MessageRow } from "../contract/persisted";
import { fallbackUserDisplayName } from "../contract/primitives";
import {
  PLATFORM_BOT_DISPLAY_NAME,
  PLATFORM_BOT_ID,
} from "./platform-commands";

export const REPLY_TEXT_PREVIEW_MAX_LEN = 120;

type SqlExec = {
  exec: (query: string, ...params: unknown[]) => { toArray: () => unknown[] };
};

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

export function replyTextPreview(
  target: Pick<MessageRow, "type" | "text" | "status">,
  options?: { hasMediaPreview?: boolean },
): string {
  if (target.status === "deleted" || target.status === "recalled") {
    return "";
  }
  if (target.type === "image") {
    return options?.hasMediaPreview ? "" : "[图片]";
  }
  if (target.type === "sticker") {
    return options?.hasMediaPreview ? "" : "[表情]";
  }
  const text = (target.text ?? "").trim();
  if (!text) return "";
  if (text.length <= REPLY_TEXT_PREVIEW_MAX_LEN) return text;
  return `${text.slice(0, REPLY_TEXT_PREVIEW_MAX_LEN)}…`;
}

export function loadReplySnapshotMedia(
  sql: SqlExec,
  messageId: string,
  messageType: string,
): ReplySnapshotMediaPreview | null {
  if (messageType === "sticker") {
    const row = sql
      .exec(
        "SELECT url, blurhash, width, height FROM message_stickers WHERE message_id=? LIMIT 1",
        messageId,
      )
      .toArray()[0] as {
      url: string;
      blurhash: string | null;
      width: number;
      height: number;
    } | undefined;
    if (!row?.url) return null;
    return {
      kind: "sticker",
      url: row.url,
      blurhash: row.blurhash,
      width: row.width,
      height: row.height,
    };
  }
  if (messageType === "image") {
    const row = sql
      .exec(
        `SELECT a.url, a.blurhash, a.width, a.height
         FROM message_attachments ma
         INNER JOIN attachments a ON a.attachment_id = ma.attachment_id
         WHERE ma.message_id=?
         ORDER BY ma.attachment_id ASC
         LIMIT 1`,
        messageId,
      )
      .toArray()[0] as {
      url: string;
      blurhash: string | null;
      width: number;
      height: number;
    } | undefined;
    if (!row?.url) return null;
    return {
      kind: "image",
      url: row.url,
      blurhash: row.blurhash,
      width: row.width,
      height: row.height,
    };
  }
  return null;
}

export function buildReplySnapshot(
  target: MessageRow,
  senderDisplayName: string,
  options?: { mediaPreview?: ReplySnapshotMediaPreview | null },
): ReplySnapshot {
  const mediaPreview = options?.mediaPreview ?? null;
  const snapshot: ReplySnapshot = {
    message_id: target.message_id,
    sender_display_name: senderDisplayName,
    text_preview: replyTextPreview(target, { hasMediaPreview: Boolean(mediaPreview) }),
    status: target.status as MessageLifecycleStatus,
  };
  if (mediaPreview) {
    snapshot.media_preview = mediaPreview;
  }
  return snapshot;
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
      media_preview: null,
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
