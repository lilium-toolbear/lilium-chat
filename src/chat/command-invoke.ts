import type { IncomingCommandFrame } from "../contract/commands";
import { isRecord } from "../contract/utils";
import type { ParsedChannelCommandFrame } from "./ws-command-frame";
import { parseChannelCommandFrame } from "./ws-command-frame";

export interface ParsedCommandInvoke {
  channel_id: string;
  command_id: string;
  bot_command_id: string;
  invoked_name: string;
  command_manifest_version: number;
  options: Record<string, { type: string; value: unknown }>;
  reply_to_message_id: string | null;
}

export type ParseCommandInvokeResult =
  | { ok: true; command: ParsedCommandInvoke }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

function fail(message: string): ParseCommandInvokeResult {
  return {
    ok: false,
    error: { code: "INVALID_MESSAGE", message, retryable: false },
  };
}

export function parseCommandInvokePayload(
  frame: IncomingCommandFrame,
  channel: ParsedChannelCommandFrame,
): ParseCommandInvokeResult {
  if (!isRecord(frame.payload)) {
    return fail("invalid payload");
  }

  const botCommandId = typeof frame.payload.bot_command_id === "string"
    ? frame.payload.bot_command_id
    : "";
  if (!botCommandId) {
    return fail("bot_command_id is required");
  }

  const invokedName = typeof frame.payload.invoked_name === "string"
    ? frame.payload.invoked_name
    : "";
  const manifestVersionRaw = frame.payload.command_manifest_version;
  const commandManifestVersion = typeof manifestVersionRaw === "number"
    && Number.isFinite(manifestVersionRaw)
    && manifestVersionRaw >= 0
    ? manifestVersionRaw
    : -1;
  if (commandManifestVersion < 0) {
    return fail("command_manifest_version is required");
  }

  if (!isRecord(frame.payload.options)) {
    return fail("options must be an object");
  }

  const replyToMessageIdRaw = frame.payload.reply_to_message_id;
  const reply_to_message_id =
    typeof replyToMessageIdRaw === "string" && replyToMessageIdRaw.length > 0
      ? replyToMessageIdRaw
      : null;

  const options: Record<string, { type: string; value: unknown }> = {};
  for (const [name, rawOption] of Object.entries(frame.payload.options)) {
    if (!isRecord(rawOption)) {
      return fail(`option ${name} must be an object`);
    }
    if (typeof rawOption.type !== "string" || rawOption.type.length === 0) {
      return fail(`option ${name}.type is required`);
    }
    options[name] = {
      type: rawOption.type,
      value: rawOption.value,
    };
  }

  return {
    ok: true,
    command: {
      channel_id: channel.channel_id,
      command_id: channel.command_id,
      bot_command_id: botCommandId,
      invoked_name: invokedName,
      command_manifest_version: commandManifestVersion,
      options,
      reply_to_message_id,
    },
  };
}

export function parseCommandInvokeCommand(frame: IncomingCommandFrame): ParseCommandInvokeResult {
  const scoped = parseChannelCommandFrame(frame, "command.invoke");
  if (!scoped.ok) return scoped;
  return parseCommandInvokePayload(frame, scoped.frame);
}
