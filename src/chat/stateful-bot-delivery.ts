import type { Env } from "../env";
import { logSwallowedError } from "../errors";
import { OUTBOX_MAX_ATTEMPTS } from "../contract/outbox";
import { bumpQueueRetry } from "../do/shared/retry-backoff";

export const STATEFUL_BOT_DELIVERY_KINDS = {
  sessionStart: "stateful_session_start",
  sessionRefUpsert: "stateful_session_ref_upsert",
  sessionInput: "stateful_session_input",
  sessionClose: "stateful_session_close",
} as const;

export type StatefulBotDeliveryKind =
  (typeof STATEFUL_BOT_DELIVERY_KINDS)[keyof typeof STATEFUL_BOT_DELIVERY_KINDS];

export interface StatefulBotDeliveryRow {
  outbox_id: string;
  channel_id: string;
  bot_id: string;
  kind: string;
  event_id: string | null;
  request_json: string;
}

interface StatefulSessionRefPayload {
  session_id: string;
  channel_id: string;
  bot_id: string;
  status: string;
  updated_at: string;
}

function isStatefulSessionRefPayload(value: unknown): value is StatefulSessionRefPayload {
  const ref = value as Partial<StatefulSessionRefPayload> | null;
  return ref !== null &&
    typeof ref === "object" &&
    typeof ref.session_id === "string" &&
    typeof ref.channel_id === "string" &&
    typeof ref.bot_id === "string" &&
    typeof ref.status === "string" &&
    typeof ref.updated_at === "string";
}

export function enqueueStatefulBotDelivery(
  ctx: DurableObjectState,
  input: {
    outboxId: string;
    channelId: string;
    botId: string;
    kind: StatefulBotDeliveryKind;
    sessionId: string;
    requestJson: string;
    nowIso: string;
  },
): void {
  ctx.storage.sql.exec(
    `INSERT INTO bot_delivery_outbox (
       outbox_id, channel_id, bot_id, kind, invocation_id, interaction_id, event_id, request_json,
       status, attempts, max_attempts, last_error, failed_at, next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?, ?)`,
    input.outboxId,
    input.channelId,
    input.botId,
    input.kind,
    input.sessionId,
    input.requestJson,
    OUTBOX_MAX_ATTEMPTS,
    input.nowIso,
    input.nowIso,
    input.nowIso,
  );
}

export async function flushStatefulBotDeliveryRow(
  env: Env,
  sql: DurableObjectState["storage"]["sql"],
  row: StatefulBotDeliveryRow,
  nowIso: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sessionId = row.event_id;
  if (!sessionId) return { ok: false, error: "missing session_id" };

  if (row.kind === STATEFUL_BOT_DELIVERY_KINDS.sessionStart) {
    let payload: { ref?: unknown; start_frame?: unknown };
    try {
      payload = JSON.parse(row.request_json) as { ref?: unknown; start_frame?: unknown };
    } catch (err) {
      logSwallowedError("stateful_bot_delivery_json_invalid", err, { outbox_id: row.outbox_id, kind: row.kind });
      return { ok: false, error: "invalid session start payload" };
    }
    if (!payload.ref || !payload.start_frame) {
      return { ok: false, error: "invalid session start payload" };
    }
    if (!isStatefulSessionRefPayload(payload.ref)) {
      return { ok: false, error: "invalid session start payload" };
    }
    await env.BOT_CONNECTION.getByName(row.bot_id).upsertStatefulSessionRef(payload.ref);
    await env.BOT_CONNECTION.getByName(row.bot_id).pushSessionFrame(row.bot_id, payload.start_frame);
    return { ok: true };
  }

  if (row.kind === STATEFUL_BOT_DELIVERY_KINDS.sessionRefUpsert) {
    let ref: unknown;
    try {
      ref = JSON.parse(row.request_json);
    } catch (err) {
      logSwallowedError("stateful_bot_delivery_json_invalid", err, { outbox_id: row.outbox_id, kind: row.kind });
      return { ok: false, error: "invalid ref payload" };
    }
    if (!isStatefulSessionRefPayload(ref)) return { ok: false, error: "invalid ref payload" };
    await env.BOT_CONNECTION.getByName(row.bot_id).upsertStatefulSessionRef(ref);
    return { ok: true };
  }

  if (row.kind === STATEFUL_BOT_DELIVERY_KINDS.sessionInput) {
    let frame: unknown;
    let seq: number | null = null;
    try {
      const parsed = JSON.parse(row.request_json) as { frame?: unknown; seq?: unknown };
      frame = parsed.frame;
      seq = typeof parsed.seq === "number" ? parsed.seq : null;
    } catch (err) {
      logSwallowedError("stateful_bot_delivery_json_invalid", err, { outbox_id: row.outbox_id, kind: row.kind });
      return { ok: false, error: "invalid session input payload" };
    }
    if (!frame) return { ok: false, error: "invalid session input payload" };
    await env.BOT_CONNECTION.getByName(row.bot_id).pushSessionFrame(row.bot_id, frame);
    if (seq !== null) {
      sql.exec(
        "UPDATE stateful_session_inputs SET status='sent', sent_at=? WHERE session_id=? AND seq=? AND status='pending'",
        nowIso,
        sessionId,
        seq,
      );
    }
    return { ok: true };
  }

  if (row.kind === STATEFUL_BOT_DELIVERY_KINDS.sessionClose) {
    let payload: { close_frame?: unknown; delete_ref?: boolean };
    try {
      payload = JSON.parse(row.request_json) as { close_frame?: unknown; delete_ref?: boolean };
    } catch (err) {
      logSwallowedError("stateful_bot_delivery_json_invalid", err, { outbox_id: row.outbox_id, kind: row.kind });
      return { ok: false, error: "invalid session close payload" };
    }
    if (payload.close_frame) {
      await env.BOT_CONNECTION.getByName(row.bot_id).pushSessionFrame(row.bot_id, payload.close_frame);
    }
    if (payload.delete_ref !== false) {
      await env.BOT_CONNECTION.getByName(row.bot_id).deleteStatefulSessionRef({ session_id: sessionId });
    }
    return { ok: true };
  }

  return { ok: false, error: `unsupported stateful delivery kind=${row.kind}` };
}

export function bumpStatefulBotDeliveryRetry(
  sql: DurableObjectState["storage"]["sql"],
  outboxId: string,
  nowIso: string,
  error: string,
): void {
  bumpQueueRetry(sql, {
    table: "bot_delivery_outbox",
    idColumn: "outbox_id",
    id: outboxId,
    nowIso,
    error,
    maxAttempts: OUTBOX_MAX_ATTEMPTS,
  });
}
