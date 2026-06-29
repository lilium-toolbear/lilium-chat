import type { MessageRow } from "../contract/persisted";
import type { Mention, MessageImageAttachment, WireChatMessage } from "../contract/message";
import { fallbackUserDisplayName, type UserSummary } from "../contract/primitives";
import {
  PLATFORM_BOT_AVATAR_URL,
  PLATFORM_BOT_DISPLAY_NAME,
  PLATFORM_BOT_ID,
} from "./platform-commands";

export interface MessageMention {
  user_id: string;
  start: number;
  end: number;
}

export interface MessageStickerSnapshot {
  sticker_id: string;
  attachment_id: string;
  url: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  blurhash: string | null;
}

export function projectMessageForBrowser(
  row: MessageRow,
  opts: {
    senderSummary?: UserSummary | null;
    mentions?: MessageMention[];
    attachments?: MessageImageAttachment[];
    sticker?: MessageStickerSnapshot | null;
    components?: WireChatMessage["components"];
  } = {},
): WireChatMessage {
  const hidden = row.status === "deleted" || row.status === "recalled";

  let replySnapshot: WireChatMessage["reply_snapshot"] = null;
  if (row.reply_snapshot_json) {
    try {
      replySnapshot = JSON.parse(row.reply_snapshot_json) as WireChatMessage["reply_snapshot"];
    } catch {
      replySnapshot = null;
    }
  }

  let sender: WireChatMessage["sender"];
  if (row.sender_kind === "user" && row.sender_user_id) {
    const u = opts.senderSummary ?? {
      user_id: row.sender_user_id,
      display_name: fallbackUserDisplayName(row.sender_user_id),
      avatar_url: null,
    };
    sender = { kind: "user", user: u };
  } else if (row.sender_kind === "bot" && row.sender_bot_id) {
    const botId = row.sender_bot_id;
    const displayName =
      row.sender_bot_display_name ??
      (botId === PLATFORM_BOT_ID ? PLATFORM_BOT_DISPLAY_NAME : botId);
    const avatarUrl =
      row.sender_bot_avatar_url ??
      (botId === PLATFORM_BOT_ID ? PLATFORM_BOT_AVATAR_URL : null);
    sender = {
      kind: "bot",
      bot: {
        bot_id: botId,
        display_name: displayName,
        avatar_url: avatarUrl,
      },
    };
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
    type: row.type as WireChatMessage["type"],
    format: row.format as WireChatMessage["format"],
    status: row.status as WireChatMessage["status"],
    stream_state: row.stream_state as WireChatMessage["stream_state"],
    text: hidden ? null : row.text,
    reply_to: row.reply_to,
    reply_snapshot: replySnapshot,
    attachments: hidden ? [] : (opts.attachments ?? []),
    sticker: hidden ? null : (opts.sticker ?? null),
    components: hidden ? [] : (opts.components ?? []),
    mentions: hidden ? [] : ((opts.mentions ?? []) as Mention[]),
    created_at: row.created_at,
    updated_at: row.updated_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
    recalled_at: row.recalled_at,
  };
}
