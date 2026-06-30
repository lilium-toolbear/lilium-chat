import { projectMessageForBrowser } from "./message-projection";
import type { Env } from "../env";
import type { MessageRow } from "../contract/persisted";
import type { WireChatMessage } from "../contract/message";
import { buildWireStreamEventFrame } from "../contract/wire-frames";
import type { WireStreamEventFrame } from "../contract/bot-stream";

export function buildStreamStartedFrame(input: {
  channelId: string;
  messageRow: MessageRow;
  components: WireChatMessage["components"];
  occurredAt: string;
}): WireStreamEventFrame<"message.stream_started"> {
  const liveMessage = projectMessageForBrowser(input.messageRow, { components: input.components });
  return buildWireStreamEventFrame({
    type: "message.stream_started",
    channel_id: input.channelId,
    payload: { channel_id: input.channelId, message: liveMessage },
    occurred_at: input.occurredAt,
  });
}

export function buildStreamAbandonCleanupFrame(input: {
  channelId: string;
  messageId: string;
  occurredAt: string;
}): WireStreamEventFrame<"message.stream_abandon_cleanup"> {
  return buildWireStreamEventFrame({
    type: "message.stream_abandon_cleanup",
    channel_id: input.channelId,
    payload: { channel_id: input.channelId, message_id: input.messageId },
    occurred_at: input.occurredAt,
  });
}

export async function deliverLiveStreamFrame(
  env: Env,
  input: {
    channel_id: string;
    frame: WireStreamEventFrame;
  },
): Promise<void> {
  const fanout = env.CHANNEL_FANOUT.getByName(input.channel_id);
  await fanout.fanoutDeliverStreamFrame({
    channel_id: input.channel_id,
    frame: input.frame,
  });
}
