import type { Env } from "../env";
import { RESUMABLE_REF_STATUSES } from "../chat/stateful-session";
import { buildSessionInput, type SessionInputFrame } from "../chat/bot-gateway-session";

export interface SessionRefRow {
  session_id: string;
  channel_id: string;
  bot_id: string;
  status: string;
  updated_at: string;
}

export function upsertStatefulSessionRef(
  ctx: DurableObjectState,
  input: { session_id: string; channel_id: string; bot_id: string; status: string; updated_at: string },
): void {
  ctx.storage.sql.exec(
    `INSERT INTO active_stateful_session_refs (session_id, channel_id, bot_id, status, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       channel_id = excluded.channel_id,
       bot_id = excluded.bot_id,
       status = excluded.status,
       updated_at = excluded.updated_at`,
    input.session_id,
    input.channel_id,
    input.bot_id,
    input.status,
    input.updated_at,
  );
}

export function deleteStatefulSessionRef(ctx: DurableObjectState, sessionId: string): void {
  ctx.storage.sql.exec("DELETE FROM active_stateful_session_refs WHERE session_id=?", sessionId);
}

export function listResumableSessionRefs(ctx: DurableObjectState, botId: string): SessionRefRow[] {
  const placeholders = RESUMABLE_REF_STATUSES.map(() => "?").join(", ");
  return ctx.storage.sql
    .exec(
      `SELECT session_id, channel_id, bot_id, status, updated_at
       FROM active_stateful_session_refs
       WHERE bot_id=? AND status IN (${placeholders})
       ORDER BY updated_at ASC`,
      botId,
      ...RESUMABLE_REF_STATUSES,
    )
    .toArray() as unknown as SessionRefRow[];
}

export async function resumeStatefulSessions(
  ctx: DurableObjectState,
  env: Env,
  botId: string,
  pushFrame: (frame: SessionInputFrame) => boolean,
): Promise<void> {
  const refs = listResumableSessionRefs(ctx, botId);
  for (const ref of refs) {
    const res = await env.CHAT_CHANNEL.getByName(ref.channel_id).fetch(
      new Request(`https://x/internal/stateful-session-inputs?session_id=${encodeURIComponent(ref.session_id)}`),
    );
    if (res.status === 404 || res.status === 409) {
      deleteStatefulSessionRef(ctx, ref.session_id);
      continue;
    }
    if (!res.ok) continue;
    const body = (await res.json()) as {
      session?: { status?: string };
      inputs?: Array<{
        seq: number;
        event_id: string;
        event_type: string;
        occurred_at: string;
        message: Record<string, unknown>;
      }>;
    };
    if (!body.session || body.session.status === "closed" || body.session.status === "failed" || body.session.status === "expired") {
      deleteStatefulSessionRef(ctx, ref.session_id);
      continue;
    }
    for (const input of body.inputs ?? []) {
      pushFrame(
        buildSessionInput({
          session_id: ref.session_id,
          channel_id: ref.channel_id,
          seq: input.seq,
          event: { event_id: input.event_id, type: input.event_type, occurred_at: input.occurred_at },
          message: input.message,
        }),
      );
    }
  }
}

export async function forwardBotSessionFrameToChatChannel(
  env: Env,
  channelId: string,
  pathname: string,
  body: unknown,
): Promise<Response> {
  return env.CHAT_CHANNEL.getByName(channelId).fetch(
    new Request(`https://x${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
