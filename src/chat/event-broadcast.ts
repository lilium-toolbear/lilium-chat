import type { MessagePersistedPayload } from "../contract/persisted";
import type { MessageProjectionEventPayload } from "../contract/events";
import { fallbackUserDisplayName, type UserSummary } from "../contract/primitives";
import type { WireChatMessage } from "../contract/message";
import { buildWireEventFrame, type EventFrame } from "../contract/wire-frames";
import type { ChatEventPayloadByType, ChatEventType } from "../contract/events";

export type { UserSummary };

export function buildEventFrame<T extends ChatEventType>(args: {
  event_id: string;
  type: T;
  channel_id: string;
  occurred_at: string;
  payload: ChatEventPayloadByType[T];
}): EventFrame {
  return buildWireEventFrame(args) as EventFrame;
}

// Per design spec §3.5: PERSISTED event payloads store actor REFERENCES, not UserSummary.
export function buildMessageCreatedPayload(raw: {
  message_id: string;
  command_id: string;
  channel_id: string;
  sender_kind: string;
  sender_user_id: string | null;
  sender_bot_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  recalled_at: string | null;
  stream_state: string;
  reply_to: string | null;
  reply_snapshot_json: string | null;
  type: string;
  format: string;
  text: string | null;
}): MessagePersistedPayload {
  let replySnapshot: unknown = null;
  if (raw.reply_snapshot_json) {
    try {
      replySnapshot = JSON.parse(raw.reply_snapshot_json);
    } catch {
      replySnapshot = null;
    }
  }

  return {
    message: {
      message_id: raw.message_id,
      command_id: raw.command_id,
      channel_id: raw.channel_id,
      sender: {
        kind: raw.sender_kind,
        user_id: raw.sender_user_id,
        bot_id: raw.sender_bot_id,
      },
      text: raw.text,
      type: raw.type,
      format: raw.format,
      status: raw.status,
      stream_state: raw.stream_state,
      reply_to: raw.reply_to,
      reply_snapshot: replySnapshot,
      attachments: [],
      components: [],
      mentions: [],
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      edited_at: raw.edited_at,
      deleted_at: raw.deleted_at,
      deleted_by: raw.deleted_by,
      recalled_at: raw.recalled_at,
    },
  };
}

export function buildMessageLifecyclePayload(raw: Parameters<typeof buildMessageCreatedPayload>[0]): MessagePersistedPayload {
  return buildMessageCreatedPayload(raw);
}

export type ResolveUserSummaries = (userIds: string[]) => Promise<Map<string, UserSummary>>;

// Per design spec §3.5: the LIVE broadcast (wire) projection resolves UserSummary at output time.
export async function resolveSenderForLiveBroadcast(
  payload: MessagePersistedPayload,
  resolveUserSummaries: ResolveUserSummaries,
): Promise<MessageProjectionEventPayload> {
  const sender = payload.message.sender;
  let resolvedSender: WireChatMessage["sender"];
  if (sender.kind === "user" && sender.user_id) {
    const map = await resolveUserSummaries([sender.user_id]);
    const u = map.get(sender.user_id) ?? {
      user_id: sender.user_id,
      display_name: fallbackUserDisplayName(sender.user_id),
      avatar_url: null,
    };
    resolvedSender = { kind: "user", user: u };
  } else if (sender.kind === "bot") {
    resolvedSender = { kind: "bot", bot_id: sender.bot_id };
  } else {
    resolvedSender = { kind: sender.kind };
  }

  return {
    message: {
      ...payload.message,
      sender: resolvedSender,
      reply_snapshot: payload.message.reply_snapshot as WireChatMessage["reply_snapshot"],
      type: payload.message.type as WireChatMessage["type"],
      format: payload.message.format as WireChatMessage["format"],
      status: payload.message.status as WireChatMessage["status"],
      stream_state: payload.message.stream_state as WireChatMessage["stream_state"],
      attachments: [],
      sticker: null,
      components: [],
      mentions: [],
    },
  };
}
