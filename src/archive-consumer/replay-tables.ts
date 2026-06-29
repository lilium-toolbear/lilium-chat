export interface ReplayTableConfig {
  pgTable: string;
  pk: string[];
  jsonColumns?: ReadonlySet<string>;
  transformRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** replace_scope: soft-delete rows in scope, then upsert incoming rows */
  scopeReplace?: boolean;
  /** Column set on soft delete (replace_scope and delete op). */
  softDeleteColumn?: string;
}

function eventsTransform(row: Record<string, unknown>): Record<string, unknown> {
  const next = { ...row };
  if (next.payload_json !== undefined && next.payload === undefined) {
    const raw = next.payload_json;
    next.payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    delete next.payload_json;
  }
  return next;
}

/** Whitelist replay config per archive table name (spec §7.5, §8.9). */
export const REPLAY_TABLES: Record<string, ReplayTableConfig> = {
  chat_channels: {
    pgTable: "chat.channels",
    pk: ["channel_id"],
  },
  chat_channel_members: {
    pgTable: "chat.channel_members",
    pk: ["channel_id", "user_id"],
    softDeleteColumn: "left_at",
  },
  chat_messages: {
    pgTable: "chat.messages",
    pk: ["message_id"],
    jsonColumns: new Set(["reply_snapshot_json"]),
  },
  chat_message_edits: {
    pgTable: "chat.message_edits",
    pk: ["edit_id"],
  },
  chat_audit_logs: {
    pgTable: "chat.audit_logs",
    pk: ["audit_id"],
    jsonColumns: new Set(["before_json", "after_json"]),
  },
  chat_events: {
    pgTable: "chat.events",
    pk: ["event_id"],
    jsonColumns: new Set(["payload"]),
    transformRow: eventsTransform,
  },
  chat_attachments: {
    pgTable: "chat.attachments",
    pk: ["attachment_id"],
  },
  chat_message_attachments: {
    pgTable: "chat.message_attachments",
    pk: ["message_id", "attachment_id"],
    scopeReplace: true,
    softDeleteColumn: "deleted_at",
  },
  chat_message_stickers: {
    pgTable: "chat.message_stickers",
    pk: ["message_id"],
    scopeReplace: true,
    softDeleteColumn: "deleted_at",
  },
  chat_mentions: {
    pgTable: "chat.mentions",
    pk: ["message_id", "start_index", "end_index"],
    scopeReplace: true,
    softDeleteColumn: "deleted_at",
  },
  chat_invites: {
    pgTable: "chat.invites",
    pk: ["invite_code"],
    softDeleteColumn: "revoked_at",
  },
  chat_dm_pairs: {
    pgTable: "chat.dm_pairs",
    pk: ["pair_key"],
  },
  chat_personal_stickers: {
    pgTable: "chat.personal_stickers",
    pk: ["sticker_id"],
    softDeleteColumn: "deleted_at",
  },
  chat_bot_apps: {
    pgTable: "chat.bot_apps",
    pk: ["bot_id"],
  },
  chat_bot_tokens: {
    pgTable: "chat.bot_tokens",
    pk: ["token_id"],
    softDeleteColumn: "revoked_at",
  },
  chat_bot_commands: {
    pgTable: "chat.bot_commands",
    pk: ["bot_command_id"],
    jsonColumns: new Set(["options_json"]),
    softDeleteColumn: "deleted_at",
  },
  chat_bot_command_aliases: {
    pgTable: "chat.bot_command_aliases",
    pk: ["bot_command_id", "alias"],
    scopeReplace: true,
    softDeleteColumn: "deleted_at",
  },
  chat_bot_event_capabilities: {
    pgTable: "chat.bot_event_capabilities",
    pk: ["bot_id", "event_type"],
    jsonColumns: new Set(["filters_json"]),
    scopeReplace: true,
    softDeleteColumn: "deleted_at",
  },
  chat_bot_installations: {
    pgTable: "chat.bot_installations",
    pk: ["channel_id", "bot_id"],
  },
  chat_channel_command_bindings: {
    pgTable: "chat.channel_command_bindings",
    pk: ["binding_id"],
    jsonColumns: new Set(["options_json", "aliases_json"]),
    scopeReplace: true,
    softDeleteColumn: "deleted_at",
  },
  chat_channel_command_names: {
    pgTable: "chat.channel_command_names",
    pk: ["channel_id", "slash_name"],
    scopeReplace: true,
    softDeleteColumn: "deleted_at",
  },
  chat_channel_bot_event_subscriptions: {
    pgTable: "chat.channel_bot_event_subscriptions",
    pk: ["subscription_id"],
    jsonColumns: new Set(["filters_json"]),
    scopeReplace: true,
    softDeleteColumn: "deleted_at",
  },
  chat_command_invocations: {
    pgTable: "chat.command_invocations",
    pk: ["invocation_id"],
    jsonColumns: new Set(["options_json"]),
  },
  chat_interactions: {
    pgTable: "chat.interactions",
    pk: ["interaction_id"],
    jsonColumns: new Set(["value_json"]),
  },
};
