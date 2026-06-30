import type { Context } from "hono";
import type { BotCommandsSyncResponse } from "../contract/bot-api";
import type { Env } from "../env";
import { ApiError, apiErrorFromRemote } from "../errors";
import { botRegistryStub, getBotIdentity } from "../auth/bot";

/** PUT /api/chat/bot/commands — sync the bot's global command catalog. */
export async function putBotCommandsHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { botId, env } = await getBotIdentity(c, "chat:commands:manage");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_COMMAND_OPTIONS", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => null)) as {
    commands?: unknown;
  } | null;
  if (!body || !Array.isArray(body.commands)) {
    throw new ApiError("INVALID_COMMAND_OPTIONS", "commands array required");
  }

  try {
    const out = await botRegistryStub(env).syncCommands({
      bot_id: botId,
      idempotency_key: idempotencyKey,
      commands: body.commands,
    });
    return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
  } catch (err) {
    const apiErr = err instanceof ApiError ? err : apiErrorFromRemote(err);
    if (apiErr?.code === "COMMAND_NAME_CONFLICT") {
      return c.json(
        {
          error: {
            code: "COMMAND_NAME_CONFLICT",
            message: apiErr.message,
            retryable: false,
            conflict: (apiErr as ApiError & { conflict?: unknown }).conflict ?? null,
          },
          request_id: c.get("requestId"),
        },
        409,
        { "X-Request-Id": c.get("requestId") },
      );
    }
    if (apiErr) throw apiErr;
    throw err;
  }
}
