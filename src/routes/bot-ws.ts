import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError, errorResponse } from "../errors";
import { BOT_GATEWAY_API_VERSION } from "../chat/bot-gateway-protocol";
import { botConnectionStub, verifyBotToken } from "../auth/bot";

/** GET /api/chat/bot/ws — bot outbound WS upgrade entrypoint. */
export async function botWsUpgradeHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const requestId = (c.get("requestId") as string | undefined) ?? `req_${crypto.randomUUID()}`;
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    return errorResponse(new ApiError("UNAUTHORIZED", "Not authenticated"), requestId);
  }

  let botId: string;
  try {
    ({ bot_id: botId } = await verifyBotToken(c.env, token));
  } catch (err) {
    if (err instanceof ApiError) {
      return errorResponse(err, requestId);
    }
    return errorResponse(new ApiError("UNAUTHORIZED", "Invalid bot token"), requestId);
  }

  const upstream = new Request(c.req.raw, c.req.raw);
  upstream.headers.set("Sec-WebSocket-Protocol", BOT_GATEWAY_API_VERSION);
  upstream.headers.set("Upgrade", "websocket");
  upstream.headers.set("X-Verified-Bot-Id", botId);

  return botConnectionStub(c.env, botId).fetch(upstream);
}
