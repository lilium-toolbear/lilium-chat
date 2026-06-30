import type { Context } from "hono";
import type { Env } from "../env";
import { botStreamConnectionStub, verifyBotStreamConnectScopes, verifyBotToken } from "../auth/bot";
import { BOT_STREAM_API_VERSION } from "../contract/bot-stream";
import { ApiError, apiErrorFromRemote, errorResponse } from "../errors";

/** GET /api/chat/bot/channels/:channel_id/streams/:message_id/ws — stream WS upgrade. */
export async function botStreamWsUpgradeHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const requestId = (c.get("requestId") as string | undefined) ?? `req_${crypto.randomUUID()}`;
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    return errorResponse(new ApiError("UNAUTHORIZED", "Not authenticated"), requestId);
  }

  let botId: string;
  let scopes: string[];
  try {
    ({ bot_id: botId, scopes } = await verifyBotToken(c.env, token));
  } catch (err) {
    if (err instanceof ApiError) {
      return errorResponse(err, requestId);
    }
    return errorResponse(new ApiError("UNAUTHORIZED", "Invalid bot token"), requestId);
  }

  try {
    verifyBotStreamConnectScopes(scopes);
  } catch (err) {
    if (err instanceof ApiError) {
      return errorResponse(err, requestId);
    }
    return errorResponse(new ApiError("BOT_SCOPE_DENIED", "Missing required bot scopes"), requestId);
  }

  const channelId = c.req.param("channel_id");
  const messageId = c.req.param("message_id");
  if (!channelId || !messageId) {
    return errorResponse(new ApiError("BOT_STREAM_NOT_FOUND", "stream registry not found"), requestId);
  }

  const checkRes = await c.env.CHAT_CHANNEL.getByName(channelId).streamRegistryCheck({
    channel_id: channelId,
    message_id: messageId,
    bot_id: botId,
  }).catch((err: unknown) => {
    const apiErr = err instanceof ApiError ? err : apiErrorFromRemote(err);
    if (apiErr) return apiErr;
    return new ApiError("CHAT_WORKER_UNAVAILABLE", "stream registry check failed");
  });

  if (checkRes instanceof ApiError) {
    return errorResponse(checkRes, requestId);
  }

  const expiresAt = typeof checkRes.expires_at === "string" ? checkRes.expires_at : "";

  const upstream = new Request(c.req.raw, c.req.raw);
  upstream.headers.set("Sec-WebSocket-Protocol", BOT_STREAM_API_VERSION);
  upstream.headers.set("Upgrade", "websocket");
  upstream.headers.set("X-Verified-Bot-Id", botId);
  upstream.headers.set("X-Channel-Id", channelId);
  upstream.headers.set("X-Message-Id", messageId);
  if (expiresAt) {
    upstream.headers.set("X-Stream-Expires-At", expiresAt);
  }

  return botStreamConnectionStub(c.env, channelId, messageId).fetch(upstream);
}
