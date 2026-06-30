import type { MessageRow } from "../../../contract/persisted";

export type SyncSql = DurableObjectState["storage"]["sql"];

/** Build `col1, col2, ...` for SELECT lists — keys should match the target row projection. */
export function sqlColumns(...columns: string[]): string {
  return columns.join(", ");
}

const MESSAGE_LIFECYCLE_KEYS = [
  "message_id",
  "command_id",
  "channel_id",
  "sender_kind",
  "sender_user_id",
  "sender_bot_id",
  "type",
  "format",
  "status",
  "text",
  "reply_to",
  "reply_snapshot_json",
  "stream_state",
  "created_at",
  "updated_at",
  "edited_at",
  "deleted_at",
  "deleted_by",
  "recalled_at",
  "invocation_json",
] as const satisfies readonly (keyof MessageRow)[];

export type MessageLifecycleRow = Pick<MessageRow, (typeof MESSAGE_LIFECYCLE_KEYS)[number]>;

export const MESSAGE_LIFECYCLE_COLS = sqlColumns(...MESSAGE_LIFECYCLE_KEYS);

const MESSAGE_REPLY_TARGET_KEYS = [
  "message_id",
  "command_id",
  "channel_id",
  "sender_kind",
  "sender_user_id",
  "sender_bot_id",
  "sender_bot_display_name",
  "sender_bot_avatar_url",
  "type",
  "format",
  "status",
  "text",
  "reply_to",
  "reply_snapshot_json",
  "stream_state",
  "created_at",
  "updated_at",
  "edited_at",
  "deleted_at",
  "deleted_by",
  "recalled_at",
] as const satisfies readonly (keyof MessageRow)[];

export type MessageReplyTargetRow = Pick<MessageRow, (typeof MESSAGE_REPLY_TARGET_KEYS)[number]>;

export const MESSAGE_REPLY_TARGET_COLS = sqlColumns(...MESSAGE_REPLY_TARGET_KEYS);
