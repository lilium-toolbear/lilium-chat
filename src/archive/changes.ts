import type { ArchiveChange } from "./payload";

export function rowVersionFromEvent(eventId: string): string {
  return eventId;
}

export function rowVersionFromSeq(sourceSeq: number): string {
  return `source_seq:${sourceSeq}`;
}

export function archiveUpsert(
  table: string,
  pk: Record<string, string | number>,
  rowVersion: string,
  after: Record<string, unknown>,
): ArchiveChange {
  return { op: "upsert", table, pk, row_version: rowVersion, after };
}

export function archiveDelete(
  table: string,
  pk: Record<string, string | number>,
  rowVersion: string,
): ArchiveChange {
  return { op: "delete", table, pk, row_version: rowVersion };
}

export function archiveReplaceScope(
  table: string,
  scope: Record<string, string | number>,
  rowVersion: string,
  rows: Array<Record<string, unknown>>,
): ArchiveChange {
  return { op: "replace_scope", table, scope, row_version: rowVersion, rows };
}

/** Map ChatChannel SQLite table names to normalized archive table names. */
export const CHAT_CHANNEL_TABLE_MAP: Record<string, string> = {
  channel_meta: "chat_channels",
  members: "chat_channel_members",
  messages: "chat_messages",
  message_edits: "chat_message_edits",
  audit_logs: "chat_audit_logs",
  attachments: "chat_attachments",
  message_attachments: "chat_message_attachments",
  message_stickers: "chat_message_stickers",
  mentions: "chat_mentions",
  invites: "chat_invites",
  events: "chat_events",
  bot_installations: "chat_bot_installations",
  channel_command_bindings: "chat_channel_command_bindings",
  channel_command_names: "chat_channel_command_names",
  command_invocations: "chat_command_invocations",
  interactions: "chat_interactions",
  channel_bot_event_subscriptions: "chat_channel_bot_event_subscriptions",
};

export function chatChannelTable(sqliteTable: string): string {
  const mapped = CHAT_CHANNEL_TABLE_MAP[sqliteTable];
  if (!mapped) throw new Error(`unknown ChatChannel table: ${sqliteTable}`);
  return mapped;
}
