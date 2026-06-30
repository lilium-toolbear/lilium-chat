import type { CommandBindingSnapshot, CommandBindingSnapshotExecution } from "../contract/bot-api";
import type { CommandBindingManifestRow } from "./command-manifest";

export interface OfficialCommandCatalogItem {
  bot_command_id: string;
  name: string;
  aliases: string[];
  description: string;
  help_text: string;
  bot: CommandBindingSnapshot["bot"];
  options: unknown[];
  default_member_permission: "member" | "admin" | "owner";
  execution: CommandBindingSnapshotExecution;
}

export interface ChannelBindingRow {
  bot_command_id: string;
  bot_id: string;
  status: string;
  command_snapshot_json: string;
  permission_override: string | null;
}

export function officialCommandToSnapshot(item: OfficialCommandCatalogItem): CommandBindingSnapshot {
  return {
    bot_command_id: item.bot_command_id,
    name: item.name,
    aliases: item.aliases,
    description: item.description,
    help_text: item.help_text,
    bot: item.bot,
    options: item.options,
    default_member_permission: item.default_member_permission,
    execution: item.execution,
  };
}

export function mergeOfficialIntoBindingRows(
  bindingRows: readonly ChannelBindingRow[],
  officialCatalog: readonly OfficialCommandCatalogItem[],
): CommandBindingManifestRow[] {
  const officialBotIds = new Set(officialCatalog.map((item) => item.bot.bot_id));
  const blockedOfficialIds = new Set(
    bindingRows
      .filter((row) => row.status === "blocked" && officialBotIds.has(row.bot_id))
      .map((row) => row.bot_command_id),
  );
  const allowedOverrides = new Map(
    bindingRows
      .filter((row) => row.status === "allowed")
      .map((row) => [row.bot_command_id, row] as const),
  );

  const result: CommandBindingManifestRow[] = [];

  for (const row of bindingRows) {
    if (officialBotIds.has(row.bot_id)) continue;
    if (row.status !== "allowed") continue;
    result.push({
      status: row.status,
      command_snapshot_json: row.command_snapshot_json,
      permission_override: row.permission_override,
    });
  }

  for (const item of officialCatalog) {
    if (blockedOfficialIds.has(item.bot_command_id)) continue;
    const allowedRow = allowedOverrides.get(item.bot_command_id);
    result.push({
      status: "allowed",
      command_snapshot_json: JSON.stringify(officialCommandToSnapshot(item)),
      permission_override: allowedRow?.permission_override ?? null,
    });
  }

  return result;
}

export function isOfficialCommandId(
  botCommandId: string,
  officialCatalog: readonly OfficialCommandCatalogItem[],
): boolean {
  return officialCatalog.some((item) => item.bot_command_id === botCommandId);
}

export function isOfficialCommandBlocked(
  bindingRows: readonly ChannelBindingRow[],
  botCommandId: string,
): boolean {
  return bindingRows.some(
    (row) => row.bot_command_id === botCommandId && row.status === "blocked",
  );
}
