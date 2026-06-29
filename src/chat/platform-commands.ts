import type { CommandManifestBotSummary, CommandManifestItem } from "../contract/bot-api";

export const PLATFORM_BOT_ID = "00000000-0000-7000-8000-000000000600";
export const PLATFORM_HELP_BOT_COMMAND_ID = "00000000-0000-7000-8000-000000000700";
export const PLATFORM_HELP_NAME = "help";
export const PLATFORM_HELP_DESCRIPTION = "查看可用斜杠命令";

export const PLATFORM_BOT_DISPLAY_NAME = "system";
export const PLATFORM_BOT_AVATAR_URL =
  "https://s3.kuma.homes/chat/avatars/019f134b-4324-7300-9023-b092c06ac4b2.png";

export function platformBotSummary(): CommandManifestBotSummary {
  return {
    bot_id: PLATFORM_BOT_ID,
    display_name: PLATFORM_BOT_DISPLAY_NAME,
    avatar_url: PLATFORM_BOT_AVATAR_URL,
  };
}

export function isPlatformHelpCommand(botCommandId: string): boolean {
  return botCommandId === PLATFORM_HELP_BOT_COMMAND_ID;
}

export function platformHelpManifestItem(): CommandManifestItem {
  return {
    bot_command_id: PLATFORM_HELP_BOT_COMMAND_ID,
    name: PLATFORM_HELP_NAME,
    aliases: [],
    description: PLATFORM_HELP_DESCRIPTION,
    help_text: "",
    bot: platformBotSummary(),
    options: [{ name: "command", type: "string", required: false, description: "命令名" }],
    execution: { mode: "stateless" },
    effective_member_permission: "member",
  };
}

export function buildPlatformHelpText(
  items: readonly CommandManifestItem[],
  commandOption?: string,
): string {
  const visible = items.filter((item) => item.bot_command_id !== PLATFORM_HELP_BOT_COMMAND_ID);
  if (commandOption && commandOption.trim().length > 0) {
    const needle = commandOption.trim().toLowerCase();
    const match = visible.find(
      (item) =>
        item.name.toLowerCase() === needle ||
        item.aliases.some((alias) => alias.toLowerCase() === needle),
    );
    if (!match) return `未知命令: ${commandOption}`;
    return match.help_text || match.description;
  }

  const groups = new Map<string, CommandManifestItem[]>();
  for (const item of visible) {
    const key = item.bot.display_name;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const lines: string[] = [];
  for (const [botName, commands] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`**${botName}**`);
    for (const command of [...commands].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`/${command.name} — ${command.description}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
