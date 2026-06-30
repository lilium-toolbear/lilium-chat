import { uuidv7 } from "../../ids/uuidv7";
import { dedupePrincipalKeyForUser } from "../../chat/command";
import { disableComponentsInJson, parseStoredComponents } from "../../chat/bot-effects";
import {
  ACTIVE_INTERACTION_STATUSES,
  checkTargetedPolicy,
  disabledComponentSubmitError,
  findMessageComponentIncludingDisabled,
  policyBlocksExclusive,
  policyBlocksPerUserOnce,
  resolveInteractionPolicy,
  validateInteractionValue,
} from "../../chat/interaction-policy";
import { buildEventFrame, buildMessageLifecyclePayload } from "../../chat/event-broadcast";
import { projectMessageForBrowser } from "../../chat/message-projection";
import { idempotencyExpiresAt } from "../../contract/idempotency";
import { fallbackUserDisplayName } from "../../contract/primitives";
import type { MessageRow } from "../../contract/persisted";
import type { BotEffectMessageContextRow } from "../../chat/bot-effects";
import { HTTP_STATUS_BY_CODE } from "../../errors";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  rvEvent,
  upsertEventChange,
  upsertMessageChange,
} from "../../archive/chat-channel-record";
import type { ChatChannelHost } from "./host";

interface InteractionSubmitBody {
  operation_id?: unknown;
  channel_id?: unknown;
  message_id?: unknown;
  component_id?: unknown;
  custom_id?: unknown;
  value?: unknown;
}

type TxResult =
  | { kind: "ok"; responseJson: string }
  | { kind: "cached"; responseJson: string }
  | { kind: "conflict" }
  | { kind: "error"; j: string };

function interactionErrorResponse(code: string, message: string): Response {
  return Response.json(
    { error: { code, message, retryable: code === "BOT_OFFLINE" } },
    { status: HTTP_STATUS_BY_CODE[code] ?? 500 },
  );
}

function resolveComponentForSubmit(
  host: ChatChannelHost,
  input: {
    componentsJson: string;
    componentId: string;
    customId: string;
    messageId: string;
  },
): ReturnType<typeof findMessageComponentIncludingDisabled> {
  const lookup = findMessageComponentIncludingDisabled(
    input.componentsJson,
    input.componentId,
    input.customId,
  );
  if (!lookup.ok) return lookup;
  if (!lookup.component.disabled) return lookup;

  const policy = resolveInteractionPolicy(lookup.component);
  const exclusiveUsed = policy === "exclusive"
    && countActiveInteractions(host, { messageId: input.messageId, componentId: input.componentId }) > 0;
  const disabledError = disabledComponentSubmitError(lookup.component, exclusiveUsed);
  return { ok: false, code: disabledError.code, message: disabledError.message };
}

function countActiveInteractions(
  host: ChatChannelHost,
  filter: { messageId: string; componentId: string; actorUserId?: string },
): number {
  if (filter.actorUserId) {
    const row = host.ctx.storage.sql
      .exec(
        `SELECT COUNT(*) AS c FROM interactions
         WHERE message_id=? AND component_id=? AND actor_user_id=?
           AND status IN (${ACTIVE_INTERACTION_STATUSES.map(() => "?").join(", ")})`,
        filter.messageId,
        filter.componentId,
        filter.actorUserId,
        ...ACTIVE_INTERACTION_STATUSES,
      )
      .toArray()[0] as { c: number } | undefined;
    return row?.c ?? 0;
  }
  const row = host.ctx.storage.sql
    .exec(
      `SELECT COUNT(*) AS c FROM interactions
       WHERE message_id=? AND component_id=?
         AND status IN (${ACTIVE_INTERACTION_STATUSES.map(() => "?").join(", ")})`,
      filter.messageId,
      filter.componentId,
      ...ACTIVE_INTERACTION_STATUSES,
    )
    .toArray()[0] as { c: number } | undefined;
  return row?.c ?? 0;
}

function emitExclusiveComponentLock(
  host: ChatChannelHost,
  input: {
    channelId: string;
    messageId: string;
    messageRow: BotEffectMessageContextRow;
    componentsJson: string;
    now: string;
    nowMs: number;
    membershipVersion: number;
  },
): string {
  host.ctx.storage.sql.exec(
    "UPDATE messages SET components_json=?, updated_at=? WHERE message_id=? AND channel_id=?",
    input.componentsJson,
    input.now,
    input.messageId,
    input.channelId,
  );

  const updatedRow: BotEffectMessageContextRow = {
    ...input.messageRow,
    updated_at: input.now,
  };
  const eventId = host.nextEventId(input.nowMs);
  const liveMessage = projectMessageForBrowser(updatedRow, {
    components: parseStoredComponents(input.componentsJson),
  });
  const liveEventFrame = buildEventFrame({
    event_id: eventId,
    type: "message.updated",
    channel_id: input.channelId,
    occurred_at: input.now,
    payload: { message: liveMessage },
  });
  const persistedPayload = buildMessageLifecyclePayload({
    message_id: updatedRow.message_id,
    command_id: updatedRow.command_id,
    channel_id: updatedRow.channel_id,
    sender_kind: updatedRow.sender_kind,
    sender_user_id: updatedRow.sender_user_id,
    sender_bot_id: updatedRow.sender_bot_id,
    status: updatedRow.status,
    created_at: updatedRow.created_at,
    updated_at: updatedRow.updated_at,
    edited_at: updatedRow.edited_at,
    deleted_at: updatedRow.deleted_at,
    deleted_by: updatedRow.deleted_by,
    recalled_at: updatedRow.recalled_at,
    stream_state: updatedRow.stream_state,
    reply_to: updatedRow.reply_to,
    reply_snapshot_json: updatedRow.reply_snapshot_json,
    type: updatedRow.type,
    format: updatedRow.format,
    text: updatedRow.text,
    invocation_json: updatedRow.invocation_json,
  });
  host.ctx.storage.sql.exec(
    "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'message.updated', ?, 'system', NULL, ?, ?, ?)",
    eventId,
    input.channelId,
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
  return eventId;
}

export async function handleInteractionSubmitRequest(
  host: ChatChannelHost,
  request: Request,
): Promise<Response> {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  if (!userId) return interactionErrorResponse("UNAUTHORIZED", "missing verified user");

  const body = (await request.json().catch(() => null)) as InteractionSubmitBody | null;
  if (
    !body ||
    typeof body.operation_id !== "string" ||
    typeof body.channel_id !== "string" ||
    typeof body.message_id !== "string" ||
    typeof body.component_id !== "string" ||
    typeof body.custom_id !== "string" ||
    !("value" in body)
  ) {
    return interactionErrorResponse("INVALID_MESSAGE", "invalid interaction.submit payload");
  }

  const operation = "interaction.submit";
  const operationId = body.operation_id;
  const channelId = body.channel_id;
  const messageId = body.message_id;
  const componentId = body.component_id;
  const customId = body.custom_id;
  const value = body.value;
  const now = host.nowIso();
  const nowMs = Date.parse(now);
  const idemExpiresAt = idempotencyExpiresAt(nowMs);
  const requestHash = JSON.stringify({
    channel_id: channelId,
    message_id: messageId,
    component_id: componentId,
    custom_id: customId,
    value,
  });

  const preCheck = host.ctx.storage.sql
    .exec(
      "SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
      userId,
      operation,
      operationId,
      requestHash,
    )
    .toArray()[0] as { response_json: string } | undefined;
  if (preCheck) return host.cachedResponse(preCheck.response_json);

  const meta = host.ctx.storage.sql
    .exec(
      "SELECT kind, status, membership_version FROM channel_meta WHERE channel_id=?",
      channelId,
    )
    .toArray()[0] as { kind: string; status: string; membership_version: number } | undefined;
  if (!meta) return interactionErrorResponse("CHANNEL_NOT_FOUND", "channel not found");
  if (meta.kind === "dm") {
    return interactionErrorResponse("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels");
  }
  if (meta.status === "dissolved") {
    return interactionErrorResponse("CHANNEL_DISSOLVED", "channel is dissolved");
  }

  const callerRole = host.activeRole(channelId, userId);
  if (!callerRole) return interactionErrorResponse("FORBIDDEN", "not a channel member");

  const messageRow = host.ctx.storage.sql
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
  if (!messageRow) return interactionErrorResponse("MESSAGE_NOT_FOUND", "message not found");
  if (messageRow.sender_kind !== "bot" || !messageRow.sender_bot_id) {
    return interactionErrorResponse("INVALID_MESSAGE", "message is not from a bot");
  }
  if (messageRow.status === "deleted" || messageRow.status === "recalled") {
    return interactionErrorResponse("MESSAGE_NOT_FOUND", "message not found");
  }

  const componentLookup = resolveComponentForSubmit(host, {
    componentsJson: messageRow.components_json ?? "[]",
    componentId,
    customId,
    messageId,
  });
  if (!componentLookup.ok) {
    return interactionErrorResponse(componentLookup.code, componentLookup.message);
  }

  const valueCheck = validateInteractionValue(componentLookup.component, value);
  if (!valueCheck.ok) {
    return interactionErrorResponse(valueCheck.code, valueCheck.message);
  }

  const targetedCheck = checkTargetedPolicy(componentLookup.component, userId);
  if (!targetedCheck.ok) {
    return interactionErrorResponse(targetedCheck.code, targetedCheck.message);
  }

  const botId = messageRow.sender_bot_id;
  const connectionRes = await host.env.BOT_CONNECTION.getByName(botId).fetch(
    new Request("https://x/internal/connection-state"),
  );
  const connectionState = connectionRes.ok
    ? (await connectionRes.json()) as { status?: string }
    : { status: "disconnected" };
  if (connectionState.status !== "connected") {
    return Response.json(
      {
        error: {
          code: "BOT_OFFLINE",
          message: "The bot is currently offline.",
          retryable: true,
        },
      },
      { status: HTTP_STATUS_BY_CODE.BOT_OFFLINE ?? 503 },
    );
  }

  const actorMap = await host.resolveActorMap([userId]);
  const actor = actorMap.get(userId) ?? {
    user_id: userId,
    display_name: fallbackUserDisplayName(userId),
    avatar_url: null,
  };

  const dedupePrincipalKey = dedupePrincipalKeyForUser(userId);
  const policy = resolveInteractionPolicy(componentLookup.component);

  const txResult = host.ctx.storage.transactionSync((): TxResult => {
    const idem = host.ctx.storage.sql
      .exec(
        "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=?",
        userId,
        operation,
        operationId,
      )
      .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
    if (idem) {
      if (idem.request_hash !== requestHash) return { kind: "conflict" };
      return { kind: "cached", responseJson: idem.response_json ?? "{}" };
    }

    const currentMeta = host.ctx.storage.sql
      .exec(
        "SELECT status, membership_version FROM channel_meta WHERE channel_id=?",
        channelId,
      )
      .toArray()[0] as { status: string; membership_version: number } | undefined;
    if (!currentMeta) {
      return {
        kind: "error",
        j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found" } }),
      };
    }
    if (currentMeta.status === "dissolved") {
      return {
        kind: "error",
        j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" } }),
      };
    }

    const currentMessage = host.ctx.storage.sql
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
    if (!currentMessage || currentMessage.sender_kind !== "bot") {
      return {
        kind: "error",
        j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "message is not from a bot" } }),
      };
    }

    const currentLookup = resolveComponentForSubmit(host, {
      componentsJson: currentMessage.components_json ?? "[]",
      componentId,
      customId,
      messageId,
    });
    if (!currentLookup.ok) {
      return {
        kind: "error",
        j: JSON.stringify({ error: { code: currentLookup.code, message: currentLookup.message } }),
      };
    }

    const currentTargeted = checkTargetedPolicy(currentLookup.component, userId);
    if (!currentTargeted.ok) {
      return {
        kind: "error",
        j: JSON.stringify({ error: { code: currentTargeted.code, message: currentTargeted.message } }),
      };
    }

    if (policy === "per_user_once") {
      const perUserGate = policyBlocksPerUserOnce(
        countActiveInteractions(host, { messageId, componentId, actorUserId: userId }),
      );
      if (!perUserGate.ok) {
        return {
          kind: "error",
          j: JSON.stringify({ error: { code: perUserGate.code, message: perUserGate.message } }),
        };
      }
    } else if (policy === "exclusive") {
      const exclusiveGate = policyBlocksExclusive(
        countActiveInteractions(host, { messageId, componentId }),
      );
      if (!exclusiveGate.ok) {
        return {
          kind: "error",
          j: JSON.stringify({ error: { code: exclusiveGate.code, message: exclusiveGate.message } }),
        };
      }
    }

    const interactionId = uuidv7(nowMs);
    try {
      host.ctx.storage.sql.exec(
        `INSERT INTO interactions (
           interaction_id, message_id, component_id, custom_id, actor_user_id, dedupe_principal_key,
           command_id, value_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        interactionId,
        messageId,
        componentId,
        customId,
        userId,
        dedupePrincipalKey,
        operationId,
        JSON.stringify(value),
        now,
        now,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint failed")) {
        if (policy === "per_user_once") {
          return {
            kind: "error",
            j: JSON.stringify({
              error: {
                code: "INTERACTION_ALREADY_SUBMITTED",
                message: "You have already submitted this interaction.",
              },
            }),
          };
        }
        if (policy === "exclusive") {
          return {
            kind: "error",
            j: JSON.stringify({
              error: {
                code: "COMPONENT_ALREADY_USED",
                message: "This component has already been used.",
              },
            }),
          };
        }
        return { kind: "conflict" };
      }
      throw err;
    }

    const archiveEventIds: string[] = [];
    let nextEventOffset = 1;

    if (policy === "exclusive") {
      const lockedComponentsJson = disableComponentsInJson(
        currentMessage.components_json ?? "[]",
        [componentId],
      );
      const lockEventId = emitExclusiveComponentLock(host, {
        channelId,
        messageId,
        messageRow: currentMessage,
        componentsJson: lockedComponentsJson,
        now,
        nowMs: nowMs + nextEventOffset,
        membershipVersion: currentMeta.membership_version,
      });
      archiveEventIds.push(lockEventId);
      nextEventOffset += 1;
    }

    const eventId = host.nextEventId(nowMs + nextEventOffset);
    const persistedPayload = {
      interaction: { interaction_id: interactionId, status: "pending", created_at: now },
    };
    host.ctx.storage.sql.exec(
      "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'interaction.created', ?, 'user', ?, ?, ?, ?)",
      eventId,
      channelId,
      userId,
      JSON.stringify(persistedPayload),
      currentMeta.membership_version,
      now,
    );
    const liveEventFrame = buildEventFrame({
      event_id: eventId,
      type: "interaction.created",
      channel_id: channelId,
      occurred_at: now,
      payload: persistedPayload,
    });
    host.insertOutboxRowForFanout(
      channelId,
      eventId,
      JSON.stringify(liveEventFrame),
      currentMeta.membership_version,
      now,
    );
    archiveEventIds.push(eventId);

    const outboxId = `bot_delivery:${channelId}:${interactionId}`;
    host.ctx.storage.sql.exec(
      `INSERT INTO bot_delivery_outbox (
         outbox_id, channel_id, bot_id, kind, invocation_id, interaction_id, event_id, request_json,
         status, attempts, max_attempts, last_error, failed_at, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'message_interaction', NULL, ?, ?, ?, 'pending', 0, 5, NULL, NULL, ?, ?, ?)`,
      outboxId,
      channelId,
      botId,
      interactionId,
      eventId,
      JSON.stringify({
        interaction_id: interactionId,
        message_id: messageId,
        component: {
          component_id: componentId,
          custom_id: customId,
          value,
        },
        actor,
      }),
      now,
      now,
      now,
    );

    const responseBody = {
      channel_id: channelId,
      interaction_id: interactionId,
      event_id: eventId,
    };
    host.ctx.storage.sql.exec(
      "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, ?, ?, ?, ?, 'completed', ?, ?)",
      userId,
      operation,
      operationId,
      requestHash,
      JSON.stringify(responseBody),
      now,
      idemExpiresAt,
    );

    appendChatChannelArchive(host.ctx, channelId, now, archiveEventIds, () =>
      collectDefinedChanges([
        ...archiveEventIds.map((id) => upsertEventChange(host.ctx.storage.sql, id)),
        ...(policy === "exclusive"
          ? [upsertMessageChange(host.ctx.storage.sql, messageId, channelId, rvEvent(archiveEventIds[0]!))]
          : []),
      ]),
    );

    return { kind: "ok", responseJson: JSON.stringify(responseBody) };
  });

  if (txResult.kind === "conflict") {
    return Response.json(
      { error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } },
      { status: 409 },
    );
  }
  if (txResult.kind === "cached") {
    return host.cachedResponse(txResult.responseJson);
  }
  if (txResult.kind === "error") {
    return host.cachedResponse(txResult.j);
  }
  await host.scheduleArchiveAlarm(now);
  return Response.json(JSON.parse(txResult.responseJson));
}
