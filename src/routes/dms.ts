import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError, apiErrorFromRemote } from "../errors";
import type { OpenDmApiResponse } from "../contract/channel-api";
import { inflateChannelSummaryForViewer } from "../chat/channel-summary";
import { getIdentity } from "./channel-mutations";
import type { UserDirectory } from "../do/user-directory";
import type { ChatChannel } from "../do/chat-channel";

type OpenDmInternalResponse =
  | { kind: "cached"; response: OpenDmApiResponse }
  | { kind: "needs_inflate"; channel_id: string; joined_at: string; role: string };

export async function openDmHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => null)) as { recipient_user_id?: string } | null;
  if (!body?.recipient_user_id) throw new ApiError("INVALID_DM_TARGET", "recipient_user_id required");
  if (body.recipient_user_id === userId) throw new ApiError("INVALID_DM_TARGET", "cannot open DM with yourself");

  const dirStub = env.USER_DIRECTORY.getByName(userId) as DurableObjectStub<UserDirectory>;
  const internal = await dirStub.openDm(userId, { idempotency_key: idempotencyKey, recipient_user_id: body.recipient_user_id })
    .catch((err) => {
      throw apiErrorFromRemote(err) ?? err;
    }) as OpenDmInternalResponse;
  if (internal.kind === "cached") {
    return c.json(internal.response, 200, { "X-Request-Id": c.get("requestId") });
  }

  const channelId = internal.channel_id;
  const chStub = env.CHAT_CHANNEL.getByName(channelId) as DurableObjectStub<ChatChannel>;
  const summary = await chStub.getSummary(userId).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });

  let myChannelRow: { last_read_event_id: string | null } | null = null;
  const myChannels = await dirStub.listMyChannels(userId).catch(() => null);
  if (myChannels) {
    const items = myChannels.items;
    const row = items.find((it) => it.channel_id === channelId);
    if (row) myChannelRow = { last_read_event_id: row.last_read_event_id };
  }

  const channel = await inflateChannelSummaryForViewer({
    summary,
    viewerUserId: userId,
    myChannelRow,
    env,
  });

  const response = {
    channel,
    membership: { role: internal.role, joined_at: internal.joined_at },
  };

  await dirStub.completeOpenDm(userId, {
    idempotency_key: idempotencyKey,
    response_json: JSON.stringify(response),
  });

  return c.json(response, 200, { "X-Request-Id": c.get("requestId") });
}
