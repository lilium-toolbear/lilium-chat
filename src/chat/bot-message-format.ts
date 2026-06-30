import type { BotEffectWire } from "../contract/bot-gateway";
import type { MessageFormat } from "../contract/message";
import { isRecord } from "../contract/utils";

export const UNSAFE_MARKDOWN_FORMAT = "unsafe-markdown" as const;

const BOT_MESSAGE_FORMATS = new Set<string>(["plain", "markdown", UNSAFE_MARKDOWN_FORMAT]);

export function isAllowedBotMessageFormat(format: string): format is MessageFormat {
  return BOT_MESSAGE_FORMATS.has(format);
}

export function effectUsesUnsafeMarkdown(effect: BotEffectWire): boolean {
  if (effect.type !== "send_message" && effect.type !== "start_stream") {
    return false;
  }
  const message = effect.message;
  if (!isRecord(message)) return false;
  return message.format === UNSAFE_MARKDOWN_FORMAT;
}
