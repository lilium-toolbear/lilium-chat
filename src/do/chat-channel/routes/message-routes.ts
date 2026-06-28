import type { ChatChannelHost } from "../host";
import { uuidv7 } from "../../../ids/uuidv7";
import {
  buildEventFrame,
  buildMessageLifecyclePayload,
  type UserSummary as LiveUserSummary,
} from "../../../chat/event-broadcast";
import { projectMessageForBrowser, type MessageStickerSnapshot } from "../../../chat/message-projection";
import { projectAttachmentForBrowser, type AttachmentRow as ChatAttachmentRow } from "../../../chat/attachment-projection";
import type { MessageRow } from "../../../contract/persisted";
import type { MessageImageAttachment } from "../../../contract/message";
import { idempotencyExpiresAt } from "../../../contract/idempotency";
import type { MessageMutationAckPayload, MessageMutationIdempotencyEnvelope } from "../../../contract/idempotency";
import { resolveUserSummaries } from "../../../profile/resolve";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  replaceScopeMessageAttachmentsChange,
  replaceScopeMessageStickersChange,
  replaceScopeMentionsChange,
  rvEvent,
  upsertAttachmentsForMessageChanges,
  upsertEventChange,
  upsertMessageChange,
} from "../../../archive/chat-channel-record";

export async function dispatchMessageRoutes(host: ChatChannelHost, request: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/internal/message-send") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const b = (await request.json()) as {
      command_id: string;
      dedupe_principal_key: string;
      type: string;
      text: string;
      reply_to: string | null;
      attachment_ids: string[];
      sticker_id?: string;
      mentions: Array<{ user_id: string; start: number; end: number }>;
      channel_id: string;
    };

    const now = host.nowIso();
    const nowMs = Date.parse(now);

    const meta = host.ctx.storage.sql
      .exec("SELECT channel_id, membership_version FROM channel_meta LIMIT 1")
      .toArray()[0] as { channel_id: string; membership_version: number } | undefined;
    if (meta === undefined) {
      return new Response("channel not created", { status: 409 });
    }
    const channelId = meta.channel_id;
    const requestedChannelId = b.channel_id ?? "";
    if (requestedChannelId && requestedChannelId !== channelId) {
      return Response.json(
        { error: { code: "CHANNEL_NOT_FOUND", message: "channel_id mismatch", retryable: false } },
        { status: 404 },
      );
    }

    const member = host.ctx.storage.sql
      .exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, userId)
      .toArray()[0] as { x: number } | undefined;
    if (!member) {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "not a member", retryable: false } },
        { status: 403 },
      );
    }

    const requestHash = JSON.stringify({
      type: b.type,
      text: b.text,
      reply_to: b.reply_to,
      attachment_ids: b.attachment_ids ?? [],
      sticker_id: b.sticker_id ?? null,
      mentions: b.mentions ?? [],
    });

    const messageId = uuidv7(nowMs);
    const eventId = host.nextEventId(nowMs);
    const mv = meta.membership_version;
    const messageRowForProjection: MessageRow = {
      message_id: messageId,
      command_id: b.command_id,
      channel_id: channelId,
      sender_kind: "user",
      sender_user_id: userId,
      sender_bot_id: null,
      type: b.type,
      format: "plain",
      status: "normal",
      text: b.text,
      reply_to: b.reply_to,
      reply_snapshot_json: null,
      stream_state: "none",
      created_at: now,
      updated_at: now,
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
      recalled_at: null,
    };
    // v4.0 cheap pre-check: a duplicate retry (same operation_id + same request_hash) can return
    // the cached committed ack WITHOUT resolving the sender profile (Hyperdrive wait) or opening a
    // transaction. The transaction below STILL re-checks idempotency (handles the race where two
    // concurrent sends interleave). This is a pure latency optimization for the cached path.
    const preCheck = host.ctx.storage.sql
      .exec("SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='message.send' AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
        userId, b.command_id, requestHash)
      .toArray()[0] as { response_json: string } | undefined;
    if (preCheck) {
      const cached = JSON.parse(preCheck.response_json) as MessageMutationIdempotencyEnvelope;
      if (cached.payload && cached.payload.event_id && cached.payload.message) {
        return Response.json({
          channel_id: cached.payload.channel_id ?? channelId,
          event_id: cached.payload.event_id,
          message: cached.payload.message,
        });
      }
    }

    // v4.0 P0-2: resolve sender BEFORE the transaction (Hyperdrive is a network call). The live
    // projection built from this resolution is written INTO the transaction (response_json + the
    // channel_fanout outbox event_json), so the cached ack is stable+complete with no crash window.
    // A failed/missing resolution falls back to user-<shortid> (contract K: stale display data on
    // idempotent replay is acceptable).
    let resolvedSender: LiveUserSummary = {
      user_id: userId,
      display_name: `user-${userId.slice(0, 8)}`,
      avatar_url: null,
    };
    try {
      const raw = await resolveUserSummaries([userId], host.env);
      const normalized = raw.get(userId);
      if (normalized) {
        resolvedSender = {
          user_id: normalized.user_id,
          display_name: normalized.display_name ?? `user-${userId.slice(0, 8)}`,
          avatar_url: normalized.avatar_url,
        };
      }
    } catch {
      // fallback handled by the projection builder
    }

    // Phase 5 image messages: resolve finalized attachments from UserDirectory BEFORE the txn
    // (cross-DO fetch must not happen inside a storage transaction).
    let attachmentRows: ChatAttachmentRow[] = [];
    let attachmentProjections: MessageImageAttachment[] = [];
    if (b.type === "image") {
      const ids = Array.isArray(b.attachment_ids) ? b.attachment_ids : [];
      if (ids.length === 0) {
        return Response.json(
          { error: { code: "INVALID_MESSAGE", message: "image message requires attachment_ids", retryable: false } },
          { status: 422 },
        );
      }
      const userDir = host.env.USER_DIRECTORY.getByName(userId);
      for (const attachmentId of ids) {
        const res = await userDir.fetch(
          new Request(`https://x/internal/attachment-get?attachment_id=${encodeURIComponent(attachmentId)}`, {
            headers: { "X-Verified-User-Id": userId },
          }),
        );
        if (!res.ok) {
          return Response.json(
            { error: { code: "UNSUPPORTED_ATTACHMENT_TYPE", message: "attachment not finalized", retryable: false } },
            { status: 415 },
          );
        }
        const body = (await res.json()) as { attachment: ChatAttachmentRow };
        const row = body.attachment;
        if (!row || row.status !== "finalized" || row.owner_user_id !== userId) {
          return Response.json(
            { error: { code: "UNSUPPORTED_ATTACHMENT_TYPE", message: "attachment not available", retryable: false } },
            { status: 415 },
          );
        }
        if (row.kind !== "image") {
          return Response.json(
            { error: { code: "UNSUPPORTED_ATTACHMENT_TYPE", message: "only message image attachments can be sent in chat", retryable: false } },
            { status: 415 },
          );
        }
        attachmentRows.push(row);
        const projection = projectAttachmentForBrowser(row);
        if (projection) attachmentProjections.push(projection);
      }
    }

    let stickerSnapshot: MessageStickerSnapshot | null = null;
    if (b.type === "sticker") {
      if (!b.sticker_id) {
        return Response.json(
          { error: { code: "INVALID_MESSAGE", message: "sticker message requires sticker_id", retryable: false } },
          { status: 422 },
        );
      }
      const userDir = host.env.USER_DIRECTORY.getByName(userId);
      const stickerRes = await userDir.fetch(
        new Request(`https://x/internal/sticker-resolve?sticker_id=${encodeURIComponent(b.sticker_id)}`, {
          headers: { "X-Verified-User-Id": userId },
        }),
      );
      if (!stickerRes.ok) {
        const failBody = (await stickerRes.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
        return Response.json(
          {
            error: {
              code: failBody.error?.code ?? "STICKER_NOT_FOUND",
              message: failBody.error?.message ?? "sticker not found",
              retryable: false,
            },
          },
          { status: stickerRes.status === 404 ? 404 : 422 },
        );
      }
      stickerSnapshot = (await stickerRes.json()) as MessageStickerSnapshot;
    }

    // Build the LIVE message projection once (used by BOTH the committed-ack response_json AND
    // the channel_fanout outbox event_json — v4.0 addendum I/J: ack and event carry the same
    // Browser-visible projection from the one shared builder).
    const liveMessage = projectMessageForBrowser(messageRowForProjection, {
      senderSummary: resolvedSender,
      mentions: Array.isArray(b.mentions) ? b.mentions : [],
      attachments: attachmentProjections,
      sticker: stickerSnapshot,
    });
    const liveEventFrame = buildEventFrame({
      event_id: eventId,
      type: "message.created",
      channel_id: channelId,
      occurred_at: now,
      payload: { message: liveMessage },
    });
    const liveEventFrameJson = JSON.stringify(liveEventFrame);
    const fullAckJson = JSON.stringify({
      frame_type: "command_ack",
      command: "message.send",
      command_id: b.command_id,
      status: "committed",
      payload: { channel_id: channelId, event_id: eventId, message: liveMessage },
    });
    const persistedPayload = buildMessageLifecyclePayload({
      message_id: messageRowForProjection.message_id,
      command_id: messageRowForProjection.command_id,
      channel_id: messageRowForProjection.channel_id,
      sender_kind: messageRowForProjection.sender_kind,
      sender_user_id: messageRowForProjection.sender_user_id,
      sender_bot_id: messageRowForProjection.sender_bot_id,
      status: messageRowForProjection.status,
      created_at: messageRowForProjection.created_at,
      updated_at: messageRowForProjection.updated_at,
      edited_at: messageRowForProjection.edited_at,
      deleted_at: messageRowForProjection.deleted_at,
      deleted_by: messageRowForProjection.deleted_by,
      recalled_at: messageRowForProjection.recalled_at,
      stream_state: messageRowForProjection.stream_state,
      reply_to: messageRowForProjection.reply_to,
      reply_snapshot_json: messageRowForProjection.reply_snapshot_json,
      type: messageRowForProjection.type,
      format: messageRowForProjection.format,
      text: messageRowForProjection.text,
    });
    const payloadJson = JSON.stringify(persistedPayload);
    const idemExpiresAt = idempotencyExpiresAt(nowMs);

    type SendResult =
      | { kind: "created"; response_json: string }
      | { kind: "cached"; response_json: string }
      | { kind: "conflict" }
      | { kind: "dissolved" };

    const txResult = await host.ctx.storage.transaction(async (): Promise<SendResult> => {
      const statusRow = host.ctx.storage.sql.exec("SELECT status, visibility FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; visibility: string } | undefined;
      if (statusRow?.status === "dissolved") {
        return { kind: "dissolved" };
      }
      const idemRow = host.ctx.storage.sql
        .exec(
          "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='message.send' AND operation_id=?",
          userId,
          b.command_id,
        )
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idemRow) {
        if (idemRow.request_hash !== requestHash) {
          return { kind: "conflict" };
        }
        return { kind: "cached", response_json: idemRow.response_json ?? "" };
      }

      host.ctx.storage.sql.exec(
        `INSERT INTO messages (
            message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
            sender_bot_id, type, format, status, text, reply_to, stream_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'user', ?, NULL, ?, 'plain', 'normal', ?, ?, 'none', ?, ?)`,
        messageId,
        b.command_id,
        b.dedupe_principal_key,
        channelId,
        userId,
        b.type,
        b.text,
        b.reply_to,
        now,
        now,
      );
      if (Array.isArray(b.mentions)) {
        for (const m of b.mentions) {
          host.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO mentions (message_id, user_id, start, end_) VALUES (?, ?, ?, ?)",
            messageId,
            m.user_id,
            m.start,
            m.end,
          );
        }
      }
      // Persist image attachments (copied from UserDirectory) and link them to this message.
      for (const row of attachmentRows) {
        host.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO attachments (
              attachment_id, owner_user_id, kind, filename, mime_type, size_bytes,
              width, height, blurhash, storage_key, url, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finalized', ?)`,
          row.attachment_id,
          userId,
          row.kind,
          row.filename,
          row.mime_type,
          row.size_bytes,
          row.width,
          row.height,
          row.blurhash,
          row.storage_key,
          row.url,
          now,
        );
        host.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO message_attachments (message_id, attachment_id) VALUES (?, ?)",
          messageId,
          row.attachment_id,
        );
      }
      // Snapshot the sticker for historical stability (independent of future personal_stickers changes).
      if (stickerSnapshot) {
        host.ctx.storage.sql.exec(
          `INSERT INTO message_stickers (
            message_id, sticker_id, attachment_id, url, mime_type, width, height, size_bytes, blurhash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          messageId,
          stickerSnapshot.sticker_id,
          stickerSnapshot.attachment_id,
          stickerSnapshot.url,
          stickerSnapshot.mime_type,
          stickerSnapshot.width,
          stickerSnapshot.height,
          stickerSnapshot.size_bytes,
          stickerSnapshot.blurhash ?? null,
        );
      }
      host.ctx.storage.sql.exec(
        "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'message.created', ?, 'user', ?, ?, ?, ?)",
        eventId,
        channelId,
        userId,
        payloadJson,
        mv,
        now,
      );
      // idempotency_keys.response_json stores the FULL committed ack payload (v4.0 addendum K),
      // written co-atomically with the business rows — no crash window. The cached branch returns
      // this exact payload on a duplicate retry.
      host.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'message.send', ?, ?, ?, 'completed', ?, ?)",
        userId,
        b.command_id,
        requestHash,
        fullAckJson,
        now,
        idemExpiresAt,
      );
      // channel_fanout outbox carries the LIVE (sender-resolved) event frame — same projection as
      // the ack (addendum I). Written in-txn so a crash after commit leaves a deliverable event.
      host.insertOutboxRowForFanout(channelId, eventId, liveEventFrameJson, mv, now);
      // channel_directory projection: full-snapshot upsert with last_message_at=<now> for public
      // channels (P0-3: the snapshot carries title/avatar_url/member_count/status too, so a missing
      // directory row is repaired by the next message, not just last_message_at updated).
      if (statusRow?.visibility === "public_listed") {
        host.insertOutboxRowForChannelDirectory(channelId, "upsert", host.readChannelDirectorySnapshot(channelId, now), now);
      }

      appendChatChannelArchive(host.ctx, channelId, now, [eventId], (sourceSeq) => {
        const rv = rvEvent(eventId);
        return collectDefinedChanges([
          upsertMessageChange(host.ctx.storage.sql, messageId, channelId, rv),
          replaceScopeMentionsChange(host.ctx.storage.sql, messageId, rv),
          ...upsertAttachmentsForMessageChanges(host.ctx.storage.sql, messageId, rv),
          replaceScopeMessageAttachmentsChange(host.ctx.storage.sql, messageId, rv),
          replaceScopeMessageStickersChange(host.ctx.storage.sql, messageId, rv),
          upsertEventChange(host.ctx.storage.sql, eventId),
        ]);
      });

      return { kind: "created", response_json: fullAckJson };
    });

    if (txResult.kind === "conflict") {
      return Response.json(
        {
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message: "command_id reused with different body",
            retryable: false,
          },
        },
        { status: 409 },
      );
    }
    if (txResult.kind === "dissolved") {
      return Response.json({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }, { status: 409 });
    }
    if (txResult.kind === "created") {
      await host.scheduleArchiveAlarm(now);
      // Return the same projection committed to idempotency_keys + the outbox — no post-txn recompute.
      const ackPayload = JSON.parse(txResult.response_json) as MessageMutationIdempotencyEnvelope;
      return Response.json(ackPayload.payload as MessageMutationAckPayload);
    }
    // cached: return the stored full ack payload exactly (addendum K). It was written complete in
    // the original transaction, so event_id is never "" and message is never null here.
    const cached = JSON.parse(txResult.response_json) as MessageMutationIdempotencyEnvelope;
    return Response.json({
      channel_id: cached.payload?.channel_id ?? channelId,
      event_id: cached.payload?.event_id ?? "",
      message: cached.payload?.message ?? null,
    });
  }

  if (url.pathname === "/internal/message-edit") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const b = (await request.json()) as { operation_id: string; message_id: string; text: string; channel_id: string };
    const requestHash = JSON.stringify({ message_id: b.message_id, text: b.text });
    const now = host.nowIso();
    return host.applyMessageMutation({
      userId,
      operationId: b.operation_id,
      channelId: b.channel_id,
      messageId: b.message_id,
      operation: "message.edit",
      requestHash,
      reason: null,
      mutate: () => ({
        eventType: "message.updated",
        fields: {
          text: b.text,
          status: "edited",
          edited_at: now,
        },
      }),
    });
  }

  if (url.pathname === "/internal/message-recall") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const b = (await request.json()) as { operation_id: string; message_id: string; channel_id: string };
    const now = host.nowIso();
    return host.applyMessageMutation({
      userId,
      operationId: b.operation_id,
      channelId: b.channel_id,
      messageId: b.message_id,
      operation: "message.recall",
      requestHash: JSON.stringify({ message_id: b.message_id }),
      reason: null,
      mutate: () => ({
        eventType: "message.recalled",
        fields: {
          status: "recalled",
          recalled_at: now,
        },
      }),
    });
  }

  if (url.pathname === "/internal/message-delete") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const b = (await request.json()) as { operation_id: string; message_id: string; reason?: string | null; channel_id: string };
    const now = host.nowIso();
    return host.applyMessageMutation({
      userId,
      operationId: b.operation_id,
      channelId: b.channel_id,
      messageId: b.message_id,
      operation: "message.delete",
      requestHash: JSON.stringify({ message_id: b.message_id, reason: b.reason ?? null }),
      reason: b.reason ?? null,
      mutate: () => ({
        eventType: "message.deleted",
        fields: {
          status: "deleted",
          deleted_at: now,
          deleted_by: userId,
        },
      }),
    });
  }

  return null;
}
