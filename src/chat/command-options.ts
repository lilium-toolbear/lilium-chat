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
  description: string | null;
  options: CommandOption[];
  default_member_permission: "member" | "admin" | "owner";
  default_enabled_on_install: boolean;
}

export interface CommandInput {
  name?: unknown;
  aliases?: unknown;
  description?: unknown;
  options?: unknown;
  default_member_permission?: unknown;
  default_enabled_on_install?: unknown;
}

export interface EventCapabilityInput {
  event_type?: unknown;
  default_enabled_on_install?: unknown;
  default_filters?: unknown;
}

export interface ValidatedEventCapability {
  event_type: "message.created";
  default_enabled_on_install: boolean;
  default_filters: {
    message_types: string[];
    include_bot_messages: boolean;
    include_own_messages: boolean;
    only_when_mentioned: boolean;
  };
}

const PERMISSIONS = new Set(["member", "admin", "owner"]);
const DEFAULT_FILTERS = {
  message_types: ["text"],
  include_bot_messages: false,
  include_own_messages: false,
  only_when_mentioned: false,
};

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
  if (!/^[a-z0-9_]{1,32}$/.test(input.name)) {
    return fail("command.name must be lowercase alnum/underscore, <=32 chars");
  }
  const aliases: string[] = [];
  if (input.aliases !== undefined && input.aliases !== null) {
    if (!Array.isArray(input.aliases)) return fail("command.aliases must be array");
    const seen = new Set<string>([input.name]);
    for (const a of input.aliases) {
      if (typeof a !== "string" || !/^[a-z0-9_]{1,32}$/.test(a)) {
        return fail("alias must be lowercase alnum/underscore, <=32 chars");
      }
      if (seen.has(a)) return fail(`duplicate alias: ${a}`);
      seen.add(a);
      aliases.push(a);
    }
  }
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string") return fail("command.description must be string");
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
  const defaultEnabled = input.default_enabled_on_install ?? true;
  if (typeof defaultEnabled !== "boolean") return fail("default_enabled_on_install must be boolean");
  return ok({
    name: input.name,
    aliases,
    description: typeof input.description === "string" ? input.description : null,
    options,
    default_member_permission: perm as "member" | "admin" | "owner",
    default_enabled_on_install: defaultEnabled,
  });
}

/** Validate an event_capabilities entry (Phase 7: only message.created). */
export function validateEventCapability(
  input: EventCapabilityInput,
): ValidateResult<ValidatedEventCapability> {
  if (input.event_type !== "message.created") {
    return fail("event_type must be message.created (Phase 7)");
  }
  const defaultEnabled = input.default_enabled_on_install ?? false;
  if (typeof defaultEnabled !== "boolean") {
    return fail("default_enabled_on_install must be boolean");
  }
  const filters = { ...DEFAULT_FILTERS };
  if (input.default_filters !== undefined && input.default_filters !== null) {
    if (!isRecord(input.default_filters)) {
      return fail("default_filters must be object");
    }
    const f = input.default_filters;
    if (f.message_types !== undefined) {
      if (!Array.isArray(f.message_types) || !f.message_types.every((s) => typeof s === "string")) {
        return fail("default_filters.message_types must be string[]");
      }
      filters.message_types = f.message_types as string[];
    }
    for (const key of ["include_bot_messages", "include_own_messages", "only_when_mentioned"] as const) {
      if (f[key] !== undefined) {
        if (typeof f[key] !== "boolean") return fail(`default_filters.${key} must be boolean`);
        filters[key] = f[key];
      }
    }
  }
  return ok({ event_type: "message.created", default_enabled_on_install: defaultEnabled, default_filters: filters });
}

/**
 * Canonical form for definition_hash: stable JSON over
 * {options, description, default_member_permission}. Aliases and
 * default_enabled_on_install are excluded — they are install-time concerns,
 * not part of the command definition's wire shape.
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
  event_capabilities: ValidatedEventCapability[];
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      commands: body.commands
        .map((c) => ({ ...c, options: c.options.map((o) => ({ ...o })) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      event_capabilities: body.event_capabilities
        .map((e) => ({ ...e }))
        .sort((a, b) => (a.event_type < b.event_type ? -1 : 1)),
    }),
  );
}