export const BOT_GATEWAY_API_VERSION = "lilium.chat.bot.v1";

export type BotDeliveryKind = "command_invocation" | "message_interaction" | "message_event";

/** Main Bot Gateway WS effect types (§9.7 / §9.14). */
export const MAIN_GATEWAY_EFFECT_TYPES = [
  "send_message",
  "update_message",
  "disable_components",
  "start_stream",
] as const;

export type MainGatewayEffectType = (typeof MAIN_GATEWAY_EFFECT_TYPES)[number];

/** Rejected on main Gateway; must use Stream WS (§9.13). */
export const REJECTED_MAIN_GATEWAY_STREAM_EFFECT_TYPES = ["append_stream", "finalize_stream"] as const;

export type RejectedMainGatewayStreamEffectType = (typeof REJECTED_MAIN_GATEWAY_STREAM_EFFECT_TYPES)[number];

export interface BotEffectWire {
  type: string;
  client_effect_id: string;
  [key: string]: unknown;
}

export interface StartStreamEffectResult {
  client_effect_id: string;
  type: "start_stream";
  status: "applied";
  message_id: string;
  stream: {
    channel_id: string;
    message_id: string;
    ws_url: string;
    expires_at: string;
  };
}

export interface GenericAppliedEffectResult {
  client_effect_id: string;
  type: Exclude<MainGatewayEffectType, "start_stream">;
  status: "applied";
  message_id?: string;
  event_id?: string;
}

export type EffectResult = StartStreamEffectResult | GenericAppliedEffectResult;

/** Persisted request body inside bot_deliveries.request_json (no envelope fields). */
export type BotDeliveryRequestBody = {
  channel_id?: string;
  [key: string]: unknown;
};

/** Full delivery frame body passed to buildDeliveryFrame. */
export interface BotDeliveryBody extends BotDeliveryRequestBody {
  delivery_id: string;
  kind: BotDeliveryKind;
  channel_id: string;
}

export interface BotDeliveryFrame {
  type: "delivery";
  api_version: typeof BOT_GATEWAY_API_VERSION;
  delivery_id: string;
  kind: BotDeliveryKind;
  channel_id: string;
  [key: string]: unknown;
}

export interface BotDeliveryAckError {
  code: string;
  message: string;
}

export interface BotDeliveryAck {
  type: "delivery_ack";
  api_version: typeof BOT_GATEWAY_API_VERSION;
  delivery_id: string;
  status: "applied" | "failed";
  effect_results?: EffectResult[];
  error?: BotDeliveryAckError;
}
