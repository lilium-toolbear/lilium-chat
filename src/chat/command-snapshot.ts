import type { CommandBindingSnapshot, CommandBindingSnapshotExecution } from "../contract/bot-api";
import { isRecord } from "../contract/utils";
import type { CommandOption } from "./command-options";
import { logSwallowedError } from "../errors";
import { parseStatefulConfigFromSnapshot } from "./stateful-session";

export type { CommandBindingSnapshot, CommandBindingSnapshotExecution };

export interface ParsedCommandBindingSnapshot extends Omit<CommandBindingSnapshot, "options" | "execution"> {
  options: CommandOption[];
  execution: CommandBindingSnapshotExecution;
}

export function isCommandBindingSnapshot(value: unknown): value is CommandBindingSnapshot {
  if (!value || typeof value !== "object") return false;
  const obj = value as Partial<CommandBindingSnapshot>;
  return (
    typeof obj.bot_command_id === "string" &&
    typeof obj.name === "string" &&
    Array.isArray(obj.aliases) &&
    typeof obj.description === "string" &&
    (typeof obj.help_text === "string" || obj.help_text === undefined) &&
    !!obj.bot &&
    typeof obj.bot.bot_id === "string" &&
    typeof obj.bot.display_name === "string" &&
    (typeof obj.bot.avatar_url === "string" || obj.bot.avatar_url === null) &&
    Array.isArray(obj.options) &&
    !!obj.execution &&
    (obj.execution.mode === "stateless" || obj.execution.mode === "stateful") &&
    (obj.default_member_permission === "member" ||
      obj.default_member_permission === "admin" ||
      obj.default_member_permission === "owner")
  );
}

export function parseCommandBindingSnapshot(raw: string): ParsedCommandBindingSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logSwallowedError("command_binding_snapshot_json_invalid", err);
    return null;
  }
  if (!isRecord(parsed)) return null;

  const options = Array.isArray(parsed.options) ? parsed.options : [];
  const normalizedOptions: CommandOption[] = [];
  for (const option of options) {
    if (!isRecord(option) || typeof option.name !== "string" || typeof option.type !== "string") {
      return null;
    }
    const normalized: CommandOption = { name: option.name, type: option.type as CommandOption["type"] };
    if (typeof option.required === "boolean") normalized.required = option.required;
    if (typeof option.description === "string") normalized.description = option.description;
    if (typeof option.min === "number") normalized.min = option.min;
    if (typeof option.max === "number") normalized.max = option.max;
    normalizedOptions.push(normalized);
  }

  if (
    typeof parsed.bot_command_id !== "string" ||
    typeof parsed.name !== "string" ||
    !Array.isArray(parsed.aliases) ||
    typeof parsed.description !== "string" ||
    (parsed.help_text !== undefined && typeof parsed.help_text !== "string") ||
    !isRecord(parsed.bot) ||
    typeof parsed.bot.bot_id !== "string" ||
    typeof parsed.bot.display_name !== "string" ||
    (parsed.bot.avatar_url !== null && typeof parsed.bot.avatar_url !== "string") ||
    (parsed.default_member_permission !== "member" &&
      parsed.default_member_permission !== "admin" &&
      parsed.default_member_permission !== "owner") ||
    !isRecord(parsed.execution) ||
    (parsed.execution.mode !== "stateless" && parsed.execution.mode !== "stateful")
  ) {
    return null;
  }

  const statefulConfig = parsed.execution.mode === "stateful"
    ? parseStatefulConfigFromSnapshot(parsed.execution)
    : null;
  if (parsed.execution.mode === "stateful" && !statefulConfig) {
    return null;
  }

  const execution: CommandBindingSnapshotExecution = {
    mode: parsed.execution.mode,
    ...(statefulConfig ? { stateful: statefulConfig } : {}),
    ...(typeof parsed.execution.schema_version === "number"
      ? { schema_version: parsed.execution.schema_version }
      : {}),
    ...(typeof parsed.execution.definition_hash === "string"
      ? { definition_hash: parsed.execution.definition_hash }
      : {}),
  };

  return {
    bot_command_id: parsed.bot_command_id,
    name: parsed.name,
    aliases: parsed.aliases.filter((alias): alias is string => typeof alias === "string"),
    description: parsed.description,
    help_text: typeof parsed.help_text === "string" ? parsed.help_text : "",
    bot: {
      bot_id: parsed.bot.bot_id,
      display_name: parsed.bot.display_name,
      avatar_url: parsed.bot.avatar_url ?? null,
    },
    options: normalizedOptions,
    default_member_permission: parsed.default_member_permission,
    execution,
  };
}
