import type { Env } from "../env";
import type { StreamAbandonNonCanonical, StreamAbandonResponse } from "./stream-registry";
import { computeAbandonedTextHash } from "./stream-registry";
import { ApiError } from "../errors";

export interface StreamAbandonRequest {
  channel_id: string;
  message_id: string;
  bot_id: string;
  resolved_partial: string;
}

export async function callChatChannelStreamAbandon(
  env: Env,
  body: StreamAbandonRequest,
): Promise<StreamAbandonResponse | StreamAbandonNonCanonical> {
  const abandonedTextHash = await computeAbandonedTextHash(body.resolved_partial);
  return env.CHAT_CHANNEL.getByName(body.channel_id).streamAbandon({
    channel_id: body.channel_id,
    message_id: body.message_id,
    bot_id: body.bot_id,
    resolved_partial: body.resolved_partial,
    abandoned_text_hash: abandonedTextHash,
  });
}

export function streamAbandonErrorFromThrown(
  err: unknown,
): { code: string; message: string; retryable: boolean } {
  if (err instanceof ApiError) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable === true,
    };
  }
  return {
    code: "CHAT_WORKER_UNAVAILABLE",
    message: err instanceof Error ? err.message : "stream abandon failed",
    retryable: true,
  };
}
