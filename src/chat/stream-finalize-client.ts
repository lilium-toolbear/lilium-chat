import type { Env } from "../env";
import type { StreamFinalizeResponse } from "./stream-registry";
import { ApiError, apiErrorFromRemote, logSwallowedError } from "../errors";

export interface StreamFinalizeRequest {
  channel_id: string;
  message_id: string;
  bot_id: string;
  resolved_text: string;
  finalize_request_hash: string;
  final_seq: number;
  components?: unknown[];
  attachment_ids?: string[];
}

export async function callChatChannelStreamFinalize(
  env: Env,
  body: StreamFinalizeRequest,
): Promise<StreamFinalizeResponse> {
  return env.CHAT_CHANNEL.getByName(body.channel_id).streamFinalize(body);
}

export async function parseStreamFinalizeResponse(
  res: StreamFinalizeResponse | Response,
): Promise<{ ok: true; body: StreamFinalizeResponse } | { ok: false; code: string; message: string; retryable: boolean }> {
  if (res instanceof Response) {
    if (res.ok) {
      const body = (await res.json()) as StreamFinalizeResponse;
      return { ok: true, body };
    }
    try {
      const err = (await res.json()) as { error?: { code?: string; message?: string; retryable?: boolean } };
      return {
        ok: false,
        code: typeof err.error?.code === "string" ? err.error.code : "CHAT_WORKER_UNAVAILABLE",
        message: typeof err.error?.message === "string" ? err.error.message : "stream finalize failed",
        retryable: err.error?.retryable === true,
      };
    } catch (err) {
      logSwallowedError("stream_finalize_response_parse_failed", err);
      return { ok: false, code: "CHAT_WORKER_UNAVAILABLE", message: "stream finalize failed", retryable: true };
    }
  }
  return { ok: true, body: res };
}

export function streamFinalizeErrorFromThrown(
  err: unknown,
): { ok: false; code: string; message: string; retryable: boolean } {
  const apiErr = err instanceof ApiError ? err : apiErrorFromRemote(err);
  if (apiErr) {
    return {
      ok: false,
      code: apiErr.code,
      message: apiErr.message,
      retryable: apiErr.retryable === true,
    };
  }
  return {
    ok: false,
    code: "CHAT_WORKER_UNAVAILABLE",
    message: err instanceof Error ? err.message : "stream finalize failed",
    retryable: true,
  };
}
