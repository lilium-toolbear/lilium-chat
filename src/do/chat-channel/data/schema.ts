/**
 * ChatChannel SQLite row types — keep in sync with migrations.ts CHAT_CHANNEL_BASELINE_SCHEMA.
 * Query projections use Pick<> instead of duplicating inline object types.
 */

export type { MessageRow } from "../../../contract/persisted";

export interface ChannelMetaRow {
  channel_id: string;
  kind: string;
  visibility: string;
  title: string;
  topic: string | null;
  avatar_url: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  member_count: number;
  membership_version: number;
  command_manifest_version: number;
}

export type ChannelMetaStatusVisibilityRow = Pick<ChannelMetaRow, "status" | "visibility">;

export type ChannelMetaIdStatusRow = Pick<ChannelMetaRow, "channel_id" | "status">;

export type ChannelMetaKindStatusRow = Pick<ChannelMetaRow, "kind" | "status" | "command_manifest_version">;

export type ChannelMetaCommandRow = Pick<
  ChannelMetaRow,
  "kind" | "status" | "membership_version" | "command_manifest_version"
>;

export type ChannelMetaKindRow = Pick<ChannelMetaRow, "channel_id" | "kind">;

export type ChannelMetaStreamGateRow = Pick<ChannelMetaRow, "channel_id" | "status" | "membership_version">;

export type ChannelMetaKindStreamGateRow = Pick<ChannelMetaRow, "channel_id" | "kind" | "status" | "membership_version">;

export type ChannelMetaManifestGateRow = Pick<ChannelMetaRow, "kind" | "status" | "command_manifest_version">;

export type ChannelMetaManifestVersionRow = Pick<ChannelMetaRow, "status" | "command_manifest_version">;

export type ChannelMetaVisibilityGateRow = Pick<ChannelMetaRow, "channel_id" | "visibility">;

export type ChannelMetaInvitePreviewRow = Pick<
  ChannelMetaRow,
  "channel_id" | "kind" | "visibility" | "title" | "avatar_url" | "member_count" | "status"
>;

export type ChannelMetaDirectoryFieldsRow = Pick<ChannelMetaRow, "title" | "avatar_url" | "member_count" | "status">;

export type ChannelMetaMemberCountRow = Pick<ChannelMetaRow, "membership_version" | "member_count">;

export type ChannelMetaPublicProjectionRow = Pick<
  ChannelMetaRow,
  "channel_id" | "kind" | "visibility" | "title" | "topic" | "avatar_url" | "member_count" | "status" | "created_at" | "updated_at"
>;

export type ChannelMetaExistsRow = Pick<ChannelMetaRow, "channel_id">;

export type MemberJoinedAtRow = Pick<MemberRow, "joined_at">;

export type ActiveMemberWithJoinedAtRow = Pick<MemberRow, "user_id" | "joined_at">;

export type MessageLastActivityRow = { created_at: string };

export interface MentionRow {
  user_id: string;
  start: number;
  end: number;
}

export type ChannelMetaJoinHeaderRow = Pick<
  ChannelMetaRow,
  "channel_id" | "kind" | "visibility" | "status" | "membership_version" | "member_count"
>;

export type ChannelMetaMembershipRow = Pick<
  ChannelMetaRow,
  "status" | "visibility" | "membership_version" | "member_count"
>;

export type ChannelMetaAdminRow = Pick<
  ChannelMetaRow,
  "status" | "visibility" | "membership_version" | "member_count" | "kind" | "created_by"
>;

export type ChannelMetaInviteAcceptRow = Pick<
  ChannelMetaRow,
  "channel_id" | "kind" | "visibility" | "title" | "avatar_url" | "member_count" | "membership_version" | "status"
>;

export type ChannelMetaUpdateRow = Pick<
  ChannelMetaRow,
  "kind" | "visibility" | "title" | "topic" | "avatar_url" | "status" | "created_at" | "updated_at" | "member_count" | "membership_version"
>;

export interface MemberRow {
  channel_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  left_at: string | null;
}

export type ActiveMemberListRow = Pick<MemberRow, "user_id" | "role" | "joined_at">;

export type MemberRoleRow = Pick<MemberRow, "role">;

export type MemberRoleStatusRow = Pick<MemberRow, "role" | "joined_at" | "left_at">;

export type MemberLeftAtRow = Pick<MemberRow, "left_at">;

export interface InviteRow {
  invite_code: string;
  created_by: string;
  expires_at: string;
  max_uses: number | null;
  used_count: number;
  revoked_at: string | null;
  created_at: string;
}

export type InviteCreatedByRow = Pick<InviteRow, "created_by">;

export interface ProjectionOutboxRow {
  outbox_id: string;
  target_kind: string;
  target_key: string;
  event_id: string;
  payload_json: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  failed_at: string | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
}

export interface BotDeliveryOutboxRow {
  outbox_id: string;
  channel_id: string;
  bot_id: string;
  kind: string;
  invocation_id: string | null;
  interaction_id: string | null;
  event_id: string | null;
  request_json: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  failed_at: string | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
}

/** EXISTS (SELECT 1 ...) probe rows. */
export interface SqlExistsRow {
  x: number;
}
