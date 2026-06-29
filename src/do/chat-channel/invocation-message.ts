import { uuidv7 } from "../../ids/uuidv7";
import {
  buildEventFrame,
  buildMessageLifecyclePayload,
  type UserSummary as LiveUserSummary,
} from "../../chat/event-broadcast";
import { projectMessageForBrowser } from "../../chat/message-projection";
import {
  buildInvocationDisplayText,
  serializeInvocationJson,
} from "../../chat/command-invocation";
import type { MessageRow } from "../../contract/persisted";
import type { WireChatMessage } from "../../contract/message";

export interface InvocationMessageHost {
  ctx: DurableObjectState;
  nextEventId(nowMs?: number): string;
  insertOutboxRowForFanout(
    channelId: string,
    eventId: string,
    eventFrameJson: string,
    membershipVersionAtEvent: number,
    nowIso: string,
  ): void;
}

export interface InsertUserCommandInvocationMessageInput {
  userId: string;
  channelId: string;
  operationId: string;
  botCommandId: string;
  invokedName: string;
  options: Record<string, { type: string; value: unknown }>;
  now: string;
  nowMs: number;
  membershipVersion: number;
  senderSummary: LiveUserSummary;
  messageId?: string;
}

export interface InsertUserCommandInvocationMessageResult {
  invocationMessageId: string;
  invocationEventId: string;
  invocationMessageRow: MessageRow;
  liveMessage: WireChatMessage;
}

export function insertUserCommandInvocationMessage(
  host: InvocationMessageHost,
  input: InsertUserCommandInvocationMessageInput,
): InsertUserCommandInvocationMessageResult {
  const resolvedInvokedName = input.invokedName.length > 0 ? input.invokedName : input.botCommandId;
  const invocationJson = serializeInvocationJson({
    bot_command_id: input.botCommandId,
    invoked_name: resolvedInvokedName,
    options: input.options,
  });
  const displayText = buildInvocationDisplayText(resolvedInvokedName, input.options);
  const messageId = input.messageId ?? uuidv7(input.nowMs);
  const eventId = host.nextEventId(input.nowMs);
  const dedupePrincipalKey = `user:${input.userId}`;

  const messageRow: MessageRow = {
    message_id: messageId,
    command_id: input.operationId,
    channel_id: input.channelId,
    sender_kind: "user",
    sender_user_id: input.userId,
    sender_bot_id: null,
    type: "text",
    format: "plain",
    status: "normal",
    text: displayText,
    reply_to: null,
    reply_snapshot_json: null,
    stream_state: "none",
    created_at: input.now,
    updated_at: input.now,
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    recalled_at: null,
    invocation_json: invocationJson,
  };

  host.ctx.storage.sql.exec(
    `INSERT INTO messages (
       message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
       sender_bot_id, type, format, status, text, reply_to, invocation_json, stream_state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'user', ?, NULL, 'text', 'plain', 'normal', ?, NULL, ?, 'none', ?, ?)`,
    messageId,
    input.operationId,
    dedupePrincipalKey,
    input.channelId,
    input.userId,
    displayText,
    invocationJson,
    input.now,
    input.now,
  );

  const liveMessage = projectMessageForBrowser(messageRow, { senderSummary: input.senderSummary });
  const liveEventFrame = buildEventFrame({
    event_id: eventId,
    type: "message.created",
    channel_id: input.channelId,
    occurred_at: input.now,
    payload: { message: liveMessage },
  });
  const persistedPayload = buildMessageLifecyclePayload({
    message_id: messageRow.message_id,
    command_id: messageRow.command_id,
    channel_id: messageRow.channel_id,
    sender_kind: messageRow.sender_kind,
    sender_user_id: messageRow.sender_user_id,
    sender_bot_id: messageRow.sender_bot_id,
    status: messageRow.status,
    created_at: messageRow.created_at,
    updated_at: messageRow.updated_at,
    edited_at: messageRow.edited_at,
    deleted_at: messageRow.deleted_at,
    deleted_by: messageRow.deleted_by,
    recalled_at: messageRow.recalled_at,
    stream_state: messageRow.stream_state,
    reply_to: messageRow.reply_to,
    reply_snapshot_json: messageRow.reply_snapshot_json,
    type: messageRow.type,
    format: messageRow.format,
    text: messageRow.text,
    invocation_json: messageRow.invocation_json,
  });

  host.ctx.storage.sql.exec(
    "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'message.created', ?, 'user', ?, ?, ?, ?)",
    eventId,
    input.channelId,
    input.userId,
    JSON.stringify(persistedPayload),
    input.membershipVersion,
    input.now,
  );
  host.insertOutboxRowForFanout(
    input.channelId,
    eventId,
    JSON.stringify(liveEventFrame),
    input.membershipVersion,
    input.now,
  );

  return {
    invocationMessageId: messageId,
    invocationEventId: eventId,
    invocationMessageRow: messageRow,
    liveMessage,
  };
}
