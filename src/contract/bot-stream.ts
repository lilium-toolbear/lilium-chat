import type { ChatId, IsoDateTimeString } from "./primitives";
import type {
  MessageStreamAbandonCleanupPayload,
  MessageStreamDeltaPayload,
  MessageStreamStartedPayload,
} from "./events";

export const BOT_STREAM_API_VERSION = "lilium.chat.bot.stream.v1";
export const BROWSER_STREAM_EVENT_API_VERSION = "lilium.chat.stream.v1";

export type LiveStreamEventType =
  | "message.stream_started"
  | "message.stream_delta"
  | "message.stream_abandon_cleanup";

export const LIVE_STREAM_EVENT_TYPES = [
  "message.stream_started",
  "message.stream_delta",
  "message.stream_abandon_cleanup",
] as const satisfies readonly LiveStreamEventType[];

export interface BotStreamHelloFrame {
  type: "hello";
  api_version: typeof BOT_STREAM_API_VERSION;
}

export interface BotStreamReadyFrame {
  type: "ready";
  api_version: typeof BOT_STREAM_API_VERSION;
  channel_id: ChatId;
  message_id: ChatId;
  expires_at: IsoDateTimeString;
  ack_seq: number;
}

export interface BotStreamAppendFrame {
  type: "append";
  api_version: typeof BOT_STREAM_API_VERSION;
  seq: number;
  delta: string;
}

export interface BotStreamAppendAckFrame {
  type: "append_ack";
  api_version: typeof BOT_STREAM_API_VERSION;
  ack_seq: number;
}

export interface BotStreamFinalizeFrame {
  type: "finalize";
  api_version: typeof BOT_STREAM_API_VERSION;
  final_seq: number;
  components?: unknown[];
  attachment_ids?: ChatId[];
}

export interface BotStreamFinalizedAckFrame {
  type: "finalized_ack";
  api_version: typeof BOT_STREAM_API_VERSION;
  ok: true;
  message_id: ChatId;
  event_id: ChatId;
}

export interface BotStreamErrorFrame {
  type: "stream_error";
  api_version: typeof BOT_STREAM_API_VERSION;
  code: string;
  message: string;
  retryable: boolean;
}

export interface BotStreamPingFrame {
  type: "ping";
  api_version: typeof BOT_STREAM_API_VERSION;
}

export interface BotStreamPongFrame {
  type: "pong";
  api_version: typeof BOT_STREAM_API_VERSION;
}

export type BotStreamIncomingFrame = BotStreamHelloFrame | BotStreamAppendFrame | BotStreamFinalizeFrame | BotStreamPingFrame;

export type BotStreamOutgoingFrame =
  | BotStreamReadyFrame
  | BotStreamAppendAckFrame
  | BotStreamFinalizedAckFrame
  | BotStreamErrorFrame
  | BotStreamPongFrame;

export type LiveStreamEventPayloadByType = {
  "message.stream_started": MessageStreamStartedPayload;
  "message.stream_delta": MessageStreamDeltaPayload;
  "message.stream_abandon_cleanup": MessageStreamAbandonCleanupPayload;
};

export type WireStreamEventFrame<T extends LiveStreamEventType = LiveStreamEventType> = {
  frame_type: "stream_event";
  api_version: typeof BROWSER_STREAM_EVENT_API_VERSION;
  channel_id: ChatId;
  type: T;
  payload: LiveStreamEventPayloadByType[T];
  stream_seq?: number;
  occurred_at?: IsoDateTimeString;
};

export type StreamEventFrame = {
  [K in LiveStreamEventType]: WireStreamEventFrame<K>;
}[LiveStreamEventType];
