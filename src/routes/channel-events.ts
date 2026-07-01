import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError, apiErrorFromRemote } from "../errors";
import { requireChannelIdParam } from "./path-params";
import { verifyBrowserJwt } from "../auth/jwt";

export async function channelEventsHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id: userId } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  const channelId = requireChannelIdParam(c.req.param("channel_id"));

  const url = new URL(c.req.url);
  const afterEventId = url.searchParams.get("after_event_id") ?? "";
  const limitParam = url.searchParams.get("limit") ?? "100";
  const limit = Math.max(1, Math.min(100, Math.floor(Number(limitParam) || 100)));

  const stub = c.env.CHAT_CHANNEL.getByName(channelId);
  const body = await stub.replayEventsPage(userId, afterEventId, limit).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });
  return c.json(body, 200, { "X-Request-Id": c.get("requestId") });
}
