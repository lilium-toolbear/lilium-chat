import type { IncomingCommandFrame } from "../contract/commands";
import { isRecord } from "../contract/utils";

export interface ParsedInteractionSubmit {
  channel_id: string;
  command_id: string;
  message_id: string;
  component_id: string;
  custom_id: string;
  value: unknown;
}

export type ParseInteractionSubmitResult =
  | { ok: true; command: ParsedInteractionSubmit }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

function fail(message: string, code = "INVALID_MESSAGE"): ParseInteractionSubmitResult {
  return {
    ok: false,
    error: { code, message, retryable: false },
  };
}

export function parseInteractionSubmitCommand(frame: IncomingCommandFrame): ParseInteractionSubmitResult {
  if (frame.command !== "interaction.submit") {
    return fail(`unsupported command: ${frame.command}`);
  }
  if (typeof frame.command_id !== "string" || frame.command_id.length === 0) {
    return fail("command_id is required");
  }
  if (typeof frame.channel_id !== "string" || frame.channel_id.length === 0) {
    return {
      ok: false,
      error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false },
    };
  }
  if (!isRecord(frame.payload)) {
    return fail("invalid payload");
  }

  const messageId = typeof frame.payload.message_id === "string" ? frame.payload.message_id : "";
  const componentId = typeof frame.payload.component_id === "string" ? frame.payload.component_id : "";
  const customId = typeof frame.payload.custom_id === "string" ? frame.payload.custom_id : "";
  if (!messageId) return fail("message_id is required");
  if (!componentId) return fail("component_id is required");
  if (!customId) return fail("custom_id is required");
  if (!("value" in frame.payload)) return fail("value is required");

  return {
    ok: true,
    command: {
      channel_id: frame.channel_id,
      command_id: frame.command_id,
      message_id: messageId,
      component_id: componentId,
      custom_id: customId,
      value: frame.payload.value,
    },
  };
}
