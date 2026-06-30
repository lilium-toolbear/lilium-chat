import type { Context } from "hono";
import type { BotAppSummary } from "../contract/bot-api";
import { ApiError } from "../errors";
import { getIdentity, requireAdmin, requireIdempotencyKey } from "./auth";
import { botRegistryStub } from "../auth/bot";

async function getAdminBot(env: Env, botId: string): Promise<BotAppSummary> {
  const { bot } = await botRegistryStub(env).getBot(botId);
  if (bot.status === "deleted") throw new ApiError("BOT_NOT_FOUND", "bot not found");
  return bot;
}

export async function listAdminBotsHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { isAdmin, env } = await getIdentity(c);
  requireAdmin(isAdmin);

  const limit = c.req.query("limit");
  const cursor = c.req.query("cursor");
  const q = c.req.query("q");
  const ownerUserId = c.req.query("owner_user_id");
  const status = c.req.query("status");
  const visibility = c.req.query("visibility");
  const out = await botRegistryStub(env).listBotsAdmin({ limit, cursor, q, owner_user_id: ownerUserId, status, visibility });
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function getAdminBotHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { isAdmin, env } = await getIdentity(c);
  requireAdmin(isAdmin);
  const botId = c.req.param("bot_id");
  if (!botId) throw new ApiError("BOT_NOT_FOUND", "bot_id required");
  const bot = await getAdminBot(env, botId);
  return c.json({ bot }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function updateAdminBotHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { isAdmin, env } = await getIdentity(c);
  requireAdmin(isAdmin);
  requireIdempotencyKey(c);
  const botId = c.req.param("bot_id");
  if (!botId) throw new ApiError("BOT_NOT_FOUND", "bot_id required");
  await getAdminBot(env, botId);

  const body = (await c.req.json().catch(() => null)) as {
    display_name?: string;
    avatar_url?: string | null;
    description?: string | null;
    visibility?: "private" | "unlisted" | "public" | "official";
    status?: "active" | "disabled" | "deleted";
  } | null;
  if (
    !body ||
    (body.display_name === undefined &&
      body.avatar_url === undefined &&
      body.description === undefined &&
      body.visibility === undefined &&
      body.status === undefined)
  ) {
    throw new ApiError("INVALID_MESSAGE", "at least one field required");
  }
  if (body.display_name !== undefined && (typeof body.display_name !== "string" || body.display_name.trim().length === 0)) {
    throw new ApiError("INVALID_MESSAGE", "display_name invalid");
  }

  const patchBody: {
    bot_id: string;
    display_name?: string;
    avatar_url?: string | null;
    description?: string | null;
    visibility?: "private" | "unlisted" | "public" | "official";
    status?: "active" | "disabled" | "deleted";
  } = { bot_id: botId };
  if (body.display_name !== undefined) patchBody.display_name = body.display_name;
  if (body.avatar_url !== undefined) patchBody.avatar_url = body.avatar_url;
  if (body.description !== undefined) patchBody.description = body.description;
  if (body.visibility !== undefined) patchBody.visibility = body.visibility;
  if (body.status !== undefined) patchBody.status = body.status;

  const out = await botRegistryStub(env).updateBot(patchBody);
  return c.json({ bot: out.bot }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function listAdminBotTokensHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { isAdmin, env } = await getIdentity(c);
  requireAdmin(isAdmin);
  const botId = c.req.param("bot_id");
  if (!botId) throw new ApiError("BOT_NOT_FOUND", "bot_id required");
  await getAdminBot(env, botId);
  const out = await botRegistryStub(env).listBotTokens(botId);
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function revokeAdminBotTokenHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { isAdmin, env } = await getIdentity(c);
  requireAdmin(isAdmin);
  requireIdempotencyKey(c);
  const botId = c.req.param("bot_id");
  const tokenId = c.req.param("token_id");
  if (!botId) throw new ApiError("BOT_NOT_FOUND", "bot_id required");
  if (!tokenId) throw new ApiError("BOT_TOKEN_INVALID", "token_id required");
  await getAdminBot(env, botId);
  const out = await botRegistryStub(env).revokeBotToken({ bot_id: botId, token_id: tokenId });
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
