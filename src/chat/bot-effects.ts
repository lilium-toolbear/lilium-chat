import type { BotEffectWire, EffectResult } from "../contract/bot-gateway";
import type { MessageRow } from "../contract/persisted";
import type { WireChatMessage } from "../contract/message";
import { isRecord } from "../contract/utils";

export type NonStreamBotEffectType = "send_message" | "update_message" | "disable_components";

export interface BotEffectMessageBody {
  type: string;
  format: string;
  text: string;
  reply_to_message_id: string | null;
  attachment_ids: string[];
  components: unknown[];
}

export interface ParsedSendMessageEffect {
  type: "send_message";
  client_effect_id: string;
  message: BotEffectMessageBody;
}

export interface ParsedUpdateMessageEffect {
  type: "update_message";
  client_effect_id: string;
  message_id: string;
  message: {
    text?: string;
    attachment_ids?: string[];
    components?: unknown[];
  };
}

export interface ParsedDisableComponentsEffect {
  type: "disable_components";
  client_effect_id: string;
  message_id: string;
  component_ids: string[];
}

export type ParsedNonStreamEffect =
  | ParsedSendMessageEffect
  | ParsedUpdateMessageEffect
  | ParsedDisableComponentsEffect;

export class BotEffectValidationError extends Error {
  readonly code = "BOT_EFFECT_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "BotEffectValidationError";
  }
}

export function computeEffectRequestHash(effect: BotEffectWire): string {
  return JSON.stringify(effect);
}

function parseMessageBody(raw: unknown): BotEffectMessageBody {
  if (!isRecord(raw)) {
    throw new BotEffectValidationError("send_message.message must be an object");
  }
  const type = raw.type;
  const format = raw.format;
  const text = raw.text;
  if (typeof type !== "string" || type.length === 0) {
    throw new BotEffectValidationError("send_message.message.type required");
  }
  if (type !== "text") {
    throw new BotEffectValidationError("only text messages are supported");
  }
  if (typeof format !== "string" || (format !== "plain" && format !== "markdown")) {
    throw new BotEffectValidationError("send_message.message.format must be plain or markdown");
  }
  if (typeof text !== "string") {
    throw new BotEffectValidationError("send_message.message.text required");
  }
  const replyTo = raw.reply_to_message_id;
  const replyToMessageId =
    replyTo === null || replyTo === undefined
      ? null
      : typeof replyTo === "string"
        ? replyTo
        : (() => {
            throw new BotEffectValidationError("send_message.message.reply_to_message_id invalid");
          })();
  const attachmentIds = Array.isArray(raw.attachment_ids)
    ? raw.attachment_ids.filter((id): id is string => typeof id === "string")
    : [];
  if (attachmentIds.length > 0) {
    throw new BotEffectValidationError("attachment_ids are not supported yet");
  }
  const components = Array.isArray(raw.components) ? raw.components : [];
  return {
    type,
    format,
    text,
    reply_to_message_id: replyToMessageId,
    attachment_ids: attachmentIds,
    components,
  };
}

function assertBotOwnsMessage(row: MessageRow, botId: string): void {
  if (row.sender_kind !== "bot" || row.sender_bot_id !== botId) {
    throw new BotEffectValidationError("bot may only mutate its own messages");
  }
}

export function parseNonStreamEffect(raw: BotEffectWire): ParsedNonStreamEffect {
  const type = raw.type;
  const clientEffectId = raw.client_effect_id;
  if (type === "send_message") {
    return {
      type,
      client_effect_id: clientEffectId,
      message: parseMessageBody(raw.message),
    };
  }
  if (type === "update_message") {
    const messageId = raw.message_id;
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new BotEffectValidationError("update_message.message_id required");
    }
    const messageRaw = raw.message;
    if (!isRecord(messageRaw)) {
      throw new BotEffectValidationError("update_message.message must be an object");
    }
    const message: ParsedUpdateMessageEffect["message"] = {};
    if (messageRaw.text !== undefined) {
      if (typeof messageRaw.text !== "string") {
        throw new BotEffectValidationError("update_message.message.text must be a string");
      }
      message.text = messageRaw.text;
    }
    if (messageRaw.components !== undefined) {
      if (!Array.isArray(messageRaw.components)) {
        throw new BotEffectValidationError("update_message.message.components must be an array");
      }
      message.components = messageRaw.components;
    }
    if (messageRaw.attachment_ids !== undefined) {
      if (!Array.isArray(messageRaw.attachment_ids)) {
        throw new BotEffectValidationError("update_message.message.attachment_ids must be an array");
      }
      const attachmentIds = messageRaw.attachment_ids.filter((id): id is string => typeof id === "string");
      if (attachmentIds.length > 0) {
        throw new BotEffectValidationError("attachment_ids are not supported yet");
      }
      message.attachment_ids = attachmentIds;
    }
    if (message.text === undefined && message.components === undefined) {
      throw new BotEffectValidationError("update_message requires text and/or components");
    }
    return { type, client_effect_id: clientEffectId, message_id: messageId, message };
  }
  if (type === "disable_components") {
    const messageId = raw.message_id;
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new BotEffectValidationError("disable_components.message_id required");
    }
    const componentIdsRaw = raw.component_ids;
    if (!Array.isArray(componentIdsRaw) || componentIdsRaw.length === 0) {
      throw new BotEffectValidationError("disable_components.component_ids required");
    }
    const componentIds = componentIdsRaw.filter((id): id is string => typeof id === "string");
    if (componentIds.length !== componentIdsRaw.length) {
      throw new BotEffectValidationError("disable_components.component_ids must be strings");
    }
    return { type, client_effect_id: clientEffectId, message_id: messageId, component_ids: componentIds };
  }
  if (type === "start_stream") {
    throw new BotEffectValidationError("start_stream is not supported on this path yet");
  }
  throw new BotEffectValidationError(`unsupported effect type: ${type}`);
}

export interface BotEffectMessageContextRow extends MessageRow {
  components_json?: string | null;
}

export function validateNonStreamEffectsForApply(
  effects: BotEffectWire[],
  ctx: {
    botId: string;
    loadMessage: (messageId: string) => BotEffectMessageContextRow | null;
  },
): ParsedNonStreamEffect[] {
  const seen = new Set<string>();
  const parsed: ParsedNonStreamEffect[] = [];
  for (const raw of effects) {
    if (seen.has(raw.client_effect_id)) {
      throw new BotEffectValidationError("duplicate client_effect_id in batch");
    }
    seen.add(raw.client_effect_id);
    const effect = parseNonStreamEffect(raw);
    if (effect.type === "update_message" || effect.type === "disable_components") {
      const row = ctx.loadMessage(effect.message_id);
      if (!row) {
        throw new BotEffectValidationError("message not found");
      }
      assertBotOwnsMessage(row, ctx.botId);
      if (row.status === "deleted" || row.status === "recalled") {
        throw new BotEffectValidationError("message is not mutable");
      }
      if (effect.type === "disable_components") {
        const components = parseStoredComponents(row.components_json ?? "[]") as Array<{
          component_id?: string;
          disabled?: boolean;
        }>;
        const known = new Set(components.map((c) => c.component_id).filter((id): id is string => typeof id === "string"));
        for (const componentId of effect.component_ids) {
          if (!known.has(componentId)) {
            throw new BotEffectValidationError(`component not found: ${componentId}`);
          }
        }
      }
    }
    parsed.push(effect);
  }
  return parsed;
}

export function parseStoredComponents(raw: string | null | undefined): WireChatMessage["components"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as WireChatMessage["components"]) : [];
  } catch {
    return [];
  }
}

export function disableComponentsInJson(
  componentsJson: string,
  componentIds: string[],
): string {
  const disable = new Set(componentIds);
  let components: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(componentsJson) as unknown;
    components = Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => isRecord(item))
      : [];
  } catch {
    components = [];
  }
  const next = components.map((component) => {
    const componentId = component.component_id;
    if (typeof componentId === "string" && disable.has(componentId)) {
      return { ...component, disabled: true };
    }
    return component;
  });
  return JSON.stringify(next);
}

export function toGenericEffectResult(input: {
  client_effect_id: string;
  type: Exclude<NonStreamBotEffectType, never>;
  message_id?: string;
  event_id?: string;
}): EffectResult {
  return {
    client_effect_id: input.client_effect_id,
    type: input.type,
    status: "applied",
    ...(input.message_id ? { message_id: input.message_id } : {}),
    ...(input.event_id ? { event_id: input.event_id } : {}),
  };
}
