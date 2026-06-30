import type { Env } from "../env";
import type { StreamAbandonResponse } from "./stream-registry";
import { computeAbandonedTextHash } from "./stream-registry";
import { ApiError, logSwallowedError } from "../errors";

export interface StreamAbandonRequest {
  channel_id: string;
  message_id: string;
  bot_id: string;
  resolved_partial: string;
}

export async function callChatChannelStreamAbandon(
  env: Env,
  body: StreamAbandonRequest,
): Promise<StreamAbandonResponse | { ok: true; canonical: false }> {
  const abandonedTextHash = await computeAbandonedTextHash(body.resolved_partial);
  return env.CHAT_CHANNEL.getByName(body.channel_id).streamAbandon({
    channel_id: body.channel_id,
    message_id: body.message_id,
    bot_id: body.bot_id,
    resolved_partial: body.resolved_partial,
    abandoned_text_hash: abandonedTextHash,
  });
}

export async function parseStreamAbandonResponse(
  res: StreamAbandonResponse | { ok: true; canonical: false } | Response,
): Promise<
  | { ok: true; body: StreamAbandonResponse | { ok: true; canonical: false } }
  | { ok: false; code: string; message: string; retryable: boolean }
> {
  if (res instanceof Response) {
    if (res.ok) {
      const body = (await res.json()) as StreamAbandonResponse | { ok: true; canonical: false };
      return { ok: true, body };
    }
    try {
      const err = (await res.json()) as { error?: { code?: string; message?: string; retryable?: boolean } };
      return {
        ok: false,
        code: typeof err.error?.code === "string" ? err.error.code : "CHAT_WORKER_UNAVAILABLE",
        message: typeof err.error?.message === "string" ? err.error.message : "stream abandon failed",
        retryable: err.error?.retryable === true,
      };
    } catch (err) {
      logSwallowedError("stream_abandon_response_parse_failed", err);
      return { ok: false, code: "CHAT_WORKER_UNAVAILABLE", message: "stream abandon failed", retryable: true };
    }
  }
  return { ok: true, body: res };
}

export function streamAbandonErrorFromThrown(
  err: unknown,
): { ok: false; code: string; message: string; retryable: boolean } {
  if (err instanceof ApiError) {
    return {
      ok: false,
      code: err.code,
      message: err.message,
      retryable: err.retryable === true,
    };
  }
  return {
    ok: false,
    code: "CHAT_WORKER_UNAVAILABLE",
    message: err instanceof Error ? err.message : "stream abandon failed",
    retryable: true,
  };
}
