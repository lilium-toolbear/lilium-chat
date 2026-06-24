import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { channelRouteNameFor } from "../chat/system-channel";

export async function getIdentity(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<{ userId: string; env: Env }> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id } = await verifyBrowserJwt(token, c.env.JWT_SECRET);
  return { userId: user_id, env: c.env };
}

export async function createChannelHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => null)) as {
    title?: string; topic?: string | null; avatar_attachment_id?: string | null;
    visibility?: string; initial_members?: Array<{ user_id: string; role: string }>;
  } | null;
  if (!body || typeof body.title !== "string" || body.title.trim() === "") {
    throw new ApiError("INVALID_MESSAGE", "title is required");
  }

  const dirStub = env.USER_DIRECTORY.getByName(userId);
  const res = await dirStub.fetch(new Request("https://x/internal/channel-create-coordinate", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      title: body.title,
      topic: body.topic ?? null,
      avatar_attachment_id: body.avatar_attachment_id ?? null,
      visibility: body.visibility ?? "private",
      initial_members: body.initial_members ?? [],
    }),
  }));

  if (res.status === 409) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError("IDEMPOTENCY_CONFLICT", e.error?.message ?? "idempotency conflict");
  }
  if (res.status === 422) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError("INVALID_MESSAGE", e.error?.message ?? "invalid channel");
  }
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "channel create failed");

  const out = await res.json() as Record<string, unknown>;
  return c.json(out, 201, { "X-Request-Id": c.get("requestId") });
}

export async function updateChannelHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string; topic?: string | null; avatar_attachment_id?: string | null; visibility?: string;
  };
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/update-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      channel_id: channelId,
      title: body.title, topic: body.topic, avatar_attachment_id: body.avatar_attachment_id, visibility: body.visibility,
    }),
  }));
  if (res.status === 409) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    const code = e.error?.code ?? "IDEMPOTENCY_CONFLICT";
    throw new ApiError(code, e.error?.message ?? "conflict");
  }
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not authorized to update channel");
  if (res.status === 404) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "channel update failed");
  const out = await res.json() as Record<string, unknown>;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function dissolveChannelHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/dissolve", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: idempotencyKey, channel_id: channelId }),
  }));
  if (res.status === 409) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(e.error?.code ?? "CHANNEL_DISSOLVED", e.error?.message ?? "conflict");
  }
  if (res.status === 403) throw new ApiError("FORBIDDEN", "only owner may dissolve");
  if (res.status === 404) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "dissolve failed");
  const out = await res.json() as Record<string, unknown>;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
