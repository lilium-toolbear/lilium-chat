import type { ArchiveSourceKind } from "./payload";

export function sourceKeyForChatChannel(channelId: string): string {
  return channelId;
}

export function sourceKeyForUserDirectory(userId: string): string {
  return userId;
}

export function sourceKeyForDmDirectory(pairKey: string): string {
  return pairKey;
}

export function sourceKeyForBotRegistry(): string {
  return "registry";
}

export function sourceKindForDo(doClass: string): ArchiveSourceKind | null {
  switch (doClass) {
    case "ChatChannel":
      return "chat_channel";
    case "UserDirectory":
      return "user_directory";
    case "DMDirectory":
      return "dm_directory";
    case "BotRegistry":
      return "bot_registry";
    default:
      return null;
  }
}
