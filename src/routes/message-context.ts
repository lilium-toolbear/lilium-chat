import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError, apiErrorFromRemote } from "../errors";
import { requireChannelIdParam } from "./path-params";
import { verifyBrowserJwt } from "../auth/jwt";

export async function messageContextHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id: userId } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const messageId = c.req.param("message_id");
  if (!messageId) throw new ApiError("MESSAGE_NOT_FOUND", "message not found");

  const url = new URL(c.req.url);
  const beforeParam = url.searchParams.get("before") ?? "30";
  const afterParam = url.searchParams.get("after") ?? "30";
  const before = Math.max(0, Math.min(50, Math.floor(Number(beforeParam) || 30)));
  const after = Math.max(0, Math.min(50, Math.floor(Number(afterParam) || 30)));

  const stub = c.env.CHAT_CHANNEL.getByName(channelId);
  const body = await stub.getMessageContext(userId, {
    message_id: messageId,
    before,
    after,
  }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });
  return c.json(body, 200, { "X-Request-Id": c.get("requestId") });
}
