export interface MessageEventSubscriptionFilters {
  message_types: string[];
  include_bot_messages: boolean;
  include_own_messages: boolean;
  only_when_mentioned: boolean;
}

export type CommandPolicyEntry = boolean | { enabled?: boolean; permission_override?: string };
export type CommandPolicyMap = Record<string, CommandPolicyEntry>;

export type EventSubscriptionPolicyEntry =
  | boolean
  | { enabled?: boolean; filters?: MessageEventSubscriptionFilters | Record<string, unknown> };
export type EventSubscriptionPolicyMap = Record<string, EventSubscriptionPolicyEntry>;

export interface CommandBindingProjection {
  binding_id: string;
  bot_command_id: string;
  name: string;
  aliases: string[];
  status: string;
  permission_override: string | null;
  default_member_permission: string;
  definition_hash: string;
}

export interface BotEventSubscriptionProjection {
  subscription_id: string;
  event_type: string;
  status: string;
  filters: MessageEventSubscriptionFilters;
}

export interface BotInstallResponse {
  bot_id: string;
  status: string;
  bindings: CommandBindingProjection[];
  subscriptions: BotEventSubscriptionProjection[];
}

export interface BotInstallUpdateResponse {
  bot_id: string;
  status: string;
}

export interface BotCommandCatalogEntry {
  bot_command_id: string;
  name: string;
  definition_hash: string;
  schema_version: number;
  updated_at: string;
}

export interface BotEventCapabilityCatalogEntry {
  event_type: string;
  default_enabled_on_install: boolean;
  updated_at: string;
}

export interface BotCommandsSyncResponse {
  commands: BotCommandCatalogEntry[];
  event_capabilities: BotEventCapabilityCatalogEntry[];
}

export interface CommandBindingUpdateResponse {
  bot_command_id: string;
  status: string;
  enabled: boolean;
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

