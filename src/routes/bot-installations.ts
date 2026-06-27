import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { getIdentity } from "./channel-mutations";

// Browser API routes for per-channel bot installation + command binding.
// These are channel admin (owner/admin) operations authenticated with the
// ToolBear browser JWT. Runtime bot transport (Bot Gateway WS) is separate.

function chatChannelStub(env: Env, _userId: string, channelId: string) {
  return env.CHAT_CHANNEL.getByName(channelId);
}

function mapError(res: Response, fallback: string): Promise<ApiError> {
  return res
    .json()
    .catch(() => ({}))
    .then((e) => {
      const body = e as { error?: { code?: string; message?: string } };
      const code = body.error?.code ?? fallback;
      return new ApiError(code, body.error?.message ?? fallback);
    });
}

/** POST /api/chat/channels/:channel_id/bot-installations — install a bot + create command bindings. */
export async function installBotHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const body = (await c.req.json().catch(() => null)) as {
    bot_id?: string;
    initial_command_policy?: unknown;
    initial_event_subscriptions?: unknown;
  } | null;
  if (!body || typeof body.bot_id !== "string") throw new ApiError("INVALID_MESSAGE", "bot_id required");

  const stub = await chatChannelStub(env, userId, channelId);
  const res = await stub.fetch(
    new Request("https://x/internal/bot-install", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({
        operation_id: idempotencyKey,
        channel_id: channelId,
        bot_id: body.bot_id,
        initial_command_policy: body.initial_command_policy ?? {},
        initial_event_subscriptions: body.initial_event_subscriptions ?? {},
      }),
    }),
  );
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE");
  const out = (await res.json()) as Record<string, unknown>;
  return c.json(out, 201, { "X-Request-Id": c.get("requestId") });
}

/** PATCH /api/chat/channels/:channel_id/bot-installations/:bot_id — uninstall a bot. */
export async function updateBotInstallHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  const botId = c.req.param("bot_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  if (!botId) throw new ApiError("BOT_NOT_FOUND", "bot_id required");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const body = (await c.req.json().catch(() => null)) as {
    status?: string;
    command_policy?: unknown;
  } | null;
  if (!body || typeof body.status !== "string") throw new ApiError("INVALID_MESSAGE", "status required");

  const stub = await chatChannelStub(env, userId, channelId);
  const res = await stub.fetch(
    new Request("https://x/internal/bot-install-update", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({
        operation_id: idempotencyKey,
        channel_id: channelId,
        bot_id: botId,
        status: body.status,
        command_policy: body.command_policy ?? {},
      }),
    }),
  );
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE");
  const out = (await res.json()) as Record<string, unknown>;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

/** PATCH /api/chat/channels/:channel_id/commands/:bot_command_id — enable/disable a command binding. */
export async function updateCommandBindingHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  const botCommandId = c.req.param("bot_command_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  if (!botCommandId) throw new ApiError("COMMAND_NOT_FOUND", "bot_command_id required");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const body = (await c.req.json().catch(() => null)) as {
    enabled?: boolean;
    permission_override?: string | null;
  } | null;
  if (!body || typeof body.enabled !== "boolean") throw new ApiError("INVALID_MESSAGE", "enabled required");

  const stub = await chatChannelStub(env, userId, channelId);
  const res = await stub.fetch(
    new Request("https://x/internal/command-binding-update", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({
        operation_id: idempotencyKey,
        channel_id: channelId,
        bot_command_id: botCommandId,
        enabled: body.enabled,
        permission_override: body.permission_override ?? null,
      }),
    }),
  );
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE");
  const out = (await res.json()) as Record<string, unknown>;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

/** GET /api/chat/channels/:channel_id/commands?prefix=as — query available slash commands (member-only). */
export async function listChannelCommandsHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const prefix = c.req.query("prefix") ?? "";
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const summaryRes = await stub.fetch(new Request("https://x/internal/summary", {
    headers: { "X-Verified-User-Id": userId },
  }));
  if (summaryRes.ok) {
    const summary = await summaryRes.json() as { kind?: string };
    if (summary.kind === "dm") {
      return c.json({ items: [] }, 200, { "X-Request-Id": c.get("requestId") });
    }
  }
  const res = await stub.fetch(
    new Request(
      `https://x/internal/channel-commands?channel_id=${encodeURIComponent(channelId)}&user_id=${encodeURIComponent(userId)}&prefix=${encodeURIComponent(prefix)}`,
      { method: "GET", headers: { "X-Verified-User-Id": userId } },
    ),
  );
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE");
  const out = (await res.json()) as Record<string, unknown>;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
