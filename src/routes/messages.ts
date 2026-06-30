import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError, apiErrorFromRemote } from "../errors";
import { requireChannelIdParam } from "./path-params";
import { verifyBrowserJwt } from "../auth/jwt";
import type { EventFrame } from "../contract/wire-frames";

export async function listMessagesHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id: userId } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  const channelId = requireChannelIdParam(c.req.param("channel_id"));

  const url = new URL(c.req.url);
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const limit = url.searchParams.get("limit") ?? "50";

  const stub = c.env.CHAT_CHANNEL.getByName(channelId);
  const body = await stub.getMessages(userId, { before, after, limit: Number(limit) }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as { items: EventFrame[]; next_cursor: string | null };
  return c.json({ items: body.items, next_cursor: body.next_cursor }, 200, { "X-Request-Id": c.get("requestId") });
}
