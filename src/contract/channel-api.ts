import type { DissolvedChannelProjection } from "./channel";
import type { UserSummary } from "./primitives";

export interface ChannelMetaProjection {
  channel_id: string;
  kind: string;
  visibility: string;
  title: string;
  topic: string | null;
  avatar_url: string | null;
  member_count: number;
  status: string;
  created_at: string;
  updated_at: string;
  last_message_preview?: string | null;
  last_message_at?: string | null;
  last_event_id?: string | null;
  my_role?: string | null;
  dm_peer_user_id?: string | null;
}

export interface ChannelSummaryApi {
  channel_id: string;
  kind: string;
  visibility: string;
  title: string;
  topic: string | null;
  avatar_url: string | null;
  member_count: number;
  status: string;
  created_at: string;
  updated_at: string;
  unread_count: number;
  last_read_event_id: string | null;
  last_message_preview: string | null;
  last_message_at: string | null;
  last_event_id: string | null;
  role: string | null;
  dm_peer?: UserSummary | null;
}

export interface ChannelMembershipApi {
  role: string;
  joined_at: string;
  status?: string;
}

export interface OpenDmApiResponse {
  channel: ChannelMetaProjection;
  membership: ChannelMembershipApi;
}

export interface CreateChannelApiResponse {
  channel: ChannelMetaProjection;
  joined_at: string;
}

export interface DissolveChannelApiResponse {
  channel: DissolvedChannelProjection;
}

export interface ChannelUpdatePresentFields {
  title?: string;
  topic?: string | null;
  avatar_attachment_id?: string | null;
  visibility?: string;
}

export interface MemberProjection {
  user_id: string;
  role: string;
  joined_at: string;
  status?: string;
}

export interface JoinChannelApiResponse {
  channel_id: string;
  membership_version: number;
  joined_at: string;
  role: string;
}
