import { uuidv7 } from "../../../ids/uuidv7";
import { projectFinalizedAttachmentForBrowser, type AttachmentRow } from "../../../chat/attachment-projection";
import { validatePresignBody } from "../../../chat/upload-presign-validation";
import type {
  BotAttachmentFinalizeRpcInput,
  BotAttachmentFinalizeResponse,
  BotAttachmentPresignRpcInput,
  BotAttachmentPresignResponse,
} from "../../../contract/chat-channel-rpc";
import { idempotencyExpiresAt } from "../../../contract/idempotency";
import { ApiError, HTTP_STATUS_BY_CODE } from "../../../errors";
import { presignPutUrl, headObjectKey } from "../../../s3/presign";
import { attachmentObjectKey, attachmentPublicUrl } from "../../../s3/object-key";
import {
  checkPrincipalIdempotencyInTxn,
  readPrincipalIdempotencyRow,
} from "../../../chat/principal-idempotency";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";

const BOT_PRINCIPAL = "bot" as const;
const PRESIGN_OPERATION = "bot.attachment.presign";

function botIdempotencyKey(botId: string, operation: string, operationId: string) {
  return {
    principalKind: BOT_PRINCIPAL,
    principalId: botId,
    operation,
    operationId,
  };
}

function assertBotInstalledInChannel(
  repo: ChatChannelCore["repo"],
  channelId: string,
  botId: string,
): void {
  if (!repo.isBotInstalledInChannel(channelId, botId)) {
    throw new ApiError("FORBIDDEN", "bot not installed in channel");
  }
}

function isFullPresignResponse(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as { upload_url?: string };
    return typeof parsed.upload_url === "string" && parsed.upload_url.length > 0;
  } catch {
    return false;
  }
}

function pendingAttachmentId(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { attachment_id?: string; pending?: boolean };
    if (parsed.pending === true && typeof parsed.attachment_id === "string") {
      return parsed.attachment_id;
    }
    return null;
  } catch {
    return null;
  }
}

function upsertBotIdempotency(
  sql: DurableObjectState["storage"]["sql"],
  key: ReturnType<typeof botIdempotencyKey> & { requestHash: string; responseJson: string; nowIso: string },
): void {
  const expiresAt = idempotencyExpiresAt(Date.parse(key.nowIso));
  sql.exec(
    `INSERT INTO idempotency_keys (
      principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)
    ON CONFLICT(principal_kind, principal_id, operation, operation_id) DO UPDATE SET
      request_hash=excluded.request_hash,
      response_json=excluded.response_json,
      status='completed',
      expires_at=excluded.expires_at`,
    key.principalKind,
    key.principalId,
    key.operation,
    key.operationId,
    key.requestHash,
    key.responseJson,
    key.nowIso,
    expiresAt,
  );
}

export function BotAttachmentMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async botAttachmentPresign(input: BotAttachmentPresignRpcInput): Promise<BotAttachmentPresignResponse> {
      const channelId = input.channel_id;
      const botId = input.bot_id;
      const idempotencyKey = input.idempotency_key;
      if (!channelId || !botId) {
        throw new ApiError("INVALID_MESSAGE", "channel_id and bot_id required");
      }
      if (!idempotencyKey) {
        throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
      }

      const meta = this.repo.soleChannelMetaKindStreamGate();
      if (!meta || meta.channel_id !== channelId) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel not found", { httpStatus: 404 });
      }
      const dissolved = this.assertNotDissolved(meta.status);
      if (dissolved) {
        throw new ApiError(dissolved.code, dissolved.message, { httpStatus: 409 });
      }
      assertBotInstalledInChannel(this.repo, channelId, botId);

      const validation = validatePresignBody(input);
      if (!validation.ok) {
        throw new ApiError(validation.code, validation.error, {
          httpStatus: HTTP_STATUS_BY_CODE[validation.code] ?? 422,
        });
      }
      const { filename, mimeType, sizeBytes, width, height, blurhash } = validation;
      const requestHash = JSON.stringify({ filename, mimeType, sizeBytes, width, height, blurhash, channel_id: channelId });
      const now = this.nowIso();
      const idemKey = botIdempotencyKey(botId, PRESIGN_OPERATION, idempotencyKey);

      type PresignCoord =
        | { kind: "conflict" }
        | { kind: "cached"; responseJson: string }
        | { kind: "pending"; attachmentId: string }
        | { kind: "new"; attachmentId: string; storageKey: string; mimeType: string };

      const coord = await this.ctx.storage.transaction(async (): Promise<PresignCoord> => {
        const idem = checkPrincipalIdempotencyInTxn(this.ctx.storage.sql, { ...idemKey, requestHash });
        if (idem.kind === "conflict") return { kind: "conflict" };
        if (idem.kind === "cached") {
          if (isFullPresignResponse(idem.responseJson)) {
            return { kind: "cached", responseJson: idem.responseJson };
          }
          const attachmentId = pendingAttachmentId(idem.responseJson);
          if (attachmentId) return { kind: "pending", attachmentId };
        }

        const attachmentId = uuidv7();
        const storageKey = attachmentObjectKey(attachmentId, filename, mimeType);
        const publicUrl = attachmentPublicUrl(this.env.S3_PUBLIC_BASE, attachmentId, filename, mimeType);
        const expiresAt = idempotencyExpiresAt(Date.parse(now));
        this.ctx.storage.sql.exec(
          `INSERT INTO attachments (
            attachment_id, owner_user_id, owner_bot_id, channel_id, kind, filename, mime_type, size_bytes,
            width, height, blurhash, storage_key, url, status, created_at, expires_at
          ) VALUES (?, NULL, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          attachmentId,
          botId,
          channelId,
          filename,
          mimeType,
          sizeBytes,
          width ?? null,
          height ?? null,
          blurhash ?? null,
          storageKey,
          publicUrl,
          now,
          expiresAt,
        );
        const pendingJson = JSON.stringify({ attachment_id: attachmentId, pending: true });
        this.ctx.storage.sql.exec(
          `INSERT INTO idempotency_keys (
            principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          ON CONFLICT(principal_kind, principal_id, operation, operation_id) DO UPDATE SET
            request_hash=excluded.request_hash,
            response_json=excluded.response_json,
            status='pending'`,
          idemKey.principalKind,
          idemKey.principalId,
          idemKey.operation,
          idemKey.operationId,
          requestHash,
          pendingJson,
          now,
          expiresAt,
        );
        return { kind: "new", attachmentId, storageKey, mimeType };
      });

      if (coord.kind === "conflict") {
        throw new ApiError("IDEMPOTENCY_CONFLICT", "Idempotency-Key reused with different body");
      }
      if (coord.kind === "cached") {
        return JSON.parse(coord.responseJson) as BotAttachmentPresignResponse;
      }

      let attachmentId: string;
      let storageKey: string;
      let mimeForPresign: string;
      if (coord.kind === "new") {
        attachmentId = coord.attachmentId;
        storageKey = coord.storageKey;
        mimeForPresign = coord.mimeType;
      } else {
        attachmentId = coord.attachmentId;
        const row = this.ctx.storage.sql
          .exec(
            "SELECT storage_key, mime_type FROM attachments WHERE attachment_id=? AND owner_bot_id=? AND channel_id=?",
            attachmentId,
            botId,
            channelId,
          )
          .toArray()[0] as { storage_key: string; mime_type: string } | undefined;
        if (!row) {
          throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "attachment not found", { httpStatus: 415 });
        }
        storageKey = row.storage_key;
        mimeForPresign = row.mime_type;
      }

      const presign = await presignPutUrl(this.env, storageKey, mimeForPresign);
      const response: BotAttachmentPresignResponse = {
        attachment_id: attachmentId,
        upload_url: presign.upload_url,
        upload_method: "PUT",
        upload_headers: presign.upload_headers,
        expires_at: presign.expires_at,
      };
      const responseJson = JSON.stringify(response);

      await this.ctx.storage.transaction(async () => {
        const existing = readPrincipalIdempotencyRow(this.ctx.storage.sql, idemKey);
        if (existing && existing.request_hash !== requestHash) {
          throw new ApiError("IDEMPOTENCY_CONFLICT", "Idempotency-Key reused with different body");
        }
        upsertBotIdempotency(this.ctx.storage.sql, {
          ...idemKey,
          requestHash,
          responseJson,
          nowIso: now,
        });
      });

      await this.scheduleOutboxAlarm(now);

      return response;
    }

    async botAttachmentFinalize(input: BotAttachmentFinalizeRpcInput): Promise<BotAttachmentFinalizeResponse> {
      const channelId = input.channel_id;
      const botId = input.bot_id;
      const attachmentId = input.attachment_id;
      if (!channelId || !botId || !attachmentId) {
        throw new ApiError("INVALID_MESSAGE", "channel_id, bot_id and attachment_id required");
      }

      const meta = this.repo.soleChannelMetaKindStreamGate();
      if (!meta || meta.channel_id !== channelId) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel not found", { httpStatus: 404 });
      }
      const dissolved = this.assertNotDissolved(meta.status);
      if (dissolved) {
        throw new ApiError(dissolved.code, dissolved.message, { httpStatus: 409 });
      }
      assertBotInstalledInChannel(this.repo, channelId, botId);

      const row = this.ctx.storage.sql
        .exec(
          `SELECT attachment_id, owner_user_id, owner_bot_id, channel_id, kind, filename, mime_type, size_bytes,
                  width, height, blurhash, storage_key, url, status, created_at
           FROM attachments WHERE attachment_id=?`,
          attachmentId,
        )
        .toArray()[0] as AttachmentRow | undefined;

      if (!row) {
        throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "attachment not found", { httpStatus: 415 });
      }
      if (row.owner_bot_id !== botId || row.channel_id !== channelId) {
        throw new ApiError("FORBIDDEN", "attachment does not belong to bot in this channel");
      }
      if (row.status === "finalized") {
        return { attachment: projectFinalizedAttachmentForBrowser(row) };
      }
      if (row.status !== "pending") {
        throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "attachment cannot be finalized", { httpStatus: 415 });
      }

      const head = await headObjectKey(this.env, row.storage_key, row.mime_type, row.size_bytes);
      if (!head.ok) {
        throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "S3 object missing or mismatch", { httpStatus: 415 });
      }

      await this.ctx.storage.transaction(async () => {
        this.ctx.storage.sql.exec("UPDATE attachments SET status='finalized' WHERE attachment_id=?", attachmentId);
      });

      const finalizedRow = this.ctx.storage.sql
        .exec(
          `SELECT attachment_id, owner_user_id, owner_bot_id, channel_id, kind, filename, mime_type, size_bytes,
                  width, height, blurhash, storage_key, url, status, created_at
           FROM attachments WHERE attachment_id=?`,
          attachmentId,
        )
        .toArray()[0] as unknown as AttachmentRow;

      return { attachment: projectFinalizedAttachmentForBrowser(finalizedRow) };
    }
  };
}
