import type { Context } from "hono";
import type { Env } from "../env";

/** Placeholder for Task 6 Stream WS upgrade at §9.15.1. */
export function botStreamWsPlaceholderHandler(
  _c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Response {
  return new Response("Bot stream WebSocket upgrade is not available yet", { status: 501 });
}
