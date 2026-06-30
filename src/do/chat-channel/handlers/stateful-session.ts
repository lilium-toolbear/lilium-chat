import type { UserSummary } from "../../../contract/primitives";
import { ApiError, logSwallowedError } from "../../../errors";
import type { CommandInvocationReplyContext } from "../../../contract/message";
import type {
  BotSessionCloseRpcInput,
  BotSessionInputAckRpcInput,
  BotSessionStartedRpcInput,
  GetStatefulSessionRpcInput,
  StatefulSessionInputsRpcInput,
  StopStatefulSessionRpcInput,
} from "../../../contract/chat-channel-rpc";
import type {
  GetStatefulSessionResponse,
  StatefulSessionInputsResponse,
  StopStatefulSessionResponse,
} from "../../../contract/stateful-session-api";
import type { CommandInvokeResponse } from "../../../contract/bot-api";
import { buildSessionStart, buildSessionClosed, type StatefulSessionInputStored } from "../../../chat/bot-gateway-session";
import type { CommandBindingSnapshot } from "../../../contract/bot-api";
import type { WireChatMessage } from "../../../contract/message";
import {
  DEFAULT_MAX_PENDING_INPUTS,
  listenRulesFromStatefulConfig,
  matchesListenRules,
  parseStatefulConfigFromSnapshot,
  resolveSessionTtlSeconds,
  type ListenRules,
} from "../../../chat/stateful-session";
import {
  enqueueStatefulBotDelivery,
  STATEFUL_BOT_DELIVERY_KINDS,
} from "../../../chat/stateful-bot-delivery";
import { uuidv7 } from "../../../ids/uuidv7";
import { SESSION_START_TIMEOUT_MS } from "../../../chat/stateful-session";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  rvEvent,
  upsertEventChange,
  upsertStatefulSessionChange,
  upsertStatefulSessionInputChange,
} from "../../../archive/chat-channel-record";
import { rowVersionFromSeq } from "../../../archive/changes";
import { parseRpcCachedJson } from "../../shared/do-rpc";
import {
  checkUserIdempotencyInTxn,
  readUserCompletedIdempotency,
  writeUserCompletedIdempotency,
} from "../data/idempotency";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";
import { asHandlerRef, type ChatChannelHandlerRef } from "../handler-ref";

interface ActiveSessionBusyRow {
  session_id: string;
  bot_command_id: string;
  command_name: string;
  status: string;
  started_by_user_id: string;
  started_at: string;
  expires_at: string;
}

function activeSessionRow(ctx: DurableObjectState, channelId: string): ActiveSessionBusyRow | null {
  const row = ctx.storage.sql
    .exec(
      `SELECT session_id, bot_command_id, status, started_by_user_id, started_at, expires_at, summary_json
       FROM stateful_command_sessions
       WHERE channel_id=? AND status IN ('starting','active','suspended','closing')
       LIMIT 1`,
      channelId,
    )
    .toArray()[0] as {
      session_id: string;
      bot_command_id: string;
      status: string;
      started_by_user_id: string;
      started_at: string;
      expires_at: string;
      summary_json: string | null;
    } | undefined;
  if (!row) return null;
  let commandName = row.bot_command_id;
  if (row.summary_json) {
    try {
      const summary = JSON.parse(row.summary_json) as { command_name?: string };
      if (typeof summary.command_name === "string") commandName = summary.command_name;
    } catch (err) {
      logSwallowedError("stateful_session_summary_json_invalid", err);
    }
  }
  return {
    session_id: row.session_id,
    bot_command_id: row.bot_command_id,
    command_name: commandName,
    status: row.status,
    started_by_user_id: row.started_by_user_id,
    started_at: row.started_at,
    expires_at: row.expires_at,
  };
}

async function wireActiveSessionBusy(
  channel: ChatChannelHandlerRef,
  row: ActiveSessionBusyRow,
): Promise<{
  session_id: string;
  command_name: string;
  started_by: UserSummary;
  started_at: string;
  expires_at: string;
}> {
  const actorMap = await channel.resolveActorMap([row.started_by_user_id]);
  return {
    session_id: row.session_id,
    command_name: row.command_name,
    started_by: actorMap.get(row.started_by_user_id) ?? {
      user_id: row.started_by_user_id,
      display_name: row.started_by_user_id,
      avatar_url: null,
    },
    started_at: row.started_at,
    expires_at: row.expires_at,
  };
}

async function throwStatefulSessionBusy(channel: ChatChannelHandlerRef, row: ActiveSessionBusyRow): Promise<never> {
  const active_session = await wireActiveSessionBusy(channel, row);
  const err = new ApiError(
    "STATEFUL_SESSION_BUSY",
    "Another stateful command session is active in this channel.",
  );
  Object.assign(err, { active_session });
  throw err;
}

export async function statefulCommandInvoke(
  channel: ChatChannelHandlerRef,
  input: {
    userId: string;
    channelId: string;
    botCommandId: string;
    operationId: string;
    invokedName: string;
    options: Record<string, { type: string; value: unknown }>;
    snapshot: CommandBindingSnapshot;
    bindingBotId: string;
    bindingMaxTtl: number | null;
    requestHash: string;
    actor: UserSummary;
    reply_to: CommandInvocationReplyContext | null;
  },
): Promise<CommandInvokeResponse> {
  const statefulConfig = parseStatefulConfigFromSnapshot(input.snapshot.execution);
  if (!statefulConfig) {
    throw new ApiError("COMMAND_OPTIONS_INVALID", "invalid stateful command snapshot");
  }

  const now = channel.nowIso();
  const nowMs = Date.parse(now);
  const listenRules = listenRulesFromStatefulConfig(statefulConfig);
  const ttlSeconds = resolveSessionTtlSeconds(statefulConfig, input.bindingMaxTtl);
  const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();
  const sessionId = uuidv7(nowMs);
  const invocationId = uuidv7(nowMs + 1);

  const schemaVersion = typeof input.snapshot.execution.schema_version === "number"
    ? input.snapshot.execution.schema_version
    : 1;
  const definitionHash = typeof input.snapshot.execution.definition_hash === "string"
    ? input.snapshot.execution.definition_hash
    : `snapshot:${input.botCommandId}`;

  const startFrame = buildSessionStart({
    session_id: sessionId,
    channel_id: input.channelId,
    bot_command: {
      bot_command_id: input.botCommandId,
      name: input.snapshot.name,
      invoked_name: input.invokedName || input.snapshot.name,
      schema_version: schemaVersion,
      definition_hash: definitionHash,
    },
    invoker: input.actor,
    options: input.options,
    ...(input.reply_to ? { reply_to: input.reply_to } : {}),
    listen_rules: listenRules,
    input_seq_start: 1,
    expires_at: expiresAt,
  });

  const txResult = channel.ctx.storage.transactionSync(() => {
    const idem = checkUserIdempotencyInTxn(
      channel.ctx.storage.sql,
      input.userId,
      "command.invoke",
      input.operationId,
      input.requestHash,
    );
    if (idem.kind === "conflict") return { kind: "conflict" as const };
    if (idem.kind === "cached") return { kind: "cached" as const, responseJson: idem.responseJson };

    const busy = activeSessionRow(channel.ctx, input.channelId);
    if (busy) {
      return { kind: "busy" as const, busy };
    }

    channel.ctx.storage.sql.exec(
      `INSERT INTO stateful_command_sessions (
         session_id, channel_id, bot_id, bot_command_id, invocation_id, started_by_user_id,
         status, listen_rules_json, input_next_seq, input_last_acked_seq, effect_last_acked_seq,
         started_at, expires_at, closed_at, close_reason, summary_json
       ) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, 1, 0, 0, ?, ?, NULL, NULL, ?)`,
      sessionId,
      input.channelId,
      input.bindingBotId,
      input.botCommandId,
      invocationId,
      input.userId,
      JSON.stringify(listenRules),
      now,
      expiresAt,
      JSON.stringify({ command_name: input.snapshot.name }),
    );

    const responseBody = {
      channel_id: input.channelId,
      invocation_id: invocationId,
      session_id: sessionId,
    };
    writeUserCompletedIdempotency(channel.ctx.storage.sql, {
      userId: input.userId,
      operation: "command.invoke",
      operationId: input.operationId,
      requestHash: input.requestHash,
      responseJson: JSON.stringify(responseBody),
      nowIso: now,
    });

    enqueueStatefulBotDelivery(channel.ctx, {
      outboxId: `bot_delivery:${input.channelId}:stateful_start:${sessionId}`,
      channelId: input.channelId,
      botId: input.bindingBotId,
      kind: STATEFUL_BOT_DELIVERY_KINDS.sessionStart,
      sessionId,
      requestJson: JSON.stringify({
        ref: {
          session_id: sessionId,
          channel_id: input.channelId,
          bot_id: input.bindingBotId,
          status: "starting",
          updated_at: now,
        },
        start_frame: startFrame,
      }),
      nowIso: now,
    });

    appendChatChannelArchive(channel.ctx, input.channelId, now, [], (sourceSeq) =>
      collectDefinedChanges([
        upsertStatefulSessionChange(
          channel.ctx.storage.sql,
          sessionId,
          rowVersionFromSeq(sourceSeq),
        ),
      ]),
    );

    return { kind: "ok" as const, responseJson: JSON.stringify(responseBody) };
  });

  if (txResult.kind === "conflict") {
    throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
  }
  if (txResult.kind === "cached") return parseRpcCachedJson<CommandInvokeResponse>(txResult.responseJson);
  if (txResult.kind === "busy") await throwStatefulSessionBusy(channel, txResult.busy);

  if (txResult.kind !== "ok") {
    throw new ApiError("CHAT_WORKER_UNAVAILABLE", "unexpected stateful invoke result");
  }
  await channel.scheduleOutboxAlarm(now);
  await channel.scheduleArchiveAlarm(now);
  return parseRpcCachedJson<CommandInvokeResponse>(txResult.responseJson);
}

export async function closeStatefulSession(
  channel: ChatChannelHandlerRef,
  sessionId: string,
  reason: string,
): Promise<void> {
  const row = channel.ctx.storage.sql
    .exec(
      "SELECT session_id, channel_id, bot_id, bot_command_id, status, summary_json, started_at FROM stateful_command_sessions WHERE session_id=?",
      sessionId,
    )
    .toArray()[0] as {
      session_id: string;
      channel_id: string;
      bot_id: string;
      bot_command_id: string;
      status: string;
      summary_json: string | null;
    } | undefined;
  if (!row) return;
  if (["closed", "expired", "failed"].includes(row.status)) return;

  const now = channel.nowIso();
  const finalStatus = reason === "timeout" ? "failed" : "closed";
  let commandName = row.bot_command_id;
  if (row.summary_json) {
    try {
      const s = JSON.parse(row.summary_json) as { command_name?: string };
      if (s.command_name) commandName = s.command_name;
    } catch (err) {
      logSwallowedError("stateful_session_summary_json_invalid", err);
    }
  }

  const meta = channel.repo.channelMetaMembershipVersion(row.channel_id);
  const eventId = channel.nextEventId();

  channel.ctx.storage.transactionSync(() => {
    channel.ctx.storage.sql.exec(
      "UPDATE stateful_command_sessions SET status=?, closed_at=?, close_reason=? WHERE session_id=?",
      finalStatus,
      now,
      reason,
      sessionId,
    );
    channel.persistEventAndFanout(
      eventId,
      "stateful_session.closed",
      row.channel_id,
      now,
      {
        actor_kind: "system",
        actor_id: "system",
        session_id: row.session_id,
        bot_command_id: row.bot_command_id,
        command_name: commandName,
        status: finalStatus,
        reason,
        closed_at: now,
      },
      meta?.membership_version ?? 0,
      now,
      new Map(),
    );
    enqueueStatefulBotDelivery(channel.ctx, {
      outboxId: `bot_delivery:${row.channel_id}:stateful_close:${sessionId}`,
      channelId: row.channel_id,
      botId: row.bot_id,
      kind: STATEFUL_BOT_DELIVERY_KINDS.sessionClose,
      sessionId,
      requestJson: JSON.stringify({
        close_frame: buildSessionClosed({
          session_id: sessionId,
          status: finalStatus,
          reason,
        }),
        delete_ref: true,
      }),
      nowIso: now,
    });
    appendChatChannelArchive(channel.ctx, row.channel_id, now, [eventId], () =>
      collectDefinedChanges([
        upsertStatefulSessionChange(channel.ctx.storage.sql, sessionId, rvEvent(eventId)),
        upsertEventChange(channel.ctx.storage.sql, eventId),
      ]),
    );
  });

  await channel.scheduleOutboxAlarm(now);
  await channel.scheduleArchiveAlarm(now);
}

export async function maybeEnqueueStatefulSessionInput(
  channel: ChatChannelHandlerRef,
  input: {
    channelId: string;
    messageId: string;
    eventId: string;
    occurredAt: string;
    senderKind: string;
    senderUserId: string | null;
    senderBotId: string | null;
    messageType: string;
    messageProjection: WireChatMessage;
  },
): Promise<void> {
  const session = channel.ctx.storage.sql
    .exec(
      `SELECT session_id, channel_id, bot_id, started_by_user_id, status, listen_rules_json, input_next_seq
       FROM stateful_command_sessions
       WHERE channel_id=? AND status='active'
       LIMIT 1`,
      input.channelId,
    )
    .toArray()[0] as {
      session_id: string;
      channel_id: string;
      bot_id: string;
      started_by_user_id: string;
      listen_rules_json: string;
      input_next_seq: number;
    } | undefined;
  if (!session) return;

  let rules: ListenRules;
  try {
    rules = JSON.parse(session.listen_rules_json) as ListenRules;
  } catch (err) {
    logSwallowedError("stateful_session_listen_rules_invalid", err, { session_id: session.session_id });
    return;
  }

  if (
    !matchesListenRules(
      {
        message_id: input.messageId,
        sender_kind: input.senderKind,
        sender_user_id: input.senderUserId,
        sender_bot_id: input.senderBotId,
        type: input.messageType,
        started_by_user_id: session.started_by_user_id,
      },
      rules,
      session,
    )
  ) {
    return;
  }

  const seq = session.input_next_seq;
  const now = channel.nowIso();
  const projectionJson = JSON.stringify({
    event: { event_id: input.eventId, type: "message.created", occurred_at: input.occurredAt },
    message: input.messageProjection,
  } satisfies StatefulSessionInputStored);
  const inputFrame = {
    type: "session.input",
    api_version: "lilium.chat.bot.v1",
    session_id: session.session_id,
    channel_id: input.channelId,
    seq,
    event: { event_id: input.eventId, type: "message.created", occurred_at: input.occurredAt },
    message: input.messageProjection,
  };

  channel.ctx.storage.transactionSync(() => {
    channel.ctx.storage.sql.exec(
      `INSERT INTO stateful_session_inputs (
         session_id, seq, channel_id, event_id, message_id, message_projection_json, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      session.session_id,
      seq,
      input.channelId,
      input.eventId,
      input.messageId,
      projectionJson,
      now,
    );
    channel.ctx.storage.sql.exec(
      "UPDATE stateful_command_sessions SET input_next_seq=? WHERE session_id=?",
      seq + 1,
      session.session_id,
    );
    enqueueStatefulBotDelivery(channel.ctx, {
      outboxId: `bot_delivery:${input.channelId}:stateful_input:${session.session_id}:${seq}`,
      channelId: input.channelId,
      botId: session.bot_id,
      kind: STATEFUL_BOT_DELIVERY_KINDS.sessionInput,
      sessionId: session.session_id,
      requestJson: JSON.stringify({ seq, frame: inputFrame }),
      nowIso: now,
    });
    appendChatChannelArchive(channel.ctx, input.channelId, now, [], (sourceSeq) => {
      const rowVersion = rowVersionFromSeq(sourceSeq);
      return collectDefinedChanges([
        upsertStatefulSessionInputChange(channel.ctx.storage.sql, session.session_id, seq, rowVersion),
        upsertStatefulSessionChange(channel.ctx.storage.sql, session.session_id, rowVersion),
      ]);
    });
  });

  await channel.scheduleOutboxAlarm(now);
  await channel.scheduleArchiveAlarm(now);
}

export async function flushStatefulSessionTimeouts(
  channel: ChatChannelHandlerRef,
  nowIso: string,
): Promise<void> {
  const nowMs = Date.parse(nowIso);
  const startingRows = channel.ctx.storage.sql
    .exec(
      "SELECT session_id, started_at FROM stateful_command_sessions WHERE status='starting'",
    )
    .toArray() as Array<{ session_id: string; started_at: string }>;
  for (const row of startingRows) {
    const startedMs = Date.parse(row.started_at);
    if (Number.isFinite(startedMs) && nowMs - startedMs > SESSION_START_TIMEOUT_MS) {
      await closeStatefulSession(channel, row.session_id, "start_timeout");
    }
  }

  const expiredRows = channel.ctx.storage.sql
    .exec(
      "SELECT session_id FROM stateful_command_sessions WHERE status IN ('active','suspended','closing') AND expires_at <= ?",
      nowIso,
    )
    .toArray() as Array<{ session_id: string }>;
  for (const row of expiredRows) {
    await closeStatefulSession(channel, row.session_id, "timeout");
  }
}

export function getActiveStatefulSessionSummary(
  channel: ChatChannelHandlerRef,
  channelId: string,
): unknown | null {
  const row = channel.ctx.storage.sql
    .exec(
      `SELECT session_id, bot_command_id, started_by_user_id, status, started_at, expires_at, summary_json
       FROM stateful_command_sessions
       WHERE channel_id=? AND status IN ('starting','active','suspended','closing')
       LIMIT 1`,
      channelId,
    )
    .toArray()[0] as {
      session_id: string;
      bot_command_id: string;
      started_by_user_id: string;
      status: string;
      started_at: string;
      expires_at: string;
      summary_json: string | null;
    } | undefined;
  if (!row) return null;
  let commandName = row.bot_command_id;
  if (row.summary_json) {
    try {
      const s = JSON.parse(row.summary_json) as { command_name?: string };
      if (s.command_name) commandName = s.command_name;
    } catch (err) {
      logSwallowedError("stateful_session_summary_json_invalid", err);
    }
  }
  return {
    session_id: row.session_id,
    bot_command_id: row.bot_command_id,
    command_name: commandName,
    status: row.status,
    started_by_user_id: row.started_by_user_id,
    started_at: row.started_at,
    expires_at: row.expires_at,
  };
}

export function StatefulSessionMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async botSessionStarted(input: BotSessionStartedRpcInput): Promise<void> {
      if (typeof input.session_id !== "string") throw new ApiError("INVALID_MESSAGE", "invalid payload");
      const row = this.ctx.storage.sql
        .exec(
          "SELECT session_id, channel_id, bot_id, bot_command_id, started_by_user_id, status, started_at, expires_at, summary_json FROM stateful_command_sessions WHERE session_id=?",
          input.session_id,
        )
        .toArray()[0] as {
          session_id: string;
          channel_id: string;
          bot_id: string;
          bot_command_id: string;
          started_by_user_id: string;
          status: string;
          started_at: string;
          expires_at: string;
          summary_json: string | null;
        } | undefined;
      if (!row) throw new ApiError("STATEFUL_SESSION_NOT_FOUND", "session not found");
      if (row.status !== "starting") {
        throw new ApiError("STATEFUL_SESSION_NOT_ACTIVE", "session is not in starting state");
      }

      const now = this.nowIso();
      const meta = this.repo.channelMetaMembershipVersion(row.channel_id);
      const mv = meta?.membership_version ?? 0;

      let commandName = row.bot_command_id;
      if (row.summary_json) {
        try {
          const s = JSON.parse(row.summary_json) as { command_name?: string };
          if (s.command_name) commandName = s.command_name;
        } catch (err) {
          logSwallowedError("stateful_session_summary_json_invalid", err);
        }
      }

      const actorMap = await this.resolveActorMap([row.started_by_user_id]);
      const eventId = this.nextEventId();

      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE stateful_command_sessions SET status='active', summary_json=? WHERE session_id=?",
          JSON.stringify({ command_name: commandName }),
          row.session_id,
        );
        this.persistEventAndFanout(
          eventId,
          "stateful_session.started",
          row.channel_id,
          now,
          {
            actor_kind: "system",
            actor_id: "system",
            session: {
              session_id: row.session_id,
              bot_command_id: row.bot_command_id,
              command_name: commandName,
              status: "active",
              started_by_user_id: row.started_by_user_id,
              started_at: row.started_at,
              expires_at: row.expires_at,
            },
          },
          mv,
          now,
          actorMap,
        );
        enqueueStatefulBotDelivery(this.ctx, {
          outboxId: `bot_delivery:${row.channel_id}:stateful_ref:${row.session_id}:active`,
          channelId: row.channel_id,
          botId: row.bot_id,
          kind: STATEFUL_BOT_DELIVERY_KINDS.sessionRefUpsert,
          sessionId: row.session_id,
          requestJson: JSON.stringify({
            session_id: row.session_id,
            channel_id: row.channel_id,
            bot_id: row.bot_id,
            status: "active",
            updated_at: now,
          }),
          nowIso: now,
        });
        appendChatChannelArchive(this.ctx, row.channel_id, now, [eventId], () =>
          collectDefinedChanges([
            upsertStatefulSessionChange(this.ctx.storage.sql, row.session_id, rvEvent(eventId)),
            upsertEventChange(this.ctx.storage.sql, eventId),
          ]),
        );
      });

      await this.scheduleOutboxAlarm(now);
      await this.scheduleArchiveAlarm(now);
    }

    async botSessionInputAck(input: BotSessionInputAckRpcInput): Promise<void> {
      if (typeof input.session_id !== "string" || typeof input.last_received_seq !== "number") {
        throw new ApiError("INVALID_MESSAGE", "invalid payload");
      }
      const now = this.nowIso();
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE stateful_command_sessions SET input_last_acked_seq=? WHERE session_id=? AND status='active'",
          input.last_received_seq,
          input.session_id,
        );
        this.ctx.storage.sql.exec(
          `UPDATE stateful_session_inputs SET status='acked', acked_at=?
           WHERE session_id=? AND seq <= ? AND status IN ('pending','sent')`,
          now,
          input.session_id,
          input.last_received_seq,
        );
      });
    }

    statefulSessionInputs(input: StatefulSessionInputsRpcInput): StatefulSessionInputsResponse {
      if (!input.session_id) throw new ApiError("INVALID_MESSAGE", "missing session_id");
      const sessionId = input.session_id;
      const row = this.ctx.storage.sql
        .exec(
          "SELECT session_id, channel_id, bot_id, status, input_last_acked_seq FROM stateful_command_sessions WHERE session_id=?",
          sessionId,
        )
        .toArray()[0] as {
          session_id: string;
          channel_id: string;
          bot_id: string;
          status: string;
          input_last_acked_seq: number;
        } | undefined;
      if (!row) throw new ApiError("STATEFUL_SESSION_NOT_FOUND", "session not found");
      if (!["starting", "active", "suspended", "closing"].includes(row.status)) {
        throw new ApiError("STATEFUL_SESSION_NOT_ACTIVE", "session is not active");
      }

      const pendingCount = this.ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS c FROM stateful_session_inputs WHERE session_id=? AND status IN ('pending','sent')",
          sessionId,
        )
        .toArray()[0] as { c: number };
      if (Number(pendingCount?.c ?? 0) > DEFAULT_MAX_PENDING_INPUTS) {
        void closeStatefulSession(asHandlerRef(this), sessionId, "backlog_overflow");
        throw new ApiError("STATEFUL_INPUT_BACKLOG_OVERFLOW", "session input backlog overflow");
      }

      const inputs = this.ctx.storage.sql
        .exec(
          `SELECT seq, event_id, message_projection_json, created_at
           FROM stateful_session_inputs
           WHERE session_id=? AND seq > ? AND status IN ('pending','sent')
           ORDER BY seq ASC`,
          sessionId,
          row.input_last_acked_seq,
        )
        .toArray() as Array<{ seq: number; event_id: string; message_projection_json: string; created_at: string }>;

      return {
        session: { session_id: row.session_id, channel_id: row.channel_id, bot_id: row.bot_id, status: row.status },
        inputs: inputs.map((inputRow) => {
          let message: WireChatMessage | null = null;
          let eventType = "message.created";
          let occurredAt = inputRow.created_at;
          try {
            const parsed = JSON.parse(inputRow.message_projection_json) as StatefulSessionInputStored;
            if (parsed.message) message = parsed.message;
            if (parsed.event?.type) eventType = parsed.event.type;
            if (parsed.event?.occurred_at) occurredAt = parsed.event.occurred_at;
          } catch (err) {
            logSwallowedError("stateful_session_input_projection_invalid", err, { event_id: inputRow.event_id });
          }
          return {
            seq: inputRow.seq,
            event_id: inputRow.event_id,
            event_type: eventType,
            occurred_at: occurredAt,
            message: message ?? ({} as WireChatMessage),
          };
        }),
      };
    }

    async botSessionClose(input: BotSessionCloseRpcInput): Promise<void> {
      if (typeof input.session_id !== "string") throw new ApiError("INVALID_MESSAGE", "invalid payload");
      await closeStatefulSession(asHandlerRef(this), input.session_id, input.reason ?? "bot_closed");
    }

    async getStatefulSession(input: GetStatefulSessionRpcInput): Promise<GetStatefulSessionResponse> {
      if (!input.channel_id) throw new ApiError("INVALID_MESSAGE", "missing channel_id");
      const channelId = input.channel_id;
      const row = this.ctx.storage.sql
        .exec(
          `SELECT session_id, bot_command_id, started_by_user_id, status, started_at, expires_at, summary_json
           FROM stateful_command_sessions
           WHERE channel_id=? AND status IN ('starting','active','suspended','closing')
           LIMIT 1`,
          channelId,
        )
        .toArray()[0] as {
          session_id: string;
          bot_command_id: string;
          started_by_user_id: string;
          status: string;
          started_at: string;
          expires_at: string;
          summary_json: string | null;
        } | undefined;
      if (!row) return { active_session: null };

      let commandName = row.bot_command_id;
      if (row.summary_json) {
        try {
          const s = JSON.parse(row.summary_json) as { command_name?: string };
          if (s.command_name) commandName = s.command_name;
        } catch (err) {
          logSwallowedError("stateful_session_summary_json_invalid", err);
        }
      }

      const actorMap = await this.resolveActorMap([row.started_by_user_id]);
      const startedBy = actorMap.get(row.started_by_user_id);
      return {
        active_session: {
          session_id: row.session_id,
          bot_command_id: row.bot_command_id,
          command_name: commandName,
          status: row.status,
          started_by: startedBy ?? {
            user_id: row.started_by_user_id,
            display_name: row.started_by_user_id,
            avatar_url: null,
          },
          started_at: row.started_at,
          expires_at: row.expires_at,
        },
      };
    }

    async stopStatefulSession(input: StopStatefulSessionRpcInput): Promise<StopStatefulSessionResponse> {
      if (!input.user_id) throw new ApiError("UNAUTHORIZED", "missing verified user");
      if (!input.channel_id || !input.session_id) throw new ApiError("INVALID_MESSAGE", "invalid payload");
      if (!input.operation_id) throw new ApiError("INVALID_MESSAGE", "missing operation_id");
      const operation = "stateful_session.stop";
      const now = this.nowIso();
      const requestHash = JSON.stringify({
        channel_id: input.channel_id,
        session_id: input.session_id,
        reason: input.reason,
      });

      const cachedJson = readUserCompletedIdempotency(
        this.ctx.storage.sql,
        input.user_id,
        operation,
        input.operation_id,
        requestHash,
      );
      if (cachedJson) return parseRpcCachedJson<StopStatefulSessionResponse>(cachedJson);

      const txResult = this.ctx.storage.transactionSync(() => {
        const idem = checkUserIdempotencyInTxn(
          this.ctx.storage.sql,
          input.user_id,
          operation,
          input.operation_id,
          requestHash,
        );
        if (idem.kind === "conflict") return { kind: "conflict" as const };
        if (idem.kind === "cached") return { kind: "cached" as const, responseJson: idem.responseJson };

        const row = this.ctx.storage.sql
          .exec(
            "SELECT session_id, channel_id, started_by_user_id, status FROM stateful_command_sessions WHERE session_id=? AND channel_id=?",
            input.session_id,
            input.channel_id,
          )
          .toArray()[0] as {
            session_id: string;
            channel_id: string;
            started_by_user_id: string;
            status: string;
          } | undefined;
        if (!row) {
          return {
            kind: "error" as const,
            j: JSON.stringify({ error: { code: "STATEFUL_SESSION_NOT_FOUND", message: "session not found" } }),
          };
        }
        if (!["starting", "active", "suspended", "closing"].includes(row.status)) {
          return {
            kind: "error" as const,
            j: JSON.stringify({ error: { code: "STATEFUL_SESSION_NOT_ACTIVE", message: "session is not active" } }),
          };
        }

        const callerRole = this.activeRole(input.channel_id, input.user_id);
        const isStarter = row.started_by_user_id === input.user_id;
        const isAdmin = callerRole === "owner" || callerRole === "admin";
        if (!isStarter && !isAdmin) {
          return {
            kind: "error" as const,
            j: JSON.stringify({ error: { code: "FORBIDDEN", message: "not allowed to stop this session" } }),
          };
        }

        return { kind: "close" as const };
      });

      if (txResult.kind === "conflict") {
        throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
      }
      if (txResult.kind === "cached") return parseRpcCachedJson<StopStatefulSessionResponse>(txResult.responseJson);
      if (txResult.kind === "error") parseRpcCachedJson<never>(txResult.j);

      await closeStatefulSession(asHandlerRef(this), input.session_id, input.reason);

      const responseBody: StopStatefulSessionResponse = { session_id: input.session_id };
      this.ctx.storage.transactionSync(() => {
        writeUserCompletedIdempotency(this.ctx.storage.sql, {
          userId: input.user_id,
          operation,
          operationId: input.operation_id,
          requestHash,
          responseJson: JSON.stringify(responseBody),
          nowIso: now,
        });
      });

      return responseBody;
    }
  };
}
