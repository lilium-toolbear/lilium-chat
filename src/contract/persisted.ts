import type { ChannelFieldChanges } from "./events";
import type { MemberJoinSource, MemberLeaveSource } from "./events";

/** Actor references stored in SQLite events.payload_json (design §3.5). */
export interface ActorPersistedFields {
  actor_kind: string;
  actor_id: string;
}

export interface ChannelCreatedPersistedPayload extends ActorPersistedFields {
  channel: { channel_id: string; kind: string; visibility: string; title: string };
}

export interface ChannelUpdatedPersistedPayload extends ActorPersistedFields {
  channel_id: string;
  channel_changes: Record<string, { before: unknown; after: unknown }>;
}

export interface ChannelDissolvedPersistedPayload extends ActorPersistedFields {
  channel_id: string;
  status: "dissolved";
  dissolved_at: string;
}

export interface MemberJoinedPersistedPayload extends ActorPersistedFields {
  channel_id: string;
  user_id: string;
  role: string;
  membership_version: number;
  join_source: MemberJoinSource | null;
  inviter_user_id: string | null;
}

export interface MemberRoleUpdatedPersistedPayload extends ActorPersistedFields {
  channel_id: string;
  user_id: string;
  before_role: string;
  after_role: string;
  membership_version: number;
}

export interface MemberLeftPersistedPayload extends ActorPersistedFields {
  channel_id: string;
  user_id: string;
  role: string;
  membership_version: number;
  leave_source: MemberLeaveSource | null;
}

export interface ReadStateUpdatedPersistedPayload {
  channel_id: string;
  user_id: string;
  last_read_event_id: string;
}

export interface BotInstalledPersistedPayload extends ActorPersistedFields {
  channel_id: string;
  bot_id: string;
}

export interface BotUpdatedPersistedPayload extends ActorPersistedFields {
  channel_id: string;
  bot_id: string;
  status: string;
  changes: Record<string, { before: unknown; after: unknown }> | null;
}

export interface CommandBindingUpdatedPersistedPayload extends ActorPersistedFields {
  channel_id: string;
  bot_id: string;
  bot_command_id: string;
  binding_changes: Record<string, { before: unknown; after: unknown }>;
}

export interface PersistedMessageSenderRef {
  kind: string;
  user_id: string | null;
  bot_id: string | null;
}

export interface PersistedMessageSnapshot {
  message_id: string;
  command_id: string;
  channel_id: string;
  sender: PersistedMessageSenderRef;
  text: string | null;
  type: string;
  format: string;
  status: string;
  stream_state: string;
  reply_to: string | null;
  reply_snapshot: unknown;
  attachments: unknown[];
  components: unknown[];
  mentions: unknown[];
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  recalled_at: string | null;
}

/** SQLite `messages` row shape — shared between DO storage and chat projection. */
export interface MessageRow {
  message_id: string;
  command_id: string;
  channel_id: string;
  sender_kind: string;
  sender_user_id: string | null;
  sender_bot_id: string | null;
  type: string;
  format: string;
  status: string;
  text: string | null;
  reply_to: string | null;
  reply_snapshot_json: string | null;
  stream_state: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  recalled_at: string | null;
}

export interface MessagePersistedPayload {
  message: PersistedMessageSnapshot;
}

/** Event types persisted via persistEventAndFanout (actor ref → wire UserSummary). */
export type ManagementPersistedEventType =
  | "channel.created"
  | "channel.updated"
  | "channel.dissolved"
  | "member.joined"
  | "member.role_updated"
  | "member.left"
  | "bot.installed"
  | "bot.updated"
  | "command.binding_updated";

export interface ManagementPersistedPayloadByType {
  "channel.created": ChannelCreatedPersistedPayload;
  "channel.updated": ChannelUpdatedPersistedPayload;
  "channel.dissolved": ChannelDissolvedPersistedPayload;
  "member.joined": MemberJoinedPersistedPayload;
  "member.role_updated": MemberRoleUpdatedPersistedPayload;
  "member.left": MemberLeftPersistedPayload;
  "bot.installed": BotInstalledPersistedPayload;
  "bot.updated": BotUpdatedPersistedPayload;
  "command.binding_updated": CommandBindingUpdatedPersistedPayload;
}

export type ManagementPersistedPayload = ManagementPersistedPayloadByType[ManagementPersistedEventType];

export interface ChatEventPersistedPayloadByType {
  "message.created": MessagePersistedPayload;
  "message.updated": MessagePersistedPayload;
  "message.deleted": MessagePersistedPayload;
  "message.recalled": MessagePersistedPayload;
  "channel.created": ChannelCreatedPersistedPayload;
  "channel.updated": ChannelUpdatedPersistedPayload;
  "channel.dissolved": ChannelDissolvedPersistedPayload;
  "member.joined": MemberJoinedPersistedPayload;
  "member.role_updated": MemberRoleUpdatedPersistedPayload;
  "member.left": MemberLeftPersistedPayload;
  "bot.installed": BotInstalledPersistedPayload;
  "bot.updated": BotUpdatedPersistedPayload;
  "command.binding_updated": CommandBindingUpdatedPersistedPayload;
}

/** channel_changes after JSON round-trip may not satisfy ChannelFieldChanges strictly. */
export type ChannelChangesPersisted = Record<string, { before: unknown; after: unknown }>;

export function asChannelFieldChanges(
  changes: ChannelChangesPersisted,
): ChannelFieldChanges | null {
  if (Object.keys(changes).length === 0) return null;
  return changes as ChannelFieldChanges;
}
