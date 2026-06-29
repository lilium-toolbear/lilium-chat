import type { Context } from "hono";
import type {
  ChannelCommandBindingPatchRequest,
  CommandBindingUpdateResponse,
  CommandManifestResponse,
} from "../contract/bot-api";
import type { Env } from "../env";
import { botRegistryStub } from "../auth/bot";
import { ApiError } from "../errors";
import { getIdentity } from "./channel-mutations";

function chatChannelStub(env: Env, channelId: string): DurableObjectStub {
  return env.CHAT_CHANNEL.getByName(channelId);
}

async function mapError(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  const code = body.error?.code ?? fallback;
  return new ApiError(code, body.error?.message ?? fallback);
}

async function fetchCommandSnapshot(env: Env, botCommandId: string): Promise<{
  bot_command_id: string;
  name: string;
  aliases: string[];
  description: string;
  bot: { bot_id: string; display_name: string; avatar_url: string | null };
  options: unknown[];
  default_member_permission: "member" | "admin" | "owner";
  execution: { mode: "stateless" | "stateful"; stateful?: unknown };
}> {
  const res = await botRegistryStub(env).fetch(
    new Request(`https://x/internal/command-get?bot_command_id=${encodeURIComponent(botCommandId)}`),
  );
  if (res.status === 404) {
    throw new ApiError("COMMAND_NOT_FOUND", "command not found");
  }
  if (!res.ok) {
    throw new ApiError("CHAT_WORKER_UNAVAILABLE", "failed to fetch command snapshot");
  }
  const body = (await res.json()) as {
    bot_command_id?: unknown;
    name?: unknown;
    aliases?: unknown;
    description?: unknown;
    bot?: { bot_id?: unknown; display_name?: unknown; avatar_url?: unknown };
    options?: unknown;
    default_member_permission?: unknown;
    execution?: { mode?: unknown; stateful?: unknown };
  };
  if (
    typeof body.bot_command_id !== "string" ||
    typeof body.name !== "string" ||
    !Array.isArray(body.aliases) ||
    typeof body.description !== "string" ||
    !body.bot ||
    typeof body.bot.bot_id !== "string" ||
    typeof body.bot.display_name !== "string" ||
    (body.bot.avatar_url !== null && typeof body.bot.avatar_url !== "string") ||
    !Array.isArray(body.options) ||
    !body.execution ||
    (body.execution.mode !== "stateless" && body.execution.mode !== "stateful") ||
    (body.default_member_permission !== "member" &&
      body.default_member_permission !== "admin" &&
      body.default_member_permission !== "owner")
  ) {
    throw new ApiError("CHAT_WORKER_UNAVAILABLE", "invalid command snapshot from registry");
  }
  return {
    bot_command_id: body.bot_command_id,
    name: body.name,
    aliases: body.aliases.filter((alias): alias is string => typeof alias === "string"),
    description: body.description,
    bot: {
      bot_id: body.bot.bot_id,
      display_name: body.bot.display_name,
      avatar_url: body.bot.avatar_url ?? null,
    },
    options: body.options,
    default_member_permission: body.default_member_permission,
    execution: {
      mode: body.execution.mode,
      ...(body.execution.mode === "stateful" && body.execution.stateful
        ? { stateful: body.execution.stateful }
        : {}),
    },
  };
}

/** PATCH /api/chat/channels/:channel_id/commands/:bot_command_id */
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

  const body = (await c.req.json().catch(() => null)) as ChannelCommandBindingPatchRequest | null;
  if (!body || (body.status !== "allowed" && body.status !== "blocked")) {
    throw new ApiError("INVALID_MESSAGE", "status required");
  }

  const commandSnapshot = body.status === "allowed"
    ? await fetchCommandSnapshot(env, botCommandId)
    : null;

  const stub = chatChannelStub(env, channelId);
  const res = await stub.fetch(
    new Request("https://x/internal/command-binding-update", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({
        operation_id: idempotencyKey,
        channel_id: channelId,
        bot_command_id: botCommandId,
        status: body.status,
        permission_override: body.permission_override ?? null,
        stateful_max_ttl_seconds: body.stateful_max_ttl_seconds ?? null,
        command_snapshot: commandSnapshot,
      }),
    }),
  );
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE");
  const out = (await res.json()) as CommandBindingUpdateResponse;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

/** GET /api/chat/channels/:channel_id/commands */
export async function listChannelCommandsHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");

  const stub = chatChannelStub(env, channelId);
  const summaryRes = await stub.fetch(
    new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }),
  );
  if (summaryRes.ok) {
    const summary = (await summaryRes.json()) as { kind?: string };
    if (summary.kind === "dm") {
      return c.json({ version: 0, items: [] }, 200, { "X-Request-Id": c.get("requestId") });
    }
  }

  const res = await stub.fetch(
    new Request(
      `https://x/internal/channel-commands?channel_id=${encodeURIComponent(channelId)}&user_id=${encodeURIComponent(userId)}`,
      { method: "GET", headers: { "X-Verified-User-Id": userId } },
    ),
  );
  if (!res.ok) throw await mapError(res, "CHAT_WORKER_UNAVAILABLE");
  const out = (await res.json()) as CommandManifestResponse;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
