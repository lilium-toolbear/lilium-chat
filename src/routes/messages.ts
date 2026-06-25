import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { projectMessagesForBrowser } from "../chat/sender";
import type { MessageStickerSnapshot } from "../chat/message-projection";
import type { MessageRow } from "../do/chat-channel";
import type { AttachmentRow } from "../chat/attachment-projection";
import { ensureSystemJoined, channelRouteNameFor } from "../chat/system-channel";

export async function listMessagesHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id: userId } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");

  const url = new URL(c.req.url);
  const before = url.searchParams.get("before");
  const limit = url.searchParams.get("limit") ?? "50";

  await ensureSystemJoined(c.env, userId);
  const routeName = await channelRouteNameFor(c.env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");

  const stub = c.env.CHAT_CHANNEL.getByName(routeName);
  const qs = new URLSearchParams();
  if (before) qs.set("before", before);
  qs.set("limit", limit);

  const mres = await stub.fetch(new Request(`https://x/internal/messages?${qs}`, { headers: { "X-Verified-User-Id": userId } }));
  if (mres.status === 403) throw new ApiError("FORBIDDEN", "not a member");
  if (mres.status === 404 || mres.status === 409) {
    throw new ApiError("CHANNEL_NOT_FOUND", "channel not found", { httpStatus: 404 });
  }
  if (!mres.ok) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const mb = await mres.json() as {
    items: MessageRow[];
    mentions: Record<string, Array<{ user_id: string; start: number; end: number }>>;
    attachments: Record<string, AttachmentRow[]>;
    stickers: Record<string, MessageStickerSnapshot>;
    next_cursor: string | null;
  };

  const items = await projectMessagesForBrowser(mb.items, mb.mentions ?? {}, c.env, mb.attachments ?? {}, mb.stickers ?? {});
  return c.json({ items, next_cursor: mb.next_cursor }, 200, { "X-Request-Id": c.get("requestId") });
}
