import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { getIdentity } from "./channel-mutations";

function chatChannelStub(env: Env, channelId: string): DurableObjectStub {
  return env.CHAT_CHANNEL.getByName(channelId);
}

export async function getStatefulSessionHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = chatChannelStub(env, channelId);
  const res = await stub.fetch(
    new Request(`https://x/internal/stateful-session?channel_id=${encodeURIComponent(channelId)}`, {
      headers: { "X-Verified-User-Id": userId },
    }),
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    throw new ApiError(body.error?.code ?? "CHAT_WORKER_UNAVAILABLE", body.error?.message ?? "failed to load stateful session");
  }
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json", "X-Request-Id": c.get("requestId") },
  });
}

export async function stopStatefulSessionHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey) {
    throw new ApiError("INVALID_MESSAGE", "Idempotency-Key header required");
  }
  const body = (await c.req.json().catch(() => null)) as { session_id?: unknown; reason?: unknown } | null;
  if (!body || typeof body.session_id !== "string") {
    throw new ApiError("INVALID_MESSAGE", "session_id required");
  }
  const stub = chatChannelStub(env, channelId);
  const res = await stub.fetch(
    new Request("https://x/internal/stateful-session-stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Verified-User-Id": userId,
      },
      body: JSON.stringify({
        channel_id: channelId,
        session_id: body.session_id,
        reason: typeof body.reason === "string" ? body.reason : "admin_stop",
      }),
    }),
  );
  if (!res.ok) {
    const failBody = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    throw new ApiError(failBody.error?.code ?? "CHAT_WORKER_UNAVAILABLE", failBody.error?.message ?? "failed to stop session");
  }
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json", "X-Request-Id": c.get("requestId") },
  });
}
