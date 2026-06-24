export type Frame = CommandFrame | CommandAckFrame | CommandErrorFrame | EventFrame | ReadStateUpdatedFrame;

export interface CommandFrame {
  frame_type: "command";
  command: string;
  command_id: string;
  channel_id?: string;
  payload: Record<string, unknown>;
}

export interface CommandAckFrame {
  frame_type: "command_ack";
  command_id: string;
  status: "committed";
  channel_id?: string;
  message_id?: string;
  invocation_id?: string;
  interaction_id?: string;
  event_id?: string;
}

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
