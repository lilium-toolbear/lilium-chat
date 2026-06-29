// contract §9.3 slash command option schema validation (pure).

export type CommandOptionType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "user"
  | "channel"
  | "role";

import { isRecord } from "../contract/utils";
import type { CommandStatefulConfig } from "../contract/bot-api";

const OPTION_TYPES: ReadonlySet<string> = new Set<CommandOptionType>([
  "string",
  "integer",
  "number",
  "boolean",
  "user",
  "channel",
  "role",
]);

export interface CommandOption {
  name: string;
  type: CommandOptionType;
  required?: boolean;
  description?: string;
  min?: number;
  max?: number;
}

export interface ValidatedCommand {
  name: string;
  aliases: string[];
  description: string;
  options: CommandOption[];
  default_member_permission: "member" | "admin" | "owner";
  execution_mode: "stateless" | "stateful";
  stateful_config: CommandStatefulConfig | null;
}

export interface CommandInput {
  name?: unknown;
  aliases?: unknown;
  description?: unknown;
  options?: unknown;
  default_member_permission?: unknown;
  execution?: unknown;
}

const PERMISSIONS = new Set(["member", "admin", "owner"]);

export interface ValidateResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** Validate a single command option per §9.3. */
function validateOption(raw: unknown): ValidateResult<CommandOption> {
  if (!isRecord(raw)) return fail("option must be an object");
  const o = raw;
  if (typeof o.name !== "string" || o.name.length === 0) return fail("option.name required");
  if (typeof o.type !== "string" || !OPTION_TYPES.has(o.type)) {
    return fail(`option.type invalid: ${String(o.type)}`);
  }
  const type = o.type as CommandOptionType;
  const option: CommandOption = { name: o.name, type };
  if (o.required !== undefined) {
    if (typeof o.required !== "boolean") return fail("option.required must be boolean");
    option.required = o.required;
  }
  if (o.description !== undefined && o.description !== null) {
    if (typeof o.description !== "string") return fail("option.description must be string");
    option.description = o.description;
  }
  if (type === "integer" || type === "number") {
    if (o.min !== undefined && o.min !== null) {
      if (typeof o.min !== "number") return fail("option.min must be number");
      option.min = o.min;
    }
    if (o.max !== undefined && o.max !== null) {
      if (typeof o.max !== "number") return fail("option.max must be number");
      option.max = o.max;
    }
    if (option.min !== undefined && option.max !== undefined && option.min > option.max) {
      return fail("option.min > option.max");
    }
  } else if (o.min !== undefined || o.max !== undefined) {
    return fail(`option.min/max only valid for integer|number, not ${type}`);
  }
  return ok(option);
}

/** Validate a catalog command input (§9.3). Aliases default to []. */
export function validateCommand(input: CommandInput): ValidateResult<ValidatedCommand> {
  if (typeof input.name !== "string" || input.name.length === 0) {
    return fail("command.name required");
  }
  const aliases: string[] = [];
  if (input.aliases !== undefined && input.aliases !== null) {
    if (!Array.isArray(input.aliases)) return fail("command.aliases must be array");
    const seen = new Set<string>([input.name.toLowerCase()]);
    for (const a of input.aliases) {
      if (typeof a !== "string" || a.length === 0) {
        return fail("alias must be non-empty string");
      }
      const key = a.toLowerCase();
      if (seen.has(key)) return fail(`duplicate alias: ${a}`);
      seen.add(key);
      aliases.push(a);
    }
  }
  if (typeof input.description !== "string") {
    return fail("command.description must be string");
  }
  const options: CommandOption[] = [];
  if (input.options !== undefined && input.options !== null) {
    if (!Array.isArray(input.options)) return fail("command.options must be array");
    const optNames = new Set<string>();
    for (const o of input.options) {
      const r = validateOption(o);
      if (!r.ok || !r.value) return fail(r.error ?? "invalid option");
      if (optNames.has(r.value.name)) return fail(`duplicate option: ${r.value.name}`);
      optNames.add(r.value.name);
      options.push(r.value);
    }
  }
  const perm = input.default_member_permission ?? "member";
  if (typeof perm !== "string" || !PERMISSIONS.has(perm)) {
    return fail("default_member_permission must be member|admin|owner");
  }

  if (!isRecord(input.execution)) {
    return fail("command.execution must be object");
  }
  if (input.execution.mode !== "stateless" && input.execution.mode !== "stateful") {
    return fail("command.execution.mode must be stateless|stateful");
  }

  let statefulConfig: CommandStatefulConfig | null = null;
  if (input.execution.mode === "stateful") {
    if (!isRecord(input.execution.stateful)) {
      return fail("command.execution.stateful required when mode=stateful");
    }
    const statefulRaw = input.execution.stateful;
    if (statefulRaw.mutex_scope !== "channel") {
      return fail("execution.stateful.mutex_scope must be channel");
    }
    if (
      typeof statefulRaw.default_ttl_seconds !== "number" ||
      !Number.isFinite(statefulRaw.default_ttl_seconds) ||
      statefulRaw.default_ttl_seconds <= 0
    ) {
      return fail("execution.stateful.default_ttl_seconds must be positive number");
    }
    if (
      typeof statefulRaw.max_ttl_seconds !== "number" ||
      !Number.isFinite(statefulRaw.max_ttl_seconds) ||
      statefulRaw.max_ttl_seconds <= 0
    ) {
      return fail("execution.stateful.max_ttl_seconds must be positive number");
    }
    if (statefulRaw.default_ttl_seconds > statefulRaw.max_ttl_seconds) {
      return fail("execution.stateful.default_ttl_seconds must be <= max_ttl_seconds");
    }
    if (!isRecord(statefulRaw.listen_capability)) {
      return fail("execution.stateful.listen_capability must be object");
    }
    if (
      !Array.isArray(statefulRaw.listen_capability.message_types) ||
      !statefulRaw.listen_capability.message_types.every((v) => typeof v === "string")
    ) {
      return fail("execution.stateful.listen_capability.message_types must be string[]");
    }
    if (typeof statefulRaw.listen_capability.include_bot_messages !== "boolean") {
      return fail("execution.stateful.listen_capability.include_bot_messages must be boolean");
    }
    if (typeof statefulRaw.listen_capability.include_own_messages !== "boolean") {
      return fail("execution.stateful.listen_capability.include_own_messages must be boolean");
    }
    statefulConfig = {
      mutex_scope: "channel",
      default_ttl_seconds: statefulRaw.default_ttl_seconds,
      max_ttl_seconds: statefulRaw.max_ttl_seconds,
      listen_capability: {
        message_types: [...statefulRaw.listen_capability.message_types],
        include_bot_messages: statefulRaw.listen_capability.include_bot_messages,
        include_own_messages: statefulRaw.listen_capability.include_own_messages,
      },
    };
  }
  return ok({
    name: input.name,
    aliases,
    description: input.description,
    options,
    default_member_permission: perm as "member" | "admin" | "owner",
    execution_mode: input.execution.mode,
    stateful_config: statefulConfig,
  });
}

/**
 * Canonical form for definition_hash: stable JSON over
 * {options, description, default_member_permission, execution}. Aliases are
 * excluded because they are slash-token binding concerns.
 */
export function canonicalCommandDefinition(cmd: ValidatedCommand): string {
  const optionsCanonical = cmd.options
    .map((o) => ({
      name: o.name,
      type: o.type,
      required: o.required ?? false,
      description: o.description ?? null,
      min: o.min ?? null,
      max: o.max ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify({
    options: optionsCanonical,
    description: cmd.description,
    default_member_permission: cmd.default_member_permission,
    execution_mode: cmd.execution_mode,
    stateful_config: cmd.stateful_config,
  });
}

/** SHA-256 hex digest. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Canonical request hash for PUT /bot/commands idempotency. */
export async function commandsRequestHash(body: {
  commands: ValidatedCommand[];
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      commands: body.commands
        .map((c) => ({ ...c, options: c.options.map((o) => ({ ...o })) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    }),
  );
}