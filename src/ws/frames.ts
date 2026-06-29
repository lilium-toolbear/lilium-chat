import type { IncomingCommandFrame } from "../contract/commands";
import type { WireChatMessage } from "../contract/message";
import type { EventFrame } from "../contract/wire-frames";

export type { EventFrame } from "../contract/wire-frames";
export type { IncomingCommandFrame as CommandFrame } from "../contract/commands";

export type Frame = IncomingCommandFrame | CommandAckFrame | CommandErrorFrame | EventFrame | ReadStateUpdatedFrame | UserEventFrame;

export type CommandAckFrame =
  | {
      frame_type: "command_ack";
      command: "message.send" | "message.edit" | "message.recall" | "message.delete";
      command_id: string;
      status: "committed";
      payload: { channel_id: string; event_id: string; message: WireChatMessage };
    }
  | {
      frame_type: "command_ack";
      command: "channel.mark_read";
      command_id: string;
      status: "committed";
      payload: { channel_id: string; last_read_event_id: string; unread_count: number };
    }
  | {
      frame_type: "command_ack";
      command: "session.live_start";
      command_id: string;
      status: "committed";
      payload: { session_id: string; subscribed_channel_count: number; lease_expires_at: string };
    }
  | {
      frame_type: "command_ack";
      command: "session.heartbeat";
      command_id: string;
      status: "committed";
      payload: { session_id: string; lease_expires_at: string };
    };

export interface CommandErrorFrame {
  frame_type: "command_error";
  command_id: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    active_session?: {
      session_id: string;
      command_name: string;
      started_by: { user_id: string; display_name: string; avatar_url: string | null };
      started_at: string;
      expires_at: string;
    };
  };
}

export interface ReadStateUpdatedFrame {
  frame_type: "read_state_updated";
  channel_id: string;
  last_read_event_id: string;
  unread_count: number;
}

export interface UserEventFrame {
  frame_type: "user_event";
  event: "my_channels_changed";
  reason: string;
  changed_channel_id?: string;
}

export function parseFrame(text: string): Frame {
  const obj = JSON.parse(text) as Frame;
  if (!obj || typeof obj.frame_type !== "string") throw new Error("invalid frame");
  return obj;
}
