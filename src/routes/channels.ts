import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { channelRouteNameFor, ensureSystemJoined } from "../chat/system-channel";

async function getIdentity(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<{ userId: string; env: Env }> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id } = await verifyBrowserJwt(token, c.env.JWT_SECRET);
  return { userId: user_id, env: c.env };
}

export async function listChannelsHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const sysChannelId = (await ensureSystemJoined(env, userId)).channelId;
  const dirStub = env.USER_DIRECTORY.getByName(userId);
  const dirRes = await dirStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
  const rawMyChannels = dirRes.ok
    ? ((await dirRes.json()) as { items: Array<{ channel_id: string; kind: string; last_read_event_id: string | null; membership_version: number }> }).items
    : [];
  const myChannels = rawMyChannels.some((m) => m.channel_id === sysChannelId)
    ? rawMyChannels
    : [{ channel_id: sysChannelId, kind: "channel", last_read_event_id: null, membership_version: 0 }, ...rawMyChannels];
  const items = await Promise.all(
    myChannels.map(async (mc) => {
      const routeName = await channelRouteNameFor(env, userId, mc.channel_id);
      if (routeName === null) return null;
      const stub = env.CHAT_CHANNEL.getByName(routeName);
      const res = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }));
      const s = await res.json() as Record<string, unknown>;
      return {
        channel_id: s.channel_id,
        kind: s.kind,
        visibility: s.visibility,
        title: s.title,
        avatar_url: s.avatar_url,
        member_count: s.member_count,
        role: s.my_role,
        status: s.status,
        unread_count: 0,
        last_read_event_id: mc.last_read_event_id,
        last_message_preview: s.last_message_preview ?? null,
        last_message_at: s.last_message_at ?? null,
        last_event_id: s.last_event_id ?? null,
      };
    }),
  );
  const filtered = items.filter((it) => it !== null) as Array<Record<string, unknown>>;
  return c.json({ items: filtered, next_cursor: null }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function channelDetailHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  await ensureSystemJoined(env, userId);
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not a member");
  if (!res.ok) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const s = await res.json() as Record<string, unknown>;
  const channel = {
    channel_id: s.channel_id,
    kind: s.kind,
    visibility: s.visibility,
    title: s.title,
    topic: s.topic,
    avatar_url: s.avatar_url,
    member_count: s.member_count,
    role: s.my_role,
    status: s.status,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
  return c.json({ channel }, 200, { "X-Request-Id": c.get("requestId") });
}
