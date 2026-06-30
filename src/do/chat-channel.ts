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
import type { CommandInvocationReplyContext, MessageImageAttachment, WireChatMessage } from "../contract/message";
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
import { botStreamDoName } from "./bot-stream-connection";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  replaceScopeMentionsChange,
  rvEvent,
  upsertAuditLogChange,
  upsertCommandBindingChange,
  upsertCommandInvocationChange,
  upsertEventChange,
  upsertMessageChange,
  upsertMessageEditChange,
} from "../archive/chat-channel-record";
import type { UserDirectoryOutboxPayload } from "../contract/outbox";
import type { CommandManifestItem } from "../contract/bot-api";
import { personalInviteCode } from "../chat/invite-code";
import { HTTP_STATUS_BY_CODE } from "../errors";
import { resolveUserSummaries } from "../profile/resolve";
import { fallbackUserDisplayName } from "../contract/primitives";
import { isRecord } from "../contract/utils";
import type { ChatChannelHost } from "./chat-channel/host";
import { dispatchReadRoutes } from "./chat-channel/routes/read-routes";
import { dispatchMessageRoutes } from "./chat-channel/routes/message-routes";
import { dispatchMembershipRoutes } from "./chat-channel/routes/membership-routes";
import { dispatchChannelRoutes } from "./chat-channel/routes/channel-routes";
import { dispatchBotRoutes } from "./chat-channel/routes/bot-routes";
import { dispatchStreamRoutes } from "./chat-channel/routes/stream-routes";
import {
  handleStatefulCommandInvoke,
  flushStatefulSessionTimeouts,
  maybeEnqueueStatefulSessionInput,
  type StatefulSessionHost,
} from "./chat-channel/stateful-session-handlers";
import { buildManifestRemoveDelta, buildManifestUpsertDelta, appendPlatformHelpItem, projectCommandManifest } from "../chat/command-manifest";
import { parseCommandBindingSnapshot } from "../chat/command-snapshot";
import type { CommandOption } from "../chat/command-options";
import {
  mergeOfficialIntoBindingRows,
  isOfficialCommandId,
  officialCommandToSnapshot,
  type ChannelBindingRow,
  type OfficialCommandCatalogItem,
} from "../chat/official-command-manifest";
import {
  PLATFORM_BOT_AVATAR_URL,
  PLATFORM_BOT_DISPLAY_NAME,
  PLATFORM_BOT_ID,
  PLATFORM_HELP_BOT_COMMAND_ID,
  PLATFORM_HELP_NAME,
  buildPlatformHelpText,
  isPlatformHelpCommand,
} from "../chat/platform-commands";
import {
  flushStatefulBotDeliveryRow,
  STATEFUL_BOT_DELIVERY_KINDS,
} from "../chat/stateful-bot-delivery";
import { invokedNameMatchesSnapshot } from "../chat/slash-token";
import { buildReplySnapshot, loadReplySnapshotMedia, replyTargetSenderDisplayName } from "../chat/reply-snapshot";
import { projectCommandInvokeReplyContext } from "../chat/command-invoke-reply";
import { insertUserCommandInvocationMessage, type InvocationMessageHost } from "./chat-channel/invocation-message";

interface OutboxRow {
  outbox_id: string;
  target_kind: string;
  target_key: string;
  payload_json: string;
}

interface BotDeliveryOutboxRow {
  outbox_id: string;
  channel_id: string;
  bot_id: string;
  kind:
    | "command_invocation"
    | "message_interaction"
    | "message_event"
    | "stateful_session_start"
    | "stateful_session_ref_upsert"
    | "stateful_session_input"
    | "stateful_session_close";
  invocation_id: string | null;
  interaction_id: string | null;
  event_id: string | null;
  request_json: string;
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

  private async resolveCommandInvokeReplyContext(
    channelId: string,
    replyToMessageId: string | null,
  ): Promise<
    | { ok: true; reply_to: CommandInvocationReplyContext | null; reply_snapshot_json: string | null }
    | { ok: false; code: string; message: string }
  > {
    if (!replyToMessageId) return { ok: true, reply_to: null, reply_snapshot_json: null };

    const targetRow = this.ctx.storage.sql
      .exec(
        `SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id,
                sender_bot_display_name, sender_bot_avatar_url, type, format, status, text, reply_to,
                reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at,
                deleted_by, recalled_at
         FROM messages WHERE message_id=? AND channel_id=?`,
        replyToMessageId,
        channelId,
      )
      .toArray()[0] as MessageRow | undefined;
    if (!targetRow || (targetRow.status !== "normal" && targetRow.status !== "edited")) {
      return { ok: false, code: "MESSAGE_NOT_FOUND", message: "reply target not found" };
    }

    let senderSummary: LiveUserSummary | null = null;
    if (targetRow.sender_kind === "user" && targetRow.sender_user_id) {
      const actorMap = await this.resolveActorMap([targetRow.sender_user_id]);
      senderSummary = actorMap.get(targetRow.sender_user_id) ?? null;
    }

    const targetSenderDisplayName = senderSummary?.display_name ?? replyTargetSenderDisplayName(targetRow);
    const mediaPreview = loadReplySnapshotMedia(
      this.ctx.storage.sql,
      targetRow.message_id,
      targetRow.type,
    );

    return {
      ok: true,
      reply_to: projectCommandInvokeReplyContext(targetRow, senderSummary),
      reply_snapshot_json: JSON.stringify(
        buildReplySnapshot(targetRow, targetSenderDisplayName, { mediaPreview }),
      ),
    };
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
          "SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at, invocation_json FROM messages WHERE message_id=? AND channel_id=?",
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
        invocation_json: updatedRow.invocation_json,
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
      [
        ...this.outboxDueTables(async () => Promise.resolve()),
        ...this.statefulSessionDueTables(),
        ...this.streamRegistryDueTables(),
        archiveOutboxDueTable(),
      ],
      { respectExistingAlarm: true },
    );
  }

  async scheduleArchiveAlarm(nowIso?: string): Promise<void> {
    await this.scheduleOutboxAlarm(nowIso);
  }

  private outboxDueTables(handler: (rows: DueRow[]) => Promise<void>): DueTable[] {
    return [
      isoDueTable("projection_outbox", "next_attempt_at", "status", "pending", handler),
      isoDueTable("bot_delivery_outbox", "next_attempt_at", "status", "pending", handler),
    ];
  }

  private statefulSessionDueTables(): DueTable[] {
    const host = this as unknown as StatefulSessionHost;
    const flush = async () => {
      await flushStatefulSessionTimeouts(host, this.nowIso());
    };
    return [
      isoDueTable("stateful_command_sessions", "expires_at", "status", "active", flush),
      isoDueTable("stateful_command_sessions", "started_at", "status", "starting", flush),
    ];
  }

  private streamRegistryDueTables(): DueTable[] {
    return [
      isoDueTable("message_stream_registry", "expires_at", "status", "streaming", async (rows) => {
        for (const row of rows) {
          const channelId = row.channel_id;
          const messageId = row.message_id;
          const botId = row.bot_id;
          if (typeof channelId !== "string" || typeof messageId !== "string" || typeof botId !== "string") {
            continue;
          }
          const streamDo = this.env.BOT_STREAM_CONNECTION.getByName(botStreamDoName(channelId, messageId));
          await streamDo.fetch(
            new Request("https://x/internal/expire-stream", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                channel_id: channelId,
                message_id: messageId,
                bot_id: botId,
              }),
            }),
          );
        }
      }),
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

  private async bumpBotDeliveryRetry(outboxId: string, nowIso: string, error: string): Promise<void> {
    bumpQueueRetry(this.ctx.storage.sql, {
      table: "bot_delivery_outbox",
      idColumn: "outbox_id",
      id: outboxId,
      nowIso,
      error,
      maxAttempts: OUTBOX_MAX_ATTEMPTS,
    });
  }

  private async flushBotDeliveryOutboxRows(rows: BotDeliveryOutboxRow[], nowIso: string): Promise<void> {
    for (const row of rows) {
      if (
        row.kind === STATEFUL_BOT_DELIVERY_KINDS.sessionStart ||
        row.kind === STATEFUL_BOT_DELIVERY_KINDS.sessionRefUpsert ||
        row.kind === STATEFUL_BOT_DELIVERY_KINDS.sessionInput ||
        row.kind === STATEFUL_BOT_DELIVERY_KINDS.sessionClose
      ) {
        try {
          const result = await flushStatefulBotDeliveryRow(this.env, this.ctx.storage.sql, row, nowIso);
          if (!result.ok) {
            await this.bumpBotDeliveryRetry(row.outbox_id, nowIso, result.error);
            continue;
          }
          this.ctx.storage.sql.exec(
            "UPDATE bot_delivery_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
            nowIso,
            row.outbox_id,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpBotDeliveryRetry(row.outbox_id, nowIso, msg);
        }
        continue;
      }

      const targetId = row.kind === "command_invocation"
        ? row.invocation_id
        : row.kind === "message_interaction"
          ? row.interaction_id
          : row.event_id;
      if (!targetId) {
        await this.bumpBotDeliveryRetry(row.outbox_id, nowIso, "missing target id");
        continue;
      }
      const target = this.env.BOT_CONNECTION.getByName(row.bot_id);
      try {
        const res = await target.fetch(
          new Request("https://x/internal/enqueue-delivery", {
            method: "POST",
            headers: {
              "X-Verified-Bot-Id": row.bot_id,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              outbox_id: row.outbox_id,
              channel_id: row.channel_id,
              kind: row.kind,
              target_id: targetId,
              request_json: row.request_json,
            }),
          }),
        );
        if (!res.ok) {
          const text = await res.text();
          await this.bumpBotDeliveryRetry(row.outbox_id, nowIso, `${res.status}: ${text}`);
          continue;
        }
        this.ctx.storage.sql.exec(
          "UPDATE bot_delivery_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
          nowIso,
          row.outbox_id,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.bumpBotDeliveryRetry(row.outbox_id, nowIso, msg);
      }
    }
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

    const streamResponse = await dispatchStreamRoutes(host, request, url);
    if (streamResponse !== null) return streamResponse;

    return new Response("not found", { status: 404 });
  }

  // ─── Slash command binding internals ───

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

  private parseInvokeSnapshot(raw: string) {
    return parseCommandBindingSnapshot(raw);
  }

  private validateInvokeOptions(
    provided: Record<string, { type: string; value: unknown }>,
    schemaOptions: CommandOption[],
  ): { ok: true } | { ok: false; message: string } {
    const schemaByName = new Map(schemaOptions.map((option) => [option.name, option]));

    for (const option of schemaOptions) {
      if (option.required && !provided[option.name]) {
        return { ok: false, message: `missing required option: ${option.name}` };
      }
    }

    for (const [name, value] of Object.entries(provided)) {
      const schema = schemaByName.get(name);
      if (!schema) {
        return { ok: false, message: `unknown option: ${name}` };
      }
      if (schema.type !== value.type) {
        return { ok: false, message: `option ${name} type mismatch` };
      }
      if (schema.type === "string") {
        if (typeof value.value !== "string") return { ok: false, message: `option ${name} must be string` };
      } else if (schema.type === "integer") {
        if (typeof value.value !== "number" || !Number.isInteger(value.value)) {
          return { ok: false, message: `option ${name} must be integer` };
        }
        if (typeof schema.min === "number" && value.value < schema.min) {
          return { ok: false, message: `option ${name} below min` };
        }
        if (typeof schema.max === "number" && value.value > schema.max) {
          return { ok: false, message: `option ${name} above max` };
        }
      } else if (schema.type === "number") {
        if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
          return { ok: false, message: `option ${name} must be number` };
        }
        if (typeof schema.min === "number" && value.value < schema.min) {
          return { ok: false, message: `option ${name} below min` };
        }
        if (typeof schema.max === "number" && value.value > schema.max) {
          return { ok: false, message: `option ${name} above max` };
        }
      } else if (schema.type === "boolean") {
        if (typeof value.value !== "boolean") return { ok: false, message: `option ${name} must be boolean` };
      } else if (typeof value.value !== "string" || value.value.length === 0) {
        return { ok: false, message: `option ${name} must be non-empty string` };
      }
    }

    return { ok: true };
  }

  private async fetchOfficialCatalog(): Promise<OfficialCommandCatalogItem[]> {
    const res = await this.env.BOT_REGISTRY.getByName("registry").fetch(
      new Request("https://x/internal/official-commands"),
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: OfficialCommandCatalogItem[] };
    return Array.isArray(body.items) ? body.items : [];
  }

  private readChannelBindingRows(channelId: string): ChannelBindingRow[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT bot_command_id, bot_id, status, command_snapshot_json, permission_override
         FROM channel_command_bindings
         WHERE channel_id=?`,
        channelId,
      )
      .toArray() as unknown as ChannelBindingRow[];
  }

  private async buildMergedManifest(
    channelId: string,
    manifestVersion: number,
  ): Promise<ReturnType<typeof appendPlatformHelpItem>> {
    const bindingRows = this.readChannelBindingRows(channelId);
    const officialCatalog = await this.fetchOfficialCatalog();
    const merged = mergeOfficialIntoBindingRows(bindingRows, officialCatalog);
    return appendPlatformHelpItem(projectCommandManifest(manifestVersion, merged));
  }

  /** GET /internal/channel-commands?channel_id=...&user_id=... — read full command manifest. */
  private async handleChannelCommands(request: Request): Promise<Response> {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return this.botInstallError("UNAUTHORIZED", "missing verified user");

    const url = new URL(request.url);
    const channelId = url.searchParams.get("channel_id") ?? "";
    if (!channelId) return this.botInstallError("CHANNEL_NOT_FOUND", "channel_id required");

    const meta = this.ctx.storage.sql
      .exec("SELECT status, command_manifest_version FROM channel_meta WHERE channel_id=?", channelId)
      .toArray()[0] as { status: string; command_manifest_version: number } | undefined;
    if (!meta) return this.botInstallError("CHANNEL_NOT_FOUND", "channel not found");
    if (meta.status === "dissolved") return this.botInstallError("CHANNEL_DISSOLVED", "channel is dissolved");

    const callerRole = this.activeRole(channelId, userId);
    if (!callerRole) return this.botInstallError("FORBIDDEN", "not a channel member");

    const fullManifest = await this.buildMergedManifest(channelId, meta.command_manifest_version);
    return Response.json({
      version: fullManifest.version,
      items: fullManifest.items.filter((item) =>
        this.hasRolePermission(callerRole, item.effective_member_permission),
      ),
    });
  }

  /** GET /internal/command-manifest?channel_id=... — bootstrap-local command manifest projection. */
  private async handleCommandManifest(request: Request): Promise<Response> {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return this.botInstallError("UNAUTHORIZED", "missing verified user");

    const url = new URL(request.url);
    const channelId = url.searchParams.get("channel_id") ?? "";
    if (!channelId) return this.botInstallError("CHANNEL_NOT_FOUND", "channel_id required");

    const meta = this.ctx.storage.sql
      .exec("SELECT kind, status, command_manifest_version FROM channel_meta WHERE channel_id=?", channelId)
      .toArray()[0] as { kind: string; status: string; command_manifest_version: number } | undefined;
    if (!meta) return this.botInstallError("CHANNEL_NOT_FOUND", "channel not found");
    if (meta.status === "dissolved") return this.botInstallError("CHANNEL_DISSOLVED", "channel is dissolved");
    if (meta.kind === "dm") return Response.json({ version: 0, items: [] });

    const callerRole = this.activeRole(channelId, userId);
    if (!callerRole) return this.botInstallError("FORBIDDEN", "not a channel member");

    const fullManifest = await this.buildMergedManifest(channelId, meta.command_manifest_version);
    return Response.json(fullManifest);
  }

  /** POST /internal/command-invoke — validate invoke and enqueue bot delivery. */
  private async handleCommandInvoke(request: Request): Promise<Response> {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return this.botInstallError("UNAUTHORIZED", "missing verified user");

    const b = (await request.json().catch(() => null)) as {
      operation_id?: unknown;
      channel_id?: unknown;
      bot_command_id?: unknown;
      invoked_name?: unknown;
      command_manifest_version?: unknown;
      options?: unknown;
      reply_to_message_id?: unknown;
    } | null;
    if (
      !b ||
      typeof b.operation_id !== "string" ||
      typeof b.channel_id !== "string" ||
      typeof b.bot_command_id !== "string" ||
      typeof b.command_manifest_version !== "number" ||
      !isRecord(b.options)
    ) {
      return this.botInstallError("INVALID_MESSAGE", "invalid command.invoke payload");
    }

    const operation = "command.invoke";
    const operationId = b.operation_id;
    const channelId = b.channel_id;
    const botCommandId = b.bot_command_id;
    const invokedName = typeof b.invoked_name === "string" ? b.invoked_name : "";
    const commandManifestVersion = b.command_manifest_version;
    const options = b.options as Record<string, { type: string; value: unknown }>;
    const replyToMessageId =
      typeof b.reply_to_message_id === "string" && b.reply_to_message_id.length > 0
        ? b.reply_to_message_id
        : null;
    const now = this.nowIso();
    const nowMs = Date.parse(now);
    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    const requestHash = JSON.stringify({
      channel_id: channelId,
      bot_command_id: botCommandId,
      invoked_name: invokedName,
      command_manifest_version: commandManifestVersion,
      options,
      reply_to_message_id: replyToMessageId,
    });

    const preCheck = this.ctx.storage.sql
      .exec(
        "SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
        userId,
        operation,
        operationId,
        requestHash,
      )
      .toArray()[0] as { response_json: string } | undefined;
    if (preCheck) return this.cachedResponse(preCheck.response_json);

    const meta = this.ctx.storage.sql
      .exec(
        "SELECT kind, status, membership_version, command_manifest_version FROM channel_meta WHERE channel_id=?",
        channelId,
      )
      .toArray()[0] as { kind: string; status: string; membership_version: number; command_manifest_version: number } | undefined;
    if (!meta) return this.botInstallError("CHANNEL_NOT_FOUND", "channel not found");
    if (meta.kind === "dm") return this.dmChannelManagementError();
    if (meta.status === "dissolved") return this.botInstallError("CHANNEL_DISSOLVED", "channel is dissolved");

    const callerRole = this.activeRole(channelId, userId);
    if (!callerRole) return this.botInstallError("FORBIDDEN", "not a channel member");

    if (commandManifestVersion !== meta.command_manifest_version) {
      return Response.json(
        {
          error: {
            code: "COMMAND_MANIFEST_VERSION_STALE",
            message: "command manifest version is stale",
            retryable: false,
            current_command_manifest_version: meta.command_manifest_version,
          },
        },
        { status: HTTP_STATUS_BY_CODE.COMMAND_MANIFEST_VERSION_STALE ?? 409 },
      );
    }

    if (isPlatformHelpCommand(botCommandId)) {
      return this.handlePlatformHelpInvoke({
        userId,
        channelId,
        operationId,
        commandManifestVersion,
        options,
        requestHash,
        idemExpiresAt,
        now,
        nowMs,
        membershipVersion: meta.membership_version,
      });
    }

    const binding = this.ctx.storage.sql
      .exec(
        "SELECT bot_id, status, permission_override, command_snapshot_json, stateful_max_ttl_seconds FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
        channelId,
        botCommandId,
      )
      .toArray()[0] as {
        bot_id: string;
        status: string;
        permission_override: string | null;
        command_snapshot_json: string;
        stateful_max_ttl_seconds: number | null;
      } | undefined;

    const officialCatalog = await this.fetchOfficialCatalog();
    let bindingBotId: string;
    let bindingPermissionOverride: string | null;
    let bindingMaxTtl: number | null;
    let snapshot = null as ReturnType<typeof this.parseInvokeSnapshot>;

    if (binding?.status === "blocked") {
      return Response.json(
        {
          error: {
            code: "COMMAND_NOT_ALLOWED",
            message: "This slash command is not allowed in this channel.",
            retryable: false,
            current_command_manifest_version: meta.command_manifest_version,
          },
        },
        { status: HTTP_STATUS_BY_CODE.COMMAND_NOT_ALLOWED ?? 403 },
      );
    }

    if (binding?.status === "allowed") {
      snapshot = this.parseInvokeSnapshot(binding.command_snapshot_json);
      bindingBotId = binding.bot_id;
      bindingPermissionOverride = binding.permission_override;
      bindingMaxTtl = binding.stateful_max_ttl_seconds;
    } else {
      const officialItem = officialCatalog.find((item) => item.bot_command_id === botCommandId);
      if (!officialItem) {
        return Response.json(
          {
            error: {
              code: "COMMAND_NOT_ALLOWED",
              message: "This slash command is not allowed in this channel.",
              retryable: false,
              current_command_manifest_version: meta.command_manifest_version,
            },
          },
          { status: HTTP_STATUS_BY_CODE.COMMAND_NOT_ALLOWED ?? 403 },
        );
      }
      snapshot = this.parseInvokeSnapshot(JSON.stringify(officialCommandToSnapshot(officialItem)));
      bindingBotId = officialItem.bot.bot_id;
      bindingPermissionOverride = null;
      bindingMaxTtl = null;
    }

    if (!snapshot) {
      return this.botInstallError("COMMAND_OPTIONS_INVALID", "invalid command snapshot");
    }
    const requiredRole = bindingPermissionOverride ?? snapshot.default_member_permission;
    if (!this.hasRolePermission(callerRole, requiredRole)) {
      return this.botInstallError("COMMAND_PERMISSION_DENIED", "You do not have permission to use this command.");
    }
    const optionsValidation = this.validateInvokeOptions(options, snapshot.options);
    if (!optionsValidation.ok) {
      return this.botInstallError("COMMAND_OPTIONS_INVALID", optionsValidation.message);
    }
    if (!invokedNameMatchesSnapshot(invokedName, snapshot.name, snapshot.aliases)) {
      return this.botInstallError(
        "COMMAND_OPTIONS_INVALID",
        "invoked_name does not match command canonical name or aliases",
      );
    }

    const connectionRes = await this.env.BOT_CONNECTION.getByName(bindingBotId).fetch(
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

    const actorMap = await this.resolveActorMap([userId]);
    const actor = actorMap.get(userId) ?? {
      user_id: userId,
      display_name: fallbackUserDisplayName(userId),
      avatar_url: null,
    };

    const replyResolution = await this.resolveCommandInvokeReplyContext(channelId, replyToMessageId);
    if (!replyResolution.ok) {
      return this.botInstallError(replyResolution.code, replyResolution.message);
    }
    const invokeReplyTo = replyResolution.reply_to;
    const invokeReplySnapshotJson = replyResolution.reply_snapshot_json;

    if (snapshot.execution.mode === "stateful") {
      return handleStatefulCommandInvoke(this as unknown as StatefulSessionHost, {
        userId,
        channelId,
        botCommandId,
        operationId,
        invokedName,
        options,
        snapshot,
        bindingBotId,
        bindingMaxTtl: bindingMaxTtl,
        requestHash,
        idemExpiresAt,
        actor,
        reply_to: invokeReplyTo,
      });
    }

    const txResult = this.ctx.storage.transactionSync(() => {
      const idem = this.ctx.storage.sql
        .exec(
          "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=?",
          userId,
          operation,
          operationId,
        )
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" as const };
        return { kind: "cached" as const, responseJson: idem.response_json ?? "{}" };
      }

      const currentMeta = this.ctx.storage.sql
        .exec(
          "SELECT status, membership_version, command_manifest_version FROM channel_meta WHERE channel_id=?",
          channelId,
        )
        .toArray()[0] as { status: string; membership_version: number; command_manifest_version: number } | undefined;
      if (!currentMeta) {
        return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found" } }) };
      }
      if (currentMeta.status === "dissolved") {
        return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" } }) };
      }
      if (currentMeta.command_manifest_version !== commandManifestVersion) {
        return {
          kind: "error" as const,
          j: JSON.stringify({
            error: {
              code: "COMMAND_MANIFEST_VERSION_STALE",
              message: "command manifest version is stale",
              current_command_manifest_version: currentMeta.command_manifest_version,
            },
          }),
        };
      }

      const currentBinding = this.ctx.storage.sql
        .exec(
          "SELECT status FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
          channelId,
          botCommandId,
        )
        .toArray()[0] as { status: string } | undefined;
      if (currentBinding?.status === "blocked") {
        return {
          kind: "error" as const,
          j: JSON.stringify({
            error: {
              code: "COMMAND_NOT_ALLOWED",
              message: "This slash command is not allowed in this channel.",
              current_command_manifest_version: currentMeta.command_manifest_version,
            },
          }),
        };
      }

      const currentSnapshot = snapshot;
      if (!currentSnapshot) {
        return {
          kind: "error" as const,
          j: JSON.stringify({ error: { code: "COMMAND_OPTIONS_INVALID", message: "invalid command snapshot" } }),
        };
      }
      const currentRequiredRole = bindingPermissionOverride ?? currentSnapshot.default_member_permission;
      if (!this.hasRolePermission(callerRole, currentRequiredRole)) {
        return {
          kind: "error" as const,
          j: JSON.stringify({ error: { code: "COMMAND_PERMISSION_DENIED", message: "You do not have permission to use this command." } }),
        };
      }
      const currentOptionsValidation = this.validateInvokeOptions(options, currentSnapshot.options);
      if (!currentOptionsValidation.ok) {
        return {
          kind: "error" as const,
          j: JSON.stringify({ error: { code: "COMMAND_OPTIONS_INVALID", message: currentOptionsValidation.message } }),
        };
      }

      const invocationMessage = insertUserCommandInvocationMessage(this as unknown as InvocationMessageHost, {
        userId,
        channelId,
        operationId,
        botCommandId,
        invokedName: invokedName || currentSnapshot.name,
        options,
        now,
        nowMs,
        membershipVersion: currentMeta.membership_version,
        senderSummary: actor,
        messageId: uuidv7(nowMs),
        reply_to: replyToMessageId,
        reply_snapshot_json: invokeReplySnapshotJson,
      });

      const invocationId = uuidv7(nowMs + 1);
      this.ctx.storage.sql.exec(
        `INSERT INTO command_invocations (
           invocation_id, channel_id, command_id, invoker_user_id, bot_id, bot_command_id, command_name,
           invoked_name, command_schema_version, command_definition_hash, options_json,
           status, error_code, error_message, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
        invocationId,
        channelId,
        operationId,
        userId,
        bindingBotId,
        botCommandId,
        currentSnapshot.name,
        invokedName || currentSnapshot.name,
        typeof currentSnapshot.execution.schema_version === "number" ? currentSnapshot.execution.schema_version : 1,
        typeof currentSnapshot.execution.definition_hash === "string"
          ? currentSnapshot.execution.definition_hash
          : `snapshot:${botCommandId}`,
        JSON.stringify(options),
        now,
        now,
      );

      const eventId = this.nextEventId(nowMs + 2);
      const persistedPayload = {
        invocation: { invocation_id: invocationId, status: "pending", created_at: now },
        command_id: operationId,
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'command.invoked', ?, 'user', ?, ?, ?, ?)",
        eventId,
        channelId,
        userId,
        JSON.stringify(persistedPayload),
        currentMeta.membership_version,
        now,
      );
      const frame = buildEventFrame({
        event_id: eventId,
        type: "command.invoked",
        channel_id: channelId,
        occurred_at: now,
        payload: persistedPayload,
      });
      this.insertOutboxRowForFanout(
        channelId,
        eventId,
        JSON.stringify(frame),
        currentMeta.membership_version,
        now,
      );

      const outboxId = `bot_delivery:${channelId}:${invocationId}`;
      this.ctx.storage.sql.exec(
        `INSERT INTO bot_delivery_outbox (
           outbox_id, channel_id, bot_id, kind, invocation_id, interaction_id, event_id, request_json,
           status, attempts, max_attempts, last_error, failed_at, next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'command_invocation', ?, NULL, ?, ?, 'pending', 0, 5, NULL, NULL, ?, ?, ?)`,
        outboxId,
        channelId,
        bindingBotId,
        invocationId,
        eventId,
        JSON.stringify({
          delivery_type: "command_invocation",
          invocation_id: invocationId,
          bot_command: {
            bot_command_id: botCommandId,
            name: currentSnapshot.name,
            invoked_name: invokedName || currentSnapshot.name,
            schema_version: typeof currentSnapshot.execution.schema_version === "number"
              ? currentSnapshot.execution.schema_version
              : 1,
            definition_hash: typeof currentSnapshot.execution.definition_hash === "string"
              ? currentSnapshot.execution.definition_hash
              : `snapshot:${botCommandId}`,
          },
          invoker: actor,
          options,
          ...(invokeReplyTo ? { reply_to: invokeReplyTo } : {}),
        }),
        now,
        now,
        now,
      );

      const responseBody = {
        channel_id: channelId,
        invocation_id: invocationId,
        event_id: eventId,
        invocation_message: invocationMessage.liveMessage,
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, ?, ?, ?, ?, 'completed', ?, ?)",
        userId,
        operation,
        operationId,
        requestHash,
        JSON.stringify(responseBody),
        now,
        idemExpiresAt,
      );

      appendChatChannelArchive(this.ctx, channelId, now, [invocationMessage.invocationEventId, eventId], () =>
        collectDefinedChanges([
          upsertMessageChange(
            this.ctx.storage.sql,
            invocationMessage.invocationMessageId,
            channelId,
            rvEvent(invocationMessage.invocationEventId),
          ),
          upsertCommandInvocationChange(this.ctx.storage.sql, invocationId, rvEvent(eventId)),
          upsertEventChange(this.ctx.storage.sql, invocationMessage.invocationEventId),
          upsertEventChange(this.ctx.storage.sql, eventId),
        ]),
      );

      return { kind: "ok" as const, responseJson: JSON.stringify(responseBody) };
    });

    if (txResult.kind === "conflict") {
      return Response.json(
        { error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } },
        { status: 409 },
      );
    }
    if (txResult.kind === "cached") {
      return this.cachedResponse(txResult.responseJson);
    }
    if (txResult.kind === "error") return this.cachedResponse(txResult.j);
    await this.scheduleArchiveAlarm(now);
    return Response.json(JSON.parse(txResult.responseJson));
  }

  private async handlePlatformHelpInvoke(input: {
    userId: string;
    channelId: string;
    operationId: string;
    commandManifestVersion: number;
    options: Record<string, { type: string; value: unknown }>;
    requestHash: string;
    idemExpiresAt: string;
    now: string;
    nowMs: number;
    membershipVersion: number;
  }): Promise<Response> {
    const operation = "command.invoke";
    const manifest = await this.buildMergedManifest(input.channelId, input.commandManifestVersion);
    const commandOptionRaw = input.options.command?.value;
    const commandOption = typeof commandOptionRaw === "string" ? commandOptionRaw : undefined;
    const helpText = buildPlatformHelpText(manifest.items, commandOption);

    const actorMap = await this.resolveActorMap([input.userId]);
    const senderSummary = actorMap.get(input.userId) ?? {
      user_id: input.userId,
      display_name: fallbackUserDisplayName(input.userId),
      avatar_url: null,
    };

    const txResult = this.ctx.storage.transactionSync(() => {
      const idem = this.ctx.storage.sql
        .exec(
          "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=?",
          input.userId,
          operation,
          input.operationId,
        )
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== input.requestHash) return { kind: "conflict" as const };
        return { kind: "cached" as const, responseJson: idem.response_json ?? "{}" };
      }

      const invocationMessage = insertUserCommandInvocationMessage(this as unknown as InvocationMessageHost, {
        userId: input.userId,
        channelId: input.channelId,
        operationId: input.operationId,
        botCommandId: PLATFORM_HELP_BOT_COMMAND_ID,
        invokedName: PLATFORM_HELP_NAME,
        options: input.options,
        now: input.now,
        nowMs: input.nowMs,
        membershipVersion: input.membershipVersion,
        senderSummary,
        messageId: uuidv7(input.nowMs),
      });

      const messageId = uuidv7(input.nowMs + 1);
      const invocationId = uuidv7(input.nowMs + 2);
      const eventId = this.nextEventId(input.nowMs + 3);
      const replyToMessageId = invocationMessage.invocationMessageId;
      const replySnapshotJson = JSON.stringify(
        buildReplySnapshot(invocationMessage.invocationMessageRow, senderSummary.display_name),
      );

      this.ctx.storage.sql.exec(
        `INSERT INTO messages (
           message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
           sender_bot_id, sender_bot_display_name, sender_bot_avatar_url, type, format, status, text,
           reply_to, reply_snapshot_json, stream_state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'bot', NULL, ?, ?, ?, 'text', 'markdown', 'normal', ?, ?, ?, 'none', ?, ?)`,
        messageId,
        input.operationId,
        `bot:${PLATFORM_BOT_ID}`,
        input.channelId,
        PLATFORM_BOT_ID,
        PLATFORM_BOT_DISPLAY_NAME,
        PLATFORM_BOT_AVATAR_URL,
        helpText,
        replyToMessageId,
        replySnapshotJson,
        input.now,
        input.now,
      );

      this.ctx.storage.sql.exec(
        `INSERT INTO command_invocations (
           invocation_id, channel_id, command_id, invoker_user_id, bot_id, bot_command_id, command_name,
           invoked_name, command_schema_version, command_definition_hash, options_json,
           status, error_code, error_message, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'completed', NULL, NULL, ?, ?, ?)`,
        invocationId,
        input.channelId,
        input.operationId,
        input.userId,
        PLATFORM_BOT_ID,
        PLATFORM_HELP_BOT_COMMAND_ID,
        PLATFORM_HELP_NAME,
        PLATFORM_HELP_NAME,
        `platform:${PLATFORM_HELP_BOT_COMMAND_ID}`,
        JSON.stringify(input.options),
        input.now,
        input.now,
        input.now,
      );

      const messageRow: MessageRow = {
        message_id: messageId,
        command_id: input.operationId,
        channel_id: input.channelId,
        sender_kind: "bot",
        sender_user_id: null,
        sender_bot_id: PLATFORM_BOT_ID,
        sender_bot_display_name: PLATFORM_BOT_DISPLAY_NAME,
        sender_bot_avatar_url: PLATFORM_BOT_AVATAR_URL,
        type: "text",
        format: "markdown",
        status: "normal",
        text: helpText,
        reply_to: replyToMessageId,
        reply_snapshot_json: replySnapshotJson,
        stream_state: "none",
        created_at: input.now,
        updated_at: input.now,
        edited_at: null,
        deleted_at: null,
        deleted_by: null,
        recalled_at: null,
      };

      const liveMessage = projectMessageForBrowser(messageRow, { replyTargetStatus: "normal" });
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
      });
      this.ctx.storage.sql.exec(
        "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'message.created', ?, 'user', ?, ?, ?, ?)",
        eventId,
        input.channelId,
        input.userId,
        JSON.stringify(persistedPayload),
        input.membershipVersion,
        input.now,
      );
      this.insertOutboxRowForFanout(
        input.channelId,
        eventId,
        JSON.stringify(liveEventFrame),
        input.membershipVersion,
        input.now,
      );

      const responseBody = {
        channel_id: input.channelId,
        invocation_id: invocationId,
        event_id: eventId,
        message_id: messageId,
        message: liveMessage,
        invocation_message: invocationMessage.liveMessage,
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, ?, ?, ?, ?, 'completed', ?, ?)",
        input.userId,
        operation,
        input.operationId,
        input.requestHash,
        JSON.stringify(responseBody),
        input.now,
        input.idemExpiresAt,
      );

      appendChatChannelArchive(this.ctx, input.channelId, input.now, [invocationMessage.invocationEventId, eventId], () =>
        collectDefinedChanges([
          upsertMessageChange(
            this.ctx.storage.sql,
            invocationMessage.invocationMessageId,
            input.channelId,
            rvEvent(invocationMessage.invocationEventId),
          ),
          upsertMessageChange(this.ctx.storage.sql, messageId, input.channelId, rvEvent(eventId)),
          upsertCommandInvocationChange(this.ctx.storage.sql, invocationId, rvEvent(eventId)),
          upsertEventChange(this.ctx.storage.sql, invocationMessage.invocationEventId),
          upsertEventChange(this.ctx.storage.sql, eventId),
        ]),
      );

      return { kind: "ok" as const, responseJson: JSON.stringify(responseBody) };
    });

    if (txResult.kind === "conflict") {
      return Response.json(
        { error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } },
        { status: 409 },
      );
    }
    if (txResult.kind === "cached") {
      return this.cachedResponse(txResult.responseJson);
    }
    await this.scheduleArchiveAlarm(input.now);
    return Response.json(JSON.parse(txResult.responseJson));
  }

  /** POST /internal/command-binding-update — allow/block a single command binding. */
  private async handleCommandBindingUpdate(request: Request): Promise<Response> {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return this.botInstallError("UNAUTHORIZED", "missing verified user");
    const kindGate = this.requireChannelKindChannel();
    if (!kindGate.ok) return kindGate.response;
    const b = (await request.json().catch(() => null)) as {
      operation_id?: unknown; channel_id?: unknown; bot_command_id?: unknown;
      status?: unknown;
      permission_override?: unknown;
      stateful_max_ttl_seconds?: unknown;
      command_snapshot?: unknown;
    } | null;
    if (
      !b ||
      typeof b.operation_id !== "string" ||
      typeof b.channel_id !== "string" ||
      typeof b.bot_command_id !== "string" ||
      (b.status !== "allowed" && b.status !== "blocked")
    ) {
      return this.botInstallError(
        "INVALID_MESSAGE",
        "operation_id, channel_id, bot_command_id, status required",
      );
    }
    const channelId = b.channel_id;
    const botCommandId = b.bot_command_id;
    const status = b.status;
    const permissionOverride = typeof b.permission_override === "string" ? b.permission_override : null;
    const statefulMaxTtlSeconds = typeof b.stateful_max_ttl_seconds === "number"
      ? b.stateful_max_ttl_seconds
      : null;
    const commandSnapshot = status === "allowed"
      ? this.validateCommandSnapshot(b.command_snapshot)
      : null;
    if (status === "allowed" && !commandSnapshot) {
      return this.botInstallError("INVALID_MESSAGE", "command_snapshot required for allowed status");
    }

    const officialCatalog = await this.fetchOfficialCatalog();
    if (status === "allowed" && isOfficialCommandId(botCommandId, officialCatalog)) {
      return Response.json(
        {
          error: {
            code: "OFFICIAL_COMMAND_AUTO_ALLOWED",
            message: "official commands are auto-allowed in every channel",
            retryable: false,
          },
        },
        { status: HTTP_STATUS_BY_CODE.OFFICIAL_COMMAND_AUTO_ALLOWED ?? 409 },
      );
    }

    const operationId = b.operation_id;
    const operation = "bot.command_binding_update";
    const now = this.nowIso();
    const nowMs = Date.parse(now);
    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    const requestHash = JSON.stringify({
      bot_command_id: botCommandId,
      status,
      permission_override: permissionOverride,
      stateful_max_ttl_seconds: statefulMaxTtlSeconds,
      command_snapshot: commandSnapshot,
    });

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
        .exec(
          "SELECT status, membership_version, command_manifest_version FROM channel_meta WHERE channel_id=?",
          channelId,
        )
        .toArray()[0] as { status: string; membership_version: number; command_manifest_version: number } | undefined;
      if (!meta) return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found" } }) };
      if (meta.status === "dissolved") return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" } }) };

      const callerRole = this.activeRole(channelId, userId);
      if (callerRole !== "owner" && callerRole !== "admin") {
        return { kind: "error" as const, j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner/admin may update command bindings" } }) };
      }

      const binding = this.ctx.storage.sql
        .exec(
          "SELECT bot_id, status, permission_override, command_snapshot_json FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
          channelId,
          botCommandId,
        )
        .toArray()[0] as {
          bot_id: string;
          status: string;
          permission_override: string | null;
          command_snapshot_json: string;
        } | undefined;

      const beforeStatus = binding?.status ?? "blocked";
      const beforePermission = binding?.permission_override ?? null;
      const beforeSnapshot = binding?.command_snapshot_json ?? null;
      const nextManifestVersion = meta.command_manifest_version + 1;

      let bindingBotId = binding?.bot_id ?? "";
      let snapshotJson = binding?.command_snapshot_json ?? "{}";
      let manifestDelta = buildManifestRemoveDelta(nextManifestVersion);

      if (status === "allowed") {
        if (!commandSnapshot) {
          return {
            kind: "error" as const,
            j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "command_snapshot required for allowed status" } }),
          };
        }
        bindingBotId = commandSnapshot.bot.bot_id;
        snapshotJson = JSON.stringify(commandSnapshot);

        this.ctx.storage.sql.exec(
          `INSERT INTO channel_command_bindings (
             channel_id, bot_command_id, bot_id, status, permission_override,
             command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
           ) VALUES (?, ?, ?, 'allowed', ?, ?, ?, ?, ?)
           ON CONFLICT(channel_id, bot_command_id) DO UPDATE SET
             bot_id=excluded.bot_id,
             status='allowed',
             permission_override=excluded.permission_override,
             command_snapshot_json=excluded.command_snapshot_json,
             stateful_max_ttl_seconds=excluded.stateful_max_ttl_seconds,
             updated_by_user_id=excluded.updated_by_user_id,
             updated_at=excluded.updated_at`,
          channelId,
          botCommandId,
          bindingBotId,
          permissionOverride,
          snapshotJson,
          statefulMaxTtlSeconds,
          userId,
          now,
        );

        const projected = projectCommandManifest(nextManifestVersion, [
          { status: "allowed", command_snapshot_json: snapshotJson, permission_override: permissionOverride },
        ]);
        const item = projected.items[0];
        if (!item) {
          return {
            kind: "error" as const,
            j: JSON.stringify({ error: { code: "INVALID_COMMAND_OPTIONS", message: "invalid command snapshot" } }),
          };
        }
        manifestDelta = buildManifestUpsertDelta(nextManifestVersion, item);
      } else {
        if (!binding) {
          const officialItem = officialCatalog.find((item) => item.bot_command_id === botCommandId);
          if (!officialItem) {
            return {
              kind: "error" as const,
              j: JSON.stringify({ error: { code: "COMMAND_NOT_FOUND", message: "command binding not found" } }),
            };
          }
          bindingBotId = officialItem.bot.bot_id;
          snapshotJson = JSON.stringify(officialCommandToSnapshot(officialItem));
          this.ctx.storage.sql.exec(
            `INSERT INTO channel_command_bindings (
               channel_id, bot_command_id, bot_id, status, permission_override,
               command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
             ) VALUES (?, ?, ?, 'blocked', ?, ?, ?, ?, ?)`,
            channelId,
            botCommandId,
            bindingBotId,
            permissionOverride,
            snapshotJson,
            statefulMaxTtlSeconds,
            userId,
            now,
          );
        } else {
          this.ctx.storage.sql.exec(
            `UPDATE channel_command_bindings
             SET status='blocked', permission_override=?, updated_by_user_id=?, updated_at=?
             WHERE channel_id=? AND bot_command_id=?`,
            permissionOverride,
            userId,
            now,
            channelId,
            botCommandId,
          );
        }
      }

      this.ctx.storage.sql.exec(
        "UPDATE channel_meta SET command_manifest_version=?, updated_at=? WHERE channel_id=?",
        nextManifestVersion,
        now,
        channelId,
      );

      const mv = meta.membership_version;
      const afterStatus = status;
      const bindingUpdatedId = this.nextEventId(nowMs);
      const bindingChanges: Record<string, { before: unknown; after: unknown }> = {
        status: { before: beforeStatus, after: afterStatus },
      };
      if (beforePermission !== permissionOverride) {
        bindingChanges.permission_override = { before: beforePermission, after: permissionOverride };
      }
      if (status === "allowed" && beforeSnapshot !== snapshotJson) {
        bindingChanges.command_snapshot_json = { before: beforeSnapshot, after: snapshotJson };
      }
      this.persistEventAndFanout(
        bindingUpdatedId, "command.binding_updated", channelId, now,
        buildCommandBindingUpdatedPayload({
          channel_id: channelId,
          bot_id: bindingBotId,
          bot_command_id: botCommandId,
          binding_changes: bindingChanges,
          actor_kind: "user", actor_id: userId,
          command_manifest_delta: manifestDelta,
        }),
        mv, now, actorMap,
      );

      const responseBody = { bot_command_id: botCommandId, status: afterStatus, permission_override: permissionOverride };
      const fullResponse = JSON.stringify(responseBody);
      this.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, ?, ?, ?, ?, 'completed', ?, ?)",
        userId, operation, operationId, requestHash, fullResponse, now, idemExpiresAt,
      );

      appendChatChannelArchive(this.ctx, channelId, now, [bindingUpdatedId], () => {
        const rv = rvEvent(bindingUpdatedId);
        return collectDefinedChanges([
          upsertCommandBindingChange(this.ctx.storage.sql, channelId, botCommandId, rv),
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

  private validateCommandSnapshot(value: unknown): {
    bot_command_id: string;
    name: string;
    aliases: string[];
    description: string;
    bot: CommandManifestItem["bot"];
    options: unknown[];
    default_member_permission: "member" | "admin" | "owner";
    execution: CommandManifestItem["execution"];
  } | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<{
      bot_command_id: unknown;
      name: unknown;
      aliases: unknown;
      description: unknown;
      bot: unknown;
      options: unknown;
      default_member_permission: unknown;
      execution: unknown;
    }>;
    const bot = item.bot as Partial<CommandManifestItem["bot"]> | undefined;
    const execution = item.execution as Partial<CommandManifestItem["execution"]> | undefined;
    if (
      typeof item.bot_command_id !== "string" ||
      typeof item.name !== "string" ||
      !Array.isArray(item.aliases) ||
      typeof item.description !== "string" ||
      !bot ||
      typeof bot.bot_id !== "string" ||
      typeof bot.display_name !== "string" ||
      (bot.avatar_url !== null && typeof bot.avatar_url !== "string") ||
      !Array.isArray(item.options) ||
      !execution ||
      (execution.mode !== "stateless" && execution.mode !== "stateful") ||
      (item.default_member_permission !== "member" &&
        item.default_member_permission !== "admin" &&
        item.default_member_permission !== "owner")
    ) {
      return null;
    }
    return {
      bot_command_id: item.bot_command_id,
      name: item.name,
      aliases: item.aliases.filter((alias): alias is string => typeof alias === "string"),
      description: item.description,
      bot: {
        bot_id: bot.bot_id,
        display_name: bot.display_name,
        avatar_url: bot.avatar_url ?? null,
      },
      options: item.options as unknown[],
      default_member_permission: item.default_member_permission,
      execution: execution as CommandManifestItem["execution"],
    };
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
    await flushStatefulSessionTimeouts(this as unknown as StatefulSessionHost, nowIso);
    await runDueJobs(this.ctx, nowIso, [
      ...this.outboxDueTables(async (rows) => {
      const projectionRows: OutboxRow[] = [];
      const botRows: BotDeliveryOutboxRow[] = [];
      for (const row of rows as unknown as Array<Record<string, unknown>>) {
        if (typeof row.target_kind === "string") {
          projectionRows.push(row as unknown as OutboxRow);
        } else {
          botRows.push(row as unknown as BotDeliveryOutboxRow);
        }
      }
      if (projectionRows.length > 0) {
        await this.flushProjectionOutboxRows(projectionRows, nowIso);
      }
      if (botRows.length > 0) {
        await this.flushBotDeliveryOutboxRows(botRows, nowIso);
      }
    }),
      ...this.streamRegistryDueTables(),
    ]);
    try {
      await flushArchiveOutboxToQueue(this.ctx, this.env.CHAT_ARCHIVE_QUEUE, { now: nowIso });
    } catch {
      // Archive flush failure must not block projection retry scheduling.
    }
    await this.scheduleOutboxAlarm(nowIso);
  }
}
