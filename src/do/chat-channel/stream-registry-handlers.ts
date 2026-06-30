import { uuidv7 } from "../../ids/uuidv7";
import { buildEventFrame, buildMessageLifecyclePayload } from "../../chat/event-broadcast";
import { projectMessageForBrowser } from "../../chat/message-projection";
import type { MessageRow } from "../../contract/persisted";
import type { WireChatMessage } from "../../contract/message";
import type { ChatChannelHost } from "./host";
import { doErrorResponse } from "../../errors";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  rvEvent,
  upsertEventChange,
  upsertMessageChange,
} from "../../archive/chat-channel-record";
import {
  botDedupePrincipalKey,
  buildStartStreamEffectResponse,
  computeAbandonedTextHash,
  computeFinalizeRequestHash,
  computeTextHash,
  isStreamRegistryExpired,
  parseStreamRegistryMessageJson,
  sanitizeStreamMessageMetadata,
  streamExpiresAtIso,
  type StreamRegistryStatus,
  type StreamRegistryMessageJson,
  type StartStreamEffectResponse,
  type StreamAbandonResponse,
  type StreamFinalizeResponse,
} from "../../chat/stream-registry";

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

function loadRegistryRow(host: ChatChannelHost, channelId: string, messageId: string): RegistryRow | null {
  const row = host.ctx.storage.sql
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

function channelMeta(host: ChatChannelHost): { channel_id: string; status: string; membership_version: number } | null {
  const row = host.ctx.storage.sql
    .exec("SELECT channel_id, status, membership_version FROM channel_meta LIMIT 1")
    .toArray()[0] as { channel_id: string; status: string; membership_version: number } | undefined;
  return row ?? null;
}

function assertWritableChannel(host: ChatChannelHost): Response | null {
  const meta = channelMeta(host);
  if (!meta) {
    return doErrorResponse("CHANNEL_NOT_FOUND", "channel not created", { httpStatus: 404 });
  }
  const dissolved = host.assertNotDissolved(meta.status);
  if (dissolved) {
    return doErrorResponse(dissolved.code, dissolved.message, { httpStatus: 409 });
  }
  return null;
}

function registryExpiredError(): Response {
  return doErrorResponse("BOT_STREAM_EXPIRED", "stream registry expired", { httpStatus: 410 });
}

function registryNotFoundError(): Response {
  return doErrorResponse("BOT_STREAM_NOT_FOUND", "stream registry not found", { httpStatus: 404 });
}

function registryConflictError(message: string): Response {
  return doErrorResponse("BOT_STREAM_CONFLICT", message, { httpStatus: 409 });
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
  host: ChatChannelHost,
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
  const now = host.nowIso();
  const nowMs = Date.parse(now);
  const expiresAt = streamExpiresAtIso(nowMs);

  const existing = host.ctx.storage.sql
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
    host.ctx.storage.sql.exec(
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

  host.ctx.storage.sql.exec(
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
  host: ChatChannelHost,
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
  host.ctx.storage.sql.exec(
    "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, ?, ?, 'bot', ?, ?, ?, ?)",
    input.eventId,
    input.eventType,
    input.channelId,
    input.botId,
    JSON.stringify(persistedPayload),
    input.membershipVersion,
    input.occurredAt,
  );
  host.insertOutboxRowForFanout(
    input.channelId,
    input.eventId,
    JSON.stringify(liveEventFrame),
    input.membershipVersion,
    input.occurredAt,
  );
  return JSON.stringify(liveEventFrame);
}

export async function handleStreamRegistryCheck(host: ChatChannelHost, body: {
  channel_id?: unknown;
  message_id?: unknown;
  bot_id?: unknown;
}): Promise<Response> {
  if (
    typeof body.channel_id !== "string" ||
    typeof body.message_id !== "string" ||
    typeof body.bot_id !== "string"
  ) {
    return new Response("invalid payload", { status: 400 });
  }

  const registry = loadRegistryRow(host, body.channel_id, body.message_id);
  if (!registry) return registryNotFoundError();
  if (registry.bot_id !== body.bot_id) return registryNotFoundError();
  if (registry.status !== "streaming") {
    if (registry.status === "finalized" || registry.status === "abandoned" || registry.status === "expired") {
      return registryExpiredError();
    }
    return registryNotFoundError();
  }
  if (isStreamRegistryExpired(registry.expires_at)) {
    return registryExpiredError();
  }

  return Response.json({
    ok: true,
    channel_id: registry.channel_id,
    message_id: registry.message_id,
    bot_id: registry.bot_id,
    status: registry.status,
    expires_at: registry.expires_at,
    created_at: registry.created_at,
  });
}

export async function handleStreamRegistryRegister(host: ChatChannelHost, body: {
  channel_id?: unknown;
  bot_id?: unknown;
  client_effect_id?: unknown;
  request_hash?: unknown;
  sender_bot_display_name?: unknown;
  sender_bot_avatar_url?: unknown;
  message?: unknown;
}): Promise<Response> {
  if (
    typeof body.channel_id !== "string" ||
    typeof body.bot_id !== "string" ||
    typeof body.client_effect_id !== "string" ||
    typeof body.request_hash !== "string" ||
    typeof body.sender_bot_display_name !== "string"
  ) {
    return new Response("invalid payload", { status: 400 });
  }

  const writable = assertWritableChannel(host);
  if (writable) return writable;

  const meta = channelMeta(host)!;
  if (meta.channel_id !== body.channel_id) {
    return doErrorResponse("CHANNEL_NOT_FOUND", "channel_id mismatch", { httpStatus: 404 });
  }

  const avatarUrl = typeof body.sender_bot_avatar_url === "string" ? body.sender_bot_avatar_url : null;

  const txResult = await host.ctx.storage.transaction(async (): Promise<StartStreamRegistrationResult> =>
    registerStartStreamEffectInTransaction(host, {
      channelId: body.channel_id as string,
      botId: body.bot_id as string,
      clientEffectId: body.client_effect_id as string,
      requestHash: body.request_hash as string,
      senderBotDisplayName: body.sender_bot_display_name as string,
      senderBotAvatarUrl: avatarUrl,
      message:
        typeof body.message === "object" && body.message !== null
          ? (body.message as Record<string, unknown>)
          : {},
    }),
  );

  if (txResult.kind === "conflict") {
    return doErrorResponse("BOT_EFFECT_CONFLICT", "client_effect_id reused with different body", { httpStatus: 409 });
  }
  return Response.json(txResult.response);
}

export async function handleStreamFinalize(host: ChatChannelHost, body: {
  channel_id?: unknown;
  message_id?: unknown;
  bot_id?: unknown;
  resolved_text?: unknown;
  finalize_request_hash?: unknown;
  final_seq?: unknown;
  components?: unknown;
  attachment_ids?: unknown;
}): Promise<Response> {
  if (
    typeof body.channel_id !== "string" ||
    typeof body.message_id !== "string" ||
    typeof body.bot_id !== "string" ||
    typeof body.resolved_text !== "string" ||
    typeof body.finalize_request_hash !== "string" ||
    typeof body.final_seq !== "number"
  ) {
    return new Response("invalid payload", { status: 400 });
  }

  const writable = assertWritableChannel(host);
  if (writable) return writable;

  const registry = loadRegistryRow(host, body.channel_id, body.message_id);
  if (!registry) return registryNotFoundError();
  if (registry.bot_id !== body.bot_id) return registryNotFoundError();

  const components = Array.isArray(body.components) ? body.components : [];
  const attachmentIds = Array.isArray(body.attachment_ids)
    ? body.attachment_ids.filter((id): id is string => typeof id === "string")
    : [];
  if (attachmentIds.length > 0) {
    return doErrorResponse("BOT_EFFECT_INVALID", "attachment_ids not supported yet", { httpStatus: 422 });
  }

  const expectedHash = await computeFinalizeRequestHash({
    final_seq: body.final_seq,
    resolved_text: body.resolved_text,
    components,
    attachment_ids: attachmentIds,
  });
  if (expectedHash !== body.finalize_request_hash) {
    return doErrorResponse("BOT_EFFECT_INVALID", "finalize_request_hash mismatch", { httpStatus: 422 });
  }

  if (registry.status === "finalized") {
    if (registry.finalize_request_hash === body.finalize_request_hash && registry.finalized_response_json) {
      return Response.json(JSON.parse(registry.finalized_response_json));
    }
    return registryConflictError("stream already finalized with different request");
  }
  if (registry.status === "abandoned" || registry.status === "expired") {
    return registryExpiredError();
  }
  if (registry.status !== "streaming") return registryNotFoundError();
  if (isStreamRegistryExpired(registry.expires_at)) {
    return registryExpiredError();
  }

  const meta = channelMeta(host)!;
  const now = host.nowIso();
  const eventId = host.nextEventId(Date.parse(now));
  const finalTextHash = await computeTextHash(body.resolved_text);
  const componentsJson = JSON.stringify(components);
  const messageRow = buildBotMessageRow({
    registry,
    text: body.resolved_text,
    streamState: "final",
    status: "normal",
    finalizedAt: now,
    componentsJson,
  });
  const response: StreamFinalizeResponse = { message_id: registry.message_id, event_id: eventId };
  const responseJson = JSON.stringify(response);

  type FinalizeResult = { kind: "ok"; responseJson: string } | { kind: "conflict" } | { kind: "expired" };

  const txResult = await host.ctx.storage.transaction(async (): Promise<FinalizeResult> => {
    const fresh = loadRegistryRow(host, body.channel_id as string, body.message_id as string);
    if (!fresh) return { kind: "expired" };
    if (fresh.status === "finalized") {
      if (fresh.finalize_request_hash === body.finalize_request_hash && fresh.finalized_response_json) {
        return { kind: "ok", responseJson: fresh.finalized_response_json };
      }
      return { kind: "conflict" };
    }
    if (fresh.status !== "streaming") return { kind: "expired" };

    host.ctx.storage.sql.exec(
      `INSERT INTO messages (
        message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
        sender_bot_id, sender_bot_display_name, sender_bot_avatar_url,
        type, format, status, text, reply_to, reply_snapshot_json, components_json,
        stream_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'bot', NULL, ?, ?, ?, ?, ?, 'normal', ?, ?, NULL, ?, 'final', ?, ?)`,
      messageRow.message_id,
      messageRow.command_id,
      botDedupePrincipalKey(body.bot_id as string),
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

    insertStreamCanonicalEvent(host, {
      eventId,
      eventType: "message.stream_finalized",
      channelId: body.channel_id as string,
      botId: body.bot_id as string,
      occurredAt: now,
      messageRow,
      components,
      membershipVersion: meta.membership_version,
    });

    host.ctx.storage.sql.exec(
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
      body.finalize_request_hash,
      responseJson,
      body.channel_id,
      body.message_id,
    );

    appendChatChannelArchive(host.ctx, body.channel_id as string, now, [eventId], () => {
      const rv = rvEvent(eventId);
      return collectDefinedChanges([
        upsertMessageChange(host.ctx.storage.sql, messageRow.message_id, messageRow.channel_id, rv),
        upsertEventChange(host.ctx.storage.sql, eventId),
      ]);
    });

    return { kind: "ok", responseJson };
  });

  if (txResult.kind === "conflict") return registryConflictError("stream already finalized with different request");
  if (txResult.kind === "expired") return registryExpiredError();

  await host.scheduleOutboxAlarm(now);
  await host.scheduleArchiveAlarm(now);
  return Response.json(JSON.parse(txResult.responseJson));
}

export async function handleStreamAbandon(host: ChatChannelHost, body: {
  channel_id?: unknown;
  message_id?: unknown;
  bot_id?: unknown;
  resolved_partial?: unknown;
  abandoned_text_hash?: unknown;
}): Promise<Response> {
  if (
    typeof body.channel_id !== "string" ||
    typeof body.message_id !== "string" ||
    typeof body.bot_id !== "string" ||
    typeof body.resolved_partial !== "string" ||
    typeof body.abandoned_text_hash !== "string"
  ) {
    return new Response("invalid payload", { status: 400 });
  }

  const registry = loadRegistryRow(host, body.channel_id, body.message_id);
  if (!registry) return registryNotFoundError();
  if (registry.bot_id !== body.bot_id) return registryNotFoundError();

  const expectedHash = await computeAbandonedTextHash(body.resolved_partial);
  if (expectedHash !== body.abandoned_text_hash) {
    return doErrorResponse("BOT_EFFECT_INVALID", "abandoned_text_hash mismatch", { httpStatus: 422 });
  }

  if (registry.status === "finalized") {
    return registryConflictError("stream already finalized");
  }

  if (registry.status === "abandoned") {
    if (body.resolved_partial.length === 0) {
      return Response.json({ ok: true, canonical: false });
    }
    if (registry.abandoned_text_hash === body.abandoned_text_hash && registry.abandoned_response_json) {
      return Response.json(JSON.parse(registry.abandoned_response_json));
    }
    if (registry.abandoned_text_hash && registry.abandoned_text_hash !== body.abandoned_text_hash) {
      return registryConflictError("stream already abandoned with different partial");
    }
    return Response.json({ ok: true, canonical: false });
  }

  if (registry.status === "expired") {
    return registryExpiredError();
  }

  const now = host.nowIso();

  if (body.resolved_partial.length === 0) {
    await host.ctx.storage.transaction(async () => {
      host.ctx.storage.sql.exec(
        `UPDATE message_stream_registry SET status='abandoned', abandoned_at=? WHERE channel_id=? AND message_id=?`,
        now,
        body.channel_id,
        body.message_id,
      );
    });
    return Response.json({ ok: true, canonical: false });
  }

  const meta = channelMeta(host);
  if (!meta) return doErrorResponse("CHANNEL_NOT_FOUND", "channel not created", { httpStatus: 404 });

  const eventId = host.nextEventId(Date.parse(now));
  const messageRow = buildBotMessageRow({
    registry,
    text: body.resolved_partial,
    streamState: "abandoned",
    status: "failed",
    finalizedAt: now,
    componentsJson: "[]",
  });
  const response: StreamAbandonResponse = { message_id: registry.message_id, event_id: eventId };
  const responseJson = JSON.stringify(response);

  type AbandonResult = { kind: "ok"; responseJson: string } | { kind: "conflict" };

  const txResult = await host.ctx.storage.transaction(async (): Promise<AbandonResult> => {
    const fresh = loadRegistryRow(host, body.channel_id as string, body.message_id as string);
    if (!fresh) return { kind: "conflict" };
    if (fresh.status === "finalized") return { kind: "conflict" };
    if (fresh.status === "abandoned") {
      if (fresh.abandoned_text_hash === body.abandoned_text_hash && fresh.abandoned_response_json) {
        return { kind: "ok", responseJson: fresh.abandoned_response_json };
      }
      return { kind: "conflict" };
    }

    host.ctx.storage.sql.exec(
      `INSERT INTO messages (
        message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
        sender_bot_id, sender_bot_display_name, sender_bot_avatar_url,
        type, format, status, text, reply_to, reply_snapshot_json, components_json,
        stream_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'bot', NULL, ?, ?, ?, ?, ?, 'failed', ?, ?, NULL, '[]', 'abandoned', ?, ?)`,
      messageRow.message_id,
      messageRow.command_id,
      botDedupePrincipalKey(body.bot_id as string),
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

    insertStreamCanonicalEvent(host, {
      eventId,
      eventType: "message.stream_abandoned",
      channelId: body.channel_id as string,
      botId: body.bot_id as string,
      occurredAt: now,
      messageRow,
      components: [],
      membershipVersion: meta.membership_version,
    });

    host.ctx.storage.sql.exec(
      `UPDATE message_stream_registry SET
        status='abandoned',
        abandoned_at=?,
        abandoned_event_id=?,
        abandoned_text_hash=?,
        abandoned_response_json=?
       WHERE channel_id=? AND message_id=?`,
      now,
      eventId,
      body.abandoned_text_hash,
      responseJson,
      body.channel_id,
      body.message_id,
    );

    appendChatChannelArchive(host.ctx, body.channel_id as string, now, [eventId], () => {
      const rv = rvEvent(eventId);
      return collectDefinedChanges([
        upsertMessageChange(host.ctx.storage.sql, messageRow.message_id, messageRow.channel_id, rv),
        upsertEventChange(host.ctx.storage.sql, eventId),
      ]);
    });

    return { kind: "ok", responseJson };
  });

  if (txResult.kind === "conflict") {
    return registryConflictError("stream abandon conflict");
  }

  await host.scheduleOutboxAlarm(now);
  await host.scheduleArchiveAlarm(now);
  return Response.json(JSON.parse(txResult.responseJson));
}

export function registryStatusForTest(host: ChatChannelHost, channelId: string, messageId: string): StreamRegistryStatus | null {
  const row = loadRegistryRow(host, channelId, messageId);
  if (!row) return null;
  return row.status as StreamRegistryStatus;
}
