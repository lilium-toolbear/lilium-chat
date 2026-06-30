import type { Context } from "hono";
import type { BotAppSummary, BotTokenCreated } from "../contract/bot-api";
import { ApiError } from "../errors";
import { getIdentity, requireIdempotencyKey } from "./auth";
import { botRegistryStub } from "../auth/bot";

async function getOwnedBot(env: Env, userId: string, botId: string): Promise<BotAppSummary> {
  const { bot } = await botRegistryStub(env).getBot(botId);
  if (bot.owner_user_id !== userId) throw new ApiError("FORBIDDEN", "bot access denied");
  if (bot.status === "deleted") throw new ApiError("BOT_NOT_FOUND", "bot not found");
  return bot;
}

export async function createBotHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, isAdmin, env } = await getIdentity(c);
  requireIdempotencyKey(c);
  const body = (await c.req.json().catch(() => null)) as {
    display_name?: string;
    avatar_url?: string | null;
    description?: string | null;
    visibility?: "private" | "unlisted" | "public" | "official";
    issue_initial_token?: boolean;
    initial_token_name?: string;
  } | null;
  if (!body || typeof body.display_name !== "string" || body.display_name.trim().length === 0) {
    throw new ApiError("INVALID_MESSAGE", "display_name required");
  }
  if (body.visibility === "official" && !isAdmin) {
    throw new ApiError("ADMIN_ACCESS_REQUIRED", "Admin access required to set visibility to official");
  }
  const out = await botRegistryStub(env).createBot({
    owner_user_id: userId,
    display_name: body.display_name,
    avatar_url: body.avatar_url ?? null,
    description: body.description ?? null,
    visibility: body.visibility ?? "private",
    issue_initial_token: body.issue_initial_token ?? true,
    initial_token_name: body.initial_token_name ?? "default",
  });
  return c.json(out, 201, { "X-Request-Id": c.get("requestId") });
}

export async function listBotsHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const limit = c.req.query("limit");
  const cursor = c.req.query("cursor");
  const out = await botRegistryStub(env).listBotsForOwner({ owner_user_id: userId, limit, cursor });
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function getBotHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const botId = c.req.param("bot_id");
  if (!botId) throw new ApiError("BOT_NOT_FOUND", "bot_id required");
  const bot = await getOwnedBot(env, userId, botId);
  return c.json({ bot }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function updateBotHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, isAdmin, env } = await getIdentity(c);
  requireIdempotencyKey(c);
  const botId = c.req.param("bot_id");
  if (!botId) throw new ApiError("BOT_NOT_FOUND", "bot_id required");
  await getOwnedBot(env, userId, botId);

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
  if (body.visibility === "official" && !isAdmin) {
    throw new ApiError("ADMIN_ACCESS_REQUIRED", "Admin access required to set visibility to official");
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

export async function listBotTokensHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const botId = c.req.param("bot_id");
  if (!botId) throw new ApiError("BOT_NOT_FOUND", "bot_id required");
  await getOwnedBot(env, userId, botId);
  const out = await botRegistryStub(env).listBotTokens(botId);
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function createBotTokenHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  requireIdempotencyKey(c);
  const botId = c.req.param("bot_id");
  if (!botId) throw new ApiError("BOT_NOT_FOUND", "bot_id required");
  await getOwnedBot(env, userId, botId);

  const body = (await c.req.json().catch(() => null)) as {
    name?: string;
    scopes?: string[];
    expires_at?: string | null;
  } | null;
  if (!body || typeof body.name !== "string" || body.name.trim().length === 0) {
    throw new ApiError("INVALID_MESSAGE", "token name required");
  }
  const out = await botRegistryStub(env).createBotToken({
    bot_id: botId,
    name: body.name,
    scopes: body.scopes,
    expires_at: body.expires_at ?? null,
  });
  return c.json(out, 201, { "X-Request-Id": c.get("requestId") });
}

export async function revokeBotTokenHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  requireIdempotencyKey(c);
  const botId = c.req.param("bot_id");
  const tokenId = c.req.param("token_id");
  if (!botId) throw new ApiError("BOT_NOT_FOUND", "bot_id required");
  if (!tokenId) throw new ApiError("BOT_TOKEN_INVALID", "token_id required");
  await getOwnedBot(env, userId, botId);
  const out = await botRegistryStub(env).revokeBotToken({ bot_id: botId, token_id: tokenId });
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
