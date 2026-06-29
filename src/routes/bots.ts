import type { Context } from "hono";
import type { BotAppSummary, BotTokenCreated } from "../contract/bot-api";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { getIdentity, requireIdempotencyKey } from "./auth";

function botRegistryStub(env: Env): DurableObjectStub {
  return env.BOT_REGISTRY.get(env.BOT_REGISTRY.idFromName("registry"));
}

async function mapError(res: Response, fallbackCode: string, fallbackMessage: string): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  return new ApiError(body.error?.code ?? fallbackCode, body.error?.message ?? fallbackMessage);
}

async function getOwnedBot(env: Env, userId: string, botId: string): Promise<BotAppSummary> {
  const res = await botRegistryStub(env).fetch(
    new Request(`https://x/internal/bots-get?bot_id=${encodeURIComponent(botId)}`),
  );
  if (res.status === 404) throw new ApiError("BOT_NOT_FOUND", "bot not found");
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE", "bot lookup failed");
  const body = (await res.json()) as { bot: BotAppSummary };
  if (body.bot.owner_user_id !== userId) throw new ApiError("FORBIDDEN", "bot access denied");
  if (body.bot.status === "deleted") throw new ApiError("BOT_NOT_FOUND", "bot not found");
  return body.bot;
}

export async function createBotHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
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
  const res = await botRegistryStub(env).fetch(
    new Request("https://x/internal/bots-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner_user_id: userId,
        display_name: body.display_name,
        avatar_url: body.avatar_url ?? null,
        description: body.description ?? null,
        visibility: body.visibility ?? "private",
        issue_initial_token: body.issue_initial_token ?? true,
        initial_token_name: body.initial_token_name ?? "default",
      }),
    }),
  );
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE", "bot create failed");
  const out = (await res.json()) as { bot: BotAppSummary; initial_token?: BotTokenCreated };
  return c.json(out, 201, { "X-Request-Id": c.get("requestId") });
}

export async function listBotsHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const limit = c.req.query("limit");
  const cursor = c.req.query("cursor");
  const query = new URLSearchParams({ owner_user_id: userId });
  if (limit) query.set("limit", limit);
  if (cursor) query.set("cursor", cursor);
  const res = await botRegistryStub(env).fetch(new Request(`https://x/internal/bots-list?${query.toString()}`));
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE", "bot list failed");
  const out = (await res.json()) as { items: BotAppSummary[]; next_cursor: string | null };
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
  const { userId, env } = await getIdentity(c);
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

  const patchBody: Record<string, unknown> = { bot_id: botId };
  if (body.display_name !== undefined) patchBody.display_name = body.display_name;
  if (body.avatar_url !== undefined) patchBody.avatar_url = body.avatar_url;
  if (body.description !== undefined) patchBody.description = body.description;
  if (body.visibility !== undefined) patchBody.visibility = body.visibility;
  if (body.status !== undefined) patchBody.status = body.status;

  const res = await botRegistryStub(env).fetch(
    new Request("https://x/internal/bots-patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patchBody),
    }),
  );
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE", "bot update failed");
  const out = (await res.json()) as { bot: BotAppSummary };
  return c.json({ bot: out.bot }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function listBotTokensHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const botId = c.req.param("bot_id");
  if (!botId) throw new ApiError("BOT_NOT_FOUND", "bot_id required");
  await getOwnedBot(env, userId, botId);
  const res = await botRegistryStub(env).fetch(
    new Request(`https://x/internal/bots-tokens-list?bot_id=${encodeURIComponent(botId)}`),
  );
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE", "token list failed");
  const out = (await res.json()) as {
    items: Array<{
      token_id: string;
      name: string;
      scopes: string[];
      created_at: string;
      expires_at: string | null;
      last_used_at: string | null;
      revoked_at: string | null;
    }>;
  };
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
  const res = await botRegistryStub(env).fetch(
    new Request("https://x/internal/bots-token-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bot_id: botId,
        name: body.name,
        scopes: body.scopes,
        expires_at: body.expires_at ?? null,
      }),
    }),
  );
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE", "token create failed");
  const out = (await res.json()) as { token: BotTokenCreated };
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
  const res = await botRegistryStub(env).fetch(
    new Request("https://x/internal/bots-token-revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_id: botId, token_id: tokenId }),
    }),
  );
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE", "token revoke failed");
  const out = (await res.json()) as { token_id: string; revoked_at: string };
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
