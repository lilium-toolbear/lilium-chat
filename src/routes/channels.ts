import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import type { ChannelSummaryApi } from "../contract/channel-api";
import { inflateMyChannelSummaries } from "../chat/channel-list";
import { inflateChannelSummaryForViewer } from "../chat/channel-summary";
import { getIdentity } from "./auth";

export async function listChannelsHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const dirStub = env.USER_DIRECTORY.getByName(userId);
  const dirRes = await dirStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
  const myChannels = dirRes.ok
    ? ((await dirRes.json()) as { items: Array<{ channel_id: string; kind: string; last_read_event_id: string | null; membership_version: number }> }).items
    : [];
  const items = await inflateMyChannelSummaries({
    env,
    viewerUserId: userId,
    myChannels: myChannels,
  });
  return c.json({ items, next_cursor: null }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function channelDetailHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const res = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not a member");
  if (!res.ok) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const s = await res.json() as Parameters<typeof inflateChannelSummaryForViewer>[0]["summary"];
  const channel = await inflateChannelSummaryForViewer({
    summary: s,
    viewerUserId: userId,
    myChannelRow: null,
    env,
  });
  return c.json({ channel }, 200, { "X-Request-Id": c.get("requestId") });
}
