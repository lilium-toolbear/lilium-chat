import { uuidv7 } from "../../../ids/uuidv7";
import { buildEventFrame, buildMessageLifecyclePayload } from "../../../chat/event-broadcast";
import { projectMessageForBrowser } from "../../../chat/message-projection";
import type { MessageRow } from "../../../contract/persisted";
import type { WireChatMessage } from "../../../contract/message";
import type {
  StreamAbandonRpcInput,
  StreamFinalizeRpcInput,
  StreamRegistryCheckResponse,
  StreamRegistryCheckRpcInput,
  StreamRegistryPeekResponse,
  StreamRegistryPeekRpcInput,
  StreamRegistryRegisterRpcInput,
} from "../../../contract/chat-channel-rpc";
import { ApiError } from "../../../errors";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  rvEvent,
  upsertEventChange,
  upsertMessageChange,
} from "../../../archive/chat-channel-record";
import {
  botDedupePrincipalKey,
  buildStartStreamEffectResponse,
  computeAbandonedTextHash,
  computeFinalizeRequestHash,
  computeTextHash,
  isStreamRegistryExpired,
  rejectNonEmptyStreamComponents,
  parseStreamRegistryMessageJson,
  sanitizeStreamMessageMetadata,
  streamExpiresAtIso,
  type StreamRegistryStatus,
  type StreamRegistryMessageJson,
  type StartStreamEffectResponse,
  type StreamAbandonResponse,
  type StreamAbandonNonCanonical,
  type StreamFinalizeResponse,
} from "../../../chat/stream-registry";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";
import { asHandlerRef, type ChatChannelHandlerRef } from "../handler-ref";
import { enqueueStatefulInputForBotMessageCreated } from "./stateful-session";

interface RegistryRow {
  channel_id: string;
  message_id: string;
  bot_id: string;
  client_effect_id: string;
  status: string;
  sender_bot_display_name: string;
  sender_bot_avatar_url: string | null;
  message_json: string;
  created_at: string;
  expires_at: string;
  finalized_at: string | null;
  abandoned_at: string | null;
  final_event_id: string | null;
  final_text_hash: string | null;
  finalize_request_hash: string | null;
  finalized_response_json: string | null;
  abandoned_event_id: string | null;
  abandoned_text_hash: string | null;
  abandoned_response_json: string | null;
}

function loadRegistryRow(channel: ChatChannelHandlerRef, channelId: string, messageId: string): RegistryRow | null {
  const row = channel.ctx.storage.sql
    .exec(
      `SELECT channel_id, message_id, bot_id, client_effect_id, status,
              sender_bot_display_name, sender_bot_avatar_url, message_json,
              created_at, expires_at, finalized_at, abandoned_at,
              final_event_id, final_text_hash, finalize_request_hash, finalized_response_json,
              abandoned_event_id, abandoned_text_hash, abandoned_response_json
       FROM message_stream_registry
       WHERE channel_id=? AND message_id=?`,
      channelId,
      messageId,
    )
    .toArray()[0] as RegistryRow | undefined;
  return row ?? null;
}

function channelMeta(channel: ChatChannelHandlerRef): NonNullable<ReturnType<ChatChannelCore["repo"]["soleChannelMetaStreamGate"]>> | null {
  return channel.repo.soleChannelMetaStreamGate() ?? null;
}

function assertWritableChannel(channel: ChatChannelHandlerRef): void {
  const meta = channelMeta(channel);
  if (!meta) {
    throw new ApiError("CHANNEL_NOT_FOUND", "channel not created", { httpStatus: 404 });
  }
  const dissolved = channel.assertNotDissolved(meta.status);
  if (dissolved) {
    throw new ApiError(dissolved.code, dissolved.message, { httpStatus: 409 });
  }
}

function throwRegistryExpired(): never {
  throw new ApiError("BOT_STREAM_EXPIRED", "stream registry expired", { httpStatus: 410 });
}

function throwRegistryNotFound(): never {
  throw new ApiError("BOT_STREAM_NOT_FOUND", "stream registry not found", { httpStatus: 404 });
}

function throwRegistryConflict(message: string): never {
  throw new ApiError("BOT_STREAM_CONFLICT", message, { httpStatus: 409 });
}

export type StartStreamRegistrationResult =
  | {
      kind: "created";
      response: StartStreamEffectResponse;
      messageId: string;
      messageMetadata: StreamRegistryMessageJson;
      createdAt: string;
      expiresAt: string;
    }
  | { kind: "cached"; response: StartStreamEffectResponse }
  | { kind: "conflict" };

export function registerStartStreamEffectInTransaction(
  channel: ChatChannelHandlerRef,
  input: {
    channelId: string;
    botId: string;
    clientEffectId: string;
    requestHash: string;
    senderBotDisplayName: string;
    senderBotAvatarUrl: string | null;
    message: Record<string, unknown>;
    outboxId?: string | null;
  },
): StartStreamRegistrationResult {
  const messageMetadata = sanitizeStreamMessageMetadata(input.message);
  const now = channel.nowIso();
  const nowMs = Date.parse(now);
  const expiresAt = streamExpiresAtIso(nowMs);

  const existing = channel.ctx.storage.sql
    .exec(
      "SELECT request_hash, response_json, message_id FROM bot_effects_applied WHERE channel_id=? AND bot_id=? AND client_effect_id=?",
      input.channelId,
      input.botId,
      input.clientEffectId,
    )
    .toArray()[0] as { request_hash: string; response_json: string | null; message_id: string | null } | undefined;

  if (existing) {
    if (existing.request_hash !== input.requestHash) return { kind: "conflict" };
    if (existing.response_json) {
      return { kind: "cached", response: JSON.parse(existing.response_json) as StartStreamEffectResponse };
    }
  }

  const messageId = existing?.message_id ?? uuidv7(nowMs);
  const startResponse = buildStartStreamEffectResponse({
    channelId: input.channelId,
    messageId,
    expiresAt,
  });
  const responseJson = JSON.stringify(startResponse);

  if (!existing) {
    channel.ctx.storage.sql.exec(
      `INSERT INTO message_stream_registry (
        channel_id, message_id, bot_id, client_effect_id, status,
        sender_bot_display_name, sender_bot_avatar_url, message_json,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, 'streaming', ?, ?, ?, ?, ?)`,
      input.channelId,
      messageId,
      input.botId,
      input.clientEffectId,
      input.senderBotDisplayName,
      input.senderBotAvatarUrl,
      JSON.stringify(messageMetadata),
      now,
      expiresAt,
    );
  }

  channel.ctx.storage.sql.exec(
    `INSERT INTO bot_effects_applied (
      channel_id, bot_id, client_effect_id, effect_type, request_hash,
      message_id, response_json, applied_at, outbox_id
    ) VALUES (?, ?, ?, 'start_stream', ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, bot_id, client_effect_id) DO UPDATE SET
      request_hash=excluded.request_hash,
      message_id=excluded.message_id,
      response_json=excluded.response_json,
      applied_at=excluded.applied_at,
      outbox_id=COALESCE(excluded.outbox_id, bot_effects_applied.outbox_id)`,
    input.channelId,
    input.botId,
    input.clientEffectId,
    input.requestHash,
    messageId,
    responseJson,
    now,
    input.outboxId ?? null,
  );

  return {
    kind: "created",
    response: startResponse,
    messageId,
    messageMetadata,
    createdAt: now,
    expiresAt,
  };
}

function buildBotMessageRow(input: {
  registry: RegistryRow;
  text: string;
  streamState: "final" | "abandoned";
  status: "normal" | "failed";
  finalizedAt: string;
  componentsJson: string;
}): MessageRow {
  const metadata = parseStreamRegistryMessageJson(input.registry.message_json);
  return {
    message_id: input.registry.message_id,
    command_id: input.registry.client_effect_id,
    channel_id: input.registry.channel_id,
    sender_kind: "bot",
    sender_user_id: null,
    sender_bot_id: input.registry.bot_id,
    sender_bot_display_name: input.registry.sender_bot_display_name,
    sender_bot_avatar_url: input.registry.sender_bot_avatar_url,
    type: metadata.type,
    format: metadata.format,
    status: input.status,
    text: input.text,
    reply_to: metadata.reply_to ?? null,
    reply_snapshot_json: null,
    stream_state: input.streamState,
    created_at: input.registry.created_at,
    updated_at: input.finalizedAt,
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    recalled_at: null,
  };
}

function insertStreamCanonicalEvent(
  channel: ChatChannelHandlerRef,
  input: {
    eventId: string;
    eventType: "message.stream_finalized" | "message.stream_abandoned";
    channelId: string;
    botId: string;
    occurredAt: string;
    messageRow: MessageRow;
    components: unknown[];
    membershipVersion: number;
  },
): string {
  const liveMessage = projectMessageForBrowser(input.messageRow, {
    components: input.components as WireChatMessage["components"],
  });
  const liveEventFrame = buildEventFrame({
    event_id: input.eventId,
    type: input.eventType,
    channel_id: input.channelId,
    occurred_at: input.occurredAt,
    payload: { channel_id: input.channelId, event_id: input.eventId, message: liveMessage },
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
  return JSON.stringify(liveEventFrame);
}

export function StreamRegistryMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async streamRegistryCheck(input: StreamRegistryCheckRpcInput): Promise<StreamRegistryCheckResponse> {
      if (
        typeof input.channel_id !== "string" ||
        typeof input.message_id !== "string" ||
        typeof input.bot_id !== "string"
      ) {
        throw new ApiError("INVALID_MESSAGE", "invalid payload", { httpStatus: 400 });
      }

      const registry = loadRegistryRow(asHandlerRef(this), input.channel_id, input.message_id);
      if (!registry) throwRegistryNotFound();
      if (registry.bot_id !== input.bot_id) throwRegistryNotFound();
      if (registry.status !== "streaming") {
        if (registry.status === "finalized" || registry.status === "abandoned" || registry.status === "expired") {
          throwRegistryExpired();
        }
        throwRegistryNotFound();
      }
      if (isStreamRegistryExpired(registry.expires_at)) {
        throwRegistryExpired();
      }

      return {
        channel_id: registry.channel_id,
        message_id: registry.message_id,
        bot_id: registry.bot_id,
        status: registry.status,
        expires_at: registry.expires_at,
        created_at: registry.created_at,
      };
    }

    async streamRegistryPeek(input: StreamRegistryPeekRpcInput): Promise<StreamRegistryPeekResponse> {
      if (
        typeof input.channel_id !== "string" ||
        typeof input.message_id !== "string" ||
        typeof input.bot_id !== "string"
      ) {
        throw new ApiError("INVALID_MESSAGE", "invalid payload", { httpStatus: 400 });
      }

      const registry = loadRegistryRow(asHandlerRef(this), input.channel_id, input.message_id);
      if (!registry || registry.bot_id !== input.bot_id) throwRegistryNotFound();
      return { status: registry.status };
    }

    async streamRegistryRegister(input: StreamRegistryRegisterRpcInput): Promise<StartStreamEffectResponse> {
      if (
        typeof input.channel_id !== "string" ||
        typeof input.bot_id !== "string" ||
        typeof input.client_effect_id !== "string" ||
        typeof input.request_hash !== "string" ||
        typeof input.sender_bot_display_name !== "string"
      ) {
        throw new ApiError("INVALID_MESSAGE", "invalid payload", { httpStatus: 400 });
      }

      assertWritableChannel(asHandlerRef(this));

      const meta = channelMeta(asHandlerRef(this))!;
      if (meta.channel_id !== input.channel_id) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel_id mismatch", { httpStatus: 404 });
      }

      const avatarUrl = typeof input.sender_bot_avatar_url === "string" ? input.sender_bot_avatar_url : null;

      const txResult = await this.ctx.storage.transaction(async (): Promise<StartStreamRegistrationResult> =>
        registerStartStreamEffectInTransaction(asHandlerRef(this), {
          channelId: input.channel_id,
          botId: input.bot_id,
          clientEffectId: input.client_effect_id,
          requestHash: input.request_hash,
          senderBotDisplayName: input.sender_bot_display_name,
          senderBotAvatarUrl: avatarUrl,
          message:
            typeof input.message === "object" && input.message !== null
              ? (input.message as Record<string, unknown>)
              : {},
        }),
      );

      if (txResult.kind === "conflict") {
        throw new ApiError("BOT_EFFECT_CONFLICT", "client_effect_id reused with different body", { httpStatus: 409 });
      }
      return txResult.response;
    }

    async streamFinalize(input: StreamFinalizeRpcInput): Promise<StreamFinalizeResponse> {
      if (
        typeof input.channel_id !== "string" ||
        typeof input.message_id !== "string" ||
        typeof input.bot_id !== "string" ||
        typeof input.resolved_text !== "string" ||
        typeof input.finalize_request_hash !== "string" ||
        typeof input.final_seq !== "number"
      ) {
        throw new ApiError("INVALID_MESSAGE", "invalid payload", { httpStatus: 400 });
      }

      assertWritableChannel(asHandlerRef(this));

      const registry = loadRegistryRow(asHandlerRef(this), input.channel_id, input.message_id);
      if (!registry) throwRegistryNotFound();
      if (registry.bot_id !== input.bot_id) throwRegistryNotFound();

      const components = Array.isArray(input.components) ? input.components : [];
      try {
        rejectNonEmptyStreamComponents(components);
      } catch (err) {
        const message = err instanceof Error ? err.message : "stream messages must not include components";
        throw new ApiError("BOT_EFFECT_INVALID", message, { httpStatus: 422 });
      }
      const attachmentIds = Array.isArray(input.attachment_ids)
        ? input.attachment_ids.filter((id): id is string => typeof id === "string")
        : [];
      if (attachmentIds.length > 0) {
        throw new ApiError("BOT_EFFECT_INVALID", "attachment_ids not supported yet", { httpStatus: 422 });
      }

      const expectedHash = await computeFinalizeRequestHash({
        final_seq: input.final_seq,
        resolved_text: input.resolved_text,
        components,
        attachment_ids: attachmentIds,
      });
      if (expectedHash !== input.finalize_request_hash) {
        throw new ApiError("BOT_EFFECT_INVALID", "finalize_request_hash mismatch", { httpStatus: 422 });
      }

      if (registry.status === "finalized") {
        if (registry.finalize_request_hash === input.finalize_request_hash && registry.finalized_response_json) {
          return JSON.parse(registry.finalized_response_json) as StreamFinalizeResponse;
        }
        throwRegistryConflict("stream already finalized with different request");
      }
      if (registry.status === "abandoned" || registry.status === "expired") {
        throwRegistryExpired();
      }
      if (registry.status !== "streaming") throwRegistryNotFound();
      if (isStreamRegistryExpired(registry.expires_at)) {
        throwRegistryExpired();
      }

      const meta = channelMeta(asHandlerRef(this))!;
      const now = this.nowIso();
      const eventId = this.nextEventId(Date.parse(now));
      const finalTextHash = await computeTextHash(input.resolved_text);
      const componentsJson = JSON.stringify(components);
      const messageRow = buildBotMessageRow({
        registry,
        text: input.resolved_text,
        streamState: "final",
        status: "normal",
        finalizedAt: now,
        componentsJson,
      });
      const response: StreamFinalizeResponse = { message_id: registry.message_id, event_id: eventId };
      const responseJson = JSON.stringify(response);

      type FinalizeResult = { kind: "ok"; responseJson: string } | { kind: "conflict" } | { kind: "expired" };

      const txResult = await this.ctx.storage.transaction(async (): Promise<FinalizeResult> => {
        const fresh = loadRegistryRow(asHandlerRef(this), input.channel_id, input.message_id);
        if (!fresh) return { kind: "expired" };
        if (fresh.status === "finalized") {
          if (fresh.finalize_request_hash === input.finalize_request_hash && fresh.finalized_response_json) {
            return { kind: "ok", responseJson: fresh.finalized_response_json };
          }
          return { kind: "conflict" };
        }
        if (fresh.status !== "streaming") return { kind: "expired" };

        this.ctx.storage.sql.exec(
          `INSERT INTO messages (
            message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
            sender_bot_id, sender_bot_display_name, sender_bot_avatar_url,
            type, format, status, text, reply_to, reply_snapshot_json, components_json,
            stream_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'bot', NULL, ?, ?, ?, ?, ?, 'normal', ?, ?, NULL, ?, 'final', ?, ?)`,
          messageRow.message_id,
          messageRow.command_id,
          botDedupePrincipalKey(input.bot_id),
          messageRow.channel_id,
          messageRow.sender_bot_id,
          messageRow.sender_bot_display_name,
          messageRow.sender_bot_avatar_url,
          messageRow.type,
          messageRow.format,
          messageRow.text,
          messageRow.reply_to,
          componentsJson,
          messageRow.created_at,
          now,
        );

        insertStreamCanonicalEvent(asHandlerRef(this), {
          eventId,
          eventType: "message.stream_finalized",
          channelId: input.channel_id,
          botId: input.bot_id,
          occurredAt: now,
          messageRow,
          components,
          membershipVersion: meta.membership_version,
        });

        this.ctx.storage.sql.exec(
          `UPDATE message_stream_registry SET
            status='finalized',
            finalized_at=?,
            final_event_id=?,
            final_text_hash=?,
            finalize_request_hash=?,
            finalized_response_json=?
           WHERE channel_id=? AND message_id=?`,
          now,
          eventId,
          finalTextHash,
          input.finalize_request_hash,
          responseJson,
          input.channel_id,
          input.message_id,
        );

        appendChatChannelArchive(this.ctx, input.channel_id, now, [eventId], () => {
          const rv = rvEvent(eventId);
          return collectDefinedChanges([
            upsertMessageChange(this.ctx.storage.sql, messageRow.message_id, messageRow.channel_id, rv),
            upsertEventChange(this.ctx.storage.sql, eventId),
          ]);
        });

        return { kind: "ok", responseJson };
      });

      if (txResult.kind === "conflict") throwRegistryConflict("stream already finalized with different request");
      if (txResult.kind === "expired") throwRegistryExpired();

      await enqueueStatefulInputForBotMessageCreated(asHandlerRef(this), {
        channelId: input.channel_id,
        messageId: messageRow.message_id,
        eventId,
        occurredAt: now,
        messageRow,
        components: components as WireChatMessage["components"],
      });

      await this.scheduleOutboxAlarm(now);
      await this.scheduleArchiveAlarm(now);
      return JSON.parse(txResult.responseJson) as StreamFinalizeResponse;
    }

    async streamAbandon(input: StreamAbandonRpcInput): Promise<StreamAbandonResponse | StreamAbandonNonCanonical> {
      if (
        typeof input.channel_id !== "string" ||
        typeof input.message_id !== "string" ||
        typeof input.bot_id !== "string" ||
        typeof input.resolved_partial !== "string" ||
        typeof input.abandoned_text_hash !== "string"
      ) {
        throw new ApiError("INVALID_MESSAGE", "invalid payload", { httpStatus: 400 });
      }

      const registry = loadRegistryRow(asHandlerRef(this), input.channel_id, input.message_id);
      if (!registry) throwRegistryNotFound();
      if (registry.bot_id !== input.bot_id) throwRegistryNotFound();

      const expectedHash = await computeAbandonedTextHash(input.resolved_partial);
      if (expectedHash !== input.abandoned_text_hash) {
        throw new ApiError("BOT_EFFECT_INVALID", "abandoned_text_hash mismatch", { httpStatus: 422 });
      }

      if (registry.status === "finalized") {
        throwRegistryConflict("stream already finalized");
      }

      if (registry.status === "abandoned") {
        if (input.resolved_partial.length === 0) {
          return { canonical: false };
        }
        if (registry.abandoned_text_hash === input.abandoned_text_hash && registry.abandoned_response_json) {
          return JSON.parse(registry.abandoned_response_json) as StreamAbandonResponse;
        }
        if (registry.abandoned_text_hash && registry.abandoned_text_hash !== input.abandoned_text_hash) {
          throwRegistryConflict("stream already abandoned with different partial");
        }
        return { canonical: false };
      }

      if (registry.status === "expired") {
        throwRegistryExpired();
      }

      const now = this.nowIso();

      if (input.resolved_partial.length === 0) {
        await this.ctx.storage.transaction(async () => {
          this.ctx.storage.sql.exec(
            `UPDATE message_stream_registry SET status='abandoned', abandoned_at=? WHERE channel_id=? AND message_id=?`,
            now,
            input.channel_id,
            input.message_id,
          );
        });
        return { canonical: false };
      }

      const meta = channelMeta(asHandlerRef(this));
      if (!meta) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel not created", { httpStatus: 404 });
      }

      const eventId = this.nextEventId(Date.parse(now));
      const messageRow = buildBotMessageRow({
        registry,
        text: input.resolved_partial,
        streamState: "abandoned",
        status: "failed",
        finalizedAt: now,
        componentsJson: "[]",
      });
      const response: StreamAbandonResponse = { message_id: registry.message_id, event_id: eventId };
      const responseJson = JSON.stringify(response);

      type AbandonResult = { kind: "ok"; responseJson: string } | { kind: "conflict" };

      const txResult = await this.ctx.storage.transaction(async (): Promise<AbandonResult> => {
        const fresh = loadRegistryRow(asHandlerRef(this), input.channel_id, input.message_id);
        if (!fresh) return { kind: "conflict" };
        if (fresh.status === "finalized") return { kind: "conflict" };
        if (fresh.status === "abandoned") {
          if (fresh.abandoned_text_hash === input.abandoned_text_hash && fresh.abandoned_response_json) {
            return { kind: "ok", responseJson: fresh.abandoned_response_json };
          }
          return { kind: "conflict" };
        }

        this.ctx.storage.sql.exec(
          `INSERT INTO messages (
            message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
            sender_bot_id, sender_bot_display_name, sender_bot_avatar_url,
            type, format, status, text, reply_to, reply_snapshot_json, components_json,
            stream_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'bot', NULL, ?, ?, ?, ?, ?, 'failed', ?, ?, NULL, '[]', 'abandoned', ?, ?)`,
          messageRow.message_id,
          messageRow.command_id,
          botDedupePrincipalKey(input.bot_id),
          messageRow.channel_id,
          messageRow.sender_bot_id,
          messageRow.sender_bot_display_name,
          messageRow.sender_bot_avatar_url,
          messageRow.type,
          messageRow.format,
          messageRow.text,
          messageRow.reply_to,
          messageRow.created_at,
          now,
        );

        insertStreamCanonicalEvent(asHandlerRef(this), {
          eventId,
          eventType: "message.stream_abandoned",
          channelId: input.channel_id,
          botId: input.bot_id,
          occurredAt: now,
          messageRow,
          components: [],
          membershipVersion: meta.membership_version,
        });

        this.ctx.storage.sql.exec(
          `UPDATE message_stream_registry SET
            status='abandoned',
            abandoned_at=?,
            abandoned_event_id=?,
            abandoned_text_hash=?,
            abandoned_response_json=?
           WHERE channel_id=? AND message_id=?`,
          now,
          eventId,
          input.abandoned_text_hash,
          responseJson,
          input.channel_id,
          input.message_id,
        );

        appendChatChannelArchive(this.ctx, input.channel_id, now, [eventId], () => {
          const rv = rvEvent(eventId);
          return collectDefinedChanges([
            upsertMessageChange(this.ctx.storage.sql, messageRow.message_id, messageRow.channel_id, rv),
            upsertEventChange(this.ctx.storage.sql, eventId),
          ]);
        });

        return { kind: "ok", responseJson };
      });

      if (txResult.kind === "conflict") {
        throwRegistryConflict("stream abandon conflict");
      }

      await this.scheduleOutboxAlarm(now);
      await this.scheduleArchiveAlarm(now);
      return JSON.parse(txResult.responseJson) as StreamAbandonResponse;
    }
  };
}

export function registryStatusForTest(
  channel: ChatChannelHandlerRef,
  channelId: string,
  messageId: string,
): StreamRegistryStatus | null {
  const row = loadRegistryRow(channel, channelId, messageId);
  if (!row) return null;
  return row.status as StreamRegistryStatus;
}
