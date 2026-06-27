import type { WireChatMessage } from "./message";

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
