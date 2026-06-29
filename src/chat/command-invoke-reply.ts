import type { CommandInvocationReplyContext, WireMessageSender } from "../contract/message";
import type { MessageRow } from "../contract/persisted";
import { fallbackUserDisplayName, type UserSummary } from "../contract/primitives";
import {
  PLATFORM_BOT_AVATAR_URL,
  PLATFORM_BOT_DISPLAY_NAME,
  PLATFORM_BOT_ID,
} from "./platform-commands";
import { replyTextPreview } from "./reply-snapshot";

function projectReplySender(
  row: MessageRow,
  senderSummary: UserSummary | null,
): WireMessageSender {
  if (row.sender_kind === "user" && row.sender_user_id) {
    const user = senderSummary ?? {
      user_id: row.sender_user_id,
      display_name: fallbackUserDisplayName(row.sender_user_id),
      avatar_url: null,
    };
    return { kind: "user", user };
  }
  if (row.sender_kind === "bot" && row.sender_bot_id) {
    const botId = row.sender_bot_id;
    return {
      kind: "bot",
      bot: {
        bot_id: botId,
        display_name:
          row.sender_bot_display_name
          ?? (botId === PLATFORM_BOT_ID ? PLATFORM_BOT_DISPLAY_NAME : botId),
        avatar_url:
          row.sender_bot_avatar_url
          ?? (botId === PLATFORM_BOT_ID ? PLATFORM_BOT_AVATAR_URL : null),
      },
    };
  }
  if (row.sender_kind === "bot") {
    return { kind: "bot", bot_id: row.sender_bot_id };
  }
  return { kind: row.sender_kind };
}

export function projectCommandInvokeReplyContext(
  row: MessageRow,
  senderSummary: UserSummary | null,
): CommandInvocationReplyContext {
  const hidden = row.status === "deleted" || row.status === "recalled";
  const text = hidden
    ? null
    : row.type === "text"
      ? row.text
      : replyTextPreview(row) || null;

  return {
    message_id: row.message_id,
    sender: projectReplySender(row, senderSummary),
    type: row.type as CommandInvocationReplyContext["type"],
    status: row.status as CommandInvocationReplyContext["status"],
    text,
  };
}
