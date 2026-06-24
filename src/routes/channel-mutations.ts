import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { channelRouteNameFor } from "../chat/system-channel";
import { resolveUserSummaries } from "../profile/resolve";

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

export async function addMemberHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const body = (await c.req.json().catch(() => ({}))) as { user_id?: string; role?: string };
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/members-add", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: idempotencyKey, channel_id: channelId, user_id: body.user_id ?? "", role: body.role ?? "member" }),
  }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not authorized to add members");
  if (res.status === 404) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  if (res.status === 409) { const e = await res.json().catch(() => ({})) as { error?: { code?: string } }; throw new ApiError(e.error?.code ?? "CHANNEL_DISSOLVED", "conflict"); }
  if (res.status === 422) throw new ApiError("INVALID_MESSAGE", "invalid member");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "add member failed");
  return c.json(await res.json(), 200, { "X-Request-Id": c.get("requestId") });
}

export async function updateMemberRoleHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  const memberUserId = c.req.param("user_id");
  if (!channelId || !memberUserId) throw new ApiError("CHANNEL_NOT_FOUND", "channel or user not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const body = (await c.req.json().catch(() => ({}))) as { role?: string };
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/members-update-role", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: idempotencyKey, channel_id: channelId, user_id: memberUserId, role: body.role ?? "" }),
  }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "only owner may change roles");
  if (res.status === 404) throw new ApiError("MEMBER_NOT_FOUND", "member not found");
  if (res.status === 409) { const e = await res.json().catch(() => ({})) as { error?: { code?: string } }; throw new ApiError(e.error?.code ?? "CHANNEL_DISSOLVED", "conflict"); }
  if (res.status === 422) throw new ApiError("INVALID_MESSAGE", "invalid role");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "role update failed");
  return c.json(await res.json(), 200, { "X-Request-Id": c.get("requestId") });
}

export async function removeMemberHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  const memberUserId = c.req.param("user_id");
  if (!channelId || !memberUserId) throw new ApiError("CHANNEL_NOT_FOUND", "channel or user not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/members-remove", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: idempotencyKey, channel_id: channelId, user_id: memberUserId }),
  }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "only owner may remove others");
  if (res.status === 404) throw new ApiError("MEMBER_NOT_FOUND", "member not found");
  if (res.status === 409) { const e = await res.json().catch(() => ({})) as { error?: { code?: string } }; throw new ApiError(e.error?.code ?? "CHANNEL_DISSOLVED", "conflict"); }
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "remove member failed");
  return c.json(await res.json(), 200, { "X-Request-Id": c.get("requestId") });
}

export async function listMembersHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const url = new URL(c.req.url);
  const query = (url.searchParams.get("query") ?? "").toLowerCase();
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? "50")));
  const cursor = url.searchParams.get("cursor") ?? "";
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  // Push cursor + a limit+1 fetch into the DO so it can signal hasMore without a 2nd round-trip.
  const res = await stub.fetch(new Request(`https://x/internal/members-list?cursor=${encodeURIComponent(cursor)}`, { headers: { "X-Verified-User-Id": userId } }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not a member");
  if (res.status === 404 || res.status === 409) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "member list failed");
  const raw = (await res.json()) as { items: Array<{ user_id: string; role: string; joined_at: string }> };

  const map = await resolveUserSummaries(raw.items.map((m) => m.user_id), env);
  const resolved = raw.items.map((m) => {
    const u = map.get(m.user_id) ?? { user_id: m.user_id, display_name: `user-${m.user_id.slice(0, 8)}`, avatar_url: null };
    return { user: u, role: m.role, joined_at: m.joined_at };
  });
  // With NO query filter: stable cursor pagination (DO already over-fetched so we can detect hasMore).
  if (query === "") {
    const hasMore = resolved.length > limit;
    const page = resolved.slice(0, limit);
    const nextCursor = hasMore ? page[page.length - 1]?.user.user_id ?? null : null;
    return c.json({ items: page, next_cursor: nextCursor }, 200, { "X-Request-Id": c.get("requestId") });
  }
  // WITH a query filter: filter the page, no stable continuation cursor (Phase 3 member-list query
  // is a typeahead aid, not a paged search). Clients re-fetch with a refined query.
  const filtered = resolved.filter((m) => (m.user.display_name ?? "").toLowerCase().startsWith(query) || m.user.user_id.toLowerCase().startsWith(query));
  return c.json({ items: filtered.slice(0, limit), next_cursor: null }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function getMemberHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  const targetUserId = c.req.param("user_id");
  if (!channelId || !targetUserId) throw new ApiError("CHANNEL_NOT_FOUND", "channel or user not found");
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request(`https://x/internal/members-get?user_id=${encodeURIComponent(targetUserId)}`, { headers: { "X-Verified-User-Id": userId } }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not a member");
  if (res.status === 404) throw new ApiError("MEMBER_NOT_FOUND", "member not found");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "member get failed");
  const raw = (await res.json()) as { user_id: string; role: string; joined_at: string; status: string };
  const map = await resolveUserSummaries([targetUserId], env);
  const u = map.get(targetUserId) ?? { user_id: targetUserId, display_name: `user-${targetUserId.slice(0, 8)}`, avatar_url: null };
  return c.json({ user: u, role: raw.role, joined_at: raw.joined_at, status: raw.status }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function readStateHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const body = (await c.req.json().catch(() => ({}))) as { last_read_event_id?: string };
  if (!body.last_read_event_id) throw new ApiError("INVALID_MESSAGE", "last_read_event_id required");

  const dirStub = env.USER_DIRECTORY.getByName(userId);
  const rs = await dirStub.fetch(new Request("https://x/internal/read-state", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: channelId, last_read_event_id: body.last_read_event_id }),
  }));
  if (rs.status === 403) throw new ApiError("FORBIDDEN", "not an active member");
  if (!rs.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "read-state failed");
  const rsBody = (await rs.json()) as { last_read_event_id: string; advanced: boolean; emit: boolean };

  // Route the ChatChannel correctly (P1 fix): system channel → 'system-general', user channel → channel_id.
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const chStub = env.CHAT_CHANNEL.getByName(routeName);

  // Emit read_state.updated when the floor says to (advanced OR same-cursor repair). Best-effort:
  // a failure here does not roll back the floor (SoT). ChatChannel dedupes on (user, cursor).
  if (rsBody.emit) {
    await chStub.fetch(new Request("https://x/internal/read-state-event", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, last_read_event_id: rsBody.last_read_event_id }),
    })).catch(() => undefined);
  }

  // Compute unread count from the STORED floor (rsBody.last_read_event_id is always the stored floor).
  const uc = await chStub.fetch(new Request(`https://x/internal/unread-count?after=${encodeURIComponent(rsBody.last_read_event_id)}`, { headers: { "X-Verified-User-Id": userId } }));
  const unread = uc.ok ? ((await uc.json()) as { unread_count: number }).unread_count : 0;

  return c.json({ channel_id: channelId, last_read_event_id: rsBody.last_read_event_id, unread_count: unread }, 200, { "X-Request-Id": c.get("requestId") });
}
