import type { Env } from "../env";
import type { StreamFinalizeResponse } from "./stream-registry";

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
): Promise<Response> {
  return env.CHAT_CHANNEL.getByName(body.channel_id).fetch(
    new Request("https://x/internal/stream-finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function parseStreamFinalizeResponse(
  res: Response,
): Promise<{ ok: true; body: StreamFinalizeResponse } | { ok: false; code: string; message: string; retryable: boolean }> {
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
  } catch {
    return { ok: false, code: "CHAT_WORKER_UNAVAILABLE", message: "stream finalize failed", retryable: true };
  }
}
