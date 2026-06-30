import {
  buildEventFrame,
  buildMessageLifecyclePayload,
} from "../../../chat/event-broadcast";
import { projectMessageForBrowser } from "../../../chat/message-projection";
import type { MessageRow } from "../../../contract/persisted";
import type { MessageMutationAckPayload } from "../../../contract/idempotency";
import { ApiError } from "../../../errors";
import { parseMessageMutationAckFromCached, parseRpcCachedJson } from "../../shared/do-rpc";
import {
  checkUserIdempotencyInTxn,
  readUserCompletedIdempotency,
  writeUserCompletedIdempotency,
} from "../data/idempotency";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  replaceScopeMentionsChange,
  rvEvent,
  upsertAuditLogChange,
  upsertEventChange,
  upsertMessageChange,
  upsertMessageEditChange,
} from "../../../archive/chat-channel-record";
import type { MessageMutateRpcInput } from "../../../contract/chat-channel-rpc";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";
import { asHandlerRef, type ChatChannelHandlerRef } from "../handler-ref";

export async function applyMessageMutation(
  channel: ChatChannelHandlerRef,
  input: {
    userId: string;
    operationId: string;
    channelId: string;
    messageId: string;
    operation: "message.edit" | "message.recall" | "message.delete";
    requestHash: string;
    reason: string | null;
    mutate: (row: MessageRow) => {
      eventType: "message.updated" | "message.recalled" | "message.deleted";
      fields: Partial<MessageRow>;
    };
  },
): Promise<MessageMutationAckPayload> {
  const now = channel.nowIso();
  const nowMs = Date.parse(now);

  const preCheckJson = readUserCompletedIdempotency(
    channel.ctx.storage.sql,
    input.userId,
    input.operation,
    input.operationId,
    input.requestHash,
  );
  if (preCheckJson) {
    return parseMessageMutationAckFromCached(preCheckJson);
  }

  const preflight = channel.repo.messageSenderUserId(input.messageId, input.channelId);
  const preflightActorIds = new Set<string>([input.userId]);
  if (preflight?.sender_user_id) preflightActorIds.add(preflight.sender_user_id);
  const actorMap = await channel.resolveActorMap(Array.from(preflightActorIds));

  type TxResult =
    | { kind: "conflict" }
    | { kind: "cached"; responseJson: string }
    | { kind: "error"; j: string }
    | { kind: "ok"; responseJson: string };

  const txResult = await channel.ctx.storage.transaction(async (): Promise<TxResult> => {
    const statusRow = channel.repo.channelMetaStatus(input.channelId);
    if (!statusRow) return { kind: "error", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
    if (statusRow.status === "dissolved") return {
      kind: "error",
      j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }),
    };

    const idemCheck = checkUserIdempotencyInTxn(
      channel.ctx.storage.sql,
      input.userId,
      input.operation,
      input.operationId,
      input.requestHash,
    );
    if (idemCheck.kind === "conflict") return { kind: "conflict" };
    if (idemCheck.kind === "cached") return { kind: "cached", responseJson: idemCheck.responseJson };

    const row = channel.repo.messageLifecycle(input.messageId, input.channelId);
    if (!row) return { kind: "error", j: JSON.stringify({ error: { code: "MESSAGE_NOT_FOUND", message: "message not found", retryable: false } }) };

    const callerRole = channel.activeRole(input.channelId, input.userId);
    const isSender = row.sender_kind === "user" && row.sender_user_id === input.userId;
    const channelKind = channel.repo.channelMetaKind(input.channelId);
    if (input.operation === "message.edit") {
      if (!isSender || row.type !== "text" || (row.status !== "normal" && row.status !== "edited")) {
        return { kind: "error", j: JSON.stringify({ error: { code: "MESSAGE_NOT_EDITABLE", message: "message is not editable", retryable: false } }) };
      }
    } else if (input.operation === "message.recall") {
      if (!isSender || (row.status !== "normal" && row.status !== "edited")) {
        return { kind: "error", j: JSON.stringify({ error: { code: "MESSAGE_NOT_EDITABLE", message: "message is not recallable", retryable: false } }) };
      }
    } else if (input.operation === "message.delete") {
      if (channelKind?.kind === "dm") {
        if (!isSender) {
          return { kind: "error", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only sender may delete in DM", retryable: false } }) };
        }
      } else if (!isSender && callerRole !== "owner" && callerRole !== "admin") {
        return { kind: "error", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only sender or owner/admin may delete", retryable: false } }) };
      }
      if (row.status !== "normal" && row.status !== "edited" && row.status !== "recalled") {
        return { kind: "error", j: JSON.stringify({ error: { code: "MESSAGE_NOT_EDITABLE", message: "message is not deletable", retryable: false } }) };
      }
    }

    const mutation = input.mutate(row);
    const updatedRow: MessageRow = { ...row, ...mutation.fields, updated_at: now };
    const mutateEntries = Object.entries(mutation.fields);
    const setClauses: string[] = mutateEntries.map(([k]) => `${k}=?`);
    const setArgs: unknown[] = mutateEntries.map(([, v]) => v);
    setClauses.push("updated_at=?");
    setArgs.push(now, input.messageId, input.channelId);

    channel.ctx.storage.sql.exec(`UPDATE messages SET ${setClauses.join(", ")} WHERE message_id=? AND channel_id=?`, ...setArgs);

    const mv = channel.repo.channelMetaMembershipVersion(input.channelId)?.membership_version ?? 0;
    const eventId = channel.nextEventId(nowMs);
    const persistedPayload = buildMessageLifecyclePayload(updatedRow);
    channel.ctx.storage.sql.exec(
      "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)",
      eventId,
      mutation.eventType,
      input.channelId,
      input.userId,
      JSON.stringify(persistedPayload),
      mv,
      now,
    );

    const senderSummary = updatedRow.sender_kind === "user" && updatedRow.sender_user_id
      ? actorMap.get(updatedRow.sender_user_id) ?? null
      : null;
    const mentionRows = channel.repo.listMentions(input.messageId);
    const mentionsForProjection = mentionRows.map((m) => ({ user_id: m.user_id, start: m.start, end: m.end }));
    const liveMessage = projectMessageForBrowser(updatedRow, { senderSummary, mentions: mentionsForProjection });
    const liveFrame = buildEventFrame({
      event_id: eventId,
      type: mutation.eventType,
      channel_id: input.channelId,
      occurred_at: now,
      payload: { message: liveMessage },
    });
    const liveFrameJson = JSON.stringify(liveFrame);
    channel.insertOutboxRowForFanout(input.channelId, eventId, liveFrameJson, mv, now);

    if (input.operation === "message.edit") {
      const editId = `${eventId}:edit`;
      channel.ctx.storage.sql.exec(
        "INSERT INTO message_edits (edit_id, message_id, old_text, new_text, editor_user_id, request_id, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        editId,
        input.messageId,
        row.text ?? "",
        updatedRow.text ?? "",
        input.userId,
        input.operationId,
        now,
      );
    } else if (input.operation === "message.recall") {
      const auditId = `${eventId}:audit`;
      channel.ctx.storage.sql.exec(
        "INSERT INTO audit_logs (audit_id, actor_kind, actor_id, action, target_type, target_id, before_json, after_json, reason, request_id, created_at) VALUES (?, 'user', ?, ?, 'message', ?, ?, ?, ?, ?, ?)",
        auditId,
        input.userId,
        "message.recall",
        input.messageId,
        JSON.stringify(row),
        JSON.stringify(updatedRow),
        input.reason,
        input.operationId,
        now,
      );
    } else {
      const auditId = `${eventId}:audit`;
      channel.ctx.storage.sql.exec(
        "INSERT INTO audit_logs (audit_id, actor_kind, actor_id, action, target_type, target_id, before_json, after_json, reason, request_id, created_at) VALUES (?, 'user', ?, ?, 'message', ?, ?, ?, ?, ?, ?)",
        auditId,
        input.userId,
        "message.delete",
        input.messageId,
        JSON.stringify(row),
        JSON.stringify(updatedRow),
        input.reason,
        input.operationId,
        now,
      );
    }

    const fullAckJson = JSON.stringify({
      frame_type: "command_ack",
      command: input.operation,
      command_id: input.operationId,
      status: "committed",
      payload: { channel_id: input.channelId, event_id: eventId, message: liveMessage },
    });

    writeUserCompletedIdempotency(channel.ctx.storage.sql, {
      userId: input.userId,
      operation: input.operation,
      operationId: input.operationId,
      requestHash: input.requestHash,
      responseJson: fullAckJson,
      nowIso: now,
    });

    const editId = input.operation === "message.edit" ? `${eventId}:edit` : null;
    const auditId = input.operation === "message.recall" || input.operation === "message.delete"
      ? `${eventId}:audit`
      : null;
    appendChatChannelArchive(channel.ctx, input.channelId, now, [eventId], (_sourceSeq) => {
      const rv = rvEvent(eventId);
      const changes: Array<import("../../../archive/payload").ArchiveChange | null> = [
        upsertMessageChange(channel.ctx.storage.sql, input.messageId, input.channelId, rv),
        upsertEventChange(channel.ctx.storage.sql, eventId),
      ];
      if (input.operation === "message.edit") {
        changes.push(
          upsertMessageEditChange(channel.ctx.storage.sql, editId!, rv),
        );
        changes.push(replaceScopeMentionsChange(channel.ctx.storage.sql, input.messageId, rv));
      } else if (auditId) {
        changes.push(upsertAuditLogChange(channel.ctx.storage.sql, auditId, rv));
      }
      return collectDefinedChanges(changes);
    });

    return { kind: "ok", responseJson: fullAckJson };
  });

  if (txResult.kind === "conflict") {
    throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
  }
  if (txResult.kind === "cached") {
    return parseMessageMutationAckFromCached(txResult.responseJson);
  }
  if (txResult.kind === "error") {
    parseRpcCachedJson<never>(txResult.j);
  }
  if (txResult.kind !== "ok") {
    throw new ApiError("CHAT_WORKER_UNAVAILABLE", "unexpected mutation result");
  }

  await channel.scheduleArchiveAlarm(now);
  return parseMessageMutationAckFromCached(txResult.responseJson);
}

export function MessageMutationMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async mutateMessage(input: MessageMutateRpcInput): Promise<MessageMutationAckPayload> {
      const now = this.nowIso();
      if (input.operation === "message.edit") {
        return applyMessageMutation(asHandlerRef(this), {
          userId: input.user_id,
          operationId: input.operation_id,
          channelId: input.channel_id,
          messageId: input.message_id,
          operation: "message.edit",
          requestHash: JSON.stringify({ message_id: input.message_id, text: input.text }),
          reason: null,
          mutate: () => ({
            eventType: "message.updated",
            fields: { text: input.text, status: "edited", edited_at: now },
          }),
        });
      }
      if (input.operation === "message.recall") {
        return applyMessageMutation(asHandlerRef(this), {
          userId: input.user_id,
          operationId: input.operation_id,
          channelId: input.channel_id,
          messageId: input.message_id,
          operation: "message.recall",
          requestHash: JSON.stringify({ message_id: input.message_id }),
          reason: null,
          mutate: () => ({
            eventType: "message.recalled",
            fields: { status: "recalled", recalled_at: now },
          }),
        });
      }
      return applyMessageMutation(asHandlerRef(this), {
        userId: input.user_id,
        operationId: input.operation_id,
        channelId: input.channel_id,
        messageId: input.message_id,
        operation: "message.delete",
        requestHash: JSON.stringify({ message_id: input.message_id, reason: input.reason ?? null }),
        reason: input.reason ?? null,
        mutate: () => ({
          eventType: "message.deleted",
          fields: { status: "deleted", deleted_at: now, deleted_by: input.user_id },
        }),
      });
    }
  };
}
