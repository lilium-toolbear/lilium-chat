import {
  BOT_STREAM_API_VERSION,
  type BotStreamAppendAckFrame,
  type BotStreamAppendFrame,
  type BotStreamErrorFrame,
  type BotStreamFinalizeFrame,
  type BotStreamFinalizedAckFrame,
  type BotStreamHelloFrame,
  type BotStreamPingFrame,
  type BotStreamPongFrame,
  type BotStreamReadyFrame,
} from "../contract/bot-stream";
import { isRecord } from "../contract/utils";

function asObject(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error("invalid frame");
  }
  return value;
}

function assertApiVersion(obj: Record<string, unknown>): void {
  if (obj.api_version !== BOT_STREAM_API_VERSION) {
    throw new Error("invalid api_version");
  }
}

export function buildBotStreamHello(): BotStreamHelloFrame {
  return { type: "hello", api_version: BOT_STREAM_API_VERSION };
}

export function parseBotStreamHello(raw: string): BotStreamHelloFrame {
  const obj = asObject(raw);
  if (obj.type !== "hello") {
    throw new Error("not a hello frame");
  }
  assertApiVersion(obj);
  return { type: "hello", api_version: BOT_STREAM_API_VERSION };
}

export function buildBotStreamReady(input: Omit<BotStreamReadyFrame, "type" | "api_version">): BotStreamReadyFrame {
  return { type: "ready", api_version: BOT_STREAM_API_VERSION, ...input };
}

export function parseBotStreamReady(raw: string): BotStreamReadyFrame {
  const obj = asObject(raw);
  if (obj.type !== "ready") {
    throw new Error("not a ready frame");
  }
  assertApiVersion(obj);
  if (
    typeof obj.channel_id !== "string" ||
    typeof obj.message_id !== "string" ||
    typeof obj.expires_at !== "string" ||
    typeof obj.ack_seq !== "number"
  ) {
    throw new Error("invalid ready frame");
  }
  return {
    type: "ready",
    api_version: BOT_STREAM_API_VERSION,
    channel_id: obj.channel_id,
    message_id: obj.message_id,
    expires_at: obj.expires_at,
    ack_seq: obj.ack_seq,
  };
}

export function buildBotStreamAppend(input: Omit<BotStreamAppendFrame, "type" | "api_version">): BotStreamAppendFrame {
  return { type: "append", api_version: BOT_STREAM_API_VERSION, ...input };
}

export function parseBotStreamAppend(raw: string): BotStreamAppendFrame {
  const obj = asObject(raw);
  if (obj.type !== "append") {
    throw new Error("not an append frame");
  }
  assertApiVersion(obj);
  if (typeof obj.seq !== "number" || typeof obj.delta !== "string") {
    throw new Error("invalid append frame");
  }
  return { type: "append", api_version: BOT_STREAM_API_VERSION, seq: obj.seq, delta: obj.delta };
}

export function buildBotStreamAppendAck(
  input: Omit<BotStreamAppendAckFrame, "type" | "api_version">,
): BotStreamAppendAckFrame {
  return { type: "append_ack", api_version: BOT_STREAM_API_VERSION, ...input };
}

export function parseBotStreamAppendAck(raw: string): BotStreamAppendAckFrame {
  const obj = asObject(raw);
  if (obj.type !== "append_ack") {
    throw new Error("not an append_ack frame");
  }
  assertApiVersion(obj);
  if (typeof obj.ack_seq !== "number") {
    throw new Error("invalid append_ack frame");
  }
  return { type: "append_ack", api_version: BOT_STREAM_API_VERSION, ack_seq: obj.ack_seq };
}

export function buildBotStreamFinalize(
  input: Omit<BotStreamFinalizeFrame, "type" | "api_version">,
): BotStreamFinalizeFrame {
  return { type: "finalize", api_version: BOT_STREAM_API_VERSION, ...input };
}

export function parseBotStreamFinalize(raw: string): BotStreamFinalizeFrame {
  const obj = asObject(raw);
  if (obj.type !== "finalize") {
    throw new Error("not a finalize frame");
  }
  assertApiVersion(obj);
  if (typeof obj.final_seq !== "number") {
    throw new Error("invalid finalize frame");
  }
  return {
    type: "finalize",
    api_version: BOT_STREAM_API_VERSION,
    final_seq: obj.final_seq,
    ...(Array.isArray(obj.components) ? { components: obj.components } : {}),
    ...(Array.isArray(obj.attachment_ids) ? { attachment_ids: obj.attachment_ids as string[] } : {}),
  };
}

export function buildBotStreamFinalizedAck(
  input: Omit<BotStreamFinalizedAckFrame, "type" | "api_version" | "ok">,
): BotStreamFinalizedAckFrame {
  return { type: "finalized_ack", api_version: BOT_STREAM_API_VERSION, ok: true, ...input };
}

export function parseBotStreamFinalizedAck(raw: string): BotStreamFinalizedAckFrame {
  const obj = asObject(raw);
  if (obj.type !== "finalized_ack" || obj.ok !== true) {
    throw new Error("not a finalized_ack frame");
  }
  assertApiVersion(obj);
  if (typeof obj.message_id !== "string" || typeof obj.event_id !== "string") {
    throw new Error("invalid finalized_ack frame");
  }
  return {
    type: "finalized_ack",
    api_version: BOT_STREAM_API_VERSION,
    ok: true,
    message_id: obj.message_id,
    event_id: obj.event_id,
  };
}

export function buildBotStreamError(input: Omit<BotStreamErrorFrame, "type" | "api_version">): BotStreamErrorFrame {
  return { type: "stream_error", api_version: BOT_STREAM_API_VERSION, ...input };
}

export function parseBotStreamError(raw: string): BotStreamErrorFrame {
  const obj = asObject(raw);
  if (obj.type !== "stream_error") {
    throw new Error("not a stream_error frame");
  }
  assertApiVersion(obj);
  if (typeof obj.code !== "string" || typeof obj.message !== "string" || typeof obj.retryable !== "boolean") {
    throw new Error("invalid stream_error frame");
  }
  return {
    type: "stream_error",
    api_version: BOT_STREAM_API_VERSION,
    code: obj.code,
    message: obj.message,
    retryable: obj.retryable,
  };
}

export function buildBotStreamPing(): BotStreamPingFrame {
  return { type: "ping", api_version: BOT_STREAM_API_VERSION };
}

export function parseBotStreamPing(raw: string): BotStreamPingFrame {
  const obj = asObject(raw);
  if (obj.type !== "ping") {
    throw new Error("not a ping frame");
  }
  assertApiVersion(obj);
  return { type: "ping", api_version: BOT_STREAM_API_VERSION };
}

export function buildBotStreamPong(): BotStreamPongFrame {
  return { type: "pong", api_version: BOT_STREAM_API_VERSION };
}

export function parseBotStreamPong(raw: string): BotStreamPongFrame {
  const obj = asObject(raw);
  if (obj.type !== "pong") {
    throw new Error("not a pong frame");
  }
  assertApiVersion(obj);
  return { type: "pong", api_version: BOT_STREAM_API_VERSION };
}
