import { uuidv7 } from "../../../ids/uuidv7";
import { dedupePrincipalKeyForUser } from "../../../chat/command";
import { disableComponentsInJson, parseStoredComponents } from "../../../chat/bot-effects";
import {
  ACTIVE_INTERACTION_STATUSES,
  checkTargetedPolicy,
  disabledComponentSubmitError,
  findMessageComponentIncludingDisabled,
  policyBlocksExclusive,
  policyBlocksPerUserOnce,
  resolveInteractionPolicy,
  validateInteractionValue,
} from "../../../chat/interaction-policy";
import { buildEventFrame, buildMessageLifecyclePayload } from "../../../chat/event-broadcast";
import {
  buildInteractionCreatedPersistedPayload,
  projectInteractionCreatedWirePayload,
  resolveComponentLabelFromJson,
} from "../../../chat/bot-lifecycle-events";
import { projectMessageForBrowser } from "../../../chat/message-projection";
import { fallbackUserDisplayName } from "../../../contract/primitives";
import type { MessageRow } from "../../../contract/persisted";
import type { BotEffectMessageContextRow } from "../../../chat/bot-effects";
import type { InteractionSubmitResponse } from "../../../contract/bot-api";
import { parseRpcCachedJson } from "../../shared/do-rpc";
import {
  checkUserIdempotencyInTxn,
  readUserCompletedIdempotency,
  writeUserCompletedIdempotency,
} from "../data/idempotency";
import { ApiError } from "../../../errors";
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
import type { InteractionSubmitRpcInput } from "../../../contract/chat-channel-rpc";

function throwInteractionError(code: string, message: string): never {
  throw new ApiError(code, message, {
    retryable: code === "BOT_OFFLINE",
    httpStatus: code === "BOT_OFFLINE" ? 503 : undefined,
  });
}

function resolveComponentForSubmit(
  channel: ChatChannelHandlerRef,
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
    && countActiveInteractions(channel, { messageId: input.messageId, componentId: input.componentId }) > 0;
  const disabledError = disabledComponentSubmitError(lookup.component, exclusiveUsed);
  return { ok: false, code: disabledError.code, message: disabledError.message };
}

function countActiveInteractions(
  channel: ChatChannelHandlerRef,
  filter: { messageId: string; componentId: string; actorUserId?: string },
): number {
  if (filter.actorUserId) {
    const row = channel.ctx.storage.sql
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
  const row = channel.ctx.storage.sql
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
  channel: ChatChannelHandlerRef,
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
  channel.ctx.storage.sql.exec(
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
  const eventId = channel.nextEventId(input.nowMs);
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
  channel.ctx.storage.sql.exec(
    "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'message.updated', ?, 'system', NULL, ?, ?, ?)",
    eventId,
    input.channelId,
    JSON.stringify(persistedPayload),
    input.membershipVersion,
    input.now,
  );
  channel.insertOutboxRowForFanout(
    input.channelId,
    eventId,
    JSON.stringify(liveEventFrame),
    input.membershipVersion,
    input.now,
  );
  return eventId;
}

export function InteractionSubmitMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async submitInteraction(input: InteractionSubmitRpcInput): Promise<InteractionSubmitResponse> {
  const userId = input.user_id;
  const operation = "interaction.submit";
  const operationId = input.operation_id;
  const channelId = input.channel_id;
  const messageId = input.message_id;
  const componentId = input.component_id;
  const customId = input.custom_id;
  const value = input.value;
  const now = this.nowIso();
  const nowMs = Date.parse(now);
  const requestHash = JSON.stringify({
    channel_id: channelId,
    message_id: messageId,
    component_id: componentId,
    custom_id: customId,
    value,
  });

  const cachedJson = readUserCompletedIdempotency(
    this.ctx.storage.sql,
    userId,
    operation,
    operationId,
    requestHash,
  );
  if (cachedJson) {
    return parseRpcCachedJson<InteractionSubmitResponse>(cachedJson);
  }

  const meta = this.repo.channelMetaCommand(channelId);
  if (!meta) throwInteractionError("CHANNEL_NOT_FOUND", "channel not found");
  if (meta.kind === "dm") {
    throwInteractionError("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels");
  }
  if (meta.status === "dissolved") {
    throwInteractionError("CHANNEL_DISSOLVED", "channel is dissolved");
  }

  const callerRole = this.activeRole(channelId, userId);
  if (!callerRole) throwInteractionError("FORBIDDEN", "not a channel member");

  const messageRow = this.ctx.storage.sql
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
  if (!messageRow) throwInteractionError("MESSAGE_NOT_FOUND", "message not found");
  if (messageRow.sender_kind !== "bot" || !messageRow.sender_bot_id) {
    throwInteractionError("INVALID_MESSAGE", "message is not from a bot");
  }
  if (messageRow.status === "deleted" || messageRow.status === "recalled") {
    throwInteractionError("MESSAGE_NOT_FOUND", "message not found");
  }

  const componentLookup = resolveComponentForSubmit(asHandlerRef(this), {
    componentsJson: messageRow.components_json ?? "[]",
    componentId,
    customId,
    messageId,
  });
  if (!componentLookup.ok) {
    throwInteractionError(componentLookup.code, componentLookup.message);
  }

  const valueCheck = validateInteractionValue(componentLookup.component, value);
  if (!valueCheck.ok) {
    throwInteractionError(valueCheck.code, valueCheck.message);
  }

  const targetedCheck = checkTargetedPolicy(componentLookup.component, userId);
  if (!targetedCheck.ok) {
    throwInteractionError(targetedCheck.code, targetedCheck.message);
  }

  const botId = messageRow.sender_bot_id;
  const connectionState = await this.env.BOT_CONNECTION.getByName(botId)
    .getConnectionState()
    .catch(() => ({ status: "disconnected" as const, session_id: null }));
  if (connectionState.status !== "connected") {
    throwInteractionError("BOT_OFFLINE", "The bot is currently offline.");
  }

  const actorMap = await this.resolveActorMap([userId]);
  const actor = actorMap.get(userId) ?? {
    user_id: userId,
    display_name: fallbackUserDisplayName(userId),
    avatar_url: null,
  };

  const dedupePrincipalKey = dedupePrincipalKeyForUser(userId);
  const policy = resolveInteractionPolicy(componentLookup.component);

  type TxResult =
    | { kind: "ok"; responseJson: string }
    | { kind: "cached"; responseJson: string }
    | { kind: "conflict" }
    | { kind: "error"; j: string };

  const txResult = this.ctx.storage.transactionSync((): TxResult => {
    const idem = checkUserIdempotencyInTxn(
      this.ctx.storage.sql,
      userId,
      operation,
      operationId,
      requestHash,
    );
    if (idem.kind === "conflict") return { kind: "conflict" };
    if (idem.kind === "cached") return { kind: "cached", responseJson: idem.responseJson };

    const currentMeta = this.ctx.storage.sql
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

    const currentMessage = this.ctx.storage.sql
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

    const currentLookup = resolveComponentForSubmit(asHandlerRef(this), {
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
        countActiveInteractions(asHandlerRef(this), { messageId, componentId, actorUserId: userId }),
      );
      if (!perUserGate.ok) {
        return {
          kind: "error",
          j: JSON.stringify({ error: { code: perUserGate.code, message: perUserGate.message } }),
        };
      }
    } else if (policy === "exclusive") {
      const exclusiveGate = policyBlocksExclusive(
        countActiveInteractions(asHandlerRef(this), { messageId, componentId }),
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
      this.ctx.storage.sql.exec(
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
      const lockEventId = emitExclusiveComponentLock(asHandlerRef(this), {
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

    const eventId = this.nextEventId(nowMs + nextEventOffset);
    const persistedPayload = buildInteractionCreatedPersistedPayload({
      interactionId,
      createdAt: now,
      commandId: operationId,
      actorUserId: userId,
      messageId,
      componentId,
    });
    this.ctx.storage.sql.exec(
      "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'interaction.created', ?, 'user', ?, ?, ?, ?)",
      eventId,
      channelId,
      userId,
      JSON.stringify(persistedPayload),
      currentMeta.membership_version,
      now,
    );
    const componentLabel = resolveComponentLabelFromJson(
      currentMessage.components_json ?? "[]",
      componentId,
    );
    const liveEventFrame = buildEventFrame({
      event_id: eventId,
      type: "interaction.created",
      channel_id: channelId,
      occurred_at: now,
      payload: projectInteractionCreatedWirePayload(persistedPayload, actor, componentLabel),
    });
    this.insertOutboxRowForFanout(
      channelId,
      eventId,
      JSON.stringify(liveEventFrame),
      currentMeta.membership_version,
      now,
    );
    archiveEventIds.push(eventId);

    const outboxId = `bot_delivery:${channelId}:${interactionId}`;
    this.ctx.storage.sql.exec(
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
    writeUserCompletedIdempotency(this.ctx.storage.sql, {
      userId,
      operation,
      operationId,
      requestHash,
      responseJson: JSON.stringify(responseBody),
      nowIso: now,
    });

    appendChatChannelArchive(this.ctx, channelId, now, archiveEventIds, () =>
      collectDefinedChanges([
        ...archiveEventIds.map((id) => upsertEventChange(this.ctx.storage.sql, id)),
        ...(policy === "exclusive"
          ? [upsertMessageChange(this.ctx.storage.sql, messageId, channelId, rvEvent(archiveEventIds[0]!))]
          : []),
      ]),
    );

    return { kind: "ok", responseJson: JSON.stringify(responseBody) };
  });

  if (txResult.kind === "conflict") {
    throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body", { retryable: false });
  }
  if (txResult.kind === "cached") {
    return parseRpcCachedJson<InteractionSubmitResponse>(txResult.responseJson);
  }
  if (txResult.kind === "error") {
    return parseRpcCachedJson<InteractionSubmitResponse>(txResult.j);
  }
  await this.scheduleArchiveAlarm(now);
  return parseRpcCachedJson<InteractionSubmitResponse>(txResult.responseJson);
    }
  };
}
