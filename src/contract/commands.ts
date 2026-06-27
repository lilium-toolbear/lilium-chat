import type { Mention } from "./message";

export type ChatCommandName =
  | "message.send"
  | "message.edit"
  | "message.recall"
  | "message.delete"
  | "channel.mark_read"
  | "session.live_start"
  | "session.heartbeat";

export interface MessageSendCommandPayload {
  type: "text" | "image" | "sticker";
  text: string;
  reply_to_message_id?: string | null;
  attachment_ids?: string[];
  sticker_id?: string | null;
  mentions?: Mention[];
}

export interface MessageEditCommandPayload {
  message_id: string;
  text: string;
}

export interface MessageRecallCommandPayload {
  message_id: string;
}

export interface MessageDeleteCommandPayload {
  message_id: string;
  reason?: string | null;
}

export interface ChannelMarkReadCommandPayload {
  last_read_event_id: string;
}

export interface SessionLiveStartCommandPayload {
  subscribed_channel_ids?: string[];
}

export interface SessionHeartbeatCommandPayload {
  session_id: string;
}

export interface ChatCommandPayloadByName {
  "message.send": MessageSendCommandPayload;
  "message.edit": MessageEditCommandPayload;
  "message.recall": MessageRecallCommandPayload;
  "message.delete": MessageDeleteCommandPayload;
  "channel.mark_read": ChannelMarkReadCommandPayload;
  "session.live_start": SessionLiveStartCommandPayload;
  "session.heartbeat": SessionHeartbeatCommandPayload;
}

export type TypedCommandFrame<T extends ChatCommandName = ChatCommandName> = {
  frame_type: "command";
  command: T;
  command_id: string;
  channel_id?: string;
  payload: ChatCommandPayloadByName[T];
};

export type KnownCommandFrame = {
  [K in ChatCommandName]: TypedCommandFrame<K>;
}[ChatCommandName];

/** Parsed WS command before payload validation. */
export interface IncomingCommandFrame {
  frame_type: "command";
  command: string;
  command_id: string;
  channel_id?: string;
  payload: unknown;
}
