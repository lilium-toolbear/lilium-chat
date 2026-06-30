import { sha256Hex } from "./command-options";

export const STREAM_DEFAULT_TTL_SECONDS = 300;

export const STREAM_REGISTRY_STATUSES = [
  "streaming",
  "finalized",
  "abandoned",
  "expired",
] as const;

export type StreamRegistryStatus = (typeof STREAM_REGISTRY_STATUSES)[number];

export interface StreamRegistryMessageJson {
  type: string;
  format: string;
  reply_to?: string | null;
  components?: unknown[];
  attachment_ids?: string[];
}

export interface StartStreamEffectResponse {
  message_id: string;
  stream: {
    channel_id: string;
    message_id: string;
    ws_url: string;
    expires_at: string;
  };
}

export interface StreamFinalizeResponse {
  message_id: string;
  event_id: string;
}

export interface StreamAbandonResponse {
  message_id: string;
  event_id: string;
}

export function buildBotStreamWsUrl(channelId: string, messageId: string): string {
  return `/api/chat/bot/channels/${channelId}/streams/${messageId}/ws`;
}

export function streamExpiresAtIso(fromMs: number, ttlSeconds = STREAM_DEFAULT_TTL_SECONDS): string {
  return new Date(fromMs + ttlSeconds * 1000).toISOString();
}

export function isStreamRegistryExpired(expiresAt: string, nowMs: number = Date.now()): boolean {
  return Date.parse(expiresAt) <= nowMs;
}

export function sanitizeStreamMessageMetadata(input: {
  type?: unknown;
  format?: unknown;
  reply_to?: unknown;
  components?: unknown;
  attachment_ids?: unknown;
  text?: unknown;
}): StreamRegistryMessageJson {
  const type = typeof input.type === "string" && input.type.length > 0 ? input.type : "text";
  const format = typeof input.format === "string" && input.format.length > 0 ? input.format : "plain";
  const replyTo = typeof input.reply_to === "string" ? input.reply_to : null;
  const components = Array.isArray(input.components) ? input.components : [];
  const attachmentIds = Array.isArray(input.attachment_ids)
    ? input.attachment_ids.filter((id): id is string => typeof id === "string")
    : [];
  return {
    type,
    format,
    reply_to: replyTo,
    components,
    attachment_ids: attachmentIds,
  };
}

export function buildStartStreamEffectResponse(input: {
  channelId: string;
  messageId: string;
  expiresAt: string;
}): StartStreamEffectResponse {
  return {
    message_id: input.messageId,
    stream: {
      channel_id: input.channelId,
      message_id: input.messageId,
      ws_url: buildBotStreamWsUrl(input.channelId, input.messageId),
      expires_at: input.expiresAt,
    },
  };
}

export function parseStreamRegistryMessageJson(raw: string): StreamRegistryMessageJson {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return sanitizeStreamMessageMetadata(parsed);
  } catch {
    return sanitizeStreamMessageMetadata({});
  }
}

export async function computeTextHash(text: string): Promise<string> {
  return sha256Hex(text);
}

export async function computeFinalizeRequestHash(input: {
  final_seq: number;
  resolved_text: string;
  components?: unknown[];
  attachment_ids?: string[];
}): Promise<string> {
  const canonical = {
    final_seq: input.final_seq,
    resolved_text: input.resolved_text,
    components: input.components ?? [],
    attachment_ids: input.attachment_ids ?? [],
  };
  return sha256Hex(JSON.stringify(canonical));
}

export async function computeAbandonedTextHash(resolvedPartial: string): Promise<string> {
  return computeTextHash(resolvedPartial);
}

export function botDedupePrincipalKey(botId: string): string {
  return `bot:${botId}`;
}
