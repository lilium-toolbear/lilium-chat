import type { Env } from "../env";
import type { ChannelSummaryApi } from "../contract/channel-api";
import type { ChannelMetaProjection } from "../contract/channel-api";
import { inflateChannelSummaryForViewer } from "./channel-summary";

export interface MyChannelIndexRow {
  channel_id: string;
  kind: string;
  last_read_event_id: string | null;
  membership_version: number;
  unread_count?: number;
  summary?: ChannelMetaProjection | null;
}

export async function inflateMyChannelSummaries(input: {
  env: Env;
  viewerUserId: string;
  myChannels: MyChannelIndexRow[];
}): Promise<ChannelSummaryApi[]> {
  const items = await Promise.all(
    input.myChannels.map(async (mc) => {
      if (!mc.summary) {
        return null;
      }
      return inflateChannelSummaryForViewer({
        summary: mc.summary,
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
