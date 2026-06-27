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

