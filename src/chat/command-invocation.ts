import { isRecord } from "../contract/utils";
import type { CommandInvocationProjection } from "../contract/message";
import { logSwallowedError } from "../errors";

export interface StoredCommandInvocation {
  bot_command_id: string;
  invoked_name: string;
  options: Record<string, { type: string; value: unknown }>;
}

function formatOptionValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().length > 0 ? value : "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Discord-like display: `/name` plus non-empty option values in stable key order. */
export function buildInvocationDisplayText(
  invokedName: string,
  options: Record<string, { type: string; value: unknown }>,
): string {
  const base = `/${invokedName}`;
  const parts: string[] = [];
  for (const key of Object.keys(options).sort()) {
    const formatted = formatOptionValue(options[key]?.value);
    if (formatted.length > 0) parts.push(formatted);
  }
  return parts.length > 0 ? `${base} ${parts.join(" ")}` : base;
}

export function serializeInvocationJson(invocation: StoredCommandInvocation): string {
  return JSON.stringify(invocation);
}

export function parseInvocationJson(raw: string | null | undefined): CommandInvocationProjection | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    if (typeof parsed.bot_command_id !== "string" || typeof parsed.invoked_name !== "string") return null;
    if (!isRecord(parsed.options)) return null;
    const options: Record<string, { type: string; value: unknown }> = {};
    for (const [key, value] of Object.entries(parsed.options)) {
      if (!isRecord(value) || typeof value.type !== "string") continue;
      options[key] = { type: value.type, value: value.value };
    }
    return {
      bot_command_id: parsed.bot_command_id,
      invoked_name: parsed.invoked_name,
      options,
    };
  } catch (err) {
    logSwallowedError("command_invocation_json_invalid", err);
    return null;
  }
}
