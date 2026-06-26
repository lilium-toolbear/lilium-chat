import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { botRegistryStub, getBotIdentity } from "../auth/bot";

// Bot-token HTTP routes. These are bot -> Chat outbound HTTP (bot manages its
// catalog, bot sends messages proactively). They do NOT require the bot to
// expose an inbound HTTP endpoint — runtime delivery is the Bot Gateway WS.

/** PUT /api/chat/bot/commands — sync the bot's global command catalog + event capabilities. */
export async function putBotCommandsHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { botId, env } = await getBotIdentity(c, "chat:commands:manage");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_COMMAND_OPTIONS", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => null)) as {
    commands?: unknown;
    event_capabilities?: unknown;
  } | null;
  if (!body || !Array.isArray(body.commands)) {
    throw new ApiError("INVALID_COMMAND_OPTIONS", "commands array required");
  }

  const res = await botRegistryStub(env).fetch(
    new Request("https://x/internal/commands-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bot_id: botId,
        idempotency_key: idempotencyKey,
        commands: body.commands,
        event_capabilities: body.event_capabilities ?? [],
      }),
    }),
  );

  if (res.status === 422) {
    const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ApiError("INVALID_COMMAND_OPTIONS", e.error?.message ?? "invalid commands");
  }
  if (res.status === 409) {
    throw new ApiError("IDEMPOTENCY_CONFLICT", "idempotency key reused with different body");
  }
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "commands sync failed");

  const out = (await res.json()) as Record<string, unknown>;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}