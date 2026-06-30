import type { Context } from "hono";
import type { Env } from "../env";
import { botStreamConnectionStub, verifyBotStreamConnectScopes, verifyBotToken } from "../auth/bot";
import { BOT_STREAM_API_VERSION } from "../contract/bot-stream";
import { ApiError, errorResponse } from "../errors";

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

  const checkRes = await c.env.CHAT_CHANNEL.getByName(channelId).fetch(
    new Request("https://x/internal/stream-registry-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: channelId, message_id: messageId, bot_id: botId }),
    }),
  );

  if (!checkRes.ok) {
    let code = "CHAT_WORKER_UNAVAILABLE";
    let message = "stream registry check failed";
    try {
      const body = (await checkRes.json()) as { error?: { code?: string; message?: string } };
      if (typeof body.error?.code === "string") code = body.error.code;
      if (typeof body.error?.message === "string") message = body.error.message;
    } catch {
      // use defaults
    }
    return errorResponse(new ApiError(code, message), requestId);
  }

  const checkBody = (await checkRes.json()) as { expires_at?: string };
  const expiresAt = typeof checkBody.expires_at === "string" ? checkBody.expires_at : "";

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
