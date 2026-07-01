import type { MessageSendRpcInput } from "../../../contract/chat-channel-rpc";
import { uuidv7 } from "../../../ids/uuidv7";
import {
  buildEventFrame,
  buildMessageLifecyclePayload,
  type UserSummary as LiveUserSummary,
} from "../../../chat/event-broadcast";
import { projectMessageForBrowser, type MessageStickerSnapshot } from "../../../chat/message-projection";
import { buildReplySnapshot, loadReplySnapshotMedia, replyTargetSenderDisplayName } from "../../../chat/reply-snapshot";
import { projectAttachmentForBrowser, type AttachmentRow as ChatAttachmentRow } from "../../../chat/attachment-projection";
import type { MessageRow } from "../../../contract/persisted";
import type { MessageImageAttachment } from "../../../contract/message";
import type { MessageMutationAckPayload } from "../../../contract/idempotency";
import { ApiError, apiErrorFromRemote, logSwallowedError } from "../../../errors";
import { parseMessageMutationAckFromCached } from "../../shared/do-rpc";
import {
  checkUserIdempotencyInTxn,
  readUserCompletedIdempotency,
  writeUserCompletedIdempotency,
} from "../data/idempotency";
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
import { enqueueStatefulInputForMessageCreated } from "./stateful-session";
import { resolveUserSummaries } from "../../../profile/resolve";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";
import { asHandlerRef } from "../handler-ref";

export function MessageSendMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async sendMessage(input: MessageSendRpcInput): Promise<MessageMutationAckPayload> {
      const userId = input.user_id;
      const now = this.nowIso();
      const nowMs = Date.parse(now);

      const meta = this.repo.soleChannelMetaSendGate();
      if (meta === undefined) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel not created");
      }
      const channelId = meta.channel_id;
      const requestedChannelId = input.channel_id ?? "";
      if (requestedChannelId && requestedChannelId !== channelId) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel_id mismatch");
      }

      if (!this.repo.isActiveMember(channelId, userId)) {
        throw new ApiError("FORBIDDEN", "not a member");
      }

      let replySnapshotJson: string | null = null;
      if (input.reply_to) {
        const targetRow = this.repo.messageReplyTarget(input.reply_to, channelId);
        if (!targetRow || (targetRow.status !== "normal" && targetRow.status !== "edited")) {
          throw new ApiError("MESSAGE_NOT_FOUND", "reply target not found");
        }
        let targetSenderDisplayName = replyTargetSenderDisplayName(targetRow);
        if (targetRow.sender_kind === "user" && targetRow.sender_user_id) {
          try {
            const raw = await resolveUserSummaries([targetRow.sender_user_id], this.env);
            const normalized = raw.get(targetRow.sender_user_id);
            if (normalized?.display_name) {
              targetSenderDisplayName = normalized.display_name;
            }
          } catch (err) {
            logSwallowedError("reply_target_sender_resolve_failed", err, {
              channel_id: channelId,
              reply_to: input.reply_to,
            });
          }
        }
        const mediaPreview = loadReplySnapshotMedia(this.ctx.storage.sql, targetRow.message_id, targetRow.type);
        replySnapshotJson = JSON.stringify(
          buildReplySnapshot(targetRow, targetSenderDisplayName, { mediaPreview }),
        );
      }

      const requestHash = JSON.stringify({
        type: input.type,
        text: input.text,
        reply_to: input.reply_to,
        attachment_ids: input.attachment_ids ?? [],
        sticker_id: input.sticker_id ?? null,
        mentions: input.mentions ?? [],
      });

      const messageId = uuidv7(nowMs);
      const eventId = this.nextEventId(nowMs);
      const mv = meta.membership_version;
      const messageRowForProjection: MessageRow = {
        message_id: messageId,
        command_id: input.command_id,
        channel_id: channelId,
        sender_kind: "user",
        sender_user_id: userId,
        sender_bot_id: null,
        type: input.type,
        format: "plain",
        status: "normal",
        text: input.text,
        reply_to: input.reply_to,
        reply_snapshot_json: replySnapshotJson,
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
      const preCheckJson = readUserCompletedIdempotency(
        this.ctx.storage.sql,
        userId,
        "message.send",
        input.command_id,
        requestHash,
      );
      if (preCheckJson) {
        return parseMessageMutationAckFromCached(preCheckJson);
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
        const raw = await resolveUserSummaries([userId], this.env);
        const normalized = raw.get(userId);
        if (normalized) {
          resolvedSender = {
            user_id: normalized.user_id,
            display_name: normalized.display_name ?? `user-${userId.slice(0, 8)}`,
            avatar_url: normalized.avatar_url,
          };
        }
      } catch (err) {
        logSwallowedError("message_send_sender_resolve_failed", err, { channel_id: channelId, user_id: userId });
      }

      // Phase 5 image messages: resolve finalized attachments from UserDirectory BEFORE the txn
      // (cross-DO fetch must not happen inside a storage transaction).
      let attachmentRows: ChatAttachmentRow[] = [];
      let attachmentProjections: MessageImageAttachment[] = [];
      if (input.type === "image") {
        const ids = Array.isArray(input.attachment_ids) ? input.attachment_ids : [];
        if (ids.length === 0) {
          throw new ApiError("INVALID_MESSAGE", "image message requires attachment_ids");
        }
        const userDir = this.env.USER_DIRECTORY.getByName(userId);
        for (const attachmentId of ids) {
          let row: ChatAttachmentRow;
          try {
            row = (await userDir.getAttachment(userId, attachmentId)).attachment as ChatAttachmentRow;
          } catch (err) {
            const apiErr = apiErrorFromRemote(err);
            if (!apiErr) throw err;
            throw apiErr;
          }
          if (!row || row.status !== "finalized" || row.owner_user_id !== userId) {
            throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "attachment not available", { httpStatus: 415 });
          }
          if (row.kind !== "image") {
            throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "only message image attachments can be sent in chat", { httpStatus: 415 });
          }
          attachmentRows.push(row);
          const projection = projectAttachmentForBrowser(row);
          if (projection) attachmentProjections.push(projection);
        }
      }

      let stickerSnapshot: MessageStickerSnapshot | null = null;
      if (input.type === "sticker") {
        if (!input.sticker_id) {
          throw new ApiError("INVALID_MESSAGE", "sticker message requires sticker_id");
        }
        const userDir = this.env.USER_DIRECTORY.getByName(userId);
        try {
          stickerSnapshot = await userDir.resolveSticker(userId, input.sticker_id) as MessageStickerSnapshot;
        } catch (err) {
          const apiErr = apiErrorFromRemote(err);
          if (!apiErr) throw err;
          throw apiErr;
        }
      }

      // Build the LIVE message projection once (used by BOTH the committed-ack response_json AND
      // the channel_fanout outbox event_json — v4.0 addendum I/J: ack and event carry the same
      // Browser-visible projection from the one shared builder).
      const liveMessage = projectMessageForBrowser(messageRowForProjection, {
        senderSummary: resolvedSender,
        mentions: Array.isArray(input.mentions) ? input.mentions : [],
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
        command_id: input.command_id,
        status: "committed",
        payload: { channel_id: channelId, event_id: eventId, message: liveMessage },
      });
      const persistedPayload = buildMessageLifecyclePayload(messageRowForProjection);
      const payloadJson = JSON.stringify(persistedPayload);

      type SendResult =
        | { kind: "created"; response_json: string }
        | { kind: "cached"; response_json: string }
        | { kind: "conflict" }
        | { kind: "dissolved" };

      const txResult = await this.ctx.storage.transaction(async (): Promise<SendResult> => {
        const statusRow = this.repo.channelMetaStatusVisibility(channelId);
        if (statusRow?.status === "dissolved") {
          return { kind: "dissolved" };
        }
        const idem = checkUserIdempotencyInTxn(
          this.ctx.storage.sql,
          userId,
          "message.send",
          input.command_id,
          requestHash,
        );
        if (idem.kind === "conflict") {
          return { kind: "conflict" };
        }
        if (idem.kind === "cached") {
          return { kind: "cached", response_json: idem.responseJson };
        }

        this.ctx.storage.sql.exec(
          `INSERT INTO messages (
              message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
              sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'user', ?, NULL, ?, 'plain', 'normal', ?, ?, ?, 'none', ?, ?)`,
          messageId,
          input.command_id,
          input.dedupe_principal_key,
          channelId,
          userId,
          input.type,
          input.text,
          input.reply_to,
          replySnapshotJson,
          now,
          now,
        );
        if (Array.isArray(input.mentions)) {
          for (const m of input.mentions) {
            this.ctx.storage.sql.exec(
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
          this.ctx.storage.sql.exec(
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
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO message_attachments (message_id, attachment_id) VALUES (?, ?)",
            messageId,
            row.attachment_id,
          );
        }
        // Snapshot the sticker for historical stability (independent of future personal_stickers changes).
        if (stickerSnapshot) {
          this.ctx.storage.sql.exec(
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
        this.ctx.storage.sql.exec(
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
        writeUserCompletedIdempotency(this.ctx.storage.sql, {
          userId,
          operation: "message.send",
          operationId: input.command_id,
          requestHash,
          responseJson: fullAckJson,
          nowIso: now,
        });
        // channel_fanout outbox carries the LIVE (sender-resolved) event frame — same projection as
        // the ack (addendum I). Written in-txn so a crash after commit leaves a deliverable event.
        this.insertOutboxRowForFanout(channelId, eventId, liveEventFrameJson, mv, now);
        // channel_directory projection: full-snapshot upsert with last_message_at=<now> for public
        // channels (P0-3: the snapshot carries title/avatar_url/member_count/status too, so a missing
        // directory row is repaired by the next message, not just last_message_at updated).
        if (statusRow?.visibility === "public_listed") {
          this.insertOutboxRowForChannelDirectory(channelId, "upsert", this.readChannelDirectorySnapshot(channelId, now), now);
        }

        appendChatChannelArchive(this.ctx, channelId, now, [eventId], (sourceSeq) => {
          const rv = rvEvent(eventId);
          return collectDefinedChanges([
            upsertMessageChange(this.ctx.storage.sql, messageId, channelId, rv),
            replaceScopeMentionsChange(this.ctx.storage.sql, messageId, rv, { omitWhenEmpty: true }),
            ...upsertAttachmentsForMessageChanges(this.ctx.storage.sql, messageId, rv),
            replaceScopeMessageAttachmentsChange(this.ctx.storage.sql, messageId, rv, { omitWhenEmpty: true }),
            replaceScopeMessageStickersChange(this.ctx.storage.sql, messageId, rv, { omitWhenEmpty: true }),
            upsertEventChange(this.ctx.storage.sql, eventId),
          ]);
        });

        return { kind: "created", response_json: fullAckJson };
      });

      if (txResult.kind === "conflict") {
        throw new ApiError("IDEMPOTENCY_CONFLICT", "command_id reused with different body");
      }
      if (txResult.kind === "dissolved") {
        throw new ApiError("CHANNEL_DISSOLVED", "channel is dissolved");
      }
      if (txResult.kind === "created") {
        await this.scheduleArchiveAlarm(now);
        const ackMessage = parseMessageMutationAckFromCached(txResult.response_json);
        await enqueueStatefulInputForMessageCreated(asHandlerRef(this), {
          channelId,
          messageId,
          eventId,
          occurredAt: now,
          messageRow: messageRowForProjection,
          messageProjection: ackMessage.message,
        });
        return ackMessage;
      }
      return parseMessageMutationAckFromCached(txResult.response_json);
    }
  };
}
