import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError, apiErrorFromRemote } from "../errors";
import type { ChannelSummaryApi } from "../contract/channel-api";
import { inflateMyChannelSummaries } from "../chat/channel-list";
import { inflateChannelSummaryForViewer } from "../chat/channel-summary";
import { getIdentity } from "./auth";
import { requireChannelIdParam } from "./path-params";

export async function listChannelsHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const dirStub = env.USER_DIRECTORY.getByName(userId);
  const myChannels = (await dirStub.listMyChannels(userId).catch(() => ({ items: [] as Array<import("../chat/channel-list").MyChannelIndexRow> }))).items;
  const items = await inflateMyChannelSummaries({
    env,
    viewerUserId: userId,
    myChannels: myChannels,
  });
  return c.json({ items, next_cursor: null }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function channelDetailHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const s = await stub.getSummary(userId).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });
  const channel = await inflateChannelSummaryForViewer({
    summary: s,
    viewerUserId: userId,
    myChannelRow: null,
    env,
  });
  return c.json({ channel }, 200, { "X-Request-Id": c.get("requestId") });
}
