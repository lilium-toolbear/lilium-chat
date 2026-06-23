import type { EventFrame } from "../ws/frames";

export function buildEventFrame(args: {
  event_id: string;
  type: string;
  channel_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}): EventFrame {
  return {
    frame_type: "event",
    api_version: "lilium.chat.v1",
    event_id: args.event_id,
    type: args.type,
    channel_id: args.channel_id,
    occurred_at: args.occurred_at,
    payload: args.payload,
  };
}

// Per design spec §3.5: PERSISTED event payloads store actor REFERENCES, not UserSummary.
// (events.payload_json stores the shape produced below — sender as {kind, user_id, bot_id}.)
export function buildMessageCreatedPayload(raw: {
  message_id: string;
  client_message_id: string;
  channel_id: string;
  sender_kind: string;
  sender_user_id: string | null;
  sender_bot_id: string | null;
  status: string;
  created_at: string;
  type: string;
  format: string;
  text: string | null;
}): Record<string, unknown> {
  return {
    message: {
      message_id: raw.message_id,
      client_message_id: raw.client_message_id,
      channel_id: raw.channel_id,
      sender: {
        kind: raw.sender_kind,
        user_id: raw.sender_user_id,
        bot_id: raw.sender_bot_id,
      },
      type: raw.type,
      format: raw.format,
      status: raw.status,
      text: raw.text,
      created_at: raw.created_at,
    },
  };
}

// Per design spec §3.5: the LIVE broadcast (wire) projection resolves UserSummary at output
// time. The persisted payload keeps the sender ref; this function takes that persisted payload
// and returns a NEW payload with sender replaced by { kind:'user', user: UserSummary } so the
// client never has to render a bare user_id. (For bot senders, resolution is deferred to Phase 7;
// the bot ref is passed through unchanged here.)
//
// `resolveUserSummaries` is injected so this module stays unit-testable without Hyperdrive.
export interface UserSummary {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
}
export type ResolveUserSummaries = (userIds: string[]) => Promise<Map<string, UserSummary>>;

export async function resolveSenderForLiveBroadcast(
  payload: Record<string, unknown>,
  resolveUserSummaries: ResolveUserSummaries,
): Promise<Record<string, unknown>> {
  const message = (payload.message as { sender?: { kind?: string; user_id?: string | null; bot_id?: string | null } } | undefined);
  const sender = message?.sender;
  let resolvedSender: Record<string, unknown>;
  if (sender?.kind === "user" && sender.user_id) {
    const map = await resolveUserSummaries([sender.user_id]);
    const u = map.get(sender.user_id) ?? {
      user_id: sender.user_id,
      display_name: `user-${sender.user_id.slice(0, 8)}`,
      avatar_url: null,
    };
    resolvedSender = { kind: "user", user: u };
  } else if (sender?.kind === "bot") {
    // Phase 7 will resolve bot display_name/avatar from BotRegistry. Pass through for now.
    resolvedSender = { kind: "bot", bot_id: sender.bot_id };
  } else {
    resolvedSender = (sender as Record<string, unknown>) ?? {};
  }
  const baseMessage = (payload.message as Record<string, unknown> | undefined) ?? {};
  return {
    message: { ...baseMessage, sender: resolvedSender },
  };
}

