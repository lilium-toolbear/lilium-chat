import {
  BOT_GATEWAY_API_VERSION,
  MAIN_GATEWAY_EFFECT_TYPES,
  REJECTED_MAIN_GATEWAY_STREAM_EFFECT_TYPES,
  type BotDeliveryAck,
  type BotDeliveryAckError,
  type BotDeliveryBody,
  type BotDeliveryFrame,
  type BotEffectWire,
  type EffectResult,
  type MainGatewayEffectType,
} from "../contract/bot-gateway";
import { isRecord } from "../contract/utils";

export {
  BOT_GATEWAY_API_VERSION,
  MAIN_GATEWAY_EFFECT_TYPES,
  REJECTED_MAIN_GATEWAY_STREAM_EFFECT_TYPES,
  type BotDeliveryAck,
  type BotDeliveryAckError,
  type BotDeliveryBody,
  type BotDeliveryFrame,
  type BotDeliveryRequestBody,
  type BotEffectWire,
  type EffectResult,
  type GenericAppliedEffectResult,
  type MainGatewayEffectType,
  type StartStreamEffectResult,
} from "../contract/bot-gateway";

export {
  BOT_STREAM_API_VERSION,
  BROWSER_STREAM_EVENT_API_VERSION,
  LIVE_STREAM_EVENT_TYPES,
  type BotStreamAppendAckFrame,
  type BotStreamAppendFrame,
  type BotStreamErrorFrame,
  type BotStreamFinalizeFrame,
  type BotStreamFinalizedAckFrame,
  type BotStreamHelloFrame,
  type BotStreamIncomingFrame,
  type BotStreamOutgoingFrame,
  type BotStreamPingFrame,
  type BotStreamPongFrame,
  type BotStreamReadyFrame,
  type LiveStreamEventType,
  type StreamEventFrame,
  type WireStreamEventFrame,
} from "../contract/bot-stream";

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

export interface BotReadyFrame {
  type: "ready";
  api_version: string;
  bot_id: string;
  session_id: string;
  server_time: string;
}

export interface BotPongFrame {
  type: "pong";
  api_version: string;
}

export class MainGatewayEffectValidationError extends Error {
  readonly code: "BOT_EFFECT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "MainGatewayEffectValidationError";
    this.code = "BOT_EFFECT_INVALID";
  }
}

const MAIN_GATEWAY_EFFECT_TYPE_SET = new Set<string>(MAIN_GATEWAY_EFFECT_TYPES);
const REJECTED_STREAM_EFFECT_TYPE_SET = new Set<string>(REJECTED_MAIN_GATEWAY_STREAM_EFFECT_TYPES);

function asObject(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error("invalid frame");
  }
  return value;
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

export function buildDeliveryFrame(delivery: BotDeliveryBody): BotDeliveryFrame {
  return {
    type: "delivery",
    api_version: BOT_GATEWAY_API_VERSION,
    ...delivery,
  };
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

/** Reject append_stream/finalize_stream and unknown types before DO application. */
export function validateMainGatewayEffects(effects: unknown[]): BotEffectWire[] {
  const parsed: BotEffectWire[] = [];
  for (const raw of effects) {
    if (!isRecord(raw)) {
      throw new MainGatewayEffectValidationError("invalid effect body");
    }
    const type = raw.type;
    const clientEffectId = raw.client_effect_id;
    if (typeof type !== "string" || typeof clientEffectId !== "string" || clientEffectId.length === 0) {
      throw new MainGatewayEffectValidationError("effect requires type and client_effect_id");
    }
    if (REJECTED_STREAM_EFFECT_TYPE_SET.has(type)) {
      throw new MainGatewayEffectValidationError(`${type} must use Stream WS`);
    }
    if (!MAIN_GATEWAY_EFFECT_TYPE_SET.has(type)) {
      throw new MainGatewayEffectValidationError(`unsupported effect type: ${type}`);
    }
    parsed.push({ ...raw, type, client_effect_id: clientEffectId });
  }
  return parsed;
}

export function buildDeliveryAck(
  deliveryId: string,
  status: "applied" | "failed",
  opts?: { error?: BotDeliveryAckError; effect_results?: EffectResult[] },
): BotDeliveryAck {
  return {
    type: "delivery_ack",
    api_version: BOT_GATEWAY_API_VERSION,
    delivery_id: deliveryId,
    status,
    ...(opts?.effect_results !== undefined ? { effect_results: opts.effect_results } : {}),
    ...(opts?.error ? { error: opts.error } : {}),
  };
}

export function buildPong(): BotPongFrame {
  return {
    type: "pong",
    api_version: BOT_GATEWAY_API_VERSION,
  };
}
