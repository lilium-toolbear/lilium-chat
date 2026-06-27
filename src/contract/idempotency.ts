import type { WireChatMessage } from "./message";

/** Idempotency key TTL — 24 hours. */
export const IDEMPOTENCY_TTL_MS = 86_400_000;

export function idempotencyExpiresAt(nowMs: number): string {
  return new Date(nowMs + IDEMPOTENCY_TTL_MS).toISOString();
}

export interface MessageMutationAckPayload {
  channel_id: string;
  event_id: string;
  message: WireChatMessage;
}

export interface MessageMutationIdempotencyEnvelope {
  payload?: MessageMutationAckPayload;
}

export interface MessageMutationInternalRequest {
  operation_id: string;
  message_id: string;
  channel_id: string;
  text?: string;
  reason?: string | null;
}
