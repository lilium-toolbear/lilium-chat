/** Copied from toolbear_ui/frontend/src/types/chat.ts — keep in sync manually until shared package. */

export type ChatId = string;
export type IsoDateTimeString = string;
export type Cursor = string;

export interface UserSummary {
  user_id: ChatId;
  display_name: string;
  avatar_url: string | null;
}

export function fallbackUserDisplayName(userId: string): string {
  return `user-${userId.slice(0, 8)}`;
}

export type ChannelKind = "channel" | "dm";
export type ChannelVisibility = "private" | "public_unlisted" | "public_listed";
export type ChannelRole = "owner" | "admin" | "member";
export type ChannelStatus = "active" | "archived" | "dissolved";
export type MemberStatus = "active" | "left" | "removed";
