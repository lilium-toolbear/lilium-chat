import type { CommandManifestBotSummary, CommandManifestItem } from "../contract/bot-api";
import { parseCommandBindingSnapshot } from "./command-snapshot";
import type { ChannelBindingRow, OfficialCommandCatalogItem } from "./official-command-manifest";

export const PLATFORM_BOT_ID = "00000000-0000-7000-8000-000000000600";
export const PLATFORM_HELP_BOT_COMMAND_ID = "00000000-0000-7000-8000-000000000700";
export const PLATFORM_PERMISSION_BOT_COMMAND_ID = "00000000-0000-7000-8000-000000000708";
export const PLATFORM_HELP_NAME = "help";
export const PLATFORM_PERMISSION_NAME = "permission";
export const PLATFORM_HELP_DESCRIPTION = "查看可用命令";
export const PLATFORM_PERMISSION_DESCRIPTION = "管理频道命令开关";

export const PLATFORM_BOT_DISPLAY_NAME = "system";
export const PLATFORM_BOT_AVATAR_URL =
  "https://s3.kuma.homes/chat/avatars/019f134b-4324-7300-9023-b092c06ac4b2.png";

/** Virtual href prefix for slash-command chips in bot markdown (`[text](/command:name)`). */
export const PLATFORM_COMMAND_CHIP_LINK_PREFIX = "/command:";

export function formatPlatformCommandChipMarkdown(commandName: string): string {
  return `[\`/${commandName}\`](${PLATFORM_COMMAND_CHIP_LINK_PREFIX}${commandName})`;
}

export function officialBotIdsFromCatalog(
  catalog: readonly { bot: { bot_id: string } }[],
): Set<string> {
  const ids = new Set<string>([PLATFORM_BOT_ID]);
  for (const item of catalog) ids.add(item.bot.bot_id);
  return ids;
}

export function isOfficialBotId(botId: string, officialBotIds?: ReadonlySet<string>): boolean {
  if (botId === PLATFORM_BOT_ID) return true;
  return officialBotIds?.has(botId) ?? false;
}

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

export function isPlatformPermissionCommand(botCommandId: string): boolean {
  return botCommandId === PLATFORM_PERMISSION_BOT_COMMAND_ID;
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

export function platformPermissionManifestItem(): CommandManifestItem {
  return {
    bot_command_id: PLATFORM_PERMISSION_BOT_COMMAND_ID,
    name: PLATFORM_PERMISSION_NAME,
    aliases: [],
    description: PLATFORM_PERMISSION_DESCRIPTION,
    help_text: "",
    bot: platformBotSummary(),
    options: [
      { name: "command", type: "string", required: false, description: "命令名" },
      { name: "action", type: "string", required: false, description: "on 或 off" },
    ],
    execution: { mode: "stateless" },
    effective_member_permission: "admin",
  };
}

export interface ManageableCommandInfo {
  bot_command_id: string;
  name: string;
  aliases: string[];
  enabled: boolean;
}

export function computeManageableCommands(
  bindingRows: readonly ChannelBindingRow[],
  officialCatalog: readonly OfficialCommandCatalogItem[],
): ManageableCommandInfo[] {
  const officialBotIds = new Set(officialCatalog.map((item) => item.bot.bot_id));
  const blockedOfficialIds = new Set(
    bindingRows
      .filter((row) => row.status === "blocked" && officialBotIds.has(row.bot_id))
      .map((row) => row.bot_command_id),
  );
  const result: ManageableCommandInfo[] = [];

  for (const item of officialCatalog) {
    result.push({
      bot_command_id: item.bot_command_id,
      name: item.name,
      aliases: item.aliases,
      enabled: !blockedOfficialIds.has(item.bot_command_id),
    });
  }

  for (const row of bindingRows) {
    if (officialBotIds.has(row.bot_id)) continue;
    const snapshot = parseCommandBindingSnapshot(row.command_snapshot_json);
    if (!snapshot) continue;
    result.push({
      bot_command_id: snapshot.bot_command_id,
      name: snapshot.name,
      aliases: snapshot.aliases,
      enabled: row.status === "allowed",
    });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export function resolveManageableCommandName(
  commands: readonly ManageableCommandInfo[],
  commandSpec: string,
): ManageableCommandInfo | null {
  const needle = commandSpec.trim().replace(/^\//, "").toLowerCase();
  if (!needle) return null;
  return (
    commands.find(
      (item) =>
        item.name.toLowerCase() === needle ||
        item.aliases.some((alias) => alias.toLowerCase() === needle),
    ) ?? null
  );
}

export function buildPlatformPermissionListText(commands: readonly ManageableCommandInfo[]): string {
  const enabled = commands.filter((command) => command.enabled);
  const disabled = commands.filter((command) => !command.enabled);
  const formatLines = (items: readonly ManageableCommandInfo[]) =>
    items.length > 0
      ? items.map((item) => `- ${formatPlatformCommandChipMarkdown(item.name)}`).join("\n")
      : "- 无";

  return [
    "## 当前频道命令权限",
    "",
    `**当前可用（${enabled.length}）**`,
    formatLines(enabled),
    "",
    `**当前已关闭（${disabled.length}）**`,
    formatLines(disabled),
  ].join("\n");
}

export function buildPlatformPermissionMutationText(commandName: string, enabled: boolean): string {
  const status = enabled ? "开启" : "关闭";
  return `当前频道已将 ${formatPlatformCommandChipMarkdown(commandName)} ${status}。`;
}

export function buildPlatformHelpText(
  items: readonly CommandManifestItem[],
  commandOption?: string,
): string {
  if (commandOption && commandOption.trim().length > 0) {
    const needle = commandOption.trim().toLowerCase();
    const match = items.find(
      (item) =>
        item.name.toLowerCase() === needle ||
        item.aliases.some((alias) => alias.toLowerCase() === needle),
    );
    if (!match) return `未知命令: ${commandOption}`;
    return match.help_text || match.description;
  }

  const groups = new Map<string, CommandManifestItem[]>();
  for (const item of items) {
    const key = item.bot.display_name;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const lines: string[] = [];
  for (const [botName, commands] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`**${botName}**`);
    for (const command of [...commands].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`${formatPlatformCommandChipMarkdown(command.name)} — ${command.description}`);
    }
    lines.push("");
  }
  const body = lines.join("\n").trim();
  return body.length > 0 ? body : "当前频道没有可用命令。";
}
