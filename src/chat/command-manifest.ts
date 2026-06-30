import type {
  CommandManifestDelta,
  CommandManifestItem,
  CommandManifestResponse,
} from "../contract/bot-api";
import { parseCommandBindingSnapshot } from "./command-snapshot";
import { platformHelpManifestItem, platformPermissionManifestItem } from "./platform-commands";

type PermissionLevel = CommandManifestItem["effective_member_permission"];

export interface CommandBindingManifestRow {
  status: string;
  command_snapshot_json: string;
  permission_override: string | null;
}

export interface ManifestDeltaApplyResult {
  manifest: CommandManifestResponse;
  applied: boolean;
  requiresRefresh: boolean;
}

export function projectCommandManifest(
  version: number,
  bindingRows: readonly CommandBindingManifestRow[],
): CommandManifestResponse {
  const items: CommandManifestItem[] = [];
  for (const row of bindingRows) {
    if (row.status !== "allowed") continue;
    const snapshot = parseCommandBindingSnapshot(row.command_snapshot_json);
    if (!snapshot) continue;
    const effectivePermission = normalizePermission(
      row.permission_override ?? snapshot.default_member_permission,
      snapshot.default_member_permission,
    );
    items.push({
      bot_command_id: snapshot.bot_command_id,
      name: snapshot.name,
      aliases: snapshot.aliases,
      description: snapshot.description,
      help_text: snapshot.help_text ?? "",
      bot: snapshot.bot,
      options: snapshot.options,
      execution: snapshot.execution,
      effective_member_permission: effectivePermission,
    });
  }

  items.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.bot_command_id.localeCompare(b.bot_command_id);
  });

  return { version, items };
}

export function appendPlatformHelpItem(manifest: CommandManifestResponse): CommandManifestResponse {
  if (manifest.items.some((item) => item.bot_command_id === platformHelpManifestItem().bot_command_id)) {
    return manifest;
  }
  const items = [...manifest.items, platformHelpManifestItem()];
  items.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.bot_command_id.localeCompare(b.bot_command_id);
  });
  return { version: manifest.version, items };
}

export function appendPlatformPermissionItem(manifest: CommandManifestResponse): CommandManifestResponse {
  const permissionItem = platformPermissionManifestItem();
  if (manifest.items.some((item) => item.bot_command_id === permissionItem.bot_command_id)) {
    return manifest;
  }
  const items = [...manifest.items, permissionItem];
  items.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.bot_command_id.localeCompare(b.bot_command_id);
  });
  return { version: manifest.version, items };
}

export function appendPlatformCommandItems(
  manifest: CommandManifestResponse,
  callerRole?: string | null,
): CommandManifestResponse {
  const withHelp = appendPlatformHelpItem(manifest);
  if (callerRole === "owner" || callerRole === "admin") {
    return appendPlatformPermissionItem(withHelp);
  }
  return withHelp;
}

export function buildManifestUpsertDelta(
  manifestVersion: number,
  item: CommandManifestItem,
): CommandManifestDelta {
  return { op: "upsert", manifest_version: manifestVersion, item };
}

export function buildManifestRemoveDelta(manifestVersion: number): CommandManifestDelta {
  return { op: "remove", manifest_version: manifestVersion };
}

export function applyCommandManifestDelta(
  current: CommandManifestResponse,
  delta: CommandManifestDelta,
  removeBotCommandId?: string,
): ManifestDeltaApplyResult {
  if (delta.manifest_version <= current.version) {
    return { manifest: current, applied: false, requiresRefresh: false };
  }
  if (delta.manifest_version > current.version + 1) {
    return { manifest: current, applied: false, requiresRefresh: true };
  }

  if (delta.op === "upsert") {
    if (!delta.item) {
      return { manifest: current, applied: false, requiresRefresh: true };
    }
    const kept = current.items.filter((item) => item.bot_command_id !== delta.item?.bot_command_id);
    kept.push(delta.item);
    kept.sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.bot_command_id.localeCompare(b.bot_command_id);
    });
    return {
      applied: true,
      requiresRefresh: false,
      manifest: { version: delta.manifest_version, items: kept },
    };
  }

  if (!removeBotCommandId) {
    return { manifest: current, applied: false, requiresRefresh: true };
  }

  return {
    applied: true,
    requiresRefresh: false,
    manifest: {
      version: delta.manifest_version,
      items: current.items.filter((item) => item.bot_command_id !== removeBotCommandId),
    },
  };
}

function normalizePermission(value: string | null, fallback: PermissionLevel): PermissionLevel {
  if (isPermissionLevel(value)) return value;
  return fallback;
}

function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === "member" || value === "admin" || value === "owner";
}
