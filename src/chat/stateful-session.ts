import type { CommandStatefulConfig } from "../contract/bot-api";
import { isRecord } from "../contract/utils";

export interface ListenRules {
  message_types: string[];
  include_bot_messages: boolean;
  include_own_messages: boolean;
}

export interface StatefulMessageMatchInput {
  message_id: string;
  sender_kind: string;
  sender_user_id: string | null;
  sender_bot_id: string | null;
  type: string;
  started_by_user_id: string;
}

export function listenRulesFromStatefulConfig(config: CommandStatefulConfig): ListenRules {
  return {
    message_types: [...config.listen_capability.message_types],
    include_bot_messages: config.listen_capability.include_bot_messages,
    include_own_messages: config.listen_capability.include_own_messages,
  };
}

export function parseStatefulConfigFromSnapshot(execution: Record<string, unknown>): CommandStatefulConfig | null {
  if (execution.mode !== "stateful" || !isRecord(execution.stateful)) return null;
  const s = execution.stateful;
  if (s.mutex_scope !== "channel") return null;
  if (typeof s.default_ttl_seconds !== "number" || typeof s.max_ttl_seconds !== "number") return null;
  if (!isRecord(s.listen_capability)) return null;
  const lc = s.listen_capability;
  if (
    !Array.isArray(lc.message_types) ||
    !lc.message_types.every((v) => typeof v === "string") ||
    typeof lc.include_bot_messages !== "boolean" ||
    typeof lc.include_own_messages !== "boolean"
  ) {
    return null;
  }
  return {
    mutex_scope: "channel",
    default_ttl_seconds: s.default_ttl_seconds,
    max_ttl_seconds: s.max_ttl_seconds,
    listen_capability: {
      message_types: [...lc.message_types],
      include_bot_messages: lc.include_bot_messages,
      include_own_messages: lc.include_own_messages,
    },
  };
}

export function resolveSessionTtlSeconds(
  config: CommandStatefulConfig,
  bindingMaxTtl: number | null,
): number {
  const cap = bindingMaxTtl ?? config.max_ttl_seconds;
  return Math.min(config.default_ttl_seconds, cap, config.max_ttl_seconds);
}

export function matchesListenRules(
  message: StatefulMessageMatchInput,
  rules: ListenRules,
  session: { started_by_user_id: string },
): boolean {
  if (!rules.message_types.includes(message.type)) return false;
  if (message.sender_kind === "bot" && !rules.include_bot_messages) return false;
  if (
    message.sender_kind === "user" &&
    message.sender_user_id === session.started_by_user_id &&
    !rules.include_own_messages
  ) {
    return false;
  }
  return true;
}

export const ACTIVE_STATEFUL_SESSION_STATUSES = ["starting", "active", "suspended", "closing"] as const;
export const RESUMABLE_REF_STATUSES = [...ACTIVE_STATEFUL_SESSION_STATUSES] as const;

export const DEFAULT_MAX_PENDING_INPUTS = 1000;
export const SESSION_START_TIMEOUT_MS = 30_000;
