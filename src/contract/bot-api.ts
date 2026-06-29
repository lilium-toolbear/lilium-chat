export interface BotCommandCatalogEntry {
  bot_command_id: string;
  name: string;
  aliases: string[];
  status: string;
  execution_mode: CommandExecutionMode;
  stateful_config: CommandStatefulConfig | null;
  definition_hash: string;
  schema_version: number;
  updated_at: string;
}

export interface BotCommandsSyncResponse {
  commands: BotCommandCatalogEntry[];
}

export interface CommandBindingUpdateResponse {
  bot_command_id: string;
  status: string;
  permission_override: string | null;
}

export type CommandExecutionMode = "stateless" | "stateful";

export interface CommandStatefulConfig {
  mutex_scope: "channel";
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  listen_capability: {
    message_types: string[];
    include_bot_messages: boolean;
    include_own_messages: boolean;
  };
}

export interface CommandExecutionSpec {
  mode: CommandExecutionMode;
  stateful?: CommandStatefulConfig;
}

/** Persisted on `channel_command_bindings.command_snapshot_json`. */
export interface CommandBindingSnapshotExecution extends CommandExecutionSpec {
  schema_version?: number;
  definition_hash?: string;
}

export interface CommandBindingSnapshot {
  bot_command_id: string;
  name: string;
  aliases: string[];
  description: string;
  help_text?: string;
  bot: CommandManifestBotSummary;
  options: unknown[];
  default_member_permission: "member" | "admin" | "owner";
  execution: CommandBindingSnapshotExecution;
}

export interface CommandManifestBotSummary {
  bot_id: string;
  display_name: string;
  avatar_url: string | null;
}

export interface CommandManifestItem {
  bot_command_id: string;
  name: string;
  aliases: string[];
  description: string;
  help_text: string;
  bot: CommandManifestBotSummary;
  options: unknown[];
  effective_member_permission: "member" | "admin" | "owner";
  execution: CommandExecutionSpec;
}

export interface CommandManifestResponse {
  version: number;
  items: CommandManifestItem[];
}

export interface CommandManifestDelta {
  op: "upsert" | "remove";
  manifest_version: number;
  item?: CommandManifestItem;
}

export interface ChannelCommandBindingPatchRequest {
  status: "allowed" | "blocked";
  permission_override?: "member" | "admin" | "owner" | null;
  stateful_max_ttl_seconds?: number | null;
}

export interface CommandDirectoryItem {
  bot_command_id: string;
  name: string;
  aliases: string[];
  description: string;
  help_text: string;
  bot: CommandManifestBotSummary;
  options: unknown[];
  default_member_permission: "member" | "admin" | "owner";
  execution: CommandExecutionSpec;
}

export interface BotAppSummary {
  bot_id: string;
  owner_user_id: string;
  display_name: string;
  avatar_url: string | null;
  description: string | null;
  visibility: "private" | "unlisted" | "public" | "official";
  status: "active" | "disabled" | "deleted";
  command_count?: number;
  created_at: string;
  updated_at: string;
}

export interface BotTokenCreated {
  token_id: string;
  name: string;
  scopes: string[];
  plaintext: string;
  created_at: string;
  expires_at: string | null;
}
