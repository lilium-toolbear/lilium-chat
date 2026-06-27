import type { ChatChannelHost } from "../host";
import { requireTestOnly } from "../../do-errors";
import { buildChannelMetaProjectionForMember } from "../../../chat/channel-meta-projection";
import { buildReplayEventsResponse } from "../../../chat/replay-projection";
import type { MessageRow } from "../../../contract/persisted";
import type { AttachmentRow as ChatAttachmentRow } from "../../../chat/attachment-projection";
import type { MessageStickerSnapshot } from "../../../chat/message-projection";
import { resolveUserSummaries } from "../../../profile/resolve";

export async function dispatchReadRoutes(host: ChatChannelHost, request: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/ping") return Response.json({ ok: true });

  if (url.pathname === "/next-event-id") {
    const count = Math.max(0, Number(url.searchParams.get("count") ?? "1"));
    const ms = Number(url.searchParams.get("ms") ?? String(Date.now()));
    const ids: string[] = [];

    await host.ctx.storage.transaction(async () => {
      for (let i = 0; i < count; i++) {
        ids.push(host.nextEventId(ms));
      }
    });
    return Response.json({ ids });
  }

  if (url.pathname === "/internal/outbox-pending") {
    const gate = requireTestOnly(request, host.env);
    if (gate) return gate;
    const targetKind = url.searchParams.get("target_kind");
    const rows = targetKind === null
      ? host.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM projection_outbox WHERE status='pending'")
      : host.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM projection_outbox WHERE status='pending' AND target_kind=?", targetKind);
    const row = rows.toArray()[0] as { count: number | bigint } | undefined;
    const count = Number(row?.count ?? 0);
    return Response.json({ count });
  }

  if (url.pathname === "/internal/summary") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    const summary = buildChannelMetaProjectionForMember(host.ctx.storage.sql, userId);
    if (summary === null) {
      return new Response("channel not created", { status: 409 });
    }
    const meta = host.ctx.storage.sql
      .exec("SELECT visibility FROM channel_meta LIMIT 1")
      .toArray()[0] as { visibility: string } | undefined;
    if (meta?.visibility === "private" && !summary.my_role) {
      return new Response("forbidden", { status: 403 });
    }
    return Response.json(summary);
  }

  if (url.pathname === "/internal/messages") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    const rawLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 50;
    const before = url.searchParams.get("before");

    const meta = host.ctx.storage.sql.exec("SELECT channel_id, visibility FROM channel_meta LIMIT 1").toArray()[0] as
      | { channel_id: string; visibility: string }
      | undefined;
    if (meta === undefined) {
      return new Response("channel not created", { status: 409 });
    }

    const member = userId
      ? (host.ctx.storage.sql
          .exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", meta.channel_id, userId)
          .toArray()[0] as { x: number } | undefined)
      : undefined;
    if (!member && meta.visibility === "private") {
      return new Response("forbidden", { status: 403 });
    }

    const query = before === null
      ?
        "SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE channel_id=? AND status != 'deleted' ORDER BY message_id DESC LIMIT ?"
      : "SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE channel_id=? AND status != 'deleted' AND message_id < ? ORDER BY message_id DESC LIMIT ?";

    const rows = (before === null
      ? host.ctx.storage.sql.exec(query, meta.channel_id, limit + 1)
      : host.ctx.storage.sql.exec(query, meta.channel_id, before, limit + 1)
    ).toArray() as unknown as MessageRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]!.message_id : null;

    // v4.0: return raw MessageRows + the page's mentions (grouped by message_id). The Worker
    // resolves sender UserSummaries and projects via the shared projectMessageForBrowser — one
    // serializer across history / ack / event (addendum J). rowToMessage is no longer used here.
    const messageIds = page.map((r) => r.message_id);
    const mentionsByMessage: Record<string, Array<{ user_id: string; start: number; end: number }>> = {};
    const attachmentsByMessage: Record<string, ChatAttachmentRow[]> = {};
    const stickersByMessage: Record<string, MessageStickerSnapshot> = {};
    if (messageIds.length > 0) {
      const placeholders = messageIds.map(() => "?").join(",");
      const mentionRows = host.ctx.storage.sql
        .exec(`SELECT message_id, user_id, start, end_ AS end FROM mentions WHERE message_id IN (${placeholders})`, ...messageIds)
        .toArray() as Array<{ message_id: string; user_id: string; start: number; end: number }>;
      for (const mr of mentionRows) {
        (mentionsByMessage[mr.message_id] ??= []).push({ user_id: mr.user_id, start: mr.start, end: mr.end });
      }
      const attachmentRows = host.ctx.storage.sql
        .exec(
          `SELECT ma.message_id, a.attachment_id, a.owner_user_id, a.kind, a.filename, a.mime_type, a.size_bytes, a.width, a.height, a.blurhash, a.storage_key, a.url, a.status, a.created_at
           FROM message_attachments ma
           JOIN attachments a ON a.attachment_id = ma.attachment_id
           WHERE ma.message_id IN (${placeholders})`,
          ...messageIds,
        )
        .toArray() as unknown as Array<ChatAttachmentRow & { message_id: string }>;
      for (const ar of attachmentRows) {
        const { message_id, ...row } = ar;
        (attachmentsByMessage[message_id] ??= []).push(row);
      }
      const stickerRows = host.ctx.storage.sql
        .exec(
          `SELECT message_id, sticker_id, attachment_id, url, mime_type, width, height, size_bytes, blurhash FROM message_stickers WHERE message_id IN (${placeholders})`,
          ...messageIds,
        )
        .toArray() as unknown as Array<MessageStickerSnapshot & { message_id: string }>;
      for (const sr of stickerRows) {
        const { message_id, ...snapshot } = sr;
        stickersByMessage[message_id] = snapshot;
      }
    }

    return Response.json({
      items: page,
      mentions: mentionsByMessage,
      attachments: attachmentsByMessage,
      stickers: stickersByMessage,
      next_cursor: nextCursor,
    });
  }

  if (url.pathname === "/internal/replay") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    const after = url.searchParams.get("after") ?? "";
    return buildReplayEventsResponse({
      sql: host.ctx.storage.sql,
      env: host.env,
      userId,
      after,
    });
  }

  if (url.pathname === "/internal/resolve-visible-attachment") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const attachmentId = url.searchParams.get("attachment_id") ?? "";
    if (!attachmentId) {
      return Response.json(
        { error: { code: "INVALID_MESSAGE", message: "attachment_id required", retryable: false } },
        { status: 422 },
      );
    }

    const meta = host.ctx.storage.sql
      .exec("SELECT channel_id, visibility FROM channel_meta LIMIT 1")
      .toArray()[0] as { channel_id: string; visibility: string } | undefined;
    if (!meta) {
      return Response.json(
        { error: { code: "CHANNEL_NOT_FOUND", message: "channel not created", retryable: false } },
        { status: 404 },
      );
    }

    const member = host.ctx.storage.sql
      .exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", meta.channel_id, userId)
      .toArray()[0] as { x: number } | undefined;
    if (!member) {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "not a member", retryable: false } },
        { status: 403 },
      );
    }

    // A sticker save source can be either (a) a channel-visible image message attachment
    // (attachments JOIN message_attachments JOIN messages) or (b) a channel-visible sticker
    // message (message_stickers JOIN messages). Contract §8.3: both are valid save sources.
    type SourceRow = {
      attachment_id: string;
      url: string;
      mime_type: string;
      width: number | null;
      height: number | null;
      size_bytes: number;
      blurhash: string | null;
      status: string;
      type: string;
    };
    const imageRows = host.ctx.storage.sql
      .exec(
        `SELECT a.attachment_id, a.url, a.mime_type, a.width, a.height, a.size_bytes, a.blurhash, m.status, m.type
         FROM attachments a
         JOIN message_attachments ma ON a.attachment_id = ma.attachment_id
         JOIN messages m ON m.message_id = ma.message_id
         WHERE a.attachment_id=? AND m.channel_id=?`,
        attachmentId,
        meta.channel_id,
      )
      .toArray() as unknown as SourceRow[];
    const stickerRows = host.ctx.storage.sql
      .exec(
        `SELECT ms.attachment_id, ms.url, ms.mime_type, ms.width, ms.height, ms.size_bytes, ms.blurhash, m.status, m.type
         FROM message_stickers ms
         JOIN messages m ON m.message_id = ms.message_id
         WHERE ms.attachment_id=? AND m.channel_id=?`,
        attachmentId,
        meta.channel_id,
      )
      .toArray() as unknown as SourceRow[];
    const rows = [...imageRows, ...stickerRows];

    const visibleRow = rows.find(
      (r) => (r.status === "normal" || r.status === "edited") && (r.type === "image" || r.type === "sticker"),
    );
    if (!visibleRow) {
      // No visible image/sticker message carries this attachment in this channel.
      return Response.json(
        { error: { code: "INVALID_STICKER_SOURCE", message: "attachment is not a visible image or sticker", retryable: false } },
        { status: 422 },
      );
    }

    return Response.json({
      attachment: {
        attachment_id: visibleRow.attachment_id,
        url: visibleRow.url,
        mime_type: visibleRow.mime_type,
        width: visibleRow.width,
        height: visibleRow.height,
        size_bytes: visibleRow.size_bytes,
        blurhash: visibleRow.blurhash,
      },
    });
  }

  if (url.pathname === "/internal/members-list") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    const realMeta = host.ctx.storage.sql.exec("SELECT channel_id, status FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string; status: string } | undefined;
    if (!realMeta) return new Response("channel not created", { status: 409 });
    // Must be an ACTIVE member (even dissolved channels require it — no leaking member lists to ex-members).
    const activeMember = userId ? (host.ctx.storage.sql.exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", realMeta.channel_id, userId).toArray()[0] as { x: number } | undefined) : undefined;
    if (!activeMember) return new Response("forbidden", { status: 403 });
    // Cursor is the last user_id of the previous page; members-list pages by joined_at ASC (tiebreak user_id).
    const cursorUserId = url.searchParams.get("cursor") ?? "";
    const rows = host.ctx.storage.sql.exec(
      "SELECT user_id, role, joined_at FROM members WHERE channel_id=? AND left_at IS NULL AND user_id > ? ORDER BY user_id ASC LIMIT 101",
      realMeta.channel_id, cursorUserId,
    ).toArray() as Array<{ user_id: string; role: string; joined_at: string }>;
    // Return raw active members (the Worker resolves UserSummaries + applies the query filter).
    return Response.json({ items: rows.map((r) => ({ user_id: r.user_id, role: r.role, joined_at: r.joined_at })) });
  }

  if (url.pathname === "/internal/members-get") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    const targetUserId = url.searchParams.get("user_id") ?? "";
    const realMeta = host.ctx.storage.sql.exec("SELECT channel_id, status FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string; status: string } | undefined;
    if (!realMeta) return new Response("channel not created", { status: 409 });
    // Must be an ACTIVE member (P1-3): no member read for non-members, dissolved or not.
    const activeMember = userId ? (host.ctx.storage.sql.exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", realMeta.channel_id, userId).toArray()[0] as { x: number } | undefined) : undefined;
    if (!activeMember) return new Response("forbidden", { status: 403 });

    const row = host.ctx.storage.sql.exec("SELECT role, joined_at, left_at FROM members WHERE channel_id=? AND user_id=?", realMeta.channel_id, targetUserId).toArray()[0] as
      | { role: string; joined_at: string; left_at: string | null }
      | undefined;
    if (!row) return Response.json({ error: { code: "MEMBER_NOT_FOUND", message: "user is not a member of this channel", retryable: false } }, { status: 404 });
    const status = row.left_at === null ? "active" : "left";
    return Response.json({ user_id: targetUserId, role: row.role, joined_at: row.joined_at, status });
  }

  if (url.pathname === "/internal/unread-count") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    const after = url.searchParams.get("after") ?? "";
    const realMeta = host.ctx.storage.sql.exec("SELECT channel_id FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string } | undefined;
    if (!realMeta) return Response.json({ unread_count: 0 });
    // Count message.created events after the cursor that were not authored by this user.
    const rows = host.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS c FROM events WHERE channel_id=? AND event_id > ? AND event_type='message.created'",
      realMeta.channel_id, after,
    ).toArray()[0] as { c: number | bigint };
    // Subtract the user's own messages: count their messages after the cursor.
    const own = host.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS c FROM events WHERE channel_id=? AND event_id > ? AND event_type='message.created' AND actor_id=?",
      realMeta.channel_id, after, userId,
    ).toArray()[0] as { c: number | bigint };
    const total = Number(rows.c ?? 0);
    const ownCount = Number(own.c ?? 0);
    return Response.json({ unread_count: Math.max(0, total - ownCount) });
  }

  if (url.pathname === "/internal/invites-get") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    const inviteCode = url.searchParams.get("invite_code") ?? "";
    const channelId = url.searchParams.get("channel_id") ?? "";
    if (!inviteCode || !channelId) {
      return Response.json({ error: { code: "INVITE_NOT_FOUND", message: "invite not found", retryable: false } }, { status: 404 });
    }

    const invite = host.ctx.storage.sql
      .exec(
        "SELECT invite_code, created_by, expires_at, max_uses, revoked_at FROM invites WHERE invite_code=?",
        inviteCode,
      )
      .toArray()[0] as
      | {
          invite_code: string;
          created_by: string;
          expires_at: string;
          max_uses: number | null;
          revoked_at: string | null;
        }
      | undefined;
    if (invite === undefined) {
      return Response.json({ error: { code: "INVITE_NOT_FOUND", message: "invite not found", retryable: false } }, { status: 404 });
    }

    const nowMs = Date.now();
    const expiresAtMs = Date.parse(invite.expires_at);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || invite.revoked_at !== null) {
      return Response.json({ error: { code: "INVITE_NOT_FOUND", message: "invite not found", retryable: false } }, { status: 404 });
    }

    const meta = host.ctx.storage.sql
      .exec(
        "SELECT channel_id, kind, visibility, title, avatar_url, member_count, status FROM channel_meta WHERE channel_id=?",
        channelId,
      )
      .toArray()[0] as
      | { channel_id: string; kind: string; visibility: string; title: string; avatar_url: string | null; member_count: number; status: string }
      | undefined;
    if (meta === undefined) {
      return Response.json({ error: { code: "INVITE_NOT_FOUND", message: "invite not found", retryable: false } }, { status: 404 });
    }

    const inviterUserId = url.searchParams.get("inviter_user_id") ?? invite.created_by;
    const sampleRows = host.ctx.storage.sql
      .exec("SELECT user_id FROM members WHERE channel_id=? AND left_at IS NULL ORDER BY user_id ASC LIMIT 3", channelId)
      .toArray() as Array<{ user_id: string }>;
    const userIds = Array.from(new Set([inviterUserId, ...sampleRows.map((row) => row.user_id)]));

    const memberRow = host.ctx.storage.sql
      .exec("SELECT left_at FROM members WHERE channel_id=? AND user_id=?", meta.channel_id, userId)
      .toArray()[0] as { left_at: string | null } | undefined;
    const membershipStatus = memberRow === undefined
      ? "not_joined"
      : memberRow.left_at === null
        ? "active"
        : "left";

    const resolvedMembers = await resolveUserSummaries(userIds, host.env);
    const inviterSummary = resolvedMembers.get(inviterUserId) ?? {
      user_id: inviterUserId,
      display_name: `user-${inviterUserId.slice(0, 8)}`,
      avatar_url: null,
    };
    const sampleMembers = sampleRows.map((sampleRow) => {
      const summary = resolvedMembers.get(sampleRow.user_id) ?? {
        user_id: sampleRow.user_id,
        display_name: `user-${sampleRow.user_id.slice(0, 8)}`,
        avatar_url: null,
      };
      return {
        user_id: summary.user_id,
        display_name: summary.display_name,
        avatar_url: summary.avatar_url,
      };
    });

    return Response.json({
      invite: {
        invite_code: invite.invite_code,
        expires_at: invite.expires_at,
        max_uses: invite.max_uses,
      },
      channel: {
        channel_id: meta.channel_id,
        kind: meta.kind,
        visibility: meta.visibility,
        title: meta.title,
        avatar_url: meta.avatar_url,
        member_count: meta.member_count,
        status: meta.status === "dissolved" ? "dissolved" : meta.status,
      },
      inviter: {
        user_id: inviterSummary.user_id,
        display_name: inviterSummary.display_name,
        avatar_url: inviterSummary.avatar_url,
      },
      sample_members: sampleMembers,
      my_membership: {
        status: membershipStatus,
        channel_id: membershipStatus === "active" ? meta.channel_id : null,
      },
    });
  }

  return null;
}
