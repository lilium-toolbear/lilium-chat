export const BOT_GATEWAY_API_VERSION = "lilium.chat.bot.v1";

export interface ParsedHello {
  type: "hello";
  api_version: string;
  last_received_delivery_id: string | null;
}

export interface ParsedDeliveryResult {
  type: "delivery_result";
  api_version: string;
  delivery_id: string;
  status: "ok";
  effects: unknown[];
}

export interface DeliveryAckError {
  code: string;
  message: string;
}

export interface BotReadyFrame {
  type: "ready";
  api_version: string;
  bot_id: string;
  session_id: string;
  server_time: string;
}

export interface BotDeliveryFrame {
  type: "delivery";
  api_version: string;
  delivery_id: string;
  kind: "command_invocation" | "message_interaction" | "message_event";
  [key: string]: unknown;
}

export interface BotPongFrame {
  type: "pong";
  api_version: string;
}

export interface BotDeliveryAck {
  type: "delivery_ack";
  api_version: string;
  delivery_id: string;
  status: "applied" | "failed";
  error?: DeliveryAckError;
}

function asObject(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid frame");
  }
  return value as Record<string, unknown>;
}

export function parseHello(raw: string): ParsedHello {
  const obj = asObject(raw);
  if (obj.type !== "hello" || obj.api_version !== BOT_GATEWAY_API_VERSION) {
    throw new Error("not a hello frame");
  }
  const last = obj.last_received_delivery_id;
  if (last !== null && typeof last !== "string") {
    throw new Error("invalid last_received_delivery_id");
  }
  return { type: "hello", api_version: obj.api_version, last_received_delivery_id: last ?? null };
}

export function buildReady(bot_id: string, session_id: string, server_time: string): BotReadyFrame {
  return {
    type: "ready",
    api_version: BOT_GATEWAY_API_VERSION,
    bot_id,
    session_id,
    server_time,
  };
}

export function buildDeliveryFrame(delivery: Record<string, unknown>): BotDeliveryFrame {
  return {
    type: "delivery",
    api_version: BOT_GATEWAY_API_VERSION,
    ...delivery,
  } as BotDeliveryFrame;
}

export function parseDeliveryResult(raw: string): ParsedDeliveryResult {
  const obj = asObject(raw);
  if (obj.type !== "delivery_result" || obj.api_version !== BOT_GATEWAY_API_VERSION) {
    throw new Error("not a delivery_result frame");
  }
  if (typeof obj.delivery_id !== "string" || obj.delivery_id.length === 0) {
    throw new Error("invalid delivery_id");
  }
  const status = obj.status;
  if (status !== "ok") {
    throw new Error("invalid delivery_result status");
  }
  const effectsValue = obj.effects;
  if (!Array.isArray(effectsValue)) {
    throw new Error("invalid effects");
  }
  return {
    type: "delivery_result",
    api_version: obj.api_version,
    delivery_id: obj.delivery_id,
    status: "ok",
    effects: effectsValue,
  };
}

export function buildDeliveryAck(
  deliveryId: string,
  status: "applied" | "failed",
  error?: DeliveryAckError,
): BotDeliveryAck {
  return {
    type: "delivery_ack",
    api_version: BOT_GATEWAY_API_VERSION,
    delivery_id: deliveryId,
    status,
    ...(error ? { error } : {}),
  };
}

export function buildPong(): BotPongFrame {
  return {
    type: "pong",
    api_version: BOT_GATEWAY_API_VERSION,
  };
}
