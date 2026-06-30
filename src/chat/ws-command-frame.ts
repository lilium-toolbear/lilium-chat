import type { IncomingCommandFrame } from "../contract/commands";

export interface ParsedChannelCommandFrame {
  command_id: string;
  channel_id: string;
}

export type FrameParseError = { code: string; message: string; retryable: boolean };

export type ChannelCommandFrameResult =
  | { ok: true; frame: ParsedChannelCommandFrame }
  | { ok: false; error: FrameParseError };

export function parseChannelCommandFrame(
  frame: IncomingCommandFrame,
  expectedCommand: string,
): ChannelCommandFrameResult {
  if (frame.command !== expectedCommand) {
    return {
      ok: false,
      error: {
        code: "INVALID_COMMAND",
        message: `unsupported command: ${frame.command}`,
        retryable: false,
      },
    };
  }
  const command_id = typeof frame.command_id === "string" ? frame.command_id.trim() : "";
  if (!command_id) {
    return {
      ok: false,
      error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false },
    };
  }
  const channel_id = typeof frame.channel_id === "string" ? frame.channel_id.trim() : "";
  if (!channel_id) {
    return {
      ok: false,
      error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false },
    };
  }
  return { ok: true, frame: { command_id, channel_id } };
}
