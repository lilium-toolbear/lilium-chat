import type { Context } from "hono";
import type {
  AcceptInviteApiResponse,
  AddMemberApiResponse,
  ChannelMetaProjection,
  CreateChannelApiResponse,
  CreateInviteApiResponse,
  DissolveChannelApiResponse,
  InvitePreviewApiResponse,
  JoinChannelApiResponse,
  ListMembersApiResponse,
  MemberProjection,
  RemoveMemberApiResponse,
  TransferOwnerApiResponse,
  UpdateChannelApiResponse,
  UpdateMemberRoleApiResponse,
} from "../contract/channel-api";
import type { Env } from "../env";
import { ApiError, apiErrorFromRemote } from "../errors";
import { compareMemberListRows, encodeMemberListCursor } from "../chat/member-list-order";
import { fallbackUserDisplayName } from "../contract/primitives";
import { resolveUserSummaries } from "../profile/resolve";
import { getIdentity, requireIdempotencyKey } from "./auth";
import { requireChannelIdParam, requireMemberUserIdParam } from "./path-params";

export { getIdentity } from "./auth";

export async function createChannelHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const idempotencyKey = requireIdempotencyKey(c);

  const body = (await c.req.json().catch(() => null)) as {
    title?: string; topic?: string | null; avatar_attachment_id?: string | null;
    visibility?: string; initial_members?: Array<{ user_id: string; role: string }>;
  } | null;
  if (!body || typeof body.title !== "string" || body.title.trim() === "") {
    throw new ApiError("INVALID_MESSAGE", "title is required");
  }

  const dirStub = env.USER_DIRECTORY.getByName(userId);
  const out = await dirStub.channelCreateCoordinate(userId, {
    idempotency_key: idempotencyKey,
    title: body.title,
    topic: body.topic ?? null,
    avatar_attachment_id: body.avatar_attachment_id ?? null,
    visibility: body.visibility ?? "private",
    initial_members: body.initial_members ?? [],
  }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as CreateChannelApiResponse;
  return c.json(out, 201, { "X-Request-Id": c.get("requestId") });
}

export async function updateChannelHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const idempotencyKey = requireIdempotencyKey(c);

  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string; topic?: string | null; avatar_attachment_id?: string | null; visibility?: string;
  };
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const out = await stub.updateChannel({
    user_id: userId,
    idempotency_key: idempotencyKey,
    channel_id: channelId,
    title: body.title,
    topic: body.topic,
    avatar_attachment_id: body.avatar_attachment_id,
    visibility: body.visibility,
  }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as UpdateChannelApiResponse;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function dissolveChannelHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const idempotencyKey = requireIdempotencyKey(c);
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const out = await stub.dissolveChannel({ user_id: userId, idempotency_key: idempotencyKey, channel_id: channelId }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as DissolveChannelApiResponse;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function addMemberHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const idempotencyKey = requireIdempotencyKey(c);
  const body = (await c.req.json().catch(() => ({}))) as { user_id?: string; role?: string };
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const out = await stub.addMember({ user_id: userId, idempotency_key: idempotencyKey, channel_id: channelId, target_user_id: body.user_id ?? "", role: body.role ?? "member" }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as AddMemberApiResponse;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function updateMemberRoleHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const memberUserId = requireMemberUserIdParam(c.req.param("user_id"));
  const idempotencyKey = requireIdempotencyKey(c);
  const body = (await c.req.json().catch(() => ({}))) as { role?: string };
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const out = await stub.updateMemberRole({ user_id: userId, idempotency_key: idempotencyKey, channel_id: channelId, target_user_id: memberUserId, role: body.role ?? "" }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as UpdateMemberRoleApiResponse;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function removeMemberHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const memberUserId = requireMemberUserIdParam(c.req.param("user_id"));
  const idempotencyKey = requireIdempotencyKey(c);
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const out = await stub.removeMember({ user_id: userId, idempotency_key: idempotencyKey, channel_id: channelId, target_user_id: memberUserId }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as RemoveMemberApiResponse;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function listMembersHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const url = new URL(c.req.url);
  const query = (url.searchParams.get("query") ?? "").toLowerCase();
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? "50")));
  const cursor = url.searchParams.get("cursor") ?? "";
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const raw = await stub.listMembers(userId, cursor).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as ListMembersApiResponse;

  const map = await resolveUserSummaries(raw.items.map((m) => m.user_id), env);
  const resolved = raw.items.map((m) => {
    const u = map.get(m.user_id) ?? { user_id: m.user_id, display_name: fallbackUserDisplayName(m.user_id), avatar_url: null };
    return { user: u, role: m.role, joined_at: m.joined_at };
  });
  // With NO query filter: stable cursor pagination (DO already over-fetched so we can detect hasMore).
  if (query === "") {
    const hasMore = resolved.length > limit;
    const page = resolved.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? encodeMemberListCursor({ user_id: last.user.user_id, role: last.role, joined_at: last.joined_at })
      : null;
    return c.json({ items: page, next_cursor: nextCursor }, 200, { "X-Request-Id": c.get("requestId") });
  }
  // WITH a query filter: filter the page, no stable continuation cursor (Phase 3 member-list query
  // is a typeahead aid, not a paged search). Clients re-fetch with a refined query.
  const filtered = resolved
    .filter((m) => (m.user.display_name ?? "").toLowerCase().startsWith(query) || m.user.user_id.toLowerCase().startsWith(query))
    .sort((left, right) => compareMemberListRows({
      user_id: left.user.user_id,
      role: left.role,
      joined_at: left.joined_at,
    }, {
      user_id: right.user.user_id,
      role: right.role,
      joined_at: right.joined_at,
    }));
  return c.json({ items: filtered.slice(0, limit), next_cursor: null }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function getMemberHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const targetUserId = requireMemberUserIdParam(c.req.param("user_id"));
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const raw = await stub.getMember(userId, targetUserId).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as MemberProjection;
  const map = await resolveUserSummaries([targetUserId], env);
  const u = map.get(targetUserId) ?? { user_id: targetUserId, display_name: fallbackUserDisplayName(targetUserId), avatar_url: null };
  return c.json({ user: u, role: raw.role, joined_at: raw.joined_at, status: raw.status }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function ownerTransferHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const idempotencyKey = requireIdempotencyKey(c);
  const body = (await c.req.json().catch(() => ({}))) as { target_user_id?: string; previous_owner_role?: string };
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const out = await stub.transferOwner({
    user_id: userId,
    operation_id: idempotencyKey,
    channel_id: channelId,
    target_user_id: body.target_user_id ?? "",
    previous_owner_role: body.previous_owner_role ?? "",
  }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as TransferOwnerApiResponse;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function createInviteHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const idempotencyKey = requireIdempotencyKey(c);

  const body = (await c.req.json().catch(() => ({}))) as { expires_in_seconds?: number; max_uses?: number | null };
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  const out = await stub.createInvite({
    user_id: userId,
    operation_id: idempotencyKey,
    channel_id: channelId,
    expires_in_seconds: body.expires_in_seconds,
    max_uses: body.max_uses,
  }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as CreateInviteApiResponse;

  const base = env.API_BASE_URL.replace(/\/$/, "");
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
  const row = await dirStub.previewInvite(inviteCode);
  if (!row || row.invite_code !== inviteCode || row.status !== "active") {
    throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  }

  const expiresAtMs = Date.parse(row.expires_at ?? "");
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() || row.revoked_at !== null) {
    throw new ApiError("INVITE_NOT_FOUND", "invite expired or revoked");
  }

  const stub = env.CHAT_CHANNEL.getByName(row.channel_id);
  const out = await stub.getInvite({ user_id: userId, invite_code: row.invite_code, channel_id: row.channel_id }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as InvitePreviewApiResponse;

  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function acceptInviteHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const inviteCode = c.req.param("invite_code");
  if (!inviteCode) throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  const idempotencyKey = requireIdempotencyKey(c);

  const dirStub = env.INVITE_DIRECTORY.getByName("shared");
  const row = await dirStub.previewInvite(inviteCode);
  if (!row || row.status !== "active") {
    throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  }

  const stub = env.CHAT_CHANNEL.getByName(row.channel_id);
  const out = await stub.acceptInvite({
    user_id: userId,
    operation_id: idempotencyKey,
    channel_id: row.channel_id,
    invite_code: inviteCode,
  }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as AcceptInviteApiResponse;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function listStickersHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const url = new URL(c.req.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? "50")));
  const cursor = url.searchParams.get("cursor") ?? "";
  const stub = env.USER_DIRECTORY.getByName(userId);
  const body = await stub.listStickers(userId, { limit, cursor: cursor || null }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });
  return c.json(body, 200, { "X-Request-Id": c.get("requestId") });
}

export async function saveStickerHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const idempotencyKey = requireIdempotencyKey(c);
  const body = (await c.req.json().catch(() => ({}))) as { channel_id?: string; attachment_id?: string };
  if (!body.channel_id || !body.attachment_id) {
    throw new ApiError("INVALID_MESSAGE", "channel_id and attachment_id required");
  }
  const stub = env.USER_DIRECTORY.getByName(userId);
  const bodyOut = await stub.saveSticker(userId, {
    operation_id: idempotencyKey,
    channel_id: body.channel_id,
    attachment_id: body.attachment_id,
  }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });
  return c.json(bodyOut, 200, { "X-Request-Id": c.get("requestId") });
}

export async function deleteStickerHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const stickerId = c.req.param("sticker_id");
  if (!stickerId) throw new ApiError("STICKER_NOT_FOUND", "sticker not found");
  const idempotencyKey = requireIdempotencyKey(c);
  const stub = env.USER_DIRECTORY.getByName(userId);
  const body = await stub.deleteSticker(userId, { sticker_id: stickerId, operation_id: idempotencyKey }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });
  return c.json(body, 200, { "X-Request-Id": c.get("requestId") });
}

export async function joinChannelHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = requireChannelIdParam(c.req.param("channel_id"));
  const idempotencyKey = requireIdempotencyKey(c);

  const stub = env.CHAT_CHANNEL.getByName(channelId);

  const joinBody = await stub.joinChannel({ user_id: userId, operation_id: idempotencyKey }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as JoinChannelApiResponse;

  // Re-inflate the ChannelDetail fresh (the cached idempotency result is the membership result; the
  // channel field is re-inflated per call and may differ in transient fields like title/avatar).
  const s = await stub.getSummary(userId).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });

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
  const dirBody = await dirStub.listPublicChannels({ q, limit, cursor });

  // Step 1: caller's active-membership set + last_read_event_id from UserDirectory/my-channels (one call).
  const udStub = env.USER_DIRECTORY.getByName(userId);
  const udBody = await udStub.listMyChannels(userId).catch(() => {
    throw new ApiError("CHAT_WORKER_UNAVAILABLE", "my-channels failed");
  });
  const activeChannelIds = new Set(udBody.items.map((i) => i.channel_id));
  const lastReadByChannel = new Map<string, string | null>();
  for (const i of udBody.items) lastReadByChannel.set(i.channel_id, i.last_read_event_id);

  // Step 2: for each directory row the caller is an active member of, fetch role from
  // ChatChannel summary RPC my_role (NOT .role). Run concurrently.
  const joinedRows = dirBody.items.filter((i) => activeChannelIds.has(i.channel_id));
  const roleEntries = await Promise.all(
    joinedRows.map(async (row) => {
      try {
        const chStub = env.CHAT_CHANNEL.getByName(row.channel_id);
        const s = await chStub.getSummary(userId);
        return [row.channel_id, s.my_role ?? null] as const;
      } catch (err) {
        const apiErr = apiErrorFromRemote(err);
        if (apiErr?.code === "FORBIDDEN" || apiErr?.code === "CHANNEL_NOT_FOUND") {
          return [row.channel_id, null] as const;
        }
        throw apiErr ?? err;
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
