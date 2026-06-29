import type { Env } from "../env";
import { OUTBOX_MAX_ATTEMPTS } from "../contract/outbox";
import { bumpQueueRetry } from "../do/retry-backoff";

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

async function postBotConnection(
  env: Env,
  botId: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return env.BOT_CONNECTION.getByName(botId).fetch(
    new Request(`https://x${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Verified-Bot-Id": botId },
      body: JSON.stringify(body),
    }),
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
    } catch {
      return { ok: false, error: "invalid session start payload" };
    }
    if (!payload.ref || !payload.start_frame) {
      return { ok: false, error: "invalid session start payload" };
    }
    const refRes = await postBotConnection(env, row.bot_id, "/internal/stateful-session-ref-upsert", payload.ref);
    if (!refRes.ok) {
      return { ok: false, error: `${refRes.status}: ${await refRes.text()}` };
    }
    const frameRes = await postBotConnection(env, row.bot_id, "/internal/push-session-frame", payload.start_frame);
    if (!frameRes.ok) {
      return { ok: false, error: `${frameRes.status}: ${await frameRes.text()}` };
    }
    return { ok: true };
  }

  if (row.kind === STATEFUL_BOT_DELIVERY_KINDS.sessionRefUpsert) {
    let ref: unknown;
    try {
      ref = JSON.parse(row.request_json);
    } catch {
      return { ok: false, error: "invalid ref payload" };
    }
    const res = await postBotConnection(env, row.bot_id, "/internal/stateful-session-ref-upsert", ref);
    if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
    return { ok: true };
  }

  if (row.kind === STATEFUL_BOT_DELIVERY_KINDS.sessionInput) {
    let frame: unknown;
    let seq: number | null = null;
    try {
      const parsed = JSON.parse(row.request_json) as { frame?: unknown; seq?: unknown };
      frame = parsed.frame;
      seq = typeof parsed.seq === "number" ? parsed.seq : null;
    } catch {
      return { ok: false, error: "invalid session input payload" };
    }
    if (!frame) return { ok: false, error: "invalid session input payload" };
    const res = await postBotConnection(env, row.bot_id, "/internal/push-session-frame", frame);
    if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
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
    } catch {
      return { ok: false, error: "invalid session close payload" };
    }
    if (payload.close_frame) {
      const closeRes = await postBotConnection(env, row.bot_id, "/internal/push-session-frame", payload.close_frame);
      if (!closeRes.ok) return { ok: false, error: `${closeRes.status}: ${await closeRes.text()}` };
    }
    if (payload.delete_ref !== false) {
      const delRes = await postBotConnection(env, row.bot_id, "/internal/stateful-session-ref-delete", {
        session_id: sessionId,
      });
      if (!delRes.ok) return { ok: false, error: `${delRes.status}: ${await delRes.text()}` };
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
