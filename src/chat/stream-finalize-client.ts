import type { Env } from "../env";
import type { StreamFinalizeResponse } from "./stream-registry";
import { ApiError, apiErrorFromRemote } from "../errors";

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

export function streamFinalizeErrorFromThrown(
  err: unknown,
): { code: string; message: string; retryable: boolean } {
  const apiErr = err instanceof ApiError ? err : apiErrorFromRemote(err);
  if (apiErr) {
    return {
      code: apiErr.code,
      message: apiErr.message,
      retryable: apiErr.retryable === true,
    };
  }
  return {
    code: "CHAT_WORKER_UNAVAILABLE",
    message: err instanceof Error ? err.message : "stream finalize failed",
    retryable: true,
  };
}
