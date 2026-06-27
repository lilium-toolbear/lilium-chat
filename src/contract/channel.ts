import type {
  ChannelKind,
  ChannelRole,
  ChannelStatus,
  ChannelVisibility,
  ChatId,
  IsoDateTimeString,
  MemberStatus,
  UserSummary,
} from "./primitives";

export interface ChannelDetail {
  channel_id: ChatId;
  kind: ChannelKind;
  visibility: ChannelVisibility;
  title: string;
  topic: string | null;
  avatar_url: string | null;
  member_count: number;
  role: ChannelRole | null;
  status: ChannelStatus;
  dm_peer?: UserSummary | null;
  created_at: IsoDateTimeString;
  updated_at: IsoDateTimeString;
}

export interface DissolvedChannelProjection {
  channel_id: ChatId;
  status: "dissolved";
  updated_at: IsoDateTimeString;
}

export interface ChannelMember {
  user: UserSummary;
  role: ChannelRole;
  joined_at: IsoDateTimeString;
  status?: MemberStatus;
}
