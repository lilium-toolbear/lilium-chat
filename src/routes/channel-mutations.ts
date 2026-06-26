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

export async function ownerTransferHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const body = (await c.req.json().catch(() => ({}))) as { target_user_id?: string; previous_owner_role?: string };
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/owner-transfer", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({
      operation_id: idempotencyKey,
      channel_id: channelId,
      target_user_id: body.target_user_id ?? "",
      previous_owner_role: body.previous_owner_role ?? "",
    }),
  }));
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: { code: "CHAT_WORKER_UNAVAILABLE", message: "owner transfer failed" } })) as {
      error?: { code?: string; message?: string };
    };
    if (res.status === 409) {
      throw new ApiError(e.error?.code ?? "IDEMPOTENCY_CONFLICT", e.error?.message ?? "idempotency conflict");
    }
    throw new ApiError(e.error?.code ?? "CHAT_WORKER_UNAVAILABLE", e.error?.message ?? "owner transfer failed");
  }
  return c.json(await res.json(), 200, { "X-Request-Id": c.get("requestId") });
}

export async function createInviteHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => ({}))) as { expires_in_seconds?: number; max_uses?: number | null };
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");

  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/invites-create", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({
      operation_id: idempotencyKey,
      channel_id: channelId,
      expires_in_seconds: body.expires_in_seconds,
      max_uses: body.max_uses,
    }),
  }));

  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: { code: "CHAT_WORKER_UNAVAILABLE", message: "create invite failed" } })) as {
      error?: { code?: string; message?: string };
    };
    const code = e.error?.code ?? "CHAT_WORKER_UNAVAILABLE";
    throw new ApiError(code, e.error?.message ?? "create invite failed");
  }

  const out = await res.json() as { invite_code: string; expires_at: string; max_uses: number | null };
  const base = new URL(c.req.url).origin;
  return c.json({
    invite_code: out.invite_code,
    invite_url: `${base}/chat/invites/${out.invite_code}`,
    expires_at: out.expires_at,
    max_uses: out.max_uses,
  }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function previewInviteHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const inviteCode = c.req.param("invite_code");
  if (!inviteCode) throw new ApiError("INVITE_NOT_FOUND", "invite not found");

  const dirStub = env.INVITE_DIRECTORY.getByName("shared");
  const dirRes = await dirStub.fetch(new Request(`https://x/preview?code=${encodeURIComponent(inviteCode)}`));
  if (dirRes.status === 404) throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  if (!dirRes.ok) {
    const e = await dirRes.json().catch(() => ({ error: { code: "CHAT_WORKER_UNAVAILABLE", message: "invite index unavailable" } })) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(e.error?.code ?? "CHAT_WORKER_UNAVAILABLE", e.error?.message ?? "invite preview failed");
  }

  const row = await dirRes.json() as {
    invite_code?: string;
    channel_id?: string;
    status?: string;
    expires_at?: string;
    revoked_at?: string | null;
  };
  if (row.invite_code !== inviteCode || row.channel_id === undefined || row.status !== "active") {
    throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  }

  const expiresAtMs = Date.parse(row.expires_at ?? "");
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() || row.revoked_at !== null) {
    throw new ApiError("INVITE_NOT_FOUND", "invite expired or revoked");
  }

  const routeName = await channelRouteNameFor(env, userId, row.channel_id);
  if (routeName === null) throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const inviteRes = await stub.fetch(new Request(
    `https://x/internal/invites-get?invite_code=${encodeURIComponent(row.invite_code)}&channel_id=${encodeURIComponent(row.channel_id)}`,
    { headers: { "X-Verified-User-Id": userId } },
  ));
  if (inviteRes.status === 404) {
    const inviteErr = await inviteRes.json().catch(() => ({ error: { code: "INVITE_NOT_FOUND", message: "invite not found" } })) as { error?: { code?: string; message?: string } };
    const code = inviteErr.error?.code;
    if (code === "ROUTE_INDEX_PENDING") throw new ApiError("ROUTE_INDEX_PENDING", inviteErr.error?.message ?? "invite index pending");
    if (code === "INVITE_NOT_FOUND") throw new ApiError("INVITE_NOT_FOUND", inviteErr.error?.message ?? "invite not found");
    throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  }
  if (inviteRes.status === 409) {
    const inviteErr = await inviteRes.json().catch(() => ({ error: { code: "ROUTE_INDEX_PENDING", message: "invite index pending" } })) as {
      error?: { code?: string; message?: string };
    };
    const code = inviteErr.error?.code ?? "ROUTE_INDEX_PENDING";
    if (code === "ROUTE_INDEX_PENDING") throw new ApiError("ROUTE_INDEX_PENDING", inviteErr.error?.message ?? "invite index pending");
    throw new ApiError(code, inviteErr.error?.message ?? "preview failed");
  }
  if (!inviteRes.ok) {
    const inviteErr = await inviteRes.json().catch(() => ({ error: { code: "CHAT_WORKER_UNAVAILABLE", message: "invite preview failed" } })) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(inviteErr.error?.code ?? "CHAT_WORKER_UNAVAILABLE", inviteErr.error?.message ?? "invite preview failed");
  }

  return c.json(await inviteRes.json(), 200, { "X-Request-Id": c.get("requestId") });
}

export async function acceptInviteHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const inviteCode = c.req.param("invite_code");
  if (!inviteCode) throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const dirStub = env.INVITE_DIRECTORY.getByName("shared");
  const dirRes = await dirStub.fetch(new Request(`https://x/preview?code=${encodeURIComponent(inviteCode)}`));
  if (dirRes.status === 404) throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  if (!dirRes.ok) {
    const dirErr = await dirRes.json().catch(() => ({ error: { code: "CHAT_WORKER_UNAVAILABLE", message: "invite directory unavailable" } })) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(dirErr.error?.code ?? "CHAT_WORKER_UNAVAILABLE", dirErr.error?.message ?? "invite directory unavailable");
  }

  const row = await dirRes.json() as { channel_id?: string; status?: string };
  if (row.channel_id === undefined || row.status !== undefined && row.status !== "active") {
    throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  }

  const routeName = await channelRouteNameFor(env, userId, row.channel_id);
  if (routeName === null) throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const inviteRes = await stub.fetch(new Request("https://x/internal/invites-accept", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({
      operation_id: idempotencyKey,
      channel_id: row.channel_id,
      invite_code: inviteCode,
    }),
  }));

  if (inviteRes.status === 409) {
    const inviteErr = await inviteRes.json().catch(() => ({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency conflict" } })) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(inviteErr.error?.code ?? "IDEMPOTENCY_CONFLICT", inviteErr.error?.message ?? "idempotency conflict");
  }
  if (inviteRes.status === 404) throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  if (inviteRes.status === 422) {
    const inviteErr = await inviteRes.json().catch(() => ({ error: { code: "INVALID_MESSAGE", message: "invite accept failed" } })) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(inviteErr.error?.code ?? "INVALID_MESSAGE", inviteErr.error?.message ?? "invite accept failed");
  }
  if (!inviteRes.ok) {
    const inviteErr = await inviteRes.json().catch(() => ({ error: { code: "CHAT_WORKER_UNAVAILABLE", message: "invite accept failed" } })) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(inviteErr.error?.code ?? "CHAT_WORKER_UNAVAILABLE", inviteErr.error?.message ?? "invite accept failed");
  }
  return c.json(await inviteRes.json(), 200, { "X-Request-Id": c.get("requestId") });
}

export async function listStickersHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const url = new URL(c.req.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? "50")));
  const cursor = url.searchParams.get("cursor") ?? "";
  const stub = env.USER_DIRECTORY.getByName(userId);
  const query = cursor
    ? `https://x/internal/sticker-list?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
    : `https://x/internal/sticker-list?limit=${limit}`;
  const res = await stub.fetch(new Request(query, { headers: { "X-Verified-User-Id": userId } }));
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: { code: "CHAT_WORKER_UNAVAILABLE", message: "sticker list failed" } })) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(e.error?.code ?? "CHAT_WORKER_UNAVAILABLE", e.error?.message ?? "sticker list failed");
  }
  return c.json(await res.json(), 200, { "X-Request-Id": c.get("requestId") });
}

export async function saveStickerHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const body = (await c.req.json().catch(() => ({}))) as { channel_id?: string; attachment_id?: string };
  if (!body.channel_id || !body.attachment_id) {
    throw new ApiError("INVALID_MESSAGE", "channel_id and attachment_id required");
  }
  const stub = env.USER_DIRECTORY.getByName(userId);
  const res = await stub.fetch(new Request("https://x/internal/sticker-save", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({
      operation_id: idempotencyKey,
      channel_id: body.channel_id,
      attachment_id: body.attachment_id,
    }),
  }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not authorized to save sticker");
  if (res.status === 404) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(e.error?.code ?? "STICKER_NOT_FOUND", e.error?.message ?? "sticker source not found");
  }
  if (res.status === 409) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(e.error?.code ?? "IDEMPOTENCY_CONFLICT", e.error?.message ?? "idempotency conflict");
  }
  if (res.status === 422) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(e.error?.code ?? "INVALID_MESSAGE", e.error?.message ?? "invalid sticker save");
  }
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "sticker save failed");
  return c.json(await res.json(), 200, { "X-Request-Id": c.get("requestId") });
}

export async function deleteStickerHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const stickerId = c.req.param("sticker_id");
  if (!stickerId) throw new ApiError("STICKER_NOT_FOUND", "sticker not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const stub = env.USER_DIRECTORY.getByName(userId);
  const res = await stub.fetch(new Request("https://x/internal/sticker-delete", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ sticker_id: stickerId, operation_id: idempotencyKey }),
  }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not authorized to delete sticker");
  if (res.status === 409) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(e.error?.code ?? "IDEMPOTENCY_CONFLICT", e.error?.message ?? "sticker delete conflict");
  }
  if (res.status === 422) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(e.error?.code ?? "INVALID_MESSAGE", e.error?.message ?? "invalid sticker delete");
  }
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "sticker delete failed");
  return c.json(await res.json(), 200, { "X-Request-Id": c.get("requestId") });
}

export async function joinChannelHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);

  const joinRes = await stub.fetch(new Request("https://x/internal/join", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, operation_id: idempotencyKey }),
  }));

  if (joinRes.status === 403) {
    const e = await joinRes.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError("FORBIDDEN", e.error?.message ?? "channel is not publicly joinable");
  }
  if (joinRes.status === 409) {
    const e = await joinRes.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    const code = e.error?.code ?? "CHANNEL_DISSOLVED";
    if (code === "IDEMPOTENCY_CONFLICT") throw new ApiError("IDEMPOTENCY_CONFLICT", e.error?.message ?? "idempotency conflict");
    throw new ApiError(code, e.error?.message ?? "channel dissolved");
  }
  if (!joinRes.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "join failed");

  const joinBody = (await joinRes.json()) as { channel_id: string; membership_version: number; joined_at: string; role: string };

  // Re-inflate the ChannelDetail fresh (the cached idempotency result is the membership result; the
  // channel field is re-inflated per call and may differ in transient fields like title/avatar).
  const summaryRes = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }));
  if (!summaryRes.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "channel summary failed");
  const s = (await summaryRes.json()) as Record<string, unknown>;

  const channel = {
    channel_id: s.channel_id,
    kind: s.kind,
    visibility: s.visibility,
    title: s.title,
    topic: s.topic,
    avatar_url: s.avatar_url,
    member_count: s.member_count,
    role: s.my_role,
    status: s.status,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
  const membership = { role: joinBody.role, joined_at: joinBody.joined_at };
  return c.json({ channel, membership }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function listPublicDirectoryHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const q = c.req.query("q") ?? "";
  const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
  const limit = Number.isNaN(rawLimit) ? 50 : Math.max(1, Math.min(100, rawLimit));
  const cursor = c.req.query("cursor") ?? null;

  const dirStub = env.CHANNEL_DIRECTORY.getByName("shared");
  const listUrl = `https://x/internal/list?q=${encodeURIComponent(q)}&limit=${limit}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
  const dirRes = await dirStub.fetch(new Request(listUrl));
  if (!dirRes.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "directory list failed");
  const dirBody = (await dirRes.json()) as { items: { channel_id: string; title: string; avatar_url: string | null; member_count: number; last_message_at: string | null; status: string }[]; next_cursor: string | null };

  // Step 1: caller's active-membership set + last_read_event_id from UserDirectory/my-channels (one call).
  const udStub = env.USER_DIRECTORY.getByName(userId);
  const udRes = await udStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
  if (!udRes.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "my-channels failed");
  const udBody = (await udRes.json()) as { items: { channel_id: string; last_read_event_id: string | null }[] };
  const activeChannelIds = new Set(udBody.items.map((i) => i.channel_id));
  const lastReadByChannel = new Map<string, string | null>();
  for (const i of udBody.items) lastReadByChannel.set(i.channel_id, i.last_read_event_id);

  // Step 2: for each directory row the caller is an active member of, fetch role from
  // ChatChannel/internal/summary.my_role (NOT .role). Run concurrently.
  const joinedRows = dirBody.items.filter((i) => activeChannelIds.has(i.channel_id));
  const roleEntries = await Promise.all(
    joinedRows.map(async (row) => {
      try {
        const chStub = env.CHAT_CHANNEL.getByName(row.channel_id);
        const sRes = await chStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }));
        if (!sRes.ok) return [row.channel_id, null] as const;
        const s = (await sRes.json()) as { my_role?: string | null };
        return [row.channel_id, s.my_role ?? null] as const;
      } catch {
        return [row.channel_id, null] as const;
      }
    }),
  );
  const roleByChannel = new Map<string, string | null>(roleEntries);

  const items = dirBody.items.map((row) => ({
    channel_id: row.channel_id,
    kind: "channel",
    visibility: "public_listed",
    title: row.title,
    avatar_url: row.avatar_url,
    member_count: row.member_count,
    role: roleByChannel.get(row.channel_id) ?? null,
    status: row.status,
    unread_count: 0,
    last_read_event_id: lastReadByChannel.get(row.channel_id) ?? null,
    last_message_preview: null,
    last_message_at: row.last_message_at,
  }));
  return c.json({ items, next_cursor: dirBody.next_cursor }, 200, { "X-Request-Id": c.get("requestId") });
}
