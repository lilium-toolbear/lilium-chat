import type { Env } from "../env";
import type { ChannelSummaryApi } from "../contract/channel-api";
import { apiErrorFromRemote } from "../errors";
import { inflateChannelSummaryForViewer } from "./channel-summary";

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
      let summary;
      try {
        summary = await stub.getSummary(input.viewerUserId);
      } catch (err) {
        const apiErr = apiErrorFromRemote(err);
        if (apiErr?.code === "FORBIDDEN" || apiErr?.code === "CHANNEL_NOT_FOUND") return null;
        throw apiErr ?? err;
      }
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
