import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";

// Phase 7 Bot Gateway WS RPC. Bot auth path is separate from Browser JWT:
// bot API uses `Authorization: Bearer <bot_token>`; the Worker hashes the
// token and asks the singleton BotRegistry to resolve it to a bot_id (token
// plaintext -> hash cannot reverse-resolve bot_id, so verification must
// happen in one place doing SELECT ... WHERE token_hash=?).

/** Singleton BotRegistry stub (token hash lookup needs one place). */
export function botRegistryStub(env: Env): DurableObjectStub {
  return env.BOT_REGISTRY.get(env.BOT_REGISTRY.idFromName("registry"));
}

/** BotConnection DO stub (by bot_id). */
export function botConnectionStub(env: Env, botId: string): DurableObjectStub {
  return env.BOT_CONNECTION.get(env.BOT_CONNECTION.idFromName(botId));
}

/** SHA-256 hex digest of the bot token plaintext. Stored as `bot_tokens.token_hash`. */
export async function hashBotToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface BotIdentity {
  bot_id: string;
  scopes: string[];
}

/**
 * Verify a bot bearer token against the singleton BotRegistry. Returns the
 * resolved bot_id + scopes, or throws UNAUTHORIZED if the token is unknown,
 * revoked, or belongs to a non-active bot.
 */
export async function verifyBotToken(env: Env, token: string): Promise<BotIdentity> {
  const tokenHash = await hashBotToken(token);
  const res = await botRegistryStub(env).fetch(
    new Request("https://x/internal/token-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_hash: tokenHash }),
    }),
  );
  if (res.status === 401) throw new ApiError("UNAUTHORIZED", "Invalid bot token");
  if (!res.ok) throw new ApiError("UNAUTHORIZED", "Invalid bot token");
  const body = (await res.json()) as { bot_id?: unknown; scopes?: unknown };
  if (typeof body.bot_id !== "string" || !Array.isArray(body.scopes)) {
    throw new ApiError("UNAUTHORIZED", "Invalid bot token");
  }
  return { bot_id: body.bot_id, scopes: body.scopes as string[] };
}

/**
 * Hono helper for bot-token HTTP routes. Extracts the bearer token, verifies
 * it, and checks the required scope. Throws UNAUTHORIZED (no/bad token) or
 * FORBIDDEN (scope mismatch).
 */
export async function getBotIdentity(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
  requiredScope: string,
): Promise<{ botId: string; scopes: string[]; env: Env }> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { bot_id, scopes } = await verifyBotToken(c.env, token);
  if (!scopes.includes(requiredScope)) {
    throw new ApiError("FORBIDDEN", `Missing scope: ${requiredScope}`);
  }
  return { botId: bot_id, scopes, env: c.env };
}