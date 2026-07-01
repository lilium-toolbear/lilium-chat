import type { BotEffectWire, EffectResult } from "../contract/bot-gateway";
import type { StartStreamEffectResponse } from "./stream-registry";
import type { MessageRow } from "../contract/persisted";
import type { WireChatMessage } from "../contract/message";
import { isAllowedBotMessageFormat } from "./bot-message-format";
import {
  ComponentValidationError,
  rejectNonEmptyStreamComponents,
  validateComponents,
  type WireComponent,
} from "./components";
import { isRecord } from "../contract/utils";
import { logSwallowedError } from "../errors";

export type NonStreamBotEffectType = "send_message" | "update_message" | "disable_components";
export type BotEffectType = NonStreamBotEffectType | "start_stream";

export interface BotEffectMessageBody {
  type: string;
  format: string;
  text: string;
  reply_to_message_id: string | null;
  attachment_ids: string[];
  components: WireComponent[];
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
    components?: WireComponent[];
  };
}

export interface ParsedDisableComponentsEffect {
  type: "disable_components";
  client_effect_id: string;
  message_id: string;
  component_ids: string[];
}

export interface ParsedStartStreamEffect {
  type: "start_stream";
  client_effect_id: string;
  message: BotEffectMessageBody;
}

export type ParsedNonStreamEffect =
  | ParsedSendMessageEffect
  | ParsedUpdateMessageEffect
  | ParsedDisableComponentsEffect;

export type ParsedBotEffect = ParsedNonStreamEffect | ParsedStartStreamEffect;

export class BotEffectValidationError extends Error {
  readonly code = "BOT_EFFECT_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "BotEffectValidationError";
  }
}

function wrapComponentValidation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ComponentValidationError) {
      throw new BotEffectValidationError(err.message);
    }
    throw err;
  }
}

export function computeEffectRequestHash(effect: BotEffectWire): string {
  return JSON.stringify(effect);
}

export function computeSessionEffectsRequestHash(effects: BotEffectWire[]): string {
  return JSON.stringify(
    effects.map((effect) => {
      const { client_effect_id: _clientEffectId, ...rest } = effect;
      return rest;
    }),
  );
}

function parseStartStreamMessageBody(raw: unknown): BotEffectMessageBody {
  if (!isRecord(raw)) {
    throw new BotEffectValidationError("start_stream.message must be an object");
  }
  const type = raw.type;
  const format = raw.format;
  if (typeof type !== "string" || type.length === 0) {
    throw new BotEffectValidationError("start_stream.message.type required");
  }
  if (type !== "text") {
    throw new BotEffectValidationError("only text messages are supported");
  }
  if (typeof format !== "string" || !isAllowedBotMessageFormat(format)) {
    throw new BotEffectValidationError(
      "start_stream.message.format must be plain, markdown, or unsafe-markdown",
    );
  }
  const replyTo = raw.reply_to_message_id;
  const replyToMessageId =
    replyTo === null || replyTo === undefined
      ? null
      : typeof replyTo === "string"
        ? replyTo
        : (() => {
            throw new BotEffectValidationError("start_stream.message.reply_to_message_id invalid");
          })();
  const attachmentIds = Array.isArray(raw.attachment_ids)
    ? raw.attachment_ids.filter((id): id is string => typeof id === "string")
    : [];
  if (attachmentIds.length > 0) {
    throw new BotEffectValidationError("attachment_ids not supported for start_stream");
  }
  const components = wrapComponentValidation(() => {
    const parsed = Array.isArray(raw.components) ? raw.components : [];
    rejectNonEmptyStreamComponents(parsed);
    return validateComponents(parsed);
  });
  return {
    type,
    format,
    text: "",
    reply_to_message_id: replyToMessageId,
    attachment_ids: attachmentIds,
    components,
  };
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
  if (type !== "text" && type !== "image") {
    throw new BotEffectValidationError("only text and image messages are supported");
  }
  if (typeof format !== "string" || !isAllowedBotMessageFormat(format)) {
    throw new BotEffectValidationError(
      "send_message.message.format must be plain, markdown, or unsafe-markdown",
    );
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
  if (type === "text" && attachmentIds.length > 0) {
    throw new BotEffectValidationError("attachment_ids not allowed for text messages");
  }
  if (type === "image" && attachmentIds.length === 0) {
    throw new BotEffectValidationError("image message requires attachment_ids");
  }
  const components = wrapComponentValidation(() =>
    validateComponents(Array.isArray(raw.components) ? raw.components : []),
  );
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

export function parseBotEffect(raw: BotEffectWire): ParsedBotEffect {
  const type = raw.type;
  const clientEffectId = raw.client_effect_id;
  if (type === "start_stream") {
    return {
      type,
      client_effect_id: clientEffectId,
      message: parseStartStreamMessageBody(raw.message),
    };
  }
  return parseNonStreamEffect(raw);
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
      message.attachment_ids = messageRaw.attachment_ids.filter((id): id is string => typeof id === "string");
    }
    if (
      message.text === undefined &&
      message.components === undefined &&
      message.attachment_ids === undefined
    ) {
      throw new BotEffectValidationError("update_message requires text, components, and/or attachment_ids");
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
  throw new BotEffectValidationError(`unsupported effect type: ${type}`);
}

export interface BotEffectMessageContextRow extends MessageRow {
  components_json?: string | null;
}

export function validateEffectsForApply(
  effects: BotEffectWire[],
  ctx: {
    botId: string;
    loadMessage: (messageId: string) => BotEffectMessageContextRow | null;
  },
): ParsedBotEffect[] {
  const seen = new Set<string>();
  const parsed: ParsedBotEffect[] = [];
  for (const raw of effects) {
    if (seen.has(raw.client_effect_id)) {
      throw new BotEffectValidationError("duplicate client_effect_id in batch");
    }
    seen.add(raw.client_effect_id);
    const effect = parseBotEffect(raw);
    if (effect.type === "start_stream") {
      wrapComponentValidation(() => rejectNonEmptyStreamComponents(effect.message.components));
      parsed.push(effect);
      continue;
    }
    if (effect.type === "send_message") {
      // components validated in parseMessageBody
    } else if (effect.type === "update_message" && effect.message.components !== undefined) {
      effect.message.components = wrapComponentValidation(() => validateComponents(effect.message.components));
    }
    if (effect.type === "update_message" || effect.type === "disable_components") {
      const row = ctx.loadMessage(effect.message_id);
      if (!row) {
        throw new BotEffectValidationError("message not found");
      }
      assertBotOwnsMessage(row, ctx.botId);
      if (row.status === "deleted" || row.status === "recalled") {
        throw new BotEffectValidationError("message is not mutable");
      }
      if (row.stream_state !== "none") {
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

/** @deprecated Use validateEffectsForApply */
export const validateNonStreamEffectsForApply = validateEffectsForApply;

export function parseStoredComponents(raw: string | null | undefined): WireChatMessage["components"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as WireChatMessage["components"]) : [];
  } catch (err) {
    logSwallowedError("stored_components_json_invalid", err);
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
  } catch (err) {
    logSwallowedError("disable_components_json_invalid", err);
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

export function toStartStreamEffectResult(input: {
  client_effect_id: string;
  response: StartStreamEffectResponse;
}): EffectResult {
  return {
    client_effect_id: input.client_effect_id,
    type: "start_stream",
    status: "applied",
    message_id: input.response.message_id,
    stream: input.response.stream,
  };
}
