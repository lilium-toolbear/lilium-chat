import { BOT_GATEWAY_API_VERSION } from "../contract/bot-gateway";
import type { EffectResult } from "../contract/bot-gateway";
import type { CommandInvocationReplyContext, WireChatMessage } from "../contract/message";
import { isRecord } from "../contract/utils";

export interface SessionStartFrame {
  type: "session.start";
  api_version: typeof BOT_GATEWAY_API_VERSION;
  session_id: string;
  channel_id: string;
  bot_command: {
    bot_command_id: string;
    name: string;
    invoked_name: string;
    schema_version: number;
    definition_hash: string;
  };
  invoker: { user_id: string; display_name: string; avatar_url: string | null };
  options: Record<string, { type: string; value: unknown }>;
  reply_to?: CommandInvocationReplyContext | null;
  listen_rules: {
    message_types: string[];
    include_bot_messages: boolean;
    include_own_messages: boolean;
  };
  input_seq_start: number;
  expires_at: string;
}

export interface SessionInputFrame {
  type: "session.input";
  api_version: typeof BOT_GATEWAY_API_VERSION;
  session_id: string;
  channel_id: string;
  seq: number;
  event: { event_id: string; type: string; occurred_at: string };
  message: WireChatMessage;
}

/** JSON persisted in `stateful_session_inputs.message_projection_json`. */
export interface StatefulSessionInputStored {
  event: { event_id: string; type: string; occurred_at: string };
  message: WireChatMessage;
}

export interface ParsedSessionStartAck {
  type: "session.start_ack";
  api_version: string;
  session_id: string;
}

export interface ParsedSessionInputAck {
  type: "session.input_ack";
  api_version: string;
  session_id: string;
  last_received_seq: number;
}

export interface ParsedSessionClose {
  type: "session.close";
  api_version: string;
  session_id: string;
  reason?: string;
}

function asObject(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw);
  if (!isRecord(value)) throw new Error("invalid frame");
  return value;
}

export function buildSessionStart(input: Omit<SessionStartFrame, "type" | "api_version">): SessionStartFrame {
  return { type: "session.start", api_version: BOT_GATEWAY_API_VERSION, ...input };
}

export function buildSessionInput(input: Omit<SessionInputFrame, "type" | "api_version">): SessionInputFrame {
  return { type: "session.input", api_version: BOT_GATEWAY_API_VERSION, ...input };
}

export function parseSessionStartAck(raw: string): ParsedSessionStartAck {
  const obj = asObject(raw);
  if (obj.type !== "session.start_ack" || obj.api_version !== BOT_GATEWAY_API_VERSION) {
    throw new Error("not session.start_ack");
  }
  if (typeof obj.session_id !== "string" || obj.session_id.length === 0) {
    throw new Error("invalid session_id");
  }
  return {
    type: "session.start_ack",
    api_version: obj.api_version,
    session_id: obj.session_id,
  };
}

export function parseSessionInputAck(raw: string): ParsedSessionInputAck {
  const obj = asObject(raw);
  if (obj.type !== "session.input_ack" || obj.api_version !== BOT_GATEWAY_API_VERSION) {
    throw new Error("not session.input_ack");
  }
  if (typeof obj.session_id !== "string" || typeof obj.last_received_seq !== "number") {
    throw new Error("invalid session.input_ack");
  }
  return {
    type: "session.input_ack",
    api_version: obj.api_version,
    session_id: obj.session_id,
    last_received_seq: obj.last_received_seq,
  };
}

export function parseSessionClose(raw: string): ParsedSessionClose {
  const obj = asObject(raw);
  if (obj.type !== "session.close" || obj.api_version !== BOT_GATEWAY_API_VERSION) {
    throw new Error("not session.close");
  }
  if (typeof obj.session_id !== "string") throw new Error("invalid session_id");
  return {
    type: "session.close",
    api_version: obj.api_version,
    session_id: obj.session_id,
    ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
  };
}

export interface SessionClosedFrame {
  type: "session.closed";
  api_version: typeof BOT_GATEWAY_API_VERSION;
  session_id: string;
  status: string;
  reason: string;
}

export function buildSessionClosed(input: Omit<SessionClosedFrame, "type" | "api_version">): SessionClosedFrame {
  return { type: "session.closed", api_version: BOT_GATEWAY_API_VERSION, ...input };
}

export interface ParsedSessionEffects {
  type: "session.effects";
  api_version: string;
  session_id: string;
  effect_seq: number;
  effects: unknown[];
}

export interface SessionEffectsAckFrame {
  type: "session.effects_ack";
  api_version: typeof BOT_GATEWAY_API_VERSION;
  session_id: string;
  effect_seq: number;
  status: "applied" | "rejected";
  effect_results?: EffectResult[];
  error?: { code: string; message: string };
}

export function parseSessionEffects(raw: string): ParsedSessionEffects {
  const obj = asObject(raw);
  if (obj.type !== "session.effects" || obj.api_version !== BOT_GATEWAY_API_VERSION) {
    throw new Error("not session.effects");
  }
  if (typeof obj.session_id !== "string" || obj.session_id.length === 0) {
    throw new Error("invalid session_id");
  }
  if (typeof obj.effect_seq !== "number" || !Number.isInteger(obj.effect_seq) || obj.effect_seq < 1) {
    throw new Error("invalid effect_seq");
  }
  if (!Array.isArray(obj.effects)) {
    throw new Error("invalid effects");
  }
  return {
    type: "session.effects",
    api_version: obj.api_version,
    session_id: obj.session_id,
    effect_seq: obj.effect_seq,
    effects: obj.effects,
  };
}

export function buildSessionEffectsAck(
  sessionId: string,
  effectSeq: number,
  status: "applied" | "rejected",
  opts?: {
    effect_results?: EffectResult[];
    error?: { code: string; message: string };
  },
): SessionEffectsAckFrame {
  return {
    type: "session.effects_ack",
    api_version: BOT_GATEWAY_API_VERSION,
    session_id: sessionId,
    effect_seq: effectSeq,
    status,
    ...(opts?.effect_results !== undefined ? { effect_results: opts.effect_results } : {}),
    ...(opts?.error ? { error: opts.error } : {}),
  };
}
