import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError, apiErrorFromRemote } from "../errors";
import { getIdentity } from "./channel-mutations";
import { requireChannelIdParam } from "./path-params";
import type { ChatChannel } from "../do/chat-channel";

function chatChannelStub(env: Env, channelId: string): DurableObjectStub<ChatChannel> {
  return env.CHAT_CHANNEL.getByName(channelId) as DurableObjectStub<ChatChannel>;
}

export async function getStatefulSessionHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const stub = chatChannelStub(env, channelId);
  const body = await stub.getStatefulSession({ channel_id: channelId }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });
  return c.json(body, 200, { "X-Request-Id": c.get("requestId") });
}

export async function stopStatefulSessionHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey) {
    throw new ApiError("INVALID_MESSAGE", "Idempotency-Key header required");
  }
  const body = (await c.req.json().catch(() => null)) as { session_id?: unknown; reason?: unknown } | null;
  if (!body || typeof body.session_id !== "string") {
    throw new ApiError("INVALID_MESSAGE", "session_id required");
  }
  const stub = chatChannelStub(env, channelId);
  const out = await stub.stopStatefulSession({
    user_id: userId,
    channel_id: channelId,
    session_id: body.session_id,
    reason: typeof body.reason === "string" ? body.reason : "admin_stop",
    operation_id: idempotencyKey,
  }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
