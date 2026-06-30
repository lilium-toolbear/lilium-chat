import { uuidv7 } from "../../../ids/uuidv7";
import { buildEventFrame, buildMessageLifecyclePayload } from "../../../chat/event-broadcast";
import {
  BotEffectValidationError,
  computeEffectRequestHash,
  disableComponentsInJson,
  parseStoredComponents,
  toGenericEffectResult,
  toStartStreamEffectResult,
  validateEffectsForApply,
  type BotEffectMessageContextRow,
  type ParsedBotEffect,
  type ParsedNonStreamEffect,
} from "../../../chat/bot-effects";
import { projectMessageForBrowser } from "../../../chat/message-projection";
import { isOfficialBotId } from "../../../chat/platform-commands";
import { buildStreamStartedFrame, deliverLiveStreamFrame } from "../../../chat/stream-live-delivery";
import { botDedupePrincipalKey } from "../../../chat/stream-registry";
import type { StartStreamEffectResponse } from "../../../chat/stream-registry";
import type { EffectResult } from "../../../contract/bot-gateway";
import type { BotEffectWire } from "../../../contract/bot-gateway";
import type { MessageRow } from "../../../contract/persisted";
import type { WireChatMessage } from "../../../contract/message";
import { isRecord } from "../../../contract/utils";
import type { Env } from "../../../env";
import type { BotDeliveryResultInput, BotDeliveryResultResponse } from "../../../contract/bot-api";
import { botRegistryStub } from "../../../auth/bot";
import { ApiError, logSwallowedError } from "../../../errors";
import {
  finalizeInteractionDelivery,
  loadBotDeliveryOutboxMeta,
} from "../lib/interaction-delivery-completion";
import {
  registerStartStreamEffectInTransaction,
  type StartStreamRegistrationResult,
} from "./stream-registry";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  rvEvent,
  upsertEventChange,
  upsertMessageChange,
} from "../../../archive/chat-channel-record";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";
import { asHandlerRef, type ChatChannelHandlerRef } from "../handler-ref";

function maybeFinalizeInteractionDelivery(
  channel: ChatChannelHandlerRef,
  context: { interactionId: string; membershipVersion: number } | null,
  input: {
    channelId: string;
    botId: string;
    success: boolean;
    errorCode?: string;
    errorMessage?: string;
  },
): void {
  if (!context) return;
  const finalizeNow = channel.nowIso();
  const finalizeNowMs = Date.parse(finalizeNow);
  channel.ctx.storage.transactionSync(() => {
    finalizeInteractionDelivery(channel, {
      interactionId: context.interactionId,
      channelId: input.channelId,
      botId: input.botId,
      membershipVersion: context.membershipVersion,
      now: finalizeNow,
      nowMs: finalizeNowMs,
      success: input.success,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
  });
}

function botDeliveryFailed(code: string, message: string): BotDeliveryResultResponse {
  return { status: "failed", error: { code, message } };
}

interface BotSummary {
  display_name: string;
  avatar_url: string | null;
  is_official: boolean;
}

function loadMessageRow(
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

async function fetchBotSummary(env: Env, botId: string): Promise<BotSummary | null> {
  try {
    const { bot } = await botRegistryStub(env).getBot(botId);
    return {
      display_name: bot.display_name,
      avatar_url: bot.avatar_url,
      is_official: bot.visibility === "official",
    };
  } catch (err) {
    logSwallowedError("bot_delivery_result_bot_summary_failed", err, { bot_id: botId });
    return null;
  }
}

function insertBotLifecycleEvent(
  channel: ChatChannelHandlerRef,
  input: {
    eventId: string;
    eventType: "message.created" | "message.updated";
    channelId: string;
    botId: string;
    occurredAt: string;
    messageRow: MessageRow;
    components: WireChatMessage["components"];
    membershipVersion: number;
  },
): void {
  const liveMessage = projectMessageForBrowser(input.messageRow, {
    components: input.components,
  });
  const liveEventFrame = buildEventFrame({
    event_id: input.eventId,
    type: input.eventType,
    channel_id: input.channelId,
    occurred_at: input.occurredAt,
    payload: { message: liveMessage },
  });
  const persistedPayload = buildMessageLifecyclePayload({
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
  });
  channel.ctx.storage.sql.exec(
    "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, ?, ?, 'bot', ?, ?, ?, ?)",
    input.eventId,
    input.eventType,
    input.channelId,
    input.botId,
    JSON.stringify(persistedPayload),
    input.membershipVersion,
    input.occurredAt,
  );
  channel.insertOutboxRowForFanout(
    input.channelId,
    input.eventId,
    JSON.stringify(liveEventFrame),
    input.membershipVersion,
    input.occurredAt,
  );
}

function applySendMessageEffect(
  channel: ChatChannelHandlerRef,
  input: {
    channelId: string;
    botId: string;
    botSummary: BotSummary;
    effect: Extract<ParsedNonStreamEffect, { type: "send_message" }>;
    now: string;
    nowMs: number;
    membershipVersion: number;
    outboxId: string;
    requestHash: string;
  },
): { message_id: string; event_id: string; effectResult: EffectResult } {
  const messageId = uuidv7(input.nowMs);
  const eventId = channel.nextEventId(input.nowMs + 1);
  const componentsJson = JSON.stringify(input.effect.message.components);
  channel.ctx.storage.sql.exec(
    `INSERT INTO messages (
       message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
       sender_bot_id, sender_bot_display_name, sender_bot_avatar_url, type, format, status, text,
       reply_to, reply_snapshot_json, components_json, stream_state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'bot', NULL, ?, ?, ?, ?, ?, 'normal', ?, ?, NULL, ?, 'none', ?, ?)`,
    messageId,
    input.effect.client_effect_id,
    botDedupePrincipalKey(input.botId),
    input.channelId,
    input.botId,
    input.botSummary.display_name,
    input.botSummary.avatar_url,
    input.effect.message.type,
    input.effect.message.format,
    input.effect.message.text,
    input.effect.message.reply_to_message_id,
    componentsJson,
    input.now,
    input.now,
  );

  const messageRow: MessageRow = {
    message_id: messageId,
    command_id: input.effect.client_effect_id,
    channel_id: input.channelId,
    sender_kind: "bot",
    sender_user_id: null,
    sender_bot_id: input.botId,
    sender_bot_display_name: input.botSummary.display_name,
    sender_bot_avatar_url: input.botSummary.avatar_url,
    type: input.effect.message.type,
    format: input.effect.message.format,
    status: "normal",
    text: input.effect.message.text,
    reply_to: input.effect.message.reply_to_message_id,
    reply_snapshot_json: null,
    stream_state: "none",
    created_at: input.now,
    updated_at: input.now,
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    recalled_at: null,
  };

  insertBotLifecycleEvent(channel, {
    eventId,
    eventType: "message.created",
    channelId: input.channelId,
    botId: input.botId,
    occurredAt: input.now,
    messageRow,
    components: input.effect.message.components as WireChatMessage["components"],
    membershipVersion: input.membershipVersion,
  });

  const responseJson = JSON.stringify({ message_id: messageId, event_id: eventId });
  channel.ctx.storage.sql.exec(
    `INSERT INTO bot_effects_applied (
       channel_id, bot_id, client_effect_id, effect_type, request_hash,
       message_id, response_json, applied_at, outbox_id
     ) VALUES (?, ?, ?, 'send_message', ?, ?, ?, ?, ?)`,
    input.channelId,
    input.botId,
    input.effect.client_effect_id,
    input.requestHash,
    messageId,
    responseJson,
    input.now,
    input.outboxId,
  );

  appendChatChannelArchive(channel.ctx, input.channelId, input.now, [eventId], () =>
    collectDefinedChanges([
      upsertMessageChange(channel.ctx.storage.sql, messageId, input.channelId, rvEvent(eventId)),
      upsertEventChange(channel.ctx.storage.sql, eventId),
    ]),
  );

  return {
    message_id: messageId,
    event_id: eventId,
    effectResult: toGenericEffectResult({
      client_effect_id: input.effect.client_effect_id,
      type: "send_message",
      message_id: messageId,
      event_id: eventId,
    }),
  };
}

function applyUpdateMessageEffect(
  channel: ChatChannelHandlerRef,
  input: {
    channelId: string;
    botId: string;
    effect: Extract<ParsedNonStreamEffect, { type: "update_message" }>;
    now: string;
    nowMs: number;
    membershipVersion: number;
    outboxId: string;
    requestHash: string;
    existing: BotEffectMessageContextRow;
  },
): { message_id: string; event_id: string; effectResult: EffectResult } {
  const nextText = input.effect.message.text ?? input.existing.text ?? "";
  const nextComponentsJson =
    input.effect.message.components !== undefined
      ? JSON.stringify(input.effect.message.components)
      : (input.existing.components_json ?? "[]");
  const nextStatus =
    input.effect.message.text !== undefined && input.existing.status === "normal"
      ? "edited"
      : input.existing.status;
  const editedAt = input.effect.message.text !== undefined ? input.now : input.existing.edited_at;

  channel.ctx.storage.sql.exec(
    `UPDATE messages
     SET text=?, components_json=?, status=?, updated_at=?, edited_at=?
     WHERE message_id=? AND channel_id=?`,
    nextText,
    nextComponentsJson,
    nextStatus,
    input.now,
    editedAt,
    input.effect.message_id,
    input.channelId,
  );

  const messageRow: MessageRow = {
    ...input.existing,
    text: nextText,
    status: nextStatus,
    updated_at: input.now,
    edited_at: editedAt,
  };
  const eventId = channel.nextEventId(input.nowMs);
  insertBotLifecycleEvent(channel, {
    eventId,
    eventType: "message.updated",
    channelId: input.channelId,
    botId: input.botId,
    occurredAt: input.now,
    messageRow,
    components: parseStoredComponents(nextComponentsJson),
    membershipVersion: input.membershipVersion,
  });

  const responseJson = JSON.stringify({ message_id: input.effect.message_id, event_id: eventId });
  channel.ctx.storage.sql.exec(
    `INSERT INTO bot_effects_applied (
       channel_id, bot_id, client_effect_id, effect_type, request_hash,
       message_id, response_json, applied_at, outbox_id
     ) VALUES (?, ?, ?, 'update_message', ?, ?, ?, ?, ?)`,
    input.channelId,
    input.botId,
    input.effect.client_effect_id,
    input.requestHash,
    input.effect.message_id,
    responseJson,
    input.now,
    input.outboxId,
  );

  appendChatChannelArchive(channel.ctx, input.channelId, input.now, [eventId], () =>
    collectDefinedChanges([
      upsertMessageChange(channel.ctx.storage.sql, input.effect.message_id, input.channelId, rvEvent(eventId)),
      upsertEventChange(channel.ctx.storage.sql, eventId),
    ]),
  );

  return {
    message_id: input.effect.message_id,
    event_id: eventId,
    effectResult: toGenericEffectResult({
      client_effect_id: input.effect.client_effect_id,
      type: "update_message",
      message_id: input.effect.message_id,
      event_id: eventId,
    }),
  };
}

function applyDisableComponentsEffect(
  channel: ChatChannelHandlerRef,
  input: {
    channelId: string;
    botId: string;
    effect: Extract<ParsedNonStreamEffect, { type: "disable_components" }>;
    now: string;
    nowMs: number;
    membershipVersion: number;
    outboxId: string;
    requestHash: string;
    existing: BotEffectMessageContextRow;
  },
): { message_id: string; event_id: string; effectResult: EffectResult } {
  const nextComponentsJson = disableComponentsInJson(
    input.existing.components_json ?? "[]",
    input.effect.component_ids,
  );

  channel.ctx.storage.sql.exec(
    "UPDATE messages SET components_json=?, updated_at=? WHERE message_id=? AND channel_id=?",
    nextComponentsJson,
    input.now,
    input.effect.message_id,
    input.channelId,
  );

  const messageRow: MessageRow = {
    ...input.existing,
    updated_at: input.now,
  };
  const eventId = channel.nextEventId(input.nowMs);
  insertBotLifecycleEvent(channel, {
    eventId,
    eventType: "message.updated",
    channelId: input.channelId,
    botId: input.botId,
    occurredAt: input.now,
    messageRow,
    components: parseStoredComponents(nextComponentsJson),
    membershipVersion: input.membershipVersion,
  });

  const responseJson = JSON.stringify({ message_id: input.effect.message_id, event_id: eventId });
  channel.ctx.storage.sql.exec(
    `INSERT INTO bot_effects_applied (
       channel_id, bot_id, client_effect_id, effect_type, request_hash,
       message_id, response_json, applied_at, outbox_id
     ) VALUES (?, ?, ?, 'disable_components', ?, ?, ?, ?, ?)`,
    input.channelId,
    input.botId,
    input.effect.client_effect_id,
    input.requestHash,
    input.effect.message_id,
    responseJson,
    input.now,
    input.outboxId,
  );

  appendChatChannelArchive(channel.ctx, input.channelId, input.now, [eventId], () =>
    collectDefinedChanges([
      upsertMessageChange(channel.ctx.storage.sql, input.effect.message_id, input.channelId, rvEvent(eventId)),
      upsertEventChange(channel.ctx.storage.sql, eventId),
    ]),
  );

  return {
    message_id: input.effect.message_id,
    event_id: eventId,
    effectResult: toGenericEffectResult({
      client_effect_id: input.effect.client_effect_id,
      type: "disable_components",
      message_id: input.effect.message_id,
      event_id: eventId,
    }),
  };
}

function cachedEffectResult(
  clientEffectId: string,
  effectType: string,
  responseJson: string,
): EffectResult {
  if (effectType === "start_stream") {
    return toStartStreamEffectResult({
      client_effect_id: clientEffectId,
      response: JSON.parse(responseJson) as StartStreamEffectResponse,
    });
  }
  const cached = JSON.parse(responseJson) as { message_id?: string; event_id?: string };
  return toGenericEffectResult({
    client_effect_id: clientEffectId,
    type: effectType as "send_message" | "update_message" | "disable_components",
    message_id: cached.message_id,
    event_id: cached.event_id,
  });
}

function buildStreamingMessageRow(input: {
  messageId: string;
  clientEffectId: string;
  channelId: string;
  botId: string;
  botSummary: BotSummary;
  message: Extract<ParsedBotEffect, { type: "start_stream" }>["message"];
  createdAt: string;
}): MessageRow {
  return {
    message_id: input.messageId,
    command_id: input.clientEffectId,
    channel_id: input.channelId,
    sender_kind: "bot",
    sender_user_id: null,
    sender_bot_id: input.botId,
    sender_bot_display_name: input.botSummary.display_name,
    sender_bot_avatar_url: input.botSummary.avatar_url,
    type: input.message.type,
    format: input.message.format,
    status: "normal",
    text: "",
    reply_to: input.message.reply_to_message_id,
    reply_snapshot_json: null,
    stream_state: "streaming",
    created_at: input.createdAt,
    updated_at: input.createdAt,
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    recalled_at: null,
  };
}

export function BotDeliveryMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async botDeliveryResult(body: BotDeliveryResultInput): Promise<BotDeliveryResultResponse> {
      if (
        typeof body.delivery_id !== "string" ||
        typeof body.outbox_id !== "string" ||
        typeof body.bot_id !== "string" ||
        typeof body.channel_id !== "string" ||
        !Array.isArray(body.effects)
      ) {
        throw new ApiError("INVALID_MESSAGE", "invalid payload", { httpStatus: 400 });
      }

      const deliveryId = body.delivery_id;
      const outboxId = body.outbox_id;
      const botId = body.bot_id;
      const channelId = body.channel_id;

      const meta = this.repo.soleChannelMetaKindStreamGate();
      if (!meta || meta.channel_id !== channelId) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel not found", { httpStatus: 404 });
      }
      if (meta.kind === "dm") {
        throw new ApiError("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels", {
          httpStatus: 409,
        });
      }
      const dissolved = this.assertNotDissolved(meta.status);
      if (dissolved) {
        throw new ApiError(dissolved.code, dissolved.message, { httpStatus: 409 });
      }

      const outboxMeta = loadBotDeliveryOutboxMeta(asHandlerRef(this), outboxId);
      const interactionDeliveryContext =
        outboxMeta?.kind === "message_interaction" && outboxMeta.interaction_id
          ? {
              interactionId: outboxMeta.interaction_id,
              membershipVersion: meta.membership_version,
            }
          : null;

      const effects = body.effects as BotEffectWire[];
      let parsedEffects: ParsedBotEffect[];
      try {
        parsedEffects = validateEffectsForApply(effects, {
          botId,
          loadMessage: (messageId) => loadMessageRow(asHandlerRef(this), channelId, messageId),
        });
      } catch (err) {
        const message = err instanceof BotEffectValidationError ? err.message : "invalid effect";
        maybeFinalizeInteractionDelivery(asHandlerRef(this), interactionDeliveryContext, {
          channelId,
          botId,
          success: false,
          errorCode: "BOT_EFFECT_INVALID",
          errorMessage: message,
        });
        return botDeliveryFailed("BOT_EFFECT_INVALID", message);
      }

      let botSummary: BotSummary | null = null;
      if (parsedEffects.some((effect) => effect.type === "send_message" || effect.type === "start_stream")) {
        botSummary = await fetchBotSummary(this.env, botId);
        if (!botSummary && !isOfficialBotId(botId)) {
          maybeFinalizeInteractionDelivery(asHandlerRef(this), interactionDeliveryContext, {
            channelId,
            botId,
            success: false,
            errorCode: "BOT_NOT_FOUND",
            errorMessage: "bot not found",
          });
          return botDeliveryFailed("BOT_NOT_FOUND", "bot not found");
        }
      }

      const now = this.nowIso();
      const nowMs = Date.parse(now);
      const effectResults: EffectResult[] = [];
      const streamStartedEmits: Array<{
        channelId: string;
        messageRow: MessageRow;
        components: WireChatMessage["components"];
        occurredAt: string;
      }> = [];

      try {
        await this.ctx.storage.transaction(async () => {
          for (const raw of effects) {
            const requestHash = computeEffectRequestHash(raw);
            const existing = this.ctx.storage.sql
              .exec(
                "SELECT request_hash, response_json, effect_type FROM bot_effects_applied WHERE channel_id=? AND bot_id=? AND client_effect_id=?",
                channelId,
                botId,
                raw.client_effect_id,
              )
              .toArray()[0] as
              | { request_hash: string; response_json: string | null; effect_type: string }
              | undefined;
            if (existing) {
              if (existing.request_hash !== requestHash) {
                throw Object.assign(new Error("client_effect_id reused with different body"), {
                  code: "BOT_EFFECT_CONFLICT",
                });
              }
              if (existing.response_json) {
                effectResults.push(
                  cachedEffectResult(raw.client_effect_id, existing.effect_type, existing.response_json),
                );
                continue;
              }
            }

            const effect = parsedEffects.find((item) => item.client_effect_id === raw.client_effect_id);
            if (!effect) continue;

            if (effect.type === "start_stream") {
              if (!botSummary) {
                throw new BotEffectValidationError("bot summary unavailable");
              }
              const registration = registerStartStreamEffectInTransaction(asHandlerRef(this), {
                channelId,
                botId,
                clientEffectId: effect.client_effect_id,
                requestHash,
                senderBotDisplayName: botSummary.display_name,
                senderBotAvatarUrl: botSummary.avatar_url,
                message: {
                  type: effect.message.type,
                  format: effect.message.format,
                  reply_to: effect.message.reply_to_message_id,
                  components: effect.message.components,
                  attachment_ids: effect.message.attachment_ids,
                },
                outboxId,
              }) as StartStreamRegistrationResult;
              if (registration.kind === "conflict") {
                throw Object.assign(new Error("client_effect_id reused with different body"), {
                  code: "BOT_EFFECT_CONFLICT",
                });
              }
              effectResults.push(
                toStartStreamEffectResult({
                  client_effect_id: effect.client_effect_id,
                  response: registration.response,
                }),
              );
              if (registration.kind === "created") {
                streamStartedEmits.push({
                  channelId,
                  messageRow: buildStreamingMessageRow({
                    messageId: registration.messageId,
                    clientEffectId: effect.client_effect_id,
                    channelId,
                    botId,
                    botSummary,
                    message: effect.message,
                    createdAt: registration.createdAt,
                  }),
                  components: effect.message.components as WireChatMessage["components"],
                  occurredAt: registration.createdAt,
                });
              }
              continue;
            }

            if (effect.type === "send_message") {
              if (!botSummary) {
                throw new BotEffectValidationError("bot summary unavailable");
              }
              effectResults.push(
                applySendMessageEffect(asHandlerRef(this), {
                  channelId,
                  botId,
                  botSummary,
                  effect,
                  now,
                  nowMs: nowMs + effectResults.length,
                  membershipVersion: meta.membership_version,
                  outboxId,
                  requestHash,
                }).effectResult,
              );
              continue;
            }

            const existingRow = loadMessageRow(asHandlerRef(this), channelId, effect.message_id);
            if (!existingRow) {
              throw new BotEffectValidationError("message not found");
            }

            if (effect.type === "update_message") {
              effectResults.push(
                applyUpdateMessageEffect(asHandlerRef(this), {
                  channelId,
                  botId,
                  effect,
                  now,
                  nowMs: nowMs + effectResults.length,
                  membershipVersion: meta.membership_version,
                  outboxId,
                  requestHash,
                  existing: existingRow,
                }).effectResult,
              );
              continue;
            }

            effectResults.push(
              applyDisableComponentsEffect(asHandlerRef(this), {
                channelId,
                botId,
                effect,
                now,
                nowMs: nowMs + effectResults.length,
                membershipVersion: meta.membership_version,
                outboxId,
                requestHash,
                existing: existingRow,
              }).effectResult,
            );
          }
        });
      } catch (err) {
        if (isRecord(err) && err.code === "BOT_EFFECT_CONFLICT") {
          throw new ApiError("BOT_EFFECT_CONFLICT", "client_effect_id reused with different body", { httpStatus: 409 });
        }
        const message = err instanceof BotEffectValidationError ? err.message : "invalid effect";
        maybeFinalizeInteractionDelivery(asHandlerRef(this), interactionDeliveryContext, {
          channelId,
          botId,
          success: false,
          errorCode: "BOT_EFFECT_INVALID",
          errorMessage: message,
        });
        return botDeliveryFailed("BOT_EFFECT_INVALID", message);
      }

      if (interactionDeliveryContext) {
        maybeFinalizeInteractionDelivery(asHandlerRef(this), interactionDeliveryContext, {
          channelId,
          botId,
          success: true,
        });
      }

      for (const emit of streamStartedEmits) {
        await deliverLiveStreamFrame(this.env, {
          channel_id: emit.channelId,
          frame: buildStreamStartedFrame({
            channelId: emit.channelId,
            messageRow: emit.messageRow,
            components: emit.components,
            occurredAt: emit.occurredAt,
          }),
        });
      }

      if (
        streamStartedEmits.length > 0 ||
        effectResults.some((result) => result.type !== "start_stream") ||
        interactionDeliveryContext
      ) {
        await this.scheduleOutboxAlarm(now);
      }
      return { status: "applied", effect_results: effectResults };
    }
  };
}
