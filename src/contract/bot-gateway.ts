export const BOT_GATEWAY_API_VERSION = "lilium.chat.bot.v1";

export type BotDeliveryKind = "command_invocation" | "message_interaction" | "message_event";

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
