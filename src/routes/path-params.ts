import { ApiError } from "../errors";

/** HTTP route path segments — validate once at the Hono boundary. */
export function requireChannelIdParam(channelId: string | undefined): string {
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  return channelId;
}

export function requireMemberUserIdParam(userId: string | undefined): string {
  if (!userId) throw new ApiError("MEMBER_NOT_FOUND", "member not found");
  return userId;
}
