import type { MessageMutationAckPayload } from "../../contract/idempotency";
import { ApiError } from "../../errors";

export function throwApiErrorFromJsonBody(body: unknown): never {
  const b = body as { error?: Record<string, unknown> };
  const errObj = b.error;
  const code = typeof errObj?.code === "string" ? errObj.code : "CHAT_WORKER_UNAVAILABLE";
  const message = typeof errObj?.message === "string" ? errObj.message : "error";
  const opts: { retryable?: boolean; httpStatus?: number } = {};
  if (typeof errObj?.retryable === "boolean") opts.retryable = errObj.retryable;
  const err = new ApiError(code, message, opts);
  if (errObj) {
    for (const [key, val] of Object.entries(errObj)) {
      if (key !== "code" && key !== "message" && key !== "retryable") {
        Object.assign(err, { [key]: val });
      }
    }
  }
  throw err;
}

export function parseRpcCachedJson<T>(json: string): T {
  const parsed = JSON.parse(json) as unknown;
  if (parsed && typeof parsed === "object" && "error" in parsed && (parsed as { error?: unknown }).error) {
    throwApiErrorFromJsonBody(parsed);
  }
  return parsed as T;
}

export function parseMessageMutationAckFromCached(json: string): MessageMutationAckPayload {
  const parsed = JSON.parse(json) as { payload?: MessageMutationAckPayload; error?: unknown };
  if (parsed.error) throwApiErrorFromJsonBody(parsed);
  if (parsed.payload?.event_id && parsed.payload?.message) {
    return {
      channel_id: parsed.payload.channel_id,
      event_id: parsed.payload.event_id,
      message: parsed.payload.message,
    };
  }
  throw new ApiError("IDEMPOTENCY_CONFLICT", "malformed cached mutation ack");
}
