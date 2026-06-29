import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { handleSchemaVersionRequest } from "./sql-migrations";
import { migrateChatChannelSchema } from "./migrations/chat-channel";
import { uuidv7, monotonicUuidV7, type EventSeq } from "../ids/uuidv7";
import {
  buildEventFrame,
  buildMessageCreatedPayload,
  buildMessageLifecyclePayload,
  type UserSummary as LiveUserSummary,
} from "../chat/event-broadcast";
import { projectMessageForBrowser, type MessageStickerSnapshot } from "../chat/message-projection";
import { projectAttachmentForBrowser, type AttachmentRow as ChatAttachmentRow } from "../chat/attachment-projection";
import {
  buildChannelCreatedPayload,
  buildChannelUpdatedPayload,
  buildChannelDissolvedPayload,
  buildMemberJoinedPayload,
  buildMemberRoleUpdatedPayload,
  buildMemberLeftPayload,
  buildBotInstalledPayload,
  buildBotUpdatedPayload,
  buildCommandBindingUpdatedPayload,
  resolveActorWithMap,
} from "../chat/channel-events";
import type {
  ManagementPersistedEventType,
  ManagementPersistedPayload,
  ManagementPersistedPayloadByType,
  MessagePersistedPayload,
  MessageRow,
} from "../contract/persisted";
import { buildReplayEventsResponse } from "../chat/replay-projection";
import type { ChatEventPayloadByType } from "../contract/events";
import type { MessageImageAttachment, WireChatMessage } from "../contract/message";
import { idempotencyExpiresAt } from "../contract/idempotency";
import type { MessageMutationAckPayload, MessageMutationIdempotencyEnvelope } from "../contract/idempotency";
import type { ChannelMetaProjection, ChannelUpdatePresentFields, MemberProjection } from "../contract/channel-api";
import type { DissolvedChannelProjection } from "../contract/channel";
import type {
  ProjectionOutboxPayload,
  ChannelDirectorySnapshotFields,
} from "../contract/outbox";
import { OUTBOX_MAX_ATTEMPTS } from "../contract/outbox";
import {
  checkPrincipalIdempotencyInTxn,
  principalIdempotencyConflictResponse,
  readCompletedPrincipalIdempotency,
  writeCompletedPrincipalIdempotency,
} from "../chat/principal-idempotency";
import { bumpQueueRetry } from "./retry-backoff";
import { idempotencyConflictResponse, requireTestOnly } from "./do-errors";
import { isoDueTable, runDueJobs, scheduleNextAlarm, type DueRow, type DueTable } from "./scheduler";
import { archiveOutboxDueTable, flushArchiveOutboxToQueue } from "../archive/queue-flush";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  replaceScopeMentionsChange,
  replaceScopeCommandBindingsForBotChange,
  replaceScopeCommandNamesForBindingChange,
  replaceScopeCommandNamesForBotChange,
  replaceScopeBotEventSubscriptionsForBotChange,
  rvEvent,
  upsertAuditLogChange,
  upsertBotInstallationChange,
  upsertCommandBindingChange,
  upsertEventChange,
  upsertMessageChange,
  upsertMessageEditChange,
} from "../archive/chat-channel-record";
import type { UserDirectoryOutboxPayload } from "../contract/outbox";
import type {
  CommandBindingProjection,
  BotEventSubscriptionProjection,
  CommandPolicyMap,
  EventSubscriptionPolicyMap,
  MessageEventSubscriptionFilters,
} from "../contract/bot-api";
import { personalInviteCode } from "../chat/invite-code";
import { HTTP_STATUS_BY_CODE } from "../errors";
import { resolveUserSummaries } from "../profile/resolve";
import { botRegistryStub } from "../auth/bot";
import { fallbackUserDisplayName } from "../contract/primitives";
import type { ChatChannelHost } from "./chat-channel/host";
import { dispatchReadRoutes } from "./chat-channel/routes/read-routes";
import { dispatchMessageRoutes } from "./chat-channel/routes/message-routes";
import { dispatchMembershipRoutes } from "./chat-channel/routes/membership-routes";
import { dispatchChannelRoutes } from "./chat-channel/routes/channel-routes";
import { dispatchBotRoutes } from "./chat-channel/routes/bot-routes";

interface OutboxRow {
  outbox_id: string;
  target_kind: string;
  target_key: string;
  payload_json: string;
}

export class ChatChannel extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateChatChannelSchema(this.ctx);
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private async insertOutboxRow(
    targetKind: string,
    targetKey: string,
    payload: ProjectionOutboxPayload,
    nowIso: string,
  ): Promise<void> {
    const payloadOut = { ...payload };
    const eventId = this.nextEventId(Date.parse(nowIso));
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, 5)",
      `${targetKind}:${targetKey}:${eventId}:${Math.random()}`,
      targetKind,
      targetKey,
      eventId,
      JSON.stringify(payloadOut),
      nowIso,
      nowIso,
      nowIso,
    );
  }

  private liveMembershipReason(action: string | undefined): string {
    if (action === "leave") return "channel_left";
    if (action === "dissolve") return "channel_dissolved";
    return "channel_joined";
  }

  private async notifyLiveMembershipChanged(
    affectedUserId: string,
    payload: { action?: string; channel_id?: string; membership_version?: number },
  ): Promise<void> {
    const reason = this.liveMembershipReason(payload.action);
    try {
      const res = await this.env.USER_CONNECTION.getByName(affectedUserId).fetch(new Request("https://x/internal/live-memberships-changed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          affected_user_id: affectedUserId,
          reason,
          changed_channel_id: payload.channel_id,
          membership_version: payload.membership_version ?? 0,
        }),
      }));
      if (!res.ok) {
        console.log("live_membership_resync_failed", {
          affected_user_id: affectedUserId,
          reason,
          changed_channel_id: payload.channel_id,
          status: res.status,
          error: await res.text(),
        });
      }
    } catch (err) {
      console.log("live_membership_resync_failed", {
        affected_user_id: affectedUserId,
        reason,
        changed_channel_id: payload.channel_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // SYNC core: co-atomic leave + fanout unregister outbox. Runs inside a caller transaction.
  // (P0-6: single leave implementation — /internal/test-leave and members-remove share this.)
  private markMemberLeftAndEnqueueFanoutUnregisterSync(channelId: string, userId: string, nowIso: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE members SET left_at=? WHERE channel_id=? AND user_id=?",
      nowIso, channelId, userId,
    );
    const meta = this.ctx.storage.sql
      .exec("SELECT membership_version, member_count FROM channel_meta WHERE channel_id=?", channelId)
      .toArray()[0] as { membership_version: number; member_count: number } | undefined;
    const nextMv = (meta?.membership_version ?? 0) + 1;
    const nextCount = Math.max(0, (meta?.member_count ?? 1) - 1);
    this.ctx.storage.sql.exec(
      "UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?",
      nextMv,
      nextCount,
      nowIso,
      channelId,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'channel_fanout', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
      `channel_fanout:unregister:${channelId}:${userId}:${nowIso}`,
      channelId,
      JSON.stringify({ action: "unregister-user", channel_id: channelId, user_id: userId }),
      nowIso, nowIso, nowIso,
    );
  }

  // Phase 2 path (test-leave): wraps the sync core in its own transaction.
  private async markMemberLeftAndEnqueueFanoutUnregister(channelId: string, userId: string, nowIso: string): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      this.markMemberLeftAndEnqueueFanoutUnregisterSync(channelId, userId, nowIso);
    });
  }

  private insertOutboxRowForFanout(
    channelId: string,
    eventId: string,
    eventFrameJson: string,
    membershipVersionAtEvent: number,
    nowIso: string,
  ): void {
    const payload = {
      action: "fanout",
      event_id: eventId,
      event_json: eventFrameJson,
      membership_version_at_event: membershipVersionAtEvent,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'channel_fanout', ?, ?, ?, 'pending', ?, ?, ?, 0, 5)",
      `channel_fanout:${channelId}:${eventId}`,
      channelId,
      eventId,
      JSON.stringify(payload),
      nowIso,
      nowIso,
      nowIso,
    );
  }

  // Read the current full channel_meta snapshot for a channel_directory projection.
  // Returns title/avatar_url/member_count/status + last_message_at (from the latest visible message)
  // so every channel_directory upsert is a FULL snapshot (P0-3): a missing directory row is always
  // repairable by any subsequent call site (create/update/message.send/member delta).
  private readChannelDirectorySnapshot(channelId: string, nowIso: string): ChannelDirectorySnapshotFields | null {
    const meta = this.ctx.storage.sql
      .exec("SELECT title, avatar_url, member_count, status FROM channel_meta WHERE channel_id=?", channelId)
      .toArray()[0] as { title: string; avatar_url: string | null; member_count: number; status: string } | undefined;
    if (meta === undefined) return null;
    const lastMsg = this.ctx.storage.sql
      .exec("SELECT created_at FROM messages WHERE channel_id=? AND status NOT IN ('deleted','recalled') ORDER BY message_id DESC LIMIT 1", channelId)
      .toArray()[0] as { created_at: string } | undefined;
    void nowIso;
    return {
      title: meta.title,
      avatar_url: meta.avatar_url,
      member_count: meta.member_count,
      last_message_at: lastMsg?.created_at ?? null,
      status: meta.status,
    };
  }

  // Write a channel_directory projection_outbox row. For `upsert` the snapshot is read from the
  // current channel_meta (FULL snapshot — every NOT NULL field present). For `delete` only the
  // channel_id is needed. Co-atomic with the caller's business txn (call inside the txn).
  private insertOutboxRowForChannelDirectory(
    channelId: string,
    action: "upsert" | "delete",
    snapshot: ChannelDirectorySnapshotFields | null,
    nowIso: string,
  ): void {
    if (action === "delete") {
      const eventId = this.nextEventId(Date.parse(nowIso));
      this.ctx.storage.sql.exec(
        "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'channel_directory', 'shared', ?, ?, 'pending', ?, ?, ?, 0, 5)",
        `channel_directory:delete:${channelId}:${eventId}:${Math.random()}`,
        eventId,
        JSON.stringify({ action: "delete", channel_id: channelId }),
        nowIso, nowIso, nowIso,
      );
      return;
    }
    if (snapshot === null) return; // channel gone — nothing to project
    const fields = {
      title: snapshot.title,
      avatar_url: snapshot.avatar_url,
      member_count: snapshot.member_count,
      last_message_at: snapshot.last_message_at,
      status: snapshot.status,
    };
    const eventId = this.nextEventId(Date.parse(nowIso));
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'channel_directory', 'shared', ?, ?, 'pending', ?, ?, ?, 0, 5)",
      `channel_directory:upsert:${channelId}:${eventId}:${Math.random()}`,
      eventId,
      JSON.stringify({ action: "upsert", channel_id: channelId, fields, fields_present: ["title", "avatar_url", "member_count", "last_message_at", "status"] }),
      nowIso, nowIso, nowIso,
    );
  }

  private async resolveActorMap(userIds: string[]): Promise<Map<string, import("../chat/event-broadcast").UserSummary>> {
    const raw = await resolveUserSummaries(userIds, this.env);
    const m = new Map<string, import("../chat/event-broadcast").UserSummary>();
    for (const [id, v] of raw) {
      m.set(id, { user_id: id, display_name: v.display_name ?? `user-${id.slice(0, 8)}`, avatar_url: v.avatar_url });
    }
    return m;
  }

  private assertNotDissolved(status: string): { code: string; message: string } | null {
    if (status === "dissolved") return { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" };
    return null;
  }

  // The caller's role if they are an ACTIVE member (left_at IS NULL), else null.
  private activeRole(channelId: string, userId: string): string | null {
    const row = this.ctx.storage.sql
      .exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, userId)
      .toArray()[0] as { role: string } | undefined;
    return row?.role ?? null;
  }

  private dmChannelManagementError(): Response {
    return Response.json(
      { error: { code: "UNSUPPORTED_CHANNEL_KIND", message: "operation not supported for DM channels", retryable: false } },
      { status: 409 },
    );
  }

  private readChannelMeta(): { channel_id: string; kind: string; visibility: string; status: string; membership_version: number; member_count: number } | undefined {
    return this.ctx.storage.sql
      .exec("SELECT channel_id, kind, visibility, status, membership_version, member_count FROM channel_meta LIMIT 1")
      .toArray()[0] as { channel_id: string; kind: string; visibility: string; status: string; membership_version: number; member_count: number } | undefined;
  }

  private requireChannelKindChannel(): { ok: true; meta: NonNullable<ReturnType<ChatChannel["readChannelMeta"]>> } | { ok: false; response: Response } {
    const meta = this.readChannelMeta();
    if (meta === undefined) {
      return { ok: false, response: new Response("not found", { status: 404 }) };
    }
    if (meta.kind === "dm") {
      return { ok: false, response: this.dmChannelManagementError() };
    }
    return { ok: true, meta };
  }

  // Maps a cached `{channel|member|error}` JSON (encoded inside a txn that cannot write business rows)
  // to the right HTTP status. Shared by all write handlers' cached branches (Tasks 7/8/9/11).
  private cachedResponse(j: string): Response {
    const cached = JSON.parse(j) as { channel?: unknown; member?: unknown; error?: { code?: string; message?: string } };
    if (cached.error) {
      const code = cached.error.code ?? "CHAT_WORKER_UNAVAILABLE";
      const status = HTTP_STATUS_BY_CODE[code] ?? 500;
      return Response.json({ error: { code, message: cached.error.message ?? "error", retryable: false } }, { status });
    }
    return new Response(j, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  private async applyMessageMutation(input: {
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
  }): Promise<Response> {
    const now = this.nowIso();
    const nowMs = Date.parse(now);

    // v4.0 cheap pre-check: if this exact operation+user+body already completed, return cached ack
    // without resolving user summaries or opening a transaction.
    const preCheckJson = readCompletedPrincipalIdempotency(this.ctx.storage.sql, {
      principalKind: "user",
      principalId: input.userId,
      operation: input.operation,
      operationId: input.operationId,
      requestHash: input.requestHash,
    });
    if (preCheckJson) {
      const cached = JSON.parse(preCheckJson) as MessageMutationIdempotencyEnvelope;
      if (cached.payload && cached.payload.event_id && cached.payload.message) {
        return Response.json({
          channel_id: cached.payload.channel_id ?? input.channelId,
          event_id: cached.payload.event_id,
          message: cached.payload.message,
        });
      }
    }

    // A2-corr-5: pre-read the message sender before txn so sender projection survives admin-delete.
    const preflight = this.ctx.storage.sql
      .exec("SELECT sender_user_id FROM messages WHERE message_id=? AND channel_id=?", input.messageId, input.channelId)
      .toArray()[0] as { sender_user_id: string | null } | undefined;
    const preflightActorIds = new Set<string>([input.userId]);
    if (preflight?.sender_user_id) preflightActorIds.add(preflight.sender_user_id);
    const actorMap = await this.resolveActorMap(Array.from(preflightActorIds));

    type TxResult =
      | { kind: "conflict" }
      | { kind: "cached"; responseJson: string }
      | { kind: "error"; j: string }
      | { kind: "ok"; responseJson: string };

    const txResult = await this.ctx.storage.transaction(async (): Promise<TxResult> => {
      const statusRow = this.ctx.storage.sql.exec("SELECT status FROM channel_meta WHERE channel_id=?", input.channelId).toArray()[0] as {
        status: string;
      } | undefined;
      if (!statusRow) return { kind: "error", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
      if (statusRow.status === "dissolved") return {
        kind: "error",
        j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }),
      };

      const idemCheck = checkPrincipalIdempotencyInTxn(this.ctx.storage.sql, {
        principalKind: "user",
        principalId: input.userId,
        operation: input.operation,
        operationId: input.operationId,
        requestHash: input.requestHash,
      });
      if (idemCheck.kind === "conflict") return { kind: "conflict" };
      if (idemCheck.kind === "cached") return { kind: "cached", responseJson: idemCheck.responseJson };

      const row = this.ctx.storage.sql
        .exec(
          "SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE message_id=? AND channel_id=?",
          input.messageId, input.channelId,
        )
        .toArray()[0] as MessageRow | undefined;
      if (!row) return { kind: "error", j: JSON.stringify({ error: { code: "MESSAGE_NOT_FOUND", message: "message not found", retryable: false } }) };

      const callerRole = this.activeRole(input.channelId, input.userId);
      const isSender = row.sender_kind === "user" && row.sender_user_id === input.userId;
      const channelKind = this.ctx.storage.sql
        .exec("SELECT kind FROM channel_meta WHERE channel_id=?", input.channelId)
        .toArray()[0] as { kind: string } | undefined;
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

      this.ctx.storage.sql.exec(`UPDATE messages SET ${setClauses.join(", ")} WHERE message_id=? AND channel_id=?`, ...setArgs);

      const mvRow = this.ctx.storage.sql.exec("SELECT membership_version FROM channel_meta WHERE channel_id=?", input.channelId).toArray()[0] as
        | { membership_version: number }
        | undefined;
      const mv = mvRow?.membership_version ?? 0;
      const eventId = this.nextEventId(nowMs);
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
      });
      this.ctx.storage.sql.exec(
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
      // Load the message's mentions for the live projection. For deleted/recalled the builder
      // forces mentions=[] anyway; for edited we preserve current mentions (text-edit only).
      const mentionRows = this.ctx.storage.sql
        .exec("SELECT user_id, start, end_ AS end FROM mentions WHERE message_id=?", input.messageId)
        .toArray() as Array<{ user_id: string; start: number; end: number }>;
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
      this.insertOutboxRowForFanout(input.channelId, eventId, liveFrameJson, mv, now);

      if (input.operation === "message.edit") {
        const editId = `${eventId}:edit`;
        this.ctx.storage.sql.exec(
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
        this.ctx.storage.sql.exec(
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
        this.ctx.storage.sql.exec(
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

      writeCompletedPrincipalIdempotency(this.ctx.storage.sql, {
        principalKind: "user",
        principalId: input.userId,
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
      appendChatChannelArchive(this.ctx, input.channelId, now, [eventId], (_sourceSeq) => {
        const rv = rvEvent(eventId);
        const changes: Array<import("../archive/payload").ArchiveChange | null> = [
          upsertMessageChange(this.ctx.storage.sql, input.messageId, input.channelId, rv),
          upsertEventChange(this.ctx.storage.sql, eventId),
        ];
        if (input.operation === "message.edit") {
          changes.push(
            upsertMessageEditChange(this.ctx.storage.sql, editId!, rv),
          );
          changes.push(replaceScopeMentionsChange(this.ctx.storage.sql, input.messageId, rv));
        } else if (auditId) {
          changes.push(upsertAuditLogChange(this.ctx.storage.sql, auditId, rv));
        }
        return collectDefinedChanges(changes);
      });

      return { kind: "ok", responseJson: fullAckJson };
    });

    if (txResult.kind === "conflict") {
      return principalIdempotencyConflictResponse();
    }
    if (txResult.kind === "cached") {
      // unwrap the full command_ack JSON → return {channel_id, event_id, message} (the internal
      // endpoint contract). The cached response_json is a full ack frame; the WS UserConnection
      // re-wraps it. This mirrors the cheap pre-check path + the message-send cached branch.
      const cached = JSON.parse(txResult.responseJson) as MessageMutationIdempotencyEnvelope;
      if (cached.payload && cached.payload.event_id && cached.payload.message) {
        return Response.json({ channel_id: cached.payload.channel_id ?? input.channelId, event_id: cached.payload.event_id, message: cached.payload.message });
      }
      // malformed/empty cached entry — treat as conflict (shouldn't happen with in-txn full-ack write)
      return idempotencyConflictResponse();
    }
    if (txResult.kind === "error") {
      return this.cachedResponse(txResult.j);
    }

    await this.scheduleArchiveAlarm(now);
    const ack = JSON.parse(txResult.responseJson) as MessageMutationIdempotencyEnvelope;
    return Response.json({ channel_id: ack.payload?.channel_id ?? input.channelId, event_id: ack.payload?.event_id ?? "", message: ack.payload?.message ?? null });
  }

  // Sync: persists the event (ref payload) + writes a channel_fanout outbox row with the
  // LIVE-resolved frame. MUST run inside ctx.storage.transaction. The actor map is pre-resolved
  // BEFORE the txn (Hyperdrive is a network call). All event types reaching here carry actor_kind
  // (v4.0: read_state.updated is no longer a channel event — it's a user-local WS frame).
  private persistEventAndFanout<T extends ManagementPersistedEventType>(
    eventId: string,
    type: T,
    channelId: string,
    occurredAt: string,
    persistedPayload: ManagementPersistedPayloadByType[T],
    membershipVersion: number,
    nowIso: string,
    actorMap: Map<string, import("../chat/event-broadcast").UserSummary>,
  ): void {
    const actorKind = typeof persistedPayload.actor_kind === "string" ? persistedPayload.actor_kind : null;
    const actorId = typeof persistedPayload.actor_id === "string" ? persistedPayload.actor_id : null;
    this.ctx.storage.sql.exec(
      "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      eventId, type, channelId, actorKind, actorId, JSON.stringify(persistedPayload), membershipVersion, occurredAt,
    );
    // v4.0: read_state.updated is no longer a channel event (Task 4 moved read-state to a
    // user-local WS frame), so every event type reaching here carries actor_kind and is resolved.
    const livePayload = resolveActorWithMap(persistedPayload, actorMap);
    const frame = buildEventFrame({
      event_id: eventId,
      type,
      channel_id: channelId,
      occurred_at: occurredAt,
      payload: livePayload as ChatEventPayloadByType[T],
    });
    this.insertOutboxRowForFanout(channelId, eventId, JSON.stringify(frame), membershipVersion, nowIso);
  }

  private async scheduleOutboxAlarm(_nowIso?: string): Promise<void> {
    void _nowIso;
    await scheduleNextAlarm(
      this.ctx,
      [...this.outboxDueTables(async () => Promise.resolve()), archiveOutboxDueTable()],
      { respectExistingAlarm: true },
    );
  }

  async scheduleArchiveAlarm(nowIso?: string): Promise<void> {
    await this.scheduleOutboxAlarm(nowIso);
  }

  private outboxDueTables(handler: (rows: DueRow[]) => Promise<void>): DueTable[] {
    return [
      isoDueTable("projection_outbox", "next_attempt_at", "status", "pending", handler),
    ];
  }

  private insertUserDirectoryOutbox(
    targetUserId: string,
    payload: UserDirectoryOutboxPayload,
    nowIso: string,
    outboxId: string,
  ): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'user_directory', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
      outboxId,
      targetUserId,
      JSON.stringify(payload),
      nowIso,
      nowIso,
      nowIso,
    );
  }

  private async bumpOutboxRetry(outboxId: string, nowIso: string, error: string): Promise<void> {
    bumpQueueRetry(this.ctx.storage.sql, {
      table: "projection_outbox",
      idColumn: "outbox_id",
      id: outboxId,
      nowIso,
      error,
      maxAttempts: OUTBOX_MAX_ATTEMPTS,
    });
  }

  private async flushSingleInviteDirectoryOutbox(outboxId: string, nowIso: string): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec("SELECT payload_json FROM projection_outbox WHERE outbox_id=?", outboxId)
      .toArray()[0] as { payload_json: string } | undefined;
    if (!row) return false;

    const target = this.env.INVITE_DIRECTORY.getByName("shared");
    try {
      const res = await target.fetch(new Request("https://x/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: row.payload_json,
      }));
      if (!res.ok) return false;
      this.ctx.storage.sql.exec(
        "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
        nowIso,
        outboxId,
      );
      return true;
    } catch {
      return false;
    }
  }

  nextEventId(nowMs: number = Date.now()): string {
    const rows = this.ctx.storage.sql.exec("SELECT last_ms, counter FROM event_seq WHERE id=1").toArray();
    const row = rows[0] as { last_ms: number; counter: number } | undefined;
    const seq: EventSeq = row ?? { last_ms: 0, counter: 0 };
    const { id, seq: next } = monotonicUuidV7(seq, nowMs);
    this.ctx.storage.sql.exec("UPDATE event_seq SET last_ms=?, counter=? WHERE id=1", next.last_ms, next.counter);
    return id;
  }

  async fetch(request: Request): Promise<Response> {
    const schemaVersion = handleSchemaVersionRequest(this.ctx, "ChatChannel", request);
    if (schemaVersion) return schemaVersion;

    const url = new URL(request.url);
    const host = this as unknown as ChatChannelHost;

    const readResponse = await dispatchReadRoutes(host, request, url);
    if (readResponse !== null) return readResponse;

    const messageResponse = await dispatchMessageRoutes(host, request, url);
    if (messageResponse !== null) return messageResponse;

    const membershipResponse = await dispatchMembershipRoutes(host, request, url);
    if (membershipResponse !== null) return membershipResponse;

    const channelResponse = await dispatchChannelRoutes(host, request, url);
    if (channelResponse !== null) return channelResponse;

    const botResponse = await dispatchBotRoutes(host, request, url);
    if (botResponse !== null) return botResponse;

    return new Response("not found", { status: 404 });
  }

  // ─── Phase 7a: bot installation + command binding internals ───

  private botInstallError(code: string, message: string): Response {
    return Response.json({ error: { code, message, retryable: false } }, { status: HTTP_STATUS_BY_CODE[code] ?? 500 });
  }

  private memberRoleRank(role: string | null): number {
    if (role === "owner") return 3;
    if (role === "admin") return 2;
    if (role === "member") return 1;
    return 0;
  }

  private hasRolePermission(callerRole: string | null, requiredRole: string): boolean {
    return this.memberRoleRank(callerRole) >= this.memberRoleRank(requiredRole);
  }

  private parseStringArrayFromJson(rowValue: string): string[] {
    try {
      const raw = JSON.parse(rowValue) as unknown;
      return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  private parseJsonUnknown(rowValue: string): unknown {
    try {
      return JSON.parse(rowValue) as unknown;
    } catch {
      return null;
    }
  }

  /** GET /internal/channel-commands?channel_id=...&user_id=...&prefix=... — query enabled commands by effective permission. */
  private async handleChannelCommands(request: Request): Promise<Response> {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return this.botInstallError("UNAUTHORIZED", "missing verified user");

    const url = new URL(request.url);
    const channelId = url.searchParams.get("channel_id") ?? "";
    if (!channelId) return this.botInstallError("CHANNEL_NOT_FOUND", "channel_id required");

    const meta = this.ctx.storage.sql
      .exec("SELECT status FROM channel_meta WHERE channel_id=?", channelId)
      .toArray()[0] as { status: string } | undefined;
    if (!meta) return this.botInstallError("CHANNEL_NOT_FOUND", "channel not found");
    if (meta.status === "dissolved") return this.botInstallError("CHANNEL_DISSOLVED", "channel is dissolved");

    const callerRole = this.activeRole(channelId, userId);
    if (!callerRole) return this.botInstallError("FORBIDDEN", "not a channel member");

    const prefix = url.searchParams.get("prefix") ?? "";
    const matchesPrefix = (name: string): boolean =>
      prefix.length === 0 || name.startsWith(prefix);

    const rows = this.ctx.storage.sql
      .exec(
        `SELECT
          b.bot_command_id, b.bot_id, b.name, b.description, b.options_json, b.aliases_json,
          b.default_member_permission, b.permission_override,
          i.bot_display_name, i.bot_avatar_url
         FROM channel_command_bindings AS b
         JOIN bot_installations AS i USING (bot_id)
         WHERE b.channel_id=? AND b.status='enabled' AND i.status='active'`,
        channelId,
      )
      .toArray() as Array<{
        bot_command_id: string;
        bot_id: string;
        name: string;
        description: string | null;
        options_json: string;
        aliases_json: string;
        default_member_permission: string;
        permission_override: string | null;
        bot_display_name: string;
        bot_avatar_url: string | null;
      }>;

    const items = [] as Array<{
      bot_command_id: string;
      name: string;
      aliases: string[];
      matched_name: string;
      matched_kind: "canonical" | "alias";
      description: string | null;
      bot: { bot_id: string; display_name: string; avatar_url: string | null };
      options: unknown;
      effective_member_permission: string;
    }>;

    for (const row of rows) {
      const aliases = this.parseStringArrayFromJson(row.aliases_json);
      const effectivePermission = row.permission_override ?? row.default_member_permission;
      if (!this.hasRolePermission(callerRole, effectivePermission)) continue;

      let matchedName: string | null = null;
      let matchedKind: "canonical" | "alias" | null = null;
      if (matchesPrefix(row.name)) {
        matchedName = row.name;
        matchedKind = "canonical";
      } else {
        for (const alias of aliases) {
          if (matchesPrefix(alias)) {
            matchedName = alias;
            matchedKind = "alias";
            break;
          }
        }
      }
      if (!matchedName || !matchedKind) continue;

      items.push({
        bot_command_id: row.bot_command_id,
        name: row.name,
        aliases,
        matched_name: matchedName,
        matched_kind: matchedKind,
        description: row.description,
        bot: {
          bot_id: row.bot_id,
          display_name: row.bot_display_name,
          avatar_url: row.bot_avatar_url,
        },
        options: this.parseJsonUnknown(row.options_json),
        effective_member_permission: effectivePermission,
      });
    }

    return Response.json({ items });
  }

  /** POST /internal/bot-install — install a bot into a channel + create command bindings + default event subscriptions. */
  private async handleBotInstall(request: Request): Promise<Response> {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return this.botInstallError("UNAUTHORIZED", "missing verified user");
    const kindGate = this.requireChannelKindChannel();
    if (!kindGate.ok) return kindGate.response;
    const b = (await request.json().catch(() => null)) as {
      operation_id?: unknown;
      channel_id?: unknown;
      bot_id?: unknown;
      initial_command_policy?: unknown;
      initial_event_subscriptions?: unknown;
    } | null;
    if (!b || typeof b.operation_id !== "string" || typeof b.channel_id !== "string" || typeof b.bot_id !== "string") {
      return this.botInstallError("INVALID_MESSAGE", "operation_id, channel_id, bot_id required");
    }
    const botId = b.bot_id;
    const channelId = b.channel_id;
    const operationId = b.operation_id;
    const operation = "bot.install";
    const now = this.nowIso();
    const nowMs = Date.parse(now);
    const idemExpiresAt = idempotencyExpiresAt(nowMs);

    // initial_command_policy: { [bot_command_id]: { enabled: boolean, permission_override?: string } | boolean }
    // false-y / absent -> use catalog default_enabled_on_install.
    const policy = (b.initial_command_policy ?? {}) as CommandPolicyMap;
    // initial_event_subscriptions: { [event_type]: { enabled: boolean, filters?: object } | boolean }
    const initialSubs = (b.initial_event_subscriptions ?? {}) as EventSubscriptionPolicyMap;

    const requestHash = JSON.stringify({ bot_id: botId, initial_command_policy: policy, initial_event_subscriptions: initialSubs });

    // Cheap pre-check.
    const preCheck = this.ctx.storage.sql
      .exec(
        "SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
        userId, operation, operationId, requestHash,
      )
      .toArray()[0] as { response_json: string } | undefined;
    if (preCheck) return this.cachedResponse(preCheck.response_json);

    // Fetch the bot's current catalog BEFORE the transaction (async network).
    const catalogRes = await botRegistryStub(this.env).fetch(
      new Request(`https://x/internal/bot-commands?bot_id=${encodeURIComponent(botId)}`),
    );
    if (catalogRes.status === 404) return this.botInstallError("BOT_NOT_FOUND", "bot not found");
    if (!catalogRes.ok) return this.botInstallError("CHAT_WORKER_UNAVAILABLE", "catalog fetch failed");
    const catalog = (await catalogRes.json()) as {
      bot: { bot_id: string; display_name: string; avatar_url: string | null; status: string };
      commands: Array<{
        bot_command_id: string; name: string; description: string | null;
        options: unknown; default_member_permission: string; default_enabled_on_install: boolean;
        schema_version: number; definition_hash: string; aliases: string[];
      }>;
      event_capabilities: Array<{ event_type: string; filters: unknown; default_enabled_on_install: boolean }>;
    };

    const actorMap = await this.resolveActorMap([userId]);
    const txResult = this.ctx.storage.transactionSync(() => {
      const idem = this.ctx.storage.sql
        .exec(
          "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=?",
          userId, operation, operationId,
        )
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" as const };
        return { kind: "cached" as const, responseJson: idem.response_json ?? "{}" };
      }

      const meta = this.ctx.storage.sql
        .exec("SELECT status, membership_version FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { status: string; membership_version: number } | undefined;
      if (!meta) return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found" } }) };
      if (meta.status === "dissolved") return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" } }) };

      const callerRole = this.activeRole(channelId, userId);
      if (callerRole !== "owner" && callerRole !== "admin") {
        return { kind: "error" as const, j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner/admin may install bots" } }) };
      }

      const enabledCommandSlashNames = new Set<string>();
      for (const cmd of catalog.commands) {
        const policyEntry = policy[cmd.bot_command_id];
        const enabled = typeof policyEntry === "boolean"
          ? policyEntry
          : typeof policyEntry === "object" && policyEntry !== null && typeof (policyEntry as { enabled?: unknown }).enabled === "boolean"
            ? (policyEntry as { enabled: boolean }).enabled
            : cmd.default_enabled_on_install;
        if (!enabled) continue;
        for (const slashName of [cmd.name, ...cmd.aliases]) {
          if (enabledCommandSlashNames.has(slashName)) {
            return { kind: "error" as const, j: JSON.stringify({ error: { code: "COMMAND_NAME_CONFLICT", message: `slash token already in use: ${slashName}` } }) };
          }
          enabledCommandSlashNames.add(slashName);
        }
      }
      for (const slashName of enabledCommandSlashNames) {
        const clash = this.ctx.storage.sql
          .exec("SELECT 1 FROM channel_command_names WHERE channel_id=? AND slash_name=? AND bot_id!=?", channelId, slashName, botId)
          .toArray()[0];
        if (clash) {
          return { kind: "error" as const, j: JSON.stringify({ error: { code: "COMMAND_NAME_CONFLICT", message: `slash token already in use: ${slashName}` } }) };
        }
      }

      // Re-install = upsert: clear this bot's old bindings + names first.
      this.ctx.storage.sql.exec("DELETE FROM channel_command_names WHERE channel_id=? AND bot_id=?", channelId, botId);
      this.ctx.storage.sql.exec("DELETE FROM channel_command_bindings WHERE channel_id=? AND bot_id=?", channelId, botId);

      const bindings: CommandBindingProjection[] = [];
      for (const cmd of catalog.commands) {
        const policyEntry = policy[cmd.bot_command_id];
        const enabled = typeof policyEntry === "boolean"
          ? policyEntry
          : typeof policyEntry === "object" && policyEntry !== null && typeof (policyEntry as { enabled?: unknown }).enabled === "boolean"
            ? (policyEntry as { enabled: boolean }).enabled
            : cmd.default_enabled_on_install;
        const permissionOverride = typeof policyEntry === "object" && policyEntry !== null && typeof (policyEntry as { permission_override?: unknown }).permission_override === "string"
          ? (policyEntry as { permission_override: string }).permission_override
          : null;

        const bindingId = uuidv7(nowMs);
        this.ctx.storage.sql.exec(
          `INSERT INTO channel_command_bindings (
             binding_id, channel_id, bot_id, bot_command_id, status, permission_override,
             name, description, options_json, aliases_json, default_member_permission,
             definition_hash, created_by, created_at, updated_by, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          bindingId, channelId, botId, cmd.bot_command_id,
          enabled ? "enabled" : "disabled",
          permissionOverride,
          cmd.name, cmd.description, JSON.stringify(cmd.options), JSON.stringify(cmd.aliases),
          cmd.default_member_permission, cmd.definition_hash,
          userId, now, now,
        );

        if (enabled) {
          // canonical + alias name rows; conflicts were checked before writes.
          for (const slashName of [cmd.name, ...cmd.aliases]) {
            this.ctx.storage.sql.exec(
              "INSERT INTO channel_command_names (channel_id, slash_name, bot_command_id, bot_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
              channelId, slashName, cmd.bot_command_id, botId, slashName === cmd.name ? "canonical" : "alias", now,
            );
          }
        }

        bindings.push({
          binding_id: bindingId, bot_command_id: cmd.bot_command_id, name: cmd.name,
          aliases: cmd.aliases, status: enabled ? "enabled" : "disabled",
          permission_override: permissionOverride, default_member_permission: cmd.default_member_permission,
          definition_hash: cmd.definition_hash,
        });
      }

      // event subscriptions: per initial_event_subscriptions or catalog default.
      const subscriptions: BotEventSubscriptionProjection[] = [];
      for (const cap of catalog.event_capabilities) {
        const subEntry = initialSubs[cap.event_type];
        const enabled = typeof subEntry === "boolean"
          ? subEntry
          : typeof subEntry === "object" && subEntry !== null && typeof (subEntry as { enabled?: unknown }).enabled === "boolean"
            ? (subEntry as { enabled: boolean }).enabled
            : cap.default_enabled_on_install;
        const filters: MessageEventSubscriptionFilters | unknown = typeof subEntry === "object" && subEntry !== null && typeof (subEntry as { filters?: unknown }).filters === "object"
          ? (subEntry as { filters: unknown }).filters
          : cap.filters;
        const defaultFilters: MessageEventSubscriptionFilters = {
          message_types: ["text"],
          include_bot_messages: false,
          include_own_messages: false,
          only_when_mentioned: false,
        };
        const resolvedFilters: MessageEventSubscriptionFilters = (filters ?? defaultFilters) as MessageEventSubscriptionFilters;
        const subId = uuidv7(nowMs);
        this.ctx.storage.sql.exec(
          `INSERT INTO channel_bot_event_subscriptions (
             subscription_id, channel_id, bot_id, event_type, status, filters_json,
             created_by, created_at, updated_by, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(channel_id, bot_id, event_type) DO UPDATE SET
             status=excluded.status, filters_json=excluded.filters_json,
             updated_by=excluded.created_by, updated_at=excluded.updated_at`,
          subId, channelId, botId, cap.event_type,
          enabled ? "enabled" : "disabled",
          JSON.stringify(resolvedFilters),
          userId, now, now,
        );
        subscriptions.push({ subscription_id: subId, event_type: cap.event_type, status: enabled ? "enabled" : "disabled", filters: resolvedFilters });
      }

      // upsert bot_installations
      this.ctx.storage.sql.exec(
        `INSERT INTO bot_installations (bot_id, installed_by, scopes, installed_at, status, updated_by, updated_at, bot_display_name, bot_avatar_url)
         VALUES (?, ?, '[]', ?, 'active', ?, ?, ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET
           status='active', installed_by=excluded.installed_by, updated_by=excluded.updated_by,
           updated_at=excluded.updated_at, bot_display_name=excluded.bot_display_name,
           bot_avatar_url=excluded.bot_avatar_url`,
        botId, userId, now, userId, now, catalog.bot.display_name, catalog.bot.avatar_url,
      );

      const mv = meta.membership_version;
      const installedId = this.nextEventId(nowMs);
      this.persistEventAndFanout(
        installedId, "bot.installed", channelId, now,
        buildBotInstalledPayload({ channel_id: channelId, bot_id: botId, actor_kind: "user", actor_id: userId }),
        mv, now, actorMap,
      );

      const responseBody = { bot_id: botId, status: "active", bindings, subscriptions };
      const fullResponse = JSON.stringify(responseBody);
      this.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, ?, ?, ?, ?, 'completed', ?, ?)",
        userId, operation, operationId, requestHash, fullResponse, now, idemExpiresAt,
      );

      appendChatChannelArchive(this.ctx, channelId, now, [installedId], (sourceSeq) => {
        const rv = rvEvent(installedId);
        return collectDefinedChanges([
          upsertBotInstallationChange(this.ctx.storage.sql, channelId, botId, rv),
          replaceScopeCommandBindingsForBotChange(this.ctx.storage.sql, channelId, botId, rv),
          replaceScopeCommandNamesForBotChange(this.ctx.storage.sql, channelId, botId, rv),
          replaceScopeBotEventSubscriptionsForBotChange(this.ctx.storage.sql, channelId, botId, rv),
          upsertEventChange(this.ctx.storage.sql, installedId),
        ]);
      });

      return { kind: "ok" as const, responseJson: fullResponse };
    });

    if (txResult.kind === "conflict") {
      return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } }, { status: 409 });
    }
    if (txResult.kind === "error") return this.cachedResponse(txResult.j);
    await this.scheduleArchiveAlarm(now);
    return Response.json(JSON.parse(txResult.responseJson));
  }

  /** POST /internal/bot-install-update — uninstall a bot's bindings batch. */
  private async handleBotInstallUpdate(request: Request): Promise<Response> {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return this.botInstallError("UNAUTHORIZED", "missing verified user");
    const kindGate = this.requireChannelKindChannel();
    if (!kindGate.ok) return kindGate.response;
    const b = (await request.json().catch(() => null)) as {
      operation_id?: unknown; channel_id?: unknown; bot_id?: unknown;
      status?: unknown; command_policy?: unknown;
    } | null;
    if (!b || typeof b.operation_id !== "string" || typeof b.channel_id !== "string" || typeof b.bot_id !== "string" || typeof b.status !== "string") {
      return this.botInstallError("INVALID_MESSAGE", "operation_id, channel_id, bot_id, status required");
    }
    const channelId = b.channel_id;
    const botId = b.bot_id;
    const newStatus = b.status;
    const operationId = b.operation_id;
    const operation = "bot.install_update";
    const now = this.nowIso();
    const nowMs = Date.parse(now);
    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    if (newStatus !== "removed") {
      return this.botInstallError("INVALID_MESSAGE", "status must be removed");
    }
    const requestHash = JSON.stringify({ bot_id: botId, status: newStatus });

    const preCheck = this.ctx.storage.sql
      .exec(
        "SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
        userId, operation, operationId, requestHash,
      )
      .toArray()[0] as { response_json: string } | undefined;
    if (preCheck) return this.cachedResponse(preCheck.response_json);

    const actorMap = await this.resolveActorMap([userId]);
    const txResult = this.ctx.storage.transactionSync(() => {
      const idem = this.ctx.storage.sql
        .exec(
          "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=?",
          userId, operation, operationId,
        )
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" as const };
        return { kind: "cached" as const, responseJson: idem.response_json ?? "{}" };
      }

      const meta = this.ctx.storage.sql
        .exec("SELECT status, membership_version FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { status: string; membership_version: number } | undefined;
      if (!meta) return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found" } }) };
      if (meta.status === "dissolved") return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" } }) };

      const callerRole = this.activeRole(channelId, userId);
      if (callerRole !== "owner" && callerRole !== "admin") {
        return { kind: "error" as const, j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner/admin may update bot install" } }) };
      }

      const install = this.ctx.storage.sql
        .exec("SELECT bot_id FROM bot_installations WHERE bot_id=?", botId)
        .toArray()[0] as { bot_id: string } | undefined;
      if (!install) return { kind: "error" as const, j: JSON.stringify({ error: { code: "BOT_NOT_FOUND", message: "bot not installed" } }) };

      this.ctx.storage.sql.exec("DELETE FROM channel_command_names WHERE channel_id=? AND bot_id=?", channelId, botId);
      this.ctx.storage.sql.exec("DELETE FROM channel_command_bindings WHERE channel_id=? AND bot_id=?", channelId, botId);
      this.ctx.storage.sql.exec("DELETE FROM channel_bot_event_subscriptions WHERE channel_id=? AND bot_id=?", channelId, botId);
      this.ctx.storage.sql.exec("UPDATE bot_installations SET status='removed', updated_by=?, updated_at=? WHERE bot_id=?", userId, now, botId);

      const mv = meta.membership_version;
      const updatedId = this.nextEventId(nowMs);
      this.persistEventAndFanout(
        updatedId, "bot.updated", channelId, now,
        buildBotUpdatedPayload({
          channel_id: channelId, bot_id: botId, status: newStatus,
          changes: { status: { before: "active", after: newStatus } },
          actor_kind: "user", actor_id: userId,
        }),
        mv, now, actorMap,
      );

      const responseBody = { bot_id: botId, status: newStatus };
      const fullResponse = JSON.stringify(responseBody);
      this.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, ?, ?, ?, ?, 'completed', ?, ?)",
        userId, operation, operationId, requestHash, fullResponse, now, idemExpiresAt,
      );

      appendChatChannelArchive(this.ctx, channelId, now, [updatedId], (sourceSeq) => {
        const rv = rvEvent(updatedId);
        return collectDefinedChanges([
          upsertBotInstallationChange(this.ctx.storage.sql, channelId, botId, rv),
          replaceScopeCommandBindingsForBotChange(this.ctx.storage.sql, channelId, botId, rv),
          replaceScopeCommandNamesForBotChange(this.ctx.storage.sql, channelId, botId, rv),
          replaceScopeBotEventSubscriptionsForBotChange(this.ctx.storage.sql, channelId, botId, rv),
          upsertEventChange(this.ctx.storage.sql, updatedId),
        ]);
      });

      return { kind: "ok" as const, responseJson: fullResponse };
    });

    if (txResult.kind === "conflict") {
      return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } }, { status: 409 });
    }
    if (txResult.kind === "error") return this.cachedResponse(txResult.j);
    await this.scheduleArchiveAlarm(now);
    return Response.json(JSON.parse(txResult.responseJson));
  }

  /** POST /internal/command-binding-update — enable/disable a single command binding + permission override. */
  private async handleCommandBindingUpdate(request: Request): Promise<Response> {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return this.botInstallError("UNAUTHORIZED", "missing verified user");
    const kindGate = this.requireChannelKindChannel();
    if (!kindGate.ok) return kindGate.response;
    const b = (await request.json().catch(() => null)) as {
      operation_id?: unknown; channel_id?: unknown; bot_command_id?: unknown;
      enabled?: unknown; permission_override?: unknown;
    } | null;
    if (!b || typeof b.operation_id !== "string" || typeof b.channel_id !== "string" || typeof b.bot_command_id !== "string" || typeof b.enabled !== "boolean") {
      return this.botInstallError("INVALID_MESSAGE", "operation_id, channel_id, bot_command_id, enabled required");
    }
    const channelId = b.channel_id;
    const botCommandId = b.bot_command_id;
    const enabled = b.enabled;
    const permissionOverride = typeof b.permission_override === "string" ? b.permission_override : null;
    const operationId = b.operation_id;
    const operation = "bot.command_binding_update";
    const now = this.nowIso();
    const nowMs = Date.parse(now);
    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    const requestHash = JSON.stringify({ bot_command_id: botCommandId, enabled, permission_override: permissionOverride });

    const preCheck = this.ctx.storage.sql
      .exec(
        "SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
        userId, operation, operationId, requestHash,
      )
      .toArray()[0] as { response_json: string } | undefined;
    if (preCheck) return this.cachedResponse(preCheck.response_json);

    const actorMap = await this.resolveActorMap([userId]);
    const txResult = this.ctx.storage.transactionSync(() => {
      const idem = this.ctx.storage.sql
        .exec(
          "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=?",
          userId, operation, operationId,
        )
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" as const };
        return { kind: "cached" as const, responseJson: idem.response_json ?? "{}" };
      }

      const meta = this.ctx.storage.sql
        .exec("SELECT status, membership_version FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { status: string; membership_version: number } | undefined;
      if (!meta) return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found" } }) };
      if (meta.status === "dissolved") return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" } }) };

      const callerRole = this.activeRole(channelId, userId);
      if (callerRole !== "owner" && callerRole !== "admin") {
        return { kind: "error" as const, j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner/admin may update command bindings" } }) };
      }

      const binding = this.ctx.storage.sql
        .exec("SELECT binding_id, bot_id, name, aliases_json, status FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?", channelId, botCommandId)
        .toArray()[0] as { binding_id: string; bot_id: string; name: string; aliases_json: string; status: string } | undefined;
      if (!binding) return { kind: "error" as const, j: JSON.stringify({ error: { code: "COMMAND_NOT_FOUND", message: "command binding not found" } }) };

      if (enabled) {
        const aliases = JSON.parse(binding.aliases_json) as string[];
        for (const slashName of [binding.name, ...aliases]) {
          const clash = this.ctx.storage.sql
            .exec("SELECT 1 FROM channel_command_names WHERE channel_id=? AND slash_name=? AND bot_command_id!=?", channelId, slashName, botCommandId)
            .toArray()[0];
          if (clash) return { kind: "error" as const, j: JSON.stringify({ error: { code: "COMMAND_NAME_CONFLICT", message: `slash token already in use: ${slashName}` } }) };
        }
      }

      this.ctx.storage.sql.exec(
        "UPDATE channel_command_bindings SET status=?, permission_override=?, updated_by=?, updated_at=? WHERE binding_id=?",
        enabled ? "enabled" : "disabled", permissionOverride, userId, now, binding.binding_id,
      );

      if (enabled) {
        const aliases = JSON.parse(binding.aliases_json) as string[];
        for (const slashName of [binding.name, ...aliases]) {
          this.ctx.storage.sql.exec(
            "INSERT INTO channel_command_names (channel_id, slash_name, bot_command_id, bot_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(channel_id, slash_name) DO UPDATE SET bot_command_id=excluded.bot_command_id, bot_id=excluded.bot_id, kind=excluded.kind",
            channelId, slashName, botCommandId, binding.bot_id, slashName === binding.name ? "canonical" : "alias", now,
          );
        }
      } else {
        this.ctx.storage.sql.exec("DELETE FROM channel_command_names WHERE channel_id=? AND bot_command_id=?", channelId, botCommandId);
      }

      const mv = meta.membership_version;
      const beforeStatus = binding.status;
      const afterStatus = enabled ? "enabled" : "disabled";
      const bindingUpdatedId = this.nextEventId(nowMs);
      this.persistEventAndFanout(
        bindingUpdatedId, "command.binding_updated", channelId, now,
        buildCommandBindingUpdatedPayload({
          channel_id: channelId, bot_id: binding.bot_id, bot_command_id: botCommandId,
          binding_changes: { enabled: { before: beforeStatus, after: afterStatus } },
          actor_kind: "user", actor_id: userId,
          // TODO(Task 9): replace with real manifest delta from command-manifest builders
          command_manifest_delta: {
            op: enabled ? "upsert" : "remove",
            manifest_version: 0,
          },
        }),
        mv, now, actorMap,
      );

      const responseBody = { bot_command_id: botCommandId, enabled, permission_override: permissionOverride };
      const fullResponse = JSON.stringify(responseBody);
      this.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, ?, ?, ?, ?, 'completed', ?, ?)",
        userId, operation, operationId, requestHash, fullResponse, now, idemExpiresAt,
      );

      appendChatChannelArchive(this.ctx, channelId, now, [bindingUpdatedId], (sourceSeq) => {
        const rv = rvEvent(bindingUpdatedId);
        return collectDefinedChanges([
          upsertCommandBindingChange(this.ctx.storage.sql, binding.binding_id, rv),
          replaceScopeCommandNamesForBindingChange(this.ctx.storage.sql, channelId, botCommandId, rv),
          upsertEventChange(this.ctx.storage.sql, bindingUpdatedId),
        ]);
      });

      return { kind: "ok" as const, responseJson: fullResponse };
    });

    if (txResult.kind === "conflict") {
      return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } }, { status: 409 });
    }
    if (txResult.kind === "error") return this.cachedResponse(txResult.j);
    await this.scheduleArchiveAlarm(now);
    return Response.json(JSON.parse(txResult.responseJson));
  }

  private async flushProjectionOutboxRows(rows: OutboxRow[], nowIso: string): Promise<void> {
    for (const r of rows) {
      if (r.target_kind === "user_directory") {
        const req = new Request("https://x/internal/upsert-channel", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Verified-User-Id": r.target_key,
          },
          body: r.payload_json,
        });
        const target = this.env.USER_DIRECTORY.getByName(r.target_key);
        try {
          const res = await target.fetch(req);
          if (!res.ok) {
            const text = await res.text();
            await this.bumpOutboxRetry(r.outbox_id, nowIso, `${res.status}: ${text}`);
            continue;
          }
          this.ctx.storage.sql.exec(
            "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
            nowIso,
            r.outbox_id,
          );
          let payload: { action?: string; channel_id?: string; membership_version?: number } = {};
          try {
            const parsed = JSON.parse(r.payload_json) as { action?: unknown; channel_id?: unknown; membership_version?: unknown };
            payload = {
              action: typeof parsed.action === "string" ? parsed.action : undefined,
              channel_id: typeof parsed.channel_id === "string" ? parsed.channel_id : undefined,
              membership_version: typeof parsed.membership_version === "number" ? parsed.membership_version : undefined,
            };
          } catch {
            payload = {};
          }
          await this.notifyLiveMembershipChanged(r.target_key, payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
        }
        continue;
      }

      if (r.target_kind === "invite_directory") {
        const target = this.env.INVITE_DIRECTORY.getByName("shared");
        try {
          const res = await target.fetch(new Request("https://x/upsert", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: r.payload_json,
          }));
          if (!res.ok) {
            const text = await res.text();
            await this.bumpOutboxRetry(r.outbox_id, nowIso, `${res.status}: ${text}`);
            continue;
          }
          this.ctx.storage.sql.exec(
            "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
            nowIso,
            r.outbox_id,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
        }
        continue;
      }

      if (r.target_kind === "channel_directory") {
        const target = this.env.CHANNEL_DIRECTORY.getByName("shared");
        try {
          const res = await target.fetch(new Request("https://x/internal/apply-projection", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: r.payload_json,
          }));
          if (!res.ok) {
            const text = await res.text();
            await this.bumpOutboxRetry(r.outbox_id, nowIso, `${res.status}: ${text}`);
            continue;
          }
          this.ctx.storage.sql.exec(
            "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
            nowIso,
            r.outbox_id,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
        }
        continue;
      }

      if (r.target_kind === "channel_fanout") {
        let payload: { action?: string; event_id?: string; event_json?: string; membership_version_at_event?: number; user_id?: string };
        try {
          payload = JSON.parse(r.payload_json) as {
            action?: string;
            event_id?: string;
            event_json?: string;
            membership_version_at_event?: number;
            user_id?: string;
          };
        } catch {
          await this.bumpOutboxRetry(r.outbox_id, nowIso, "invalid payload_json");
          continue;
        }

        const target = this.env.CHANNEL_FANOUT.getByName(r.target_key);
        let res: Response;
        try {
          if (payload.action === "unregister-user") {
            res = await target.fetch(new Request("https://x/unregister-user", {
              method: "POST",
              headers: {
                "X-Channel-Id": r.target_key,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ user_id: payload.user_id ?? "" }),
            }));
          } else {
            res = await target.fetch(new Request("https://x/fanout-enqueue", {
              method: "POST",
              headers: {
                "X-Channel-Id": r.target_key,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                event_id: payload.event_id ?? "",
                event_json: payload.event_json ?? "",
                membership_version_at_event: payload.membership_version_at_event ?? 0,
              }),
            }));
          }
          if (!res.ok) {
            const text = await res.text();
            await this.bumpOutboxRetry(r.outbox_id, nowIso, `${res.status}: ${text}`);
            continue;
          }
          this.ctx.storage.sql.exec(
            "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
            nowIso,
            r.outbox_id,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
        }
        continue;
      }

      await this.bumpOutboxRetry(r.outbox_id, nowIso, `unsupported target_kind=${r.target_kind}`);
    }
  }

  async alarm(): Promise<void> {
    const nowIso = this.nowIso();
    await runDueJobs(this.ctx, nowIso, this.outboxDueTables(async (rows) => {
      await this.flushProjectionOutboxRows(rows as unknown as OutboxRow[], nowIso);
    }));
    try {
      await flushArchiveOutboxToQueue(this.ctx, this.env.CHAT_ARCHIVE_QUEUE, { now: nowIso });
    } catch {
      // Archive flush failure must not block projection retry scheduling.
    }
    await this.scheduleOutboxAlarm(nowIso);
  }
}
