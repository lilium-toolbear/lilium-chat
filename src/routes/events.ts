import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import type { EventFrame } from "../ws/frames";

interface ReplayResponse {
  events: Array<{ event_id: string; event_json: string }>;
}

function decodeCursors(param: string | null): Record<string, string> {
  if (!param) return {};
  try {
    const normalized = `${param.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (param.length % 4)) % 4)}`;
    return JSON.parse(atob(normalized)) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function eventsHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id: userId } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  const url = new URL(c.req.url);
  const channelId = url.searchParams.get("channel_id");
  const afterEventId = url.searchParams.get("after_event_id") ?? "";
  const cursorsParam = url.searchParams.get("cursors");

  let targets: Array<{ channel_id: string; after: string }>;
  if (channelId) {
    targets = [{ channel_id: channelId, after: afterEventId }];
  } else {
    const cursors = decodeCursors(cursorsParam);
    const dirStub = c.env.USER_DIRECTORY.getByName(userId);
    const dirRes = await dirStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const myChannels = dirRes.ok ? ((await dirRes.json()) as { items: Array<{ channel_id: string }> }).items : [];
    targets = myChannels.map((mc) => ({ channel_id: mc.channel_id, after: cursors[mc.channel_id] ?? "" }));
  }

  const replays = await Promise.all(
    targets.map(async (target): Promise<{ channel_id: string; items: EventFrame[]; last_event_id: string | null } | null> => {
      const stub = c.env.CHAT_CHANNEL.getByName(target.channel_id);
      const replayRes = await stub.fetch(new Request(`https://x/internal/replay?after=${encodeURIComponent(target.after)}`, {
        headers: { "X-Verified-User-Id": userId },
      }));
      if (!replayRes.ok) return null;
      const replay = (await replayRes.json()) as ReplayResponse;
      const items = replay.events
        .map((it) => {
          try {
            return JSON.parse(it.event_json) as EventFrame;
          } catch {
            return null;
          }
        })
        .filter((it): it is EventFrame => it !== null);

      const lastEventId = items.length > 0 ? items[items.length - 1]!.event_id : target.after || null;
      return {
        channel_id: target.channel_id,
        items,
        last_event_id: lastEventId,
      };
    }),
  );

  const filtered = replays.filter((r): r is { channel_id: string; items: EventFrame[]; last_event_id: string | null } => r !== null);
  const items = filtered.flatMap((it) => it.items);
  const last_event_id_per_channel: Record<string, string> = {};
  for (const it of filtered) {
    if (it.last_event_id) {
      last_event_id_per_channel[it.channel_id] = it.last_event_id;
    }
  }

  return c.json(
    {
      items,
      next_cursor: null,
      last_event_id_per_channel,
    },
    200,
    { "X-Request-Id": c.get("requestId") },
  );
}
