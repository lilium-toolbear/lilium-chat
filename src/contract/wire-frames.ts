import type { ChatEventPayloadByType, ChatEventType } from "./events";
import type { ManagementPersistedEventType } from "./persisted";
import type { ChatId, IsoDateTimeString } from "./primitives";

/** WebSocket / fanout event frame (includes api_version). */
export type WireChatEventFrame<T extends ChatEventType = ChatEventType> = {
  frame_type: "event";
  api_version: "lilium.chat.v1";
  event_id: ChatId;
  type: T;
  channel_id: ChatId;
  occurred_at: IsoDateTimeString;
  payload: ChatEventPayloadByType[T];
};

export type EventFrame = {
  [K in ChatEventType]: WireChatEventFrame<K>;
}[ChatEventType];

export type UnknownWireEventFrame = {
  frame_type: "event";
  api_version: "lilium.chat.v1";
  event_id: ChatId;
  type: string;
  channel_id: ChatId;
  occurred_at: IsoDateTimeString;
  payload: Record<string, unknown>;
};

export type ManagementWirePayload = {
  [K in ManagementPersistedEventType]: ChatEventPayloadByType[K];
}[ManagementPersistedEventType];

export function buildWireEventFrame<T extends ChatEventType>(args: {
  event_id: string;
  type: T;
  channel_id: string;
  occurred_at: string;
  payload: ChatEventPayloadByType[T];
}): WireChatEventFrame<T> {
  return {
    frame_type: "event",
    api_version: "lilium.chat.v1",
    event_id: args.event_id,
    type: args.type,
    channel_id: args.channel_id,
    occurred_at: args.occurred_at,
    payload: args.payload,
  };
}
