import { buildEventFrame, buildMessageLifecyclePayload } from "../../../chat/event-broadcast";
import { parseStoredComponents } from "../../../chat/bot-effects";
import type { BotEffectMessageContextRow } from "../../../chat/bot-effects";
import { projectMessageForBrowser } from "../../../chat/message-projection";
import type { MessageRow } from "../../../contract/persisted";
import type { WireChatMessage } from "../../../contract/message";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  rvEvent,
  upsertEventChange,
  upsertMessageChange,
} from "../../../archive/chat-channel-record";
import { ChatChannelCore } from "../core";
import type { ChatChannelHandlerRef } from "../handler-ref";

interface InteractionRow {
  interaction_id: string;
  message_id: string;
  component_id: string;
  command_id: string;
  status: string;
}

function loadInteractionRow(channel: ChatChannelHandlerRef, interactionId: string): InteractionRow | null {
  const row = channel.ctx.storage.sql
    .exec(
      "SELECT interaction_id, message_id, component_id, command_id, status FROM interactions WHERE interaction_id=?",
      interactionId,
    )
    .toArray()[0] as InteractionRow | undefined;
  return row ?? null;
}

function loadMessageContextRow(
  channel: ChatChannelHandlerRef,
  channelId: string,
  messageId: string,
): BotEffectMessageContextRow | null {
  const row = channel.ctx.storage.sql
    .exec(
      `SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id,
              sender_bot_display_name, sender_bot_avatar_url, type, format, status, text,
              reply_to, reply_snapshot_json, components_json, stream_state, created_at, updated_at,
              edited_at, deleted_at, deleted_by, recalled_at, invocation_json
       FROM messages WHERE message_id=? AND channel_id=?`,
      messageId,
      channelId,
    )
    .toArray()[0] as BotEffectMessageContextRow | undefined;
  return row ?? null;
}

function insertInteractionCompletedEvent(
  channel: ChatChannelHandlerRef,
  input: {
    eventId: string;
    channelId: string;
    botId: string;
    commandId: string;
    occurredAt: string;
    messageRow: MessageRow;
    components: WireChatMessage["components"];
    membershipVersion: number;
  },
): void {
  const liveMessage = projectMessageForBrowser(input.messageRow, { components: input.components });
  const persistedPayload = {
    command_id: input.commandId,
    channel_id: input.channelId,
    event_id: input.eventId,
    message: buildMessageLifecyclePayload({
      message_id: input.messageRow.message_id,
      command_id: input.messageRow.command_id,
      channel_id: input.messageRow.channel_id,
      sender_kind: input.messageRow.sender_kind,
      sender_user_id: input.messageRow.sender_user_id,
      sender_bot_id: input.messageRow.sender_bot_id,
      status: input.messageRow.status,
      created_at: input.messageRow.created_at,
      updated_at: input.messageRow.updated_at,
      edited_at: input.messageRow.edited_at,
      deleted_at: input.messageRow.deleted_at,
      deleted_by: input.messageRow.deleted_by,
      recalled_at: input.messageRow.recalled_at,
      stream_state: input.messageRow.stream_state,
      reply_to: input.messageRow.reply_to,
      reply_snapshot_json: input.messageRow.reply_snapshot_json,
      type: input.messageRow.type,
      format: input.messageRow.format,
      text: input.messageRow.text,
      invocation_json: input.messageRow.invocation_json,
    }).message,
  };
  channel.ctx.storage.sql.exec(
    "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'interaction.completed', ?, 'bot', ?, ?, ?, ?)",
    input.eventId,
    input.channelId,
    input.botId,
    JSON.stringify(persistedPayload),
    input.membershipVersion,
    input.occurredAt,
  );
  const liveEventFrame = buildEventFrame({
    event_id: input.eventId,
    type: "interaction.completed",
    channel_id: input.channelId,
    occurred_at: input.occurredAt,
    payload: {
      command_id: input.commandId,
      channel_id: input.channelId,
      event_id: input.eventId,
      message: liveMessage as import("../../../contract/message").ChatMessage,
    },
  });
  channel.insertOutboxRowForFanout(
    input.channelId,
    input.eventId,
    JSON.stringify(liveEventFrame),
    input.membershipVersion,
    input.occurredAt,
  );
}

function insertInteractionFailedEvent(
  channel: ChatChannelHandlerRef,
  input: {
    eventId: string;
    channelId: string;
    botId: string;
    commandId: string;
    errorCode: string;
    errorMessage: string;
    occurredAt: string;
    membershipVersion: number;
  },
): void {
  const persistedPayload = {
    command_id: input.commandId,
    error_code: input.errorCode,
    error_message: input.errorMessage,
    retryable: false,
  };
  channel.ctx.storage.sql.exec(
    "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'interaction.failed', ?, 'bot', ?, ?, ?, ?)",
    input.eventId,
    input.channelId,
    input.botId,
    JSON.stringify(persistedPayload),
    input.membershipVersion,
    input.occurredAt,
  );
  const liveEventFrame = buildEventFrame({
    event_id: input.eventId,
    type: "interaction.failed",
    channel_id: input.channelId,
    occurred_at: input.occurredAt,
    payload: persistedPayload,
  });
  channel.insertOutboxRowForFanout(
    input.channelId,
    input.eventId,
    JSON.stringify(liveEventFrame),
    input.membershipVersion,
    input.occurredAt,
  );
}

export function finalizeInteractionDelivery(
  channel: ChatChannelHandlerRef,
  input: {
    interactionId: string;
    channelId: string;
    botId: string;
    membershipVersion: number;
    now: string;
    nowMs: number;
    success: boolean;
    errorCode?: string;
    errorMessage?: string;
  },
): string | null {
  const interaction = loadInteractionRow(channel, input.interactionId);
  if (!interaction) return null;
  if (interaction.status === "completed" || interaction.status === "failed") {
    return null;
  }

  const eventId = channel.nextEventId(input.nowMs);
  if (input.success) {
    const messageRow = loadMessageContextRow(channel, input.channelId, interaction.message_id);
    if (!messageRow) return null;

    channel.ctx.storage.sql.exec(
      "UPDATE interactions SET status='completed', completed_at=?, updated_at=?, error_code=NULL WHERE interaction_id=?",
      input.now,
      input.now,
      input.interactionId,
    );

    const projectedRow: MessageRow = {
      message_id: messageRow.message_id,
      command_id: messageRow.command_id,
      channel_id: messageRow.channel_id,
      sender_kind: messageRow.sender_kind,
      sender_user_id: messageRow.sender_user_id,
      sender_bot_id: messageRow.sender_bot_id,
      sender_bot_display_name: messageRow.sender_bot_display_name,
      sender_bot_avatar_url: messageRow.sender_bot_avatar_url,
      type: messageRow.type,
      format: messageRow.format,
      status: messageRow.status,
      text: messageRow.text,
      reply_to: messageRow.reply_to,
      reply_snapshot_json: messageRow.reply_snapshot_json,
      stream_state: messageRow.stream_state,
      created_at: messageRow.created_at,
      updated_at: messageRow.updated_at,
      edited_at: messageRow.edited_at,
      deleted_at: messageRow.deleted_at,
      deleted_by: messageRow.deleted_by,
      recalled_at: messageRow.recalled_at,
    };

    insertInteractionCompletedEvent(channel, {
      eventId,
      channelId: input.channelId,
      botId: input.botId,
      commandId: interaction.command_id,
      occurredAt: input.now,
      messageRow: projectedRow,
      components: parseStoredComponents(messageRow.components_json ?? "[]"),
      membershipVersion: input.membershipVersion,
    });

    appendChatChannelArchive(channel.ctx, input.channelId, input.now, [eventId], () =>
      collectDefinedChanges([
        upsertEventChange(channel.ctx.storage.sql, eventId),
        upsertMessageChange(
          channel.ctx.storage.sql,
          interaction.message_id,
          input.channelId,
          rvEvent(eventId),
        ),
      ]),
    );
    return eventId;
  }

  const errorCode = input.errorCode ?? "BOT_EFFECT_INVALID";
  const errorMessage = input.errorMessage ?? "interaction delivery failed";
  channel.ctx.storage.sql.exec(
    "UPDATE interactions SET status='failed', completed_at=?, updated_at=?, error_code=? WHERE interaction_id=?",
    input.now,
    input.now,
    errorCode,
    input.interactionId,
  );
  insertInteractionFailedEvent(channel, {
    eventId,
    channelId: input.channelId,
    botId: input.botId,
    commandId: interaction.command_id,
    errorCode,
    errorMessage,
    occurredAt: input.now,
    membershipVersion: input.membershipVersion,
  });
  appendChatChannelArchive(channel.ctx, input.channelId, input.now, [eventId], () =>
    collectDefinedChanges([upsertEventChange(channel.ctx.storage.sql, eventId)]),
  );
  return eventId;
}

export function loadBotDeliveryOutboxMeta(
  channel: ChatChannelHandlerRef,
  outboxId: string,
): { kind: string; interaction_id: string | null } | null {
  const row = channel.ctx.storage.sql
    .exec("SELECT kind, interaction_id FROM bot_delivery_outbox WHERE outbox_id=?", outboxId)
    .toArray()[0] as { kind: string; interaction_id: string | null } | undefined;
  return row ?? null;
}
