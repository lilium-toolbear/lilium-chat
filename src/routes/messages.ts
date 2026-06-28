import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import type { EventFrame } from "../contract/wire-frames";

export async function listMessagesHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id: userId } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");

  const url = new URL(c.req.url);
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const limit = url.searchParams.get("limit") ?? "50";

  const stub = c.env.CHAT_CHANNEL.getByName(channelId);
  const qs = new URLSearchParams();
  if (before) qs.set("before", before);
  if (after) qs.set("after", after);
  qs.set("limit", limit);

  const mres = await stub.fetch(new Request(`https://x/internal/messages?${qs}`, { headers: { "X-Verified-User-Id": userId } }));
  if (mres.status === 403) throw new ApiError("FORBIDDEN", "not a member");
  if (mres.status === 404 || mres.status === 409) {
    throw new ApiError("CHANNEL_NOT_FOUND", "channel not found", { httpStatus: 404 });
  }
  if (!mres.ok) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const body = await mres.json() as { items: EventFrame[]; next_cursor: string | null };
  return c.json({ items: body.items, next_cursor: body.next_cursor }, 200, { "X-Request-Id": c.get("requestId") });
}
