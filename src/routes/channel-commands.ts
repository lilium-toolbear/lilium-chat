import type { Context } from "hono";
import type {
  ChannelCommandBindingPatchRequest,
  CommandBindingUpdateResponse,
  CommandManifestResponse,
} from "../contract/bot-api";
import type { Env } from "../env";
import { botRegistryStub } from "../auth/bot";
import { ApiError, apiErrorFromRemote, logSwallowedError } from "../errors";
import { getIdentity } from "./channel-mutations";
import { requireChannelIdParam } from "./path-params";
import type { ChatChannel } from "../do/chat-channel";
import type { BotRegistry } from "../do/bot-registry";

function chatChannelStub(env: Env, channelId: string): DurableObjectStub<ChatChannel> {
  return env.CHAT_CHANNEL.getByName(channelId) as DurableObjectStub<ChatChannel>;
}

function botRegistryRpc(env: Env): DurableObjectStub<BotRegistry> {
  return botRegistryStub(env) as DurableObjectStub<BotRegistry>;
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
  help_text?: string;
  bot: { bot_id: string; display_name: string; avatar_url: string | null };
  options: unknown[];
  default_member_permission: "member" | "admin" | "owner";
  execution: { mode: "stateless" | "stateful"; stateful?: unknown };
}> {
  let body: {
    bot_command_id: string;
    name: string;
    aliases: string[];
    description: string;
    help_text?: string;
    bot: { bot_id: string; display_name: string; avatar_url: string | null };
    options: unknown[];
    default_member_permission: "member" | "admin" | "owner";
    execution: { mode: "stateless" | "stateful"; stateful?: unknown };
  };
  try {
    body = await botRegistryRpc(env).getCommand(botCommandId);
  } catch (err) {
    logSwallowedError("bot_registry_get_command_failed", err, { bot_command_id: botCommandId });
    throw new ApiError("COMMAND_NOT_FOUND", "command not found");
  }
  return {
    bot_command_id: body.bot_command_id,
    name: body.name,
    aliases: body.aliases.filter((alias): alias is string => typeof alias === "string"),
    description: body.description,
    help_text: typeof body.help_text === "string" ? body.help_text : "",
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
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const botCommandId = c.req.param("bot_command_id");
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
  const out = await stub.commandBindingUpdate({
    user_id: userId,
    operation_id: idempotencyKey,
    channel_id: channelId,
    bot_command_id: botCommandId,
    status: body.status,
    permission_override: body.permission_override ?? null,
    stateful_max_ttl_seconds: body.stateful_max_ttl_seconds ?? null,
    command_snapshot: commandSnapshot,
  }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

/** GET /api/chat/channels/:channel_id/commands */
export async function listChannelCommandsHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));

  const stub = chatChannelStub(env, channelId);
  try {
    const summary = await stub.getSummary(userId);
    if (summary.kind === "dm") {
      return c.json({ version: 0, items: [] }, 200, { "X-Request-Id": c.get("requestId") });
    }
  } catch (err) {
    const apiErr = apiErrorFromRemote(err);
    if (!apiErr || (apiErr.code !== "FORBIDDEN" && apiErr.code !== "CHANNEL_NOT_FOUND")) {
      throw apiErr ?? err;
    }
  }

  const out = await stub.getChannelCommands(userId, channelId);
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
