/** Default max delivery attempts for projection_outbox and fanout_queue rows. */
export const OUTBOX_MAX_ATTEMPTS = 5;

export interface UserDirectoryJoinOutboxPayload {
  action: "join";
  channel_id: string;
  kind: string;
  membership_version: number;
}

export interface UserDirectoryLeaveOutboxPayload {
  action: "leave";
  channel_id: string;
  kind: string;
  membership_version: number;
}

export interface UserDirectoryDissolveOutboxPayload {
  action: "dissolve";
  channel_id: string;
  kind: string;
  membership_version: number;
}

export type UserDirectoryOutboxPayload =
  | UserDirectoryJoinOutboxPayload
  | UserDirectoryLeaveOutboxPayload
  | UserDirectoryDissolveOutboxPayload;

export interface ChannelFanoutUnregisterOutboxPayload {
  action: "unregister-user";
  channel_id: string;
  user_id: string;
}

export interface ChannelFanoutDeliverOutboxPayload {
  action: "fanout";
  event_id: string;
  event_json: string;
  membership_version_at_event: number;
}

export interface ChannelDirectoryDeleteOutboxPayload {
  action: "delete";
  channel_id: string;
}

export interface ChannelDirectorySnapshotFields {
  title: string;
  avatar_url: string | null;
  member_count: number;
  last_message_at: string | null;
  status: string;
}

export interface ChannelDirectoryUpsertOutboxPayload {
  action: "upsert";
  channel_id: string;
  fields: ChannelDirectorySnapshotFields;
  fields_present: string[];
}

export type ChannelDirectoryOutboxPayload =
  | ChannelDirectoryDeleteOutboxPayload
  | ChannelDirectoryUpsertOutboxPayload;

export type ProjectionOutboxPayload =
  | UserDirectoryOutboxPayload
  | ChannelFanoutUnregisterOutboxPayload
  | ChannelDirectoryOutboxPayload;
