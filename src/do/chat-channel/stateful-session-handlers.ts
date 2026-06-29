import type { Env } from "../../env";
import type { UserSummary } from "../../contract/primitives";
import type { ManagementPersistedEventType, ManagementPersistedPayload } from "../../contract/persisted";
import { HTTP_STATUS_BY_CODE } from "../../errors";
import { buildSessionStart, buildSessionClosed, type StatefulSessionInputStored } from "../../chat/bot-gateway-session";
import type { CommandBindingSnapshot } from "../../contract/bot-api";
import type { WireChatMessage } from "../../contract/message";
import {
  DEFAULT_MAX_PENDING_INPUTS,
  listenRulesFromStatefulConfig,
  matchesListenRules,
  parseStatefulConfigFromSnapshot,
  resolveSessionTtlSeconds,
  type ListenRules,
} from "../../chat/stateful-session";
import {
  enqueueStatefulBotDelivery,
  STATEFUL_BOT_DELIVERY_KINDS,
} from "../../chat/stateful-bot-delivery";
import { uuidv7 } from "../../ids/uuidv7";
import { SESSION_START_TIMEOUT_MS } from "../../chat/stateful-session";
import { idempotencyExpiresAt } from "../../contract/idempotency";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  rvEvent,
  upsertEventChange,
  upsertStatefulSessionChange,
  upsertStatefulSessionInputChange,
} from "../../archive/chat-channel-record";
import { rowVersionFromSeq } from "../../archive/changes";

export interface StatefulSessionHost {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  nowIso(): string;
  nextEventId(nowMs?: number): string;
  resolveActorMap(userIds: string[]): Promise<Map<string, UserSummary>>;
  persistEventAndFanout<T extends ManagementPersistedEventType>(
    eventId: string,
    eventType: T,
    channelId: string,
    occurredAt: string,
    payload: ManagementPersistedPayload,
    membershipVersion: number,
    nowIso: string,
    actorMap: Map<string, UserSummary>,
  ): void;
  scheduleOutboxAlarm(nowIso?: string): Promise<void>;
  scheduleArchiveAlarm(nowIso?: string): Promise<void>;
  cachedResponse(j: string): Response;
  activeRole(channelId: string, userId: string): string | null;
}

interface ActiveSessionBusyRow {
  session_id: string;
  bot_command_id: string;
  command_name: string;
  status: string;
  started_by_user_id: string;
  started_at: string;
  expires_at: string;
}

function errorResponse(code: string, message: string, extra?: Record<string, unknown>, status?: number): Response {
  return Response.json(
    { error: { code, message, retryable: code === "BOT_OFFLINE", ...extra } },
    { status: status ?? HTTP_STATUS_BY_CODE[code] ?? 500 },
  );
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
    } catch {
      // ignore
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
  host: StatefulSessionHost,
  row: ActiveSessionBusyRow,
): Promise<{
  session_id: string;
  command_name: string;
  started_by: UserSummary;
  started_at: string;
  expires_at: string;
}> {
  const actorMap = await host.resolveActorMap([row.started_by_user_id]);
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

async function busyResponse(host: StatefulSessionHost, row: ActiveSessionBusyRow): Promise<Response> {
  const active_session = await wireActiveSessionBusy(host, row);
  return Response.json(
    {
      error: {
        code: "STATEFUL_SESSION_BUSY",
        message: "Another stateful command session is active in this channel.",
        retryable: false,
        active_session,
      },
    },
    { status: HTTP_STATUS_BY_CODE.STATEFUL_SESSION_BUSY ?? 409 },
  );
}

export async function handleStatefulCommandInvoke(
  host: StatefulSessionHost,
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
    idemExpiresAt: string;
    actor: UserSummary;
  },
): Promise<Response> {
  const statefulConfig = parseStatefulConfigFromSnapshot(input.snapshot.execution);
  if (!statefulConfig) {
    return errorResponse("COMMAND_OPTIONS_INVALID", "invalid stateful command snapshot");
  }

  const now = host.nowIso();
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
    listen_rules: listenRules,
    input_seq_start: 1,
    expires_at: expiresAt,
  });

  const txResult = host.ctx.storage.transactionSync(() => {
    const idem = host.ctx.storage.sql
      .exec(
        "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='command.invoke' AND operation_id=?",
        input.userId,
        input.operationId,
      )
      .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
    if (idem) {
      if (idem.request_hash !== input.requestHash) return { kind: "conflict" as const };
      return { kind: "cached" as const, responseJson: idem.response_json ?? "{}" };
    }

    const busy = activeSessionRow(host.ctx, input.channelId);
    if (busy) {
      return { kind: "busy" as const, busy };
    }

    host.ctx.storage.sql.exec(
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
    host.ctx.storage.sql.exec(
      "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'command.invoke', ?, ?, ?, 'completed', ?, ?)",
      input.userId,
      input.operationId,
      input.requestHash,
      JSON.stringify(responseBody),
      now,
      input.idemExpiresAt,
    );

    enqueueStatefulBotDelivery(host.ctx, {
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

    appendChatChannelArchive(host.ctx, input.channelId, now, [], (sourceSeq) =>
      collectDefinedChanges([
        upsertStatefulSessionChange(
          host.ctx.storage.sql,
          sessionId,
          rowVersionFromSeq(sourceSeq),
        ),
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
  if (txResult.kind === "cached") return host.cachedResponse(txResult.responseJson);
  if (txResult.kind === "busy") return busyResponse(host, txResult.busy);

  await host.scheduleOutboxAlarm(now);
  await host.scheduleArchiveAlarm(now);
  return Response.json(JSON.parse(txResult.responseJson));
}

export async function handleBotSessionStarted(host: StatefulSessionHost, body: { session_id: string }): Promise<Response> {
  const row = host.ctx.storage.sql
    .exec(
      "SELECT session_id, channel_id, bot_id, bot_command_id, started_by_user_id, status, started_at, expires_at, summary_json FROM stateful_command_sessions WHERE session_id=?",
      body.session_id,
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
  if (!row) return errorResponse("STATEFUL_SESSION_NOT_FOUND", "session not found", undefined, 404);
  if (row.status !== "starting") {
    return errorResponse("STATEFUL_SESSION_NOT_ACTIVE", "session is not in starting state");
  }

  const now = host.nowIso();
  const meta = host.ctx.storage.sql
    .exec("SELECT membership_version FROM channel_meta WHERE channel_id=?", row.channel_id)
    .toArray()[0] as { membership_version: number } | undefined;
  const mv = meta?.membership_version ?? 0;

  let commandName = row.bot_command_id;
  if (row.summary_json) {
    try {
      const s = JSON.parse(row.summary_json) as { command_name?: string };
      if (s.command_name) commandName = s.command_name;
    } catch {
      // ignore
    }
  }

  const actorMap = await host.resolveActorMap([row.started_by_user_id]);
  const eventId = host.nextEventId();

  host.ctx.storage.transactionSync(() => {
    host.ctx.storage.sql.exec(
      "UPDATE stateful_command_sessions SET status='active', summary_json=? WHERE session_id=?",
      JSON.stringify({ command_name: commandName }),
      row.session_id,
    );
    host.persistEventAndFanout(
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
    enqueueStatefulBotDelivery(host.ctx, {
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
    appendChatChannelArchive(host.ctx, row.channel_id, now, [eventId], () =>
      collectDefinedChanges([
        upsertStatefulSessionChange(host.ctx.storage.sql, row.session_id, rvEvent(eventId)),
        upsertEventChange(host.ctx.storage.sql, eventId),
      ]),
    );
  });

  await host.scheduleOutboxAlarm(now);
  await host.scheduleArchiveAlarm(now);
  return Response.json({ ok: true });
}

export async function handleBotSessionInputAck(
  host: StatefulSessionHost,
  body: { session_id: string; last_received_seq: number },
): Promise<Response> {
  const now = host.nowIso();
  host.ctx.storage.transactionSync(() => {
    host.ctx.storage.sql.exec(
      "UPDATE stateful_command_sessions SET input_last_acked_seq=? WHERE session_id=? AND status='active'",
      body.last_received_seq,
      body.session_id,
    );
    host.ctx.storage.sql.exec(
      `UPDATE stateful_session_inputs SET status='acked', acked_at=?
       WHERE session_id=? AND seq <= ? AND status IN ('pending','sent')`,
      now,
      body.session_id,
      body.last_received_seq,
    );
  });
  return Response.json({ ok: true });
}

export function handleStatefulSessionInputs(host: StatefulSessionHost, sessionId: string): Response {
  const row = host.ctx.storage.sql
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
  if (!row) return errorResponse("STATEFUL_SESSION_NOT_FOUND", "session not found", undefined, 404);
  if (!["starting", "active", "suspended", "closing"].includes(row.status)) {
    return errorResponse("STATEFUL_SESSION_NOT_ACTIVE", "session is not active");
  }

  const pendingCount = host.ctx.storage.sql
    .exec(
      "SELECT COUNT(*) AS c FROM stateful_session_inputs WHERE session_id=? AND status IN ('pending','sent')",
      sessionId,
    )
    .toArray()[0] as { c: number };
  if (Number(pendingCount?.c ?? 0) > DEFAULT_MAX_PENDING_INPUTS) {
    void closeStatefulSession(host, sessionId, "backlog_overflow");
    return errorResponse("STATEFUL_INPUT_BACKLOG_OVERFLOW", "session input backlog overflow", undefined, 429);
  }

  const inputs = host.ctx.storage.sql
    .exec(
      `SELECT seq, event_id, message_projection_json, created_at
       FROM stateful_session_inputs
       WHERE session_id=? AND seq > ? AND status IN ('pending','sent')
       ORDER BY seq ASC`,
      sessionId,
      row.input_last_acked_seq,
    )
    .toArray() as Array<{ seq: number; event_id: string; message_projection_json: string; created_at: string }>;

  return Response.json({
    session: { session_id: row.session_id, channel_id: row.channel_id, bot_id: row.bot_id, status: row.status },
    inputs: inputs.map((input) => {
      let message: WireChatMessage | null = null;
      let eventType = "message.created";
      let occurredAt = input.created_at;
      try {
        const parsed = JSON.parse(input.message_projection_json) as StatefulSessionInputStored;
        if (parsed.message) message = parsed.message;
        if (parsed.event?.type) eventType = parsed.event.type;
        if (parsed.event?.occurred_at) occurredAt = parsed.event.occurred_at;
      } catch {
        // ignore
      }
      return {
        seq: input.seq,
        event_id: input.event_id,
        event_type: eventType,
        occurred_at: occurredAt,
        message: message ?? ({} as WireChatMessage),
      };
    }),
  });
}

export async function closeStatefulSession(
  host: StatefulSessionHost,
  sessionId: string,
  reason: string,
): Promise<void> {
  const row = host.ctx.storage.sql
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

  const now = host.nowIso();
  const finalStatus = reason === "timeout" ? "failed" : "closed";
  let commandName = row.bot_command_id;
  if (row.summary_json) {
    try {
      const s = JSON.parse(row.summary_json) as { command_name?: string };
      if (s.command_name) commandName = s.command_name;
    } catch {
      // ignore
    }
  }

  const meta = host.ctx.storage.sql
    .exec("SELECT membership_version FROM channel_meta WHERE channel_id=?", row.channel_id)
    .toArray()[0] as { membership_version: number } | undefined;
  const eventId = host.nextEventId();

  host.ctx.storage.transactionSync(() => {
    host.ctx.storage.sql.exec(
      "UPDATE stateful_command_sessions SET status=?, closed_at=?, close_reason=? WHERE session_id=?",
      finalStatus,
      now,
      reason,
      sessionId,
    );
    host.persistEventAndFanout(
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
    enqueueStatefulBotDelivery(host.ctx, {
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
    appendChatChannelArchive(host.ctx, row.channel_id, now, [eventId], () =>
      collectDefinedChanges([
        upsertStatefulSessionChange(host.ctx.storage.sql, sessionId, rvEvent(eventId)),
        upsertEventChange(host.ctx.storage.sql, eventId),
      ]),
    );
  });

  await host.scheduleOutboxAlarm(now);
  await host.scheduleArchiveAlarm(now);
}

export async function maybeEnqueueStatefulSessionInput(
  host: StatefulSessionHost,
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
  const session = host.ctx.storage.sql
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
  } catch {
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
  const now = host.nowIso();
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

  host.ctx.storage.transactionSync(() => {
    host.ctx.storage.sql.exec(
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
    host.ctx.storage.sql.exec(
      "UPDATE stateful_command_sessions SET input_next_seq=? WHERE session_id=?",
      seq + 1,
      session.session_id,
    );
    enqueueStatefulBotDelivery(host.ctx, {
      outboxId: `bot_delivery:${input.channelId}:stateful_input:${session.session_id}:${seq}`,
      channelId: input.channelId,
      botId: session.bot_id,
      kind: STATEFUL_BOT_DELIVERY_KINDS.sessionInput,
      sessionId: session.session_id,
      requestJson: JSON.stringify({ seq, frame: inputFrame }),
      nowIso: now,
    });
    appendChatChannelArchive(host.ctx, input.channelId, now, [], (sourceSeq) => {
      const rowVersion = rowVersionFromSeq(sourceSeq);
      return collectDefinedChanges([
        upsertStatefulSessionInputChange(host.ctx.storage.sql, session.session_id, seq, rowVersion),
        upsertStatefulSessionChange(host.ctx.storage.sql, session.session_id, rowVersion),
      ]);
    });
  });

  await host.scheduleOutboxAlarm(now);
  await host.scheduleArchiveAlarm(now);
}

export async function handleBotSessionCloseFromBot(
  host: StatefulSessionHost,
  body: { session_id: string; reason?: string },
): Promise<Response> {
  await closeStatefulSession(host, body.session_id, body.reason ?? "bot_closed");
  return Response.json({ ok: true });
}

export async function handleGetStatefulSession(
  host: StatefulSessionHost,
  channelId: string,
): Promise<Response> {
  const row = host.ctx.storage.sql
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
  if (!row) return Response.json({ active_session: null });

  let commandName = row.bot_command_id;
  if (row.summary_json) {
    try {
      const s = JSON.parse(row.summary_json) as { command_name?: string };
      if (s.command_name) commandName = s.command_name;
    } catch {
      // ignore
    }
  }

  const actorMap = await host.resolveActorMap([row.started_by_user_id]);
  const startedBy = actorMap.get(row.started_by_user_id);
  return Response.json({
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
  });
}

export async function handleStatefulSessionStop(
  host: StatefulSessionHost,
  input: {
    userId: string;
    channelId: string;
    sessionId: string;
    reason: string;
    operationId: string;
    requestHash: string;
  },
): Promise<Response> {
  const operation = "stateful_session.stop";
  const now = host.nowIso();
  const idemExpiresAt = idempotencyExpiresAt(Date.parse(now));

  const preCheck = host.ctx.storage.sql
    .exec(
      "SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
      input.userId,
      operation,
      input.operationId,
      input.requestHash,
    )
    .toArray()[0] as { response_json: string } | undefined;
  if (preCheck) return host.cachedResponse(preCheck.response_json);

  const txResult = host.ctx.storage.transactionSync(() => {
    const idem = host.ctx.storage.sql
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

    const row = host.ctx.storage.sql
      .exec(
        "SELECT session_id, channel_id, started_by_user_id, status FROM stateful_command_sessions WHERE session_id=? AND channel_id=?",
        input.sessionId,
        input.channelId,
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

    const callerRole = host.activeRole(input.channelId, input.userId);
    const isStarter = row.started_by_user_id === input.userId;
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
    return Response.json(
      { error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } },
      { status: 409 },
    );
  }
  if (txResult.kind === "cached") return host.cachedResponse(txResult.responseJson);
  if (txResult.kind === "error") return host.cachedResponse(txResult.j);

  await closeStatefulSession(host, input.sessionId, input.reason);

  const responseBody = { ok: true, session_id: input.sessionId };
  host.ctx.storage.transactionSync(() => {
    host.ctx.storage.sql.exec(
      "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, ?, ?, ?, ?, 'completed', ?, ?)",
      input.userId,
      operation,
      input.operationId,
      input.requestHash,
      JSON.stringify(responseBody),
      now,
      idemExpiresAt,
    );
  });

  return Response.json(responseBody);
}

export async function flushStatefulSessionTimeouts(host: StatefulSessionHost, nowIso: string): Promise<void> {
  const nowMs = Date.parse(nowIso);
  const startingRows = host.ctx.storage.sql
    .exec(
      "SELECT session_id, started_at FROM stateful_command_sessions WHERE status='starting'",
    )
    .toArray() as Array<{ session_id: string; started_at: string }>;
  for (const row of startingRows) {
    const startedMs = Date.parse(row.started_at);
    if (Number.isFinite(startedMs) && nowMs - startedMs > SESSION_START_TIMEOUT_MS) {
      await closeStatefulSession(host, row.session_id, "start_timeout");
    }
  }

  const expiredRows = host.ctx.storage.sql
    .exec(
      "SELECT session_id FROM stateful_command_sessions WHERE status IN ('active','suspended','closing') AND expires_at <= ?",
      nowIso,
    )
    .toArray() as Array<{ session_id: string }>;
  for (const row of expiredRows) {
    await closeStatefulSession(host, row.session_id, "timeout");
  }
}

export function getActiveStatefulSessionSummary(host: StatefulSessionHost, channelId: string): unknown | null {
  const row = host.ctx.storage.sql
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
    } catch {
      // ignore
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
