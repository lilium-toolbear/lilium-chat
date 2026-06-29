import type {
  CommandManifestDelta,
  CommandManifestItem,
  CommandManifestResponse,
} from "../contract/bot-api";

type PermissionLevel = CommandManifestItem["effective_member_permission"];

export interface CommandBindingManifestRow {
  status: string;
  command_snapshot_json: string;
  permission_override: string | null;
}

interface CommandSnapshotPayload {
  bot_command_id: string;
  name: string;
  aliases: string[];
  description: string;
  bot: CommandManifestItem["bot"];
  options: unknown[];
  default_member_permission: PermissionLevel;
  execution: CommandManifestItem["execution"];
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
    const snapshot = parseSnapshot(row.command_snapshot_json);
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

function parseSnapshot(raw: string): CommandSnapshotPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isCommandSnapshotPayload(parsed)) return null;
  return parsed;
}

function isCommandSnapshotPayload(value: unknown): value is CommandSnapshotPayload {
  if (!value || typeof value !== "object") return false;
  const obj = value as Partial<CommandSnapshotPayload>;
  return (
    typeof obj.bot_command_id === "string" &&
    typeof obj.name === "string" &&
    Array.isArray(obj.aliases) &&
    typeof obj.description === "string" &&
    !!obj.bot &&
    typeof obj.bot.bot_id === "string" &&
    typeof obj.bot.display_name === "string" &&
    (typeof obj.bot.avatar_url === "string" || obj.bot.avatar_url === null) &&
    Array.isArray(obj.options) &&
    !!obj.execution &&
    typeof obj.execution.mode === "string" &&
    isPermissionLevel(obj.default_member_permission)
  );
}

function normalizePermission(value: string | null, fallback: PermissionLevel): PermissionLevel {
  if (isPermissionLevel(value)) return value;
  return fallback;
}

function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === "member" || value === "admin" || value === "owner";
}
