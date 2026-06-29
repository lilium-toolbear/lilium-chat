import { BOT_GATEWAY_API_VERSION } from "../contract/bot-gateway";
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
  message: Record<string, unknown>;
}

export interface ParsedSessionStarted {
  type: "session.started";
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

export function parseSessionStarted(raw: string): ParsedSessionStarted {
  const obj = asObject(raw);
  if (obj.type !== "session.started" || obj.api_version !== BOT_GATEWAY_API_VERSION) {
    throw new Error("not session.started");
  }
  if (typeof obj.session_id !== "string" || obj.session_id.length === 0) {
    throw new Error("invalid session_id");
  }
  return {
    type: "session.started",
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
