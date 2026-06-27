import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { resolveUserSummaries, type UserSummary } from "../profile/resolve";
import { projectMessagesForBrowser } from "../chat/sender";
import type { MessageStickerSnapshot } from "../chat/message-projection";
import type { MessageRow } from "../do/chat-channel";
import type { AttachmentRow } from "../chat/attachment-projection";
interface MyChannel {
  channel_id: string;
  kind: string;
  last_read_event_id: string | null;
  membership_version: number;
}

interface SummaryPayload {
  channel_id: string;
  kind: string;
  visibility: string;
  title: string;
  topic: string | null;
  avatar_url: string | null;
  member_count: number;
  status: string;
  created_at: string;
  updated_at: string;
  last_message_preview: string | null;
  last_message_at: string | null;
  last_event_id: string | null;
  my_role: string | null;
}

interface ChannelSummary {
  channel_id: string;
  kind: string;
  visibility: string;
  title: string;
  topic: string | null;
  avatar_url: string | null;
  member_count: number;
  status: string;
  created_at: string;
  updated_at: string;
  unread_count: number;
  last_read_event_id: string | null;
  last_message_preview: string | null;
  last_message_at: string | null;
  last_event_id: string | null;
  role: string | null;
}

function fallbackMe(user_id: string): UserSummary {
  return { user_id, display_name: `user-${user_id.slice(0, 8)}`, avatar_url: null };
}

export async function bootstrapHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  const dirStub = c.env.USER_DIRECTORY.getByName(user_id);
  const dirRes = await dirStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": user_id } }));
  const myChannels = dirRes.ok
    ? ((await dirRes.json()) as { items: MyChannel[] }).items
    : [];

  const channelSummaries = await Promise.all(
    myChannels.map(async (mc) => {
      const stub = c.env.CHAT_CHANNEL.getByName(mc.channel_id);
      const summaryRes = await stub.fetch(new Request("https://x/internal/summary", {
        headers: { "X-Verified-User-Id": user_id },
      }));
      if (!summaryRes.ok) return null;
      const summary = (await summaryRes.json()) as SummaryPayload;

      return {
        channel_id: summary.channel_id,
        kind: summary.kind,
        visibility: summary.visibility,
        title: summary.title,
        topic: summary.topic,
        avatar_url: summary.avatar_url,
        member_count: summary.member_count,
        status: summary.status,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
        unread_count: 0,
        last_read_event_id: mc.last_read_event_id,
        last_message_preview: summary.last_message_preview,
        last_message_at: summary.last_message_at,
        last_event_id: summary.last_event_id,
        role: summary.my_role,
      } as ChannelSummary;
    }),
  );

  const channels = channelSummaries.filter((it): it is ChannelSummary => it !== null);
  const requestedChannelId = new URL(c.req.url).searchParams.get("channel_id");
  const activeChannel = requestedChannelId
    ? channels.find((ch) => ch.channel_id === requestedChannelId)
    : channels[0];

  const messages = activeChannel
    ? await (async () => {
      const stub = c.env.CHAT_CHANNEL.getByName(activeChannel.channel_id);
      const mres = await stub.fetch(new Request("https://x/internal/messages?limit=50", {
        headers: { "X-Verified-User-Id": user_id },
      }));
      if (!mres.ok) return { items: [] as Array<unknown>, next_cursor: null };

      const body = await mres.json() as { items: MessageRow[]; mentions: Record<string, Array<{ user_id: string; start: number; end: number }>>; attachments: Record<string, AttachmentRow[]>; stickers: Record<string, MessageStickerSnapshot>; next_cursor: string | null };
      return {
        items: await projectMessagesForBrowser(body.items, body.mentions ?? {}, c.env, body.attachments ?? {}, body.stickers ?? {}),
        next_cursor: body.next_cursor,
      };
    })()
    : { items: [] as Array<unknown>, next_cursor: null };

  const per_channel: Record<string, string> = {};
  for (const ch of channels) {
    if (ch.last_event_id) {
      per_channel[ch.channel_id] = ch.last_event_id;
    }
  }

  const meMap = await resolveUserSummaries([user_id], c.env);
  const me = meMap.get(user_id) ?? fallbackMe(user_id);

  return c.json(
    {
      me,
      channels,
      active_channel: activeChannel ?? null,
      messages,
      event_state: { per_channel },
    },
    200,
    { "X-Request-Id": c.get("requestId") },
  );
}
