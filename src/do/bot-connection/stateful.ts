import type { Env } from "../../env";
import { apiErrorFromRemote } from "../../errors";
import type { ChatChannel } from "../chat-channel";
import { RESUMABLE_REF_STATUSES } from "../../chat/stateful-session";
import { buildSessionInput, type SessionInputFrame } from "../../chat/bot-gateway-session";
import type { StatefulSessionInputsResponse } from "../../contract/stateful-session-api";

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
    try {
      const body = await (env.CHAT_CHANNEL.getByName(ref.channel_id) as DurableObjectStub<ChatChannel>)
        .statefulSessionInputs({ session_id: ref.session_id }) as StatefulSessionInputsResponse;
      if (body.session.status === "closed" || body.session.status === "failed" || body.session.status === "expired") {
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
    } catch (err) {
      const apiErr = apiErrorFromRemote(err);
      if (apiErr && (apiErr.code === "STATEFUL_SESSION_NOT_FOUND" || apiErr.code === "STATEFUL_SESSION_NOT_ACTIVE")) {
        deleteStatefulSessionRef(ctx, ref.session_id);
      }
    }
  }
}

export async function notifyBotSessionStarted(env: Env, channelId: string, body: { session_id: string }): Promise<void> {
  await env.CHAT_CHANNEL.getByName(channelId).botSessionStarted(body);
}

export async function notifyBotSessionInputAck(
  env: Env,
  channelId: string,
  body: { session_id: string; last_received_seq: number },
): Promise<void> {
  await env.CHAT_CHANNEL.getByName(channelId).botSessionInputAck(body);
}

export async function notifyBotSessionClose(env: Env, channelId: string, body: { session_id: string; reason?: string }): Promise<void> {
  await env.CHAT_CHANNEL.getByName(channelId).botSessionClose(body);
}
