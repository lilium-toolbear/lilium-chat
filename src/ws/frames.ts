export type Frame = CommandFrame | CommandAckFrame | CommandErrorFrame | EventFrame | ReadStateUpdatedFrame;

export interface CommandFrame {
  frame_type: "command";
  command: string;
  command_id: string;
  channel_id?: string;
  payload: Record<string, unknown>;
}

// v4.0: command_ack is payload-bearing + discriminated by `command`. The flat
// {channel_id?, message_id?, event_id?...} shape is gone — clients read the
// canonical result from `payload` (command-specific). Phase 4 acks (message.edit/
// recall/delete) extend this union.
export type CommandAckFrame =
  | {
      frame_type: "command_ack";
      command: "message.send" | "message.edit" | "message.recall" | "message.delete";
      command_id: string;
      status: "committed";
      payload: { channel_id: string; event_id: string; message: Record<string, unknown> };
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
  error: { code: string; message: string; retryable: boolean };
}

export interface ReadStateUpdatedFrame {
  frame_type: "read_state_updated";
  channel_id: string;
  last_read_event_id: string;
  unread_count: number;
}

export interface EventFrame {
  frame_type: "event";
  api_version: "lilium.chat.v1";
  event_id: string;
  type: string;
  channel_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export function parseFrame(text: string): Frame {
  const obj = JSON.parse(text) as Frame;
  if (!obj || typeof obj.frame_type !== "string") throw new Error("invalid frame");
  return obj;
}
