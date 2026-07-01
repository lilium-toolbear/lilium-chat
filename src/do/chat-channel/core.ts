import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { CHAT_CHANNEL_DO_SCHEMA } from "./data/migrations";
import { migrateDoSchema } from "../shared/sql-migrations";
import { uuidv7, monotonicUuidV7, type EventSeq } from "../../ids/uuidv7";
import {
  buildEventFrame,
  type UserSummary as LiveUserSummary,
} from "../../chat/event-broadcast";
import {
  resolveActorWithMap,
} from "../../chat/channel-events";
import type {
  ManagementPersistedEventType,
  ManagementPersistedPayload,
  ManagementPersistedPayloadByType,
} from "../../contract/persisted";
import { buildReplayEventsPage, type ReplayEnvelope, type ReplayEventsPage } from "../../chat/replay-projection";
import { buildMessageContextPage, type MessageContextPage } from "../../chat/message-context";
import { buildTimelineHistoryPage, type TimelineHistoryPage } from "../../chat/timeline-history";
import type { ChatEventPayloadByType } from "../../contract/events";
import type {
  AcceptInviteApiResponse,
  AcceptInviteRpcInput,
  AddMemberApiResponse,
  AddMemberRpcInput,
  BotDeliveryResultInput,
  BotDeliveryResultResponse,
  ChannelMetaProjection,
  CommandBindingUpdateRpcInput,
  CommandBindingUpdateResponse,
  CommandInvokeResponse,
  CommandManifestResponse,
  CreateChannelRpcInput,
  CreateChannelRpcResult,
  CreateDmApiResponse,
  CreateDmRpcInput,
  CreateInviteApiResponse,
  CreateInviteRpcInput,
  DebugLeaveMemberRpcInput,
  DissolveChannelApiResponse,
  DissolveChannelRpcInput,
  GetInviteRpcInput,
  GetMessageContextRpcInput,
  GetMessagesRpcInput,
  GetStatefulSessionResponse,
  InteractionSubmitResponse,
  InteractionSubmitRpcInput,
  InvitePreviewApiResponse,
  JoinChannelApiResponse,
  JoinChannelRpcInput,
  ListMembersApiResponse,
  MemberProjection,
  MessageMutateRpcInput,
  MessageMutationAckPayload,
  MessageSendRpcInput,
  RemoveMemberApiResponse,
  RemoveMemberRpcInput,
  ResolveVisibleAttachmentRpcInput,
  StatefulSessionInputsResponse,
  StopStatefulSessionResponse,
  StopStatefulSessionRpcInput,
  StreamAbandonResponse,
  StreamFinalizeResponse,
  StreamRegistryCheckResponse,
  StreamRegistryPeekResponse,
  StartStreamEffectResponse,
  TransferOwnerApiResponse,
  TransferOwnerRpcInput,
  UpdateChannelApiResponse,
  UpdateChannelRpcInput,
  UpdateMemberRoleApiResponse,
  UpdateMemberRoleRpcInput,
  VisibleAttachmentResponse,
  BotSessionCloseRpcInput,
  BotSessionInputAckRpcInput,
  BotSessionStartedRpcInput,
  GetStatefulSessionRpcInput,
  StatefulSessionInputsRpcInput,
  StreamAbandonRpcInput,
  StreamFinalizeRpcInput,
  StreamRegistryCheckRpcInput,
  StreamRegistryPeekRpcInput,
  StreamRegistryRegisterRpcInput,
  InvokeCommandRpcInput,
} from "../../contract/chat-channel-rpc";
import type {
  ChannelDirectoryOutboxPayload,
  ChannelDirectorySnapshotFields,
  UserDirectoryOutboxPayload,
} from "../../contract/outbox";
import { OUTBOX_MAX_ATTEMPTS } from "../../contract/outbox";
import { bumpQueueRetry } from "../shared/retry-backoff";
import { isoDueTable, runDueJobs, scheduleNextAlarm, type DueRow, type DueTable } from "../shared/scheduler";
import { flushExpiredPendingBotAttachments } from "./handlers/pending-bot-attachment-gc";
import { rpcErrorMessage, shouldRetryRpcError } from "../shared/rpc-errors";
import { archiveOutboxDueTable, flushArchiveOutboxToQueue } from "../../archive/queue-flush";
import { parseRpcCachedJson } from "../shared/do-rpc";
import { assertTestRoutesEnabled } from "../shared/test-gates";
import { ApiError, logSwallowedError } from "../../errors";
import { botStreamDoName } from "../bot-stream-connection";
import {
  flushStatefulBotDeliveryRow,
  STATEFUL_BOT_DELIVERY_KINDS,
} from "../../chat/stateful-bot-delivery";
import { ChatChannelRepository } from "./data/repository";
import { resolveUserSummaries } from "../../profile/resolve";
import type { ProjectionOutboxPayload } from "../../contract/outbox";
import { asHandlerRef } from "./handler-ref";

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

interface InviteDirectoryUpsertPayload {
  invite_code?: string;
  channel_id?: string;
  status?: string;
  expires_at?: string;
  revoked_at?: string | null;
}

export class ChatChannelCore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateDoSchema(this.ctx, CHAT_CHANNEL_DO_SCHEMA);
  }

  get repo(): ChatChannelRepository {
    return new ChatChannelRepository(this.ctx.storage.sql);
  }

  protected nowIso(): string {
    return new Date().toISOString();
  }

  async getMessages(userId: string, input: GetMessagesRpcInput): Promise<TimelineHistoryPage> {
    return buildTimelineHistoryPage({
      sql: this.ctx.storage.sql,
      env: this.env,
      userId,
      before: input.before,
      after: input.after,
      limit: Math.max(1, Math.min(100, Math.floor(input.limit))),
    });
  }

  async getMessageContext(userId: string, input: GetMessageContextRpcInput): Promise<MessageContextPage> {
    return buildMessageContextPage({
      sql: this.ctx.storage.sql,
      env: this.env,
      userId,
      messageId: input.message_id,
      beforeCount: input.before,
      afterCount: input.after,
    });
  }

  async replayEvents(userId: string, after: string): Promise<{ events: ReplayEnvelope[] }> {
    const page = await buildReplayEventsPage({
      sql: this.ctx.storage.sql,
      env: this.env,
      userId,
      after,
    });
    return {
      events: page.events.map((frame) => ({
        event_id: frame.event_id,
        event_json: JSON.stringify(frame),
      })),
    };
  }

  async replayEventsPage(userId: string, after: string, limit: number): Promise<ReplayEventsPage> {
    return buildReplayEventsPage({
      sql: this.ctx.storage.sql,
      env: this.env,
      userId,
      after,
      limit,
    });
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
    await this.env.USER_CONNECTION.getByName(affectedUserId).liveMembershipsChanged({
      affected_user_id: affectedUserId,
      reason,
      changed_channel_id: payload.channel_id,
      membership_version: payload.membership_version ?? 0,
    });
  }

  // SYNC core: co-atomic leave + fanout unregister outbox. Runs inside a caller transaction.
  // (P0-6: single leave implementation shared by debugLeaveMember and members-remove.)
  protected markMemberLeftAndEnqueueFanoutUnregisterSync(channelId: string, userId: string, nowIso: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE members SET left_at=? WHERE channel_id=? AND user_id=?",
      nowIso, channelId, userId,
    );
    const meta = this.repo.channelMetaMemberCount(channelId);
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
  protected async markMemberLeftAndEnqueueFanoutUnregister(channelId: string, userId: string, nowIso: string): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      this.markMemberLeftAndEnqueueFanoutUnregisterSync(channelId, userId, nowIso);
    });
  }

  protected insertOutboxRowForFanout(
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
  protected readChannelDirectorySnapshot(channelId: string, nowIso: string): ChannelDirectorySnapshotFields | null {
    const meta = this.repo.channelMetaDirectoryFields(channelId);
    if (meta === undefined) return null;
    const lastMsg = this.repo.channelLastVisibleMessageAt(channelId);
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
  protected insertOutboxRowForChannelDirectory(
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

  protected async resolveActorMap(userIds: string[]): Promise<Map<string, import("../../chat/event-broadcast").UserSummary>> {
    const raw = await resolveUserSummaries(userIds, this.env);
    const m = new Map<string, import("../../chat/event-broadcast").UserSummary>();
    for (const [id, v] of raw) {
      m.set(id, { user_id: id, display_name: v.display_name ?? `user-${id.slice(0, 8)}`, avatar_url: v.avatar_url });
    }
    return m;
  }

  protected assertNotDissolved(status: string): { code: string; message: string } | null {
    if (status === "dissolved") return { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" };
    return null;
  }

  // The caller's role if they are an ACTIVE member (left_at IS NULL), else null.
  protected activeRole(channelId: string, userId: string): string | null {
    return this.repo.activeMemberRole(channelId, userId)?.role ?? null;
  }

  private dmChannelManagementError(): Response {
    return Response.json(
      { error: { code: "UNSUPPORTED_CHANNEL_KIND", message: "operation not supported for DM channels", retryable: false } },
      { status: 409 },
    );
  }

  private readChannelMeta(): NonNullable<ReturnType<ChatChannelRepository["soleChannelMetaJoinHeader"]>> | undefined {
    return this.repo.soleChannelMetaJoinHeader();
  }

  private requireChannelKindChannel(): { ok: true; meta: NonNullable<ReturnType<ChatChannelCore["readChannelMeta"]>> } | { ok: false; response: Response } {
    const meta = this.readChannelMeta();
    if (meta === undefined) {
      return { ok: false, response: new Response("not found", { status: 404 }) };
    }
    if (meta.kind === "dm") {
      return { ok: false, response: this.dmChannelManagementError() };
    }
    return { ok: true, meta };
  }

  assertChannelKindChannel(): NonNullable<ReturnType<ChatChannelCore["readChannelMeta"]>> {
    const gate = this.requireChannelKindChannel();
    if (gate.ok) return gate.meta;
    const meta = this.readChannelMeta();
    if (meta === undefined) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
    if (meta.kind === "dm") throw new ApiError("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels");
    throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  }


  // Sync: persists the event (ref payload) + writes a channel_fanout outbox row with the
  // LIVE-resolved frame. MUST run inside ctx.storage.transaction. The actor map is pre-resolved
  // BEFORE the txn (Hyperdrive is a network call). All event types reaching here carry actor_kind
  // (v4.0: read_state.updated is no longer a channel event — it's a user-local WS frame).
  protected persistEventAndFanout<T extends ManagementPersistedEventType>(
    eventId: string,
    type: T,
    channelId: string,
    occurredAt: string,
    persistedPayload: ManagementPersistedPayloadByType[T],
    membershipVersion: number,
    nowIso: string,
    actorMap: Map<string, import("../../chat/event-broadcast").UserSummary>,
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

  protected async scheduleOutboxAlarm(_nowIso?: string): Promise<void> {
    void _nowIso;
    await scheduleNextAlarm(
      this.ctx,
      [
        ...this.outboxDueTables(async () => Promise.resolve()),
        ...this.statefulSessionDueTables(),
        ...this.streamRegistryDueTables(),
        ...this.pendingBotAttachmentDueTables(),
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
    const flush = async () => {
      const { flushStatefulSessionTimeouts } = await import("./handlers/stateful-session");
      await flushStatefulSessionTimeouts(asHandlerRef(this), this.nowIso());
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
          await streamDo.expireStream({ channel_id: channelId, message_id: messageId, bot_id: botId });
        }
      }),
    ];
  }

  private pendingBotAttachmentDueTables(): DueTable[] {
    return [
      isoDueTable("attachments", "expires_at", "status", "pending", async (rows) => {
        await flushExpiredPendingBotAttachments(this.env, this.ctx.storage.sql, rows);
      }),
    ];
  }

  protected insertUserDirectoryOutbox(
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

  private deadLetterOutbox(outboxId: string, nowIso: string, error: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE projection_outbox SET status='dead_letter', updated_at=?, failed_at=?, last_error=? WHERE outbox_id=?",
      nowIso,
      nowIso,
      error,
      outboxId,
    );
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

  private deadLetterBotDelivery(outboxId: string, nowIso: string, error: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE bot_delivery_outbox SET status='dead_letter', updated_at=?, failed_at=?, last_error=? WHERE outbox_id=?",
      nowIso,
      nowIso,
      error,
      outboxId,
    );
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
        await target.enqueueDelivery(row.bot_id, {
          outbox_id: row.outbox_id,
          channel_id: row.channel_id,
          kind: row.kind,
          target_id: targetId,
          request_json: row.request_json,
        });
        this.ctx.storage.sql.exec(
          "UPDATE bot_delivery_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
          nowIso,
          row.outbox_id,
        );
      } catch (err) {
        const msg = rpcErrorMessage(err);
        if (shouldRetryRpcError(err)) {
          await this.bumpBotDeliveryRetry(row.outbox_id, nowIso, msg);
        } else {
          this.deadLetterBotDelivery(row.outbox_id, nowIso, msg);
        }
      }
    }
  }

  protected async flushSingleInviteDirectoryOutbox(outboxId: string, nowIso: string): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec("SELECT payload_json FROM projection_outbox WHERE outbox_id=?", outboxId)
      .toArray()[0] as { payload_json: string } | undefined;
    if (!row) return false;

    const target = this.env.INVITE_DIRECTORY.getByName("shared");
    try {
      const payload = JSON.parse(row.payload_json) as InviteDirectoryUpsertPayload;
      await target.upsertInvite(payload);
      this.ctx.storage.sql.exec(
        "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
        nowIso,
        outboxId,
      );
      return true;
    } catch (err) {
      logSwallowedError("invite_directory_projection_failed", err, { outbox_id: outboxId });
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

  debugOutboxPending(targetKind?: string): { count: number } {
    assertTestRoutesEnabled(this.env);
    const row = targetKind
      ? this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM projection_outbox WHERE status='pending' AND target_kind=?", targetKind)
        .toArray()[0]
      : this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM projection_outbox WHERE status='pending'")
        .toArray()[0];
    return { count: Number((row as { count?: number | bigint } | undefined)?.count ?? 0) };
  }

  private async flushProjectionOutboxRows(rows: OutboxRow[], nowIso: string): Promise<void> {
    for (const r of rows) {
      if (r.target_kind === "user_directory") {
        const target = this.env.USER_DIRECTORY.getByName(r.target_key);
        try {
          const payload = JSON.parse(r.payload_json) as UserDirectoryOutboxPayload;
          await target.upsertChannelProjection(r.target_key, payload);
          await this.notifyLiveMembershipChanged(r.target_key, {
            action: payload.action,
            channel_id: payload.channel_id,
            membership_version: payload.membership_version,
          });
          this.ctx.storage.sql.exec(
            "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
            nowIso,
            r.outbox_id,
          );
        } catch (err) {
          const msg = rpcErrorMessage(err);
          if (shouldRetryRpcError(err)) {
            await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
          } else {
            this.deadLetterOutbox(r.outbox_id, nowIso, msg);
          }
        }
        continue;
      }

      if (r.target_kind === "invite_directory") {
        const target = this.env.INVITE_DIRECTORY.getByName("shared");
        try {
          const payload = JSON.parse(r.payload_json) as InviteDirectoryUpsertPayload;
          await target.upsertInvite(payload);
          this.ctx.storage.sql.exec(
            "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
            nowIso,
            r.outbox_id,
          );
        } catch (err) {
          const msg = rpcErrorMessage(err);
          if (shouldRetryRpcError(err)) {
            await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
          } else {
            this.deadLetterOutbox(r.outbox_id, nowIso, msg);
          }
        }
        continue;
      }

      if (r.target_kind === "channel_directory") {
        const target = this.env.CHANNEL_DIRECTORY.getByName("shared");
        try {
          const payload = JSON.parse(r.payload_json) as ChannelDirectoryOutboxPayload;
          await target.applyProjection(payload);
          this.ctx.storage.sql.exec(
            "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
            nowIso,
            r.outbox_id,
          );
        } catch (err) {
          const msg = rpcErrorMessage(err);
          if (shouldRetryRpcError(err)) {
            await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
          } else {
            this.deadLetterOutbox(r.outbox_id, nowIso, msg);
          }
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
        } catch (err) {
          logSwallowedError("projection_outbox_invalid_payload", err, {
            outbox_id: r.outbox_id,
            target_kind: r.target_kind,
          });
          await this.bumpOutboxRetry(r.outbox_id, nowIso, "invalid payload_json");
          continue;
        }

        const target = this.env.CHANNEL_FANOUT.getByName(r.target_key);
        try {
          if (payload.action === "unregister-user") {
            await target.unregisterUser({
              channel_id: r.target_key,
              user_id: payload.user_id ?? "",
            });
          } else {
            await target.fanoutEnqueue({
              channel_id: r.target_key,
              event_id: payload.event_id ?? "",
              event_json: payload.event_json ?? "",
              membership_version_at_event: payload.membership_version_at_event ?? 0,
            });
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
    const { flushStatefulSessionTimeouts } = await import("./handlers/stateful-session");
    await flushStatefulSessionTimeouts(asHandlerRef(this), nowIso);
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
      ...this.pendingBotAttachmentDueTables(),
    ]);
    try {
      await flushArchiveOutboxToQueue(this.ctx, this.env.CHAT_ARCHIVE_QUEUE, { now: nowIso });
    } catch (err) {
      // Archive flush failure must not block projection retry scheduling.
      logSwallowedError("chat_channel_archive_flush_failed", err);
    }
    await this.scheduleOutboxAlarm(nowIso);
  }
}
