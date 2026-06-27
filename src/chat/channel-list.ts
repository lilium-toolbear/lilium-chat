import type { Env } from "../env";
import type { ChannelSummaryApi } from "../contract/channel-api";
import { inflateChannelSummaryForViewer, type ChannelSummaryFromDo } from "./channel-summary";

export interface MyChannelIndexRow {
  channel_id: string;
  kind: string;
  last_read_event_id: string | null;
  membership_version: number;
  unread_count?: number;
}

export async function inflateMyChannelSummaries(input: {
  env: Env;
  viewerUserId: string;
  myChannels: MyChannelIndexRow[];
}): Promise<ChannelSummaryApi[]> {
  const items = await Promise.all(
    input.myChannels.map(async (mc) => {
      const stub = input.env.CHAT_CHANNEL.getByName(mc.channel_id);
      const res = await stub.fetch(
        new Request("https://x/internal/summary", {
          headers: { "X-Verified-User-Id": input.viewerUserId },
        }),
      );
      if (!res.ok) return null;
      const summary = (await res.json()) as ChannelSummaryFromDo;
      return inflateChannelSummaryForViewer({
        summary,
        viewerUserId: input.viewerUserId,
        myChannelRow: {
          last_read_event_id: mc.last_read_event_id,
          unread_count: mc.unread_count,
        },
        env: input.env,
      });
    }),
  );
  return items.filter((it): it is ChannelSummaryApi => it !== null);
}
