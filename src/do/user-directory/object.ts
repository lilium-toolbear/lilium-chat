import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { uuidv7 } from "../../ids/uuidv7";
import { migrateUserDirectorySchema } from "./migrations";
import { projectAttachmentForBrowser, projectFinalizedAttachmentForBrowser, type AttachmentRow } from "../../chat/attachment-projection";
import { presignPutUrl, headObjectKey, deleteObject } from "../../s3/presign";
import { attachmentObjectKey, attachmentPublicUrl, avatarObjectKey, avatarPublicUrl } from "../../s3/object-key";
import { ApiError, HTTP_STATUS_BY_CODE, apiErrorFromRemote, logSwallowedError } from "../../errors";
import { assertTestRoutesEnabled } from "../shared/test-gates";
import { canonicalDmPairKey, isUuidString } from "../../chat/dm-pair";
import { resolveUserSummaries } from "../../profile/resolve";
import { idempotencyExpiresAt } from "../../contract/idempotency";
import type { CreateChannelApiResponse } from "../../contract/channel-api";
import type { FinalizedAttachmentProjection } from "../../contract/message";
import { isoDueTable, runDueJobs, scheduleNextAlarm, type DueTable } from "../shared/scheduler";
import { archiveOutboxDueTable, flushArchiveOutboxToQueue } from "../../archive/queue-flush";
import { appendArchiveRecordSync } from "../../archive/source-outbox";
import { archiveUpsert, rowVersionFromSeq } from "../../archive/changes";
import { sourceKeyForUserDirectory } from "../../archive/source-key";
import type { ArchiveChange } from "../../archive/payload";
import { sqlRows } from "../shared/sql";

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024; // 20 MiB
const MAX_PERSONAL_STICKERS = 200; // contract §8.3 sticker library limit

type PersonalStickerListRow = {
  sticker_id: string;
  attachment_id: string;
  url: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  blurhash: string | null;
  created_at: string;
};

function projectPersonalStickerItem(row: PersonalStickerListRow) {
  const { sticker_id, created_at, attachment_id, url, mime_type, width, height, size_bytes, blurhash } = row;
  return {
    sticker_id,
    created_at,
    attachment: { attachment_id, url, mime_type, width, height, size_bytes, blurhash },
  };
}

type PresignValidation =
  | { ok: false; error: string; code: string }
  | {
      ok: true;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      width: number | undefined;
      height: number | undefined;
      blurhash: string | undefined;
    };

type StickerSourceAttachment = {
  attachment_id: string;
  url: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  blurhash: string | null;
};

type PersonalStickerRow = {
  sticker_id: string;
  user_id: string;
  attachment_id: string;
  url: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  blurhash: string | null;
  created_at: string;
  deleted_at: string | null;
};

type PersonalStickerListItem = {
  sticker_id: string;
  attachment: {
    attachment_id: string;
    url: string;
    mime_type: string;
    width: number | null;
    height: number | null;
    size_bytes: number;
    blurhash: string | null;
  };
  created_at: string;
};

type PersonalStickerList = {
  items: PersonalStickerListItem[];
  next_cursor: string | null;
};

type SaveStickerResult = {
  sticker: PersonalStickerListItem;
};

type DeleteStickerResult = {
  sticker_id: string;
  deleted: true;
};

type ResolvedSticker = {
  sticker_id: string;
  attachment_id: string;
  url: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  blurhash: string | null;
};

type AttachmentResult = {
  attachment: AttachmentRow;
};

type UploadPresignResult = {
  attachment_id: string;
  upload_url: string;
  upload_method: "PUT";
  upload_headers: Record<string, string>;
  expires_at: string;
};

type FinalizeUploadResult = {
  attachment: FinalizedAttachmentProjection;
};

function attachmentArchiveAfter(row: AttachmentRow): Record<string, unknown> {
  return {
    attachment_id: row.attachment_id,
    owner_user_id: row.owner_user_id,
    kind: row.kind,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
    blurhash: row.blurhash,
    storage_key: row.storage_key,
    url: row.url,
    status: row.status,
    created_at: row.created_at,
  };
}

function personalStickerArchiveAfter(row: PersonalStickerRow): Record<string, unknown> {
  return {
    sticker_id: row.sticker_id,
    user_id: row.user_id,
    attachment_id: row.attachment_id,
    url: row.url,
    mime_type: row.mime_type,
    width: row.width,
    height: row.height,
    size_bytes: row.size_bytes,
    blurhash: row.blurhash,
    created_at: row.created_at,
    deleted_at: row.deleted_at,
  };
}

function readPersonalStickerRow(ctx: DurableObjectState, stickerId: string): PersonalStickerRow | undefined {
  return ctx.storage.sql
    .exec(
      "SELECT sticker_id, user_id, attachment_id, url, mime_type, width, height, size_bytes, blurhash, created_at, deleted_at FROM personal_stickers WHERE sticker_id=?",
      stickerId,
    )
    .toArray()[0] as PersonalStickerRow | undefined;
}

function appendUserDirectoryArchive(
  ctx: DurableObjectState,
  userId: string,
  occurredAt: string,
  buildChanges: (sourceSeq: number) => ArchiveChange[],
): void {
  appendArchiveRecordSync(ctx, {
    sourceKind: "user_directory",
    sourceKey: sourceKeyForUserDirectory(userId),
    occurredAt,
    businessEventIds: [],
    buildChanges,
  });
}

function validatePresignBody(body: {
  filename?: string;
  mime_type?: string;
  size_bytes?: number;
  width?: number | null;
  height?: number | null;
  blurhash?: string;
}): PresignValidation {
  const filename = body.filename?.trim();
  const mimeType = body.mime_type?.trim().toLowerCase();
  const sizeBytes = body.size_bytes;
  if (!filename) return { ok: false, error: "filename required", code: "INVALID_MESSAGE" };
  if (!mimeType) return { ok: false, error: "mime_type required", code: "INVALID_MESSAGE" };
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    return { ok: false, error: "unsupported attachment type", code: "UNSUPPORTED_ATTACHMENT_TYPE" };
  }
  if (typeof sizeBytes !== "number" || sizeBytes <= 0 || sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    return { ok: false, error: "attachment too large", code: "ATTACHMENT_TOO_LARGE" };
  }
  if (body.width != null && (typeof body.width !== "number" || !Number.isInteger(body.width) || body.width <= 0)) {
    return { ok: false, error: "width must be a positive integer", code: "INVALID_MESSAGE" };
  }
  if (body.height != null && (typeof body.height !== "number" || !Number.isInteger(body.height) || body.height <= 0)) {
    return { ok: false, error: "height must be a positive integer", code: "INVALID_MESSAGE" };
  }
  return {
    ok: true,
    filename,
    mimeType,
    sizeBytes,
    width: body.width ?? undefined,
    height: body.height ?? undefined,
    blurhash: body.blurhash,
  };
}

export class UserDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      migrateUserDirectorySchema(this.ctx);
    });
  }

  async upsertChannelProjection(
    userId: string,
    body: {
      action: "join" | "leave" | "dissolve";
      channel_id: string;
      kind: string;
      membership_version: number;
    },
  ): Promise<{ ok: true }> {
    const now = new Date().toISOString();
    return await this.ctx.storage.transaction(async () => {
      const existing = this.ctx.storage.sql
        .exec(
          "SELECT status, left_at, membership_version FROM my_channels WHERE user_id = ? AND channel_id = ?",
          userId,
          body.channel_id,
        )
        .toArray()[0] as
        | { status: string; left_at: string | null; membership_version: number }
        | undefined;

      if (existing && existing.membership_version >= body.membership_version) {
        return { ok: true };
      }

      if (body.action === "join") {
        if (existing === undefined) {
          this.ctx.storage.sql.exec(
            "INSERT INTO my_channels (user_id, channel_id, kind, joined_at, left_at, removed_at, status, membership_version, last_read_event_id) VALUES (?, ?, ?, ?, NULL, NULL, 'active', ?, NULL)",
            userId,
            body.channel_id,
            body.kind,
            now,
            body.membership_version,
          );
          return { ok: true };
        }

        this.ctx.storage.sql.exec(
          "UPDATE my_channels SET status='active', left_at=NULL, removed_at=NULL, membership_version=?, joined_at=COALESCE(joined_at, ?), kind=? WHERE user_id=? AND channel_id=?",
          body.membership_version,
          now,
          body.kind,
          userId,
          body.channel_id,
        );
        return { ok: true };
      }

      if (body.action === "dissolve") {
        if (existing === undefined) {
          this.ctx.storage.sql.exec(
            "INSERT INTO my_channels (user_id, channel_id, kind, joined_at, left_at, removed_at, status, membership_version, last_read_event_id) VALUES (?, ?, ?, ?, NULL, NULL, 'dissolved', ?, NULL)",
            userId,
            body.channel_id,
            body.kind,
            now,
            body.membership_version,
          );
          return { ok: true };
        }

        this.ctx.storage.sql.exec(
          "UPDATE my_channels SET status='dissolved', left_at=NULL, removed_at=NULL, membership_version=?, kind=? WHERE user_id=? AND channel_id=?",
          body.membership_version,
          body.kind,
          userId,
          body.channel_id,
        );
        return { ok: true };
      }

      if (existing) {
        this.ctx.storage.sql.exec(
          "UPDATE my_channels SET status='left', left_at=?, membership_version=? WHERE user_id=? AND channel_id=?",
          now,
          body.membership_version,
          userId,
          body.channel_id,
        );
      }
      return { ok: true };
    });
  }

  async listMyChannels(userId: string): Promise<{
    items: Array<{
      channel_id: string;
      kind: string;
      last_read_event_id: string | null;
      membership_version: number;
    }>;
  }> {
    if (await this.ctx.storage.get("test:my-channels-failure") === true) {
      throw new Error("test my-channels failure");
    }
    const rows = this.ctx.storage.sql
      .exec("SELECT channel_id, kind, last_read_event_id, membership_version FROM my_channels WHERE user_id = ? AND status IN ('active', 'dissolved')", userId)
      .toArray() as {
        channel_id: string;
        kind: string;
        last_read_event_id: string | null;
        membership_version: number;
      }[];
    return { items: rows };
  }

  async debugSetMyChannelsFailure(enabled: boolean): Promise<{ ok: true }> {
    assertTestRoutesEnabled(this.env);
    if (enabled) {
      await this.ctx.storage.put("test:my-channels-failure", true);
    } else {
      await this.ctx.storage.delete("test:my-channels-failure");
    }
    return { ok: true };
  }

  async updateReadState(
    userId: string,
    body: { channel_id: string; last_read_event_id: string },
  ): Promise<{ channel_id: string; last_read_event_id: string; advanced: boolean }> {
    const floor = await this.ctx.storage.transaction(async () => {
      const row = this.ctx.storage.sql
        .exec("SELECT last_read_event_id, status FROM my_channels WHERE user_id=? AND channel_id=?", userId, body.channel_id)
        .toArray()[0] as { last_read_event_id: string | null; status: string } | undefined;
      if (!row || (row.status !== "active" && row.status !== "dissolved")) {
        throw new ApiError("FORBIDDEN", "not an active member");
      }

      const current = row.last_read_event_id;
      if (current === null || body.last_read_event_id > current) {
        this.ctx.storage.sql.exec("UPDATE my_channels SET last_read_event_id=? WHERE user_id=? AND channel_id=?", body.last_read_event_id, userId, body.channel_id);
        return { stored: body.last_read_event_id, advanced: true };
      }
      if (body.last_read_event_id === current) {
        return { stored: current, advanced: false };
      }
      return { stored: current, advanced: false };
    });

    return {
      channel_id: body.channel_id,
      last_read_event_id: floor.stored,
      advanced: floor.advanced,
    };
  }

  async openDm(currentUserId: string, b: { idempotency_key: string; recipient_user_id: string }): Promise<
    | { kind: "cached"; response: unknown }
    | { kind: "needs_inflate"; channel_id: string; joined_at: string; role: string }
  > {
    if (!b.idempotency_key) {
      throw new ApiError("INVALID_MESSAGE", "idempotency_key required");
    }

    const requestHash = JSON.stringify({ recipient_user_id: b.recipient_user_id });
    const now = new Date().toISOString();
    const expiresAt = idempotencyExpiresAt(Date.parse(now));

    const coord = await this.ctx.storage.transaction(async () => {
      const row = this.ctx.storage.sql
        .exec("SELECT request_hash, status, response_json FROM idempotency_keys WHERE operation='dm.open' AND operation_id=?", b.idempotency_key)
        .toArray()[0] as { request_hash: string; status: string; response_json: string | null } | undefined;

      if (row) {
        if (row.request_hash !== requestHash) return { kind: "conflict" as const };
        if (row.status === "completed" && row.response_json) {
          return { kind: "cached" as const, responseJson: row.response_json };
        }
        return { kind: "resume" as const };
      }

      return { kind: "new" as const };
    });

    if (coord.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "idempotency_key reused with different body");
    }
    if (coord.kind === "cached") {
      return { kind: "cached", response: JSON.parse(coord.responseJson) };
    }

    if (coord.kind === "new") {
      if (!b.recipient_user_id || !isUuidString(b.recipient_user_id)) {
        throw new ApiError("INVALID_DM_TARGET", "invalid recipient_user_id");
      }
      if (b.recipient_user_id === currentUserId) {
        throw new ApiError("INVALID_DM_TARGET", "cannot open DM with yourself");
      }

      const recipientMap = await resolveUserSummaries([b.recipient_user_id], this.env);
      if (!recipientMap.has(b.recipient_user_id)) {
        throw new ApiError("DM_TARGET_NOT_FOUND", "recipient user not found");
      }

      await this.ctx.storage.transaction(async () => {
        this.ctx.storage.sql.exec(
          "INSERT INTO idempotency_keys (operation, operation_id, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('dm.open', ?, ?, 'creating', NULL, NULL, ?, ?, ?)",
          b.idempotency_key, requestHash, now, now, expiresAt,
        );
      });
    }

    if (!b.recipient_user_id || !isUuidString(b.recipient_user_id)) {
      throw new ApiError("INVALID_DM_TARGET", "invalid recipient_user_id");
    }
    const { pair_key, user_low, user_high } = canonicalDmPairKey(currentUserId, b.recipient_user_id);
    const dmStub = this.env.DM_DIRECTORY.getByName(pair_key);
    const dmBody = await dmStub.getOrCreateDm({ user_a: user_low, user_b: user_high, created_by: currentUserId });

    const chStub = this.env.CHAT_CHANNEL.getByName(dmBody.channel_id);
    const createBody = await chStub.createDm({
      user_id: currentUserId,
      channel_id: dmBody.channel_id,
      user_a: user_low,
      user_b: user_high,
      created_by: currentUserId,
    });
    const joinedAt = createBody.joined_at_by_user[currentUserId];
    if (!joinedAt) {
      throw new ApiError("CHAT_WORKER_UNAVAILABLE", "missing joined_at for opener");
    }

    if (dmBody.status === "creating") {
      await dmStub.completeDm({ pair_key, channel_id: dmBody.channel_id });
    }

    return {
      kind: "needs_inflate",
      channel_id: dmBody.channel_id,
      joined_at: joinedAt,
      role: "member",
    };
  }

  async completeOpenDm(_currentUserId: string, b: { idempotency_key: string; response_json: string }): Promise<{ ok: true }> {
    const now = new Date().toISOString();
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(
        "UPDATE idempotency_keys SET status='completed', response_json=?, updated_at=? WHERE operation='dm.open' AND operation_id=?",
        b.response_json, now, b.idempotency_key,
      );
    });
    return { ok: true };
  }

  async channelCreateCoordinate(currentUserId: string, body: {
    idempotency_key: string;
    title: string;
    topic: string | null;
    avatar_attachment_id: string | null;
    visibility: string;
    initial_members: Array<{ user_id: string; role: string }>;
  }): Promise<CreateChannelApiResponse> {
    if (!currentUserId) throw new ApiError("FORBIDDEN", "missing X-Verified-User-Id");
    if (!body.idempotency_key) {
      throw new ApiError("INVALID_MESSAGE", "idempotency_key required");
    }

    const requestHash = JSON.stringify({
      title: body.title,
      topic: body.topic ?? null,
      avatar_attachment_id: body.avatar_attachment_id ?? null,
      visibility: body.visibility ?? "private",
      initial_members: body.initial_members ?? [],
    });
    const now = new Date().toISOString();
    const expiresAt = idempotencyExpiresAt(Date.parse(now));

    const coord = await this.ctx.storage.transaction(async () => {
      const row = this.ctx.storage.sql
        .exec("SELECT request_hash, status, channel_id, response_json FROM idempotency_keys WHERE operation='channel.create' AND operation_id=?", body.idempotency_key)
        .toArray()[0] as { request_hash: string; status: string; channel_id: string | null; response_json: string | null } | undefined;

      if (row) {
        if (row.request_hash !== requestHash) return { kind: "conflict" as const };
        if (row.status === "completed" && row.response_json) {
          return { kind: "cached" as const, responseJson: row.response_json };
        }
        return { kind: "creating" as const, channelId: row.channel_id ?? "" };
      }

      const channelId = uuidv7();
      this.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (operation, operation_id, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('channel.create', ?, ?, 'creating', ?, NULL, ?, ?, ?)",
        body.idempotency_key,
        requestHash,
        channelId,
        now,
        now,
        expiresAt,
      );
      return { kind: "creating" as const, channelId };
    });

    if (coord.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "idempotency_key reused with different body");
    }
    if (coord.kind === "cached") {
      return JSON.parse(coord.responseJson) as CreateChannelApiResponse;
    }

    const channelId = coord.channelId;
    const created = await this.env.CHAT_CHANNEL.getByName(channelId).createChannel({
      user_id: currentUserId,
      channel_id: channelId,
      creator_user_id: currentUserId,
      title: body.title,
      topic: body.topic ?? null,
      avatar_attachment_id: body.avatar_attachment_id ?? null,
      visibility: body.visibility ?? "private",
      initial_members: body.initial_members ?? [],
    });
    const stored: CreateChannelApiResponse = { channel: created.channel, joined_at: created.joined_at };
    const createJson = JSON.stringify(stored);

    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(
        "UPDATE idempotency_keys SET status='completed', response_json=?, updated_at=? WHERE operation='channel.create' AND operation_id=?",
        createJson,
        now,
        body.idempotency_key,
      );
    });

    return stored;
  }

  async listStickers(userId: string, input: { limit: number; cursor: string | null }): Promise<PersonalStickerList> {
    if (!userId) throw new ApiError("FORBIDDEN", "missing X-Verified-User-Id");
    const limit = Math.min(100, Math.max(1, Number(input.limit ?? 50)));
    const rows = input.cursor
      ? this.ctx.storage.sql
        .exec(
          "SELECT sticker_id, attachment_id, url, mime_type, width, height, size_bytes, blurhash, created_at FROM personal_stickers WHERE user_id=? AND deleted_at IS NULL AND created_at < ? ORDER BY created_at DESC LIMIT ?",
          userId,
          input.cursor,
          limit,
        )
        .toArray()
      : this.ctx.storage.sql
        .exec(
          "SELECT sticker_id, attachment_id, url, mime_type, width, height, size_bytes, blurhash, created_at FROM personal_stickers WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
          userId,
          limit,
        )
        .toArray();
    const raw = sqlRows<PersonalStickerListRow>(rows);
    const items = raw.map(projectPersonalStickerItem);
    const nextCursor = items.length > 0 ? raw[raw.length - 1]!.created_at : null;
    return { items, next_cursor: nextCursor };
  }

  async saveSticker(userId: string, input: { operation_id: string; channel_id: string; attachment_id: string }): Promise<SaveStickerResult> {
    if (!userId) throw new ApiError("FORBIDDEN", "missing X-Verified-UserId");
    const operationId = input.operation_id ?? "";
    const channelId = input.channel_id ?? "";
    const attachmentId = input.attachment_id ?? "";
    if (!operationId || !channelId || !attachmentId) {
      throw new ApiError("INVALID_MESSAGE", "operation_id, channel_id and attachment_id required");
    }

    const requestHash = JSON.stringify({ channel_id: channelId, attachment_id: attachmentId });
    const now = this.nowIso();
    const idemExpiresAt = idempotencyExpiresAt(Date.now());

    type SaveCoord =
      | { kind: "conflict" }
      | { kind: "cached"; responseJson: string }
      | { kind: "resolve"; projection: StickerSourceAttachment | null };

    const coord = await this.ctx.storage.transaction(async (): Promise<SaveCoord> => {
      const idem = this.ctx.storage.sql
        .exec(
          "SELECT request_hash, status, response_json FROM idempotency_keys WHERE operation='sticker.save' AND operation_id=?",
          operationId,
        )
        .toArray()[0] as { request_hash: string; status: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" };
        if (idem.status === "completed" && idem.response_json) {
          return { kind: "cached", responseJson: idem.response_json };
        }
      }

      const ownRow = this.ctx.storage.sql
        .exec(
          "SELECT attachment_id, url, mime_type, width, height, size_bytes, blurhash FROM pending_attachments WHERE attachment_id=? AND owner_user_id=? AND status='finalized'",
          attachmentId,
          userId,
        )
        .toArray()[0] as StickerSourceAttachment | undefined;
      return { kind: "resolve", projection: ownRow ?? null };
    });

    if (coord.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
    }
    if (coord.kind === "cached") {
      return JSON.parse(coord.responseJson) as SaveStickerResult;
    }

    let projection = coord.projection;
    if (!projection) {
      try {
        const resBody = await this.env.CHAT_CHANNEL.getByName(channelId).resolveVisibleAttachment({
          user_id: userId,
          attachment_id: attachmentId,
        });
        projection = resBody.attachment;
      } catch (err) {
        const apiErr = apiErrorFromRemote(err);
        throw apiErr ?? new ApiError("STICKER_NOT_FOUND", "sticker source not found");
      }
    }

    const newStickerId = uuidv7();
    const saveResult = await this.ctx.storage.transaction(async () => {
      const idem = this.ctx.storage.sql
        .exec(
          "SELECT request_hash, status, response_json FROM idempotency_keys WHERE operation='sticker.save' AND operation_id=?",
          operationId,
        )
        .toArray()[0] as { request_hash: string; status: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" as const };
        if (idem.status === "completed" && idem.response_json) {
          return { kind: "done" as const, responseJson: idem.response_json, archived: false };
        }
      }

      const existing = this.ctx.storage.sql
        .exec(
          "SELECT sticker_id, deleted_at FROM personal_stickers WHERE user_id=? AND attachment_id=?",
          userId,
          projection.attachment_id,
        )
        .toArray()[0] as { sticker_id: string; deleted_at: string | null } | undefined;
      const stickerId = existing?.sticker_id ?? newStickerId;
      let stickerMutated = false;
      if (existing) {
        if (existing.deleted_at !== null) {
          this.ctx.storage.sql.exec(
            "UPDATE personal_stickers SET deleted_at=NULL, blurhash=?, created_at=? WHERE sticker_id=?",
            projection.blurhash ?? null,
            now,
            stickerId,
          );
          stickerMutated = true;
        }
      } else {
        const countRow = this.ctx.storage.sql
          .exec("SELECT COUNT(*) AS n FROM personal_stickers WHERE user_id=? AND deleted_at IS NULL", userId)
          .toArray()[0] as { n: number };
        if (countRow.n >= MAX_PERSONAL_STICKERS) return { kind: "limit" as const };
        this.ctx.storage.sql.exec(
          `INSERT INTO personal_stickers (
            sticker_id, user_id, attachment_id, url, mime_type, width, height, size_bytes, blurhash, created_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          stickerId,
          userId,
          projection.attachment_id,
          projection.url,
          projection.mime_type,
          projection.width ?? null,
          projection.height ?? null,
          projection.size_bytes,
          projection.blurhash ?? null,
          now,
        );
        stickerMutated = true;
      }

      if (stickerMutated) {
        const stickerRow = readPersonalStickerRow(this.ctx, stickerId);
        if (stickerRow) {
          appendUserDirectoryArchive(this.ctx, userId, now, (sourceSeq) => {
            const rowVersion = rowVersionFromSeq(sourceSeq);
            return [
              archiveUpsert(
                "chat_personal_stickers",
                { sticker_id: stickerRow.sticker_id },
                rowVersion,
                personalStickerArchiveAfter(stickerRow),
              ),
            ];
          });
        }
      }

      const json = JSON.stringify({
        sticker: {
          sticker_id: stickerId,
          attachment: {
            attachment_id: projection.attachment_id,
            url: projection.url,
            mime_type: projection.mime_type,
            width: projection.width,
            height: projection.height,
            size_bytes: projection.size_bytes,
            blurhash: projection.blurhash,
          },
          created_at: now,
        },
      });
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO idempotency_keys (operation, operation_id, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('sticker.save', ?, ?, 'completed', ?, ?, COALESCE((SELECT created_at FROM idempotency_keys WHERE operation='sticker.save' AND operation_id=?), ?), ?, ?)",
        operationId,
        requestHash,
        channelId,
        json,
        operationId,
        now,
        now,
        idemExpiresAt,
      );
      return { kind: "done" as const, responseJson: json, archived: stickerMutated };
    });

    if (saveResult.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
    }
    if (saveResult.kind === "limit") {
      throw new ApiError("STICKER_LIBRARY_LIMIT_EXCEEDED", "personal sticker library is full");
    }
    if (saveResult.archived) await this.scheduleArchiveAlarm();
    return JSON.parse(saveResult.responseJson) as SaveStickerResult;
  }

  async deleteSticker(userId: string, input: { operation_id: string; sticker_id: string }): Promise<DeleteStickerResult> {
    if (!userId) throw new ApiError("FORBIDDEN", "missing X-Verified-User-Id");
    const stickerId = input.sticker_id ?? "";
    const operationId = input.operation_id ?? "";
    if (!stickerId) {
      throw new ApiError("INVALID_MESSAGE", "sticker_id required");
    }
    if (!operationId) {
      throw new ApiError("INVALID_MESSAGE", "operation_id required");
    }

    const requestHash = JSON.stringify({ sticker_id: stickerId });
    const now = this.nowIso();
    const idemExpiresAt = idempotencyExpiresAt(Date.now());
    const responseJson = JSON.stringify({ sticker_id: stickerId, deleted: true });

    const result = await this.ctx.storage.transaction(async () => {
      const idem = this.ctx.storage.sql
        .exec(
          "SELECT request_hash, status, response_json FROM idempotency_keys WHERE operation='sticker.delete' AND operation_id=?",
          operationId,
        )
        .toArray()[0] as { request_hash: string; status: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" as const };
        return { kind: "done" as const, responseJson: idem.response_json ?? responseJson, archived: false };
      }

      const row = this.ctx.storage.sql
        .exec("SELECT user_id, deleted_at FROM personal_stickers WHERE sticker_id=?", stickerId)
        .toArray()[0] as { user_id: string; deleted_at: string | null } | undefined;
      if (row && row.user_id !== userId) return { kind: "forbidden" as const };
      const hadActiveRow = row !== undefined && row.deleted_at === null;
      if (hadActiveRow) {
        this.ctx.storage.sql.exec(
          "UPDATE personal_stickers SET deleted_at=? WHERE sticker_id=? AND user_id=? AND deleted_at IS NULL",
          now,
          stickerId,
          userId,
        );
        const stickerRow = readPersonalStickerRow(this.ctx, stickerId);
        if (stickerRow) {
          appendUserDirectoryArchive(this.ctx, userId, now, (sourceSeq) => {
            const rowVersion = rowVersionFromSeq(sourceSeq);
            return [
              archiveUpsert(
                "chat_personal_stickers",
                { sticker_id: stickerRow.sticker_id },
                rowVersion,
                personalStickerArchiveAfter(stickerRow),
              ),
            ];
          });
        }
      }
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO idempotency_keys (operation, operation_id, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('sticker.delete', ?, ?, 'completed', NULL, ?, ?, ?, ?)",
        operationId,
        requestHash,
        responseJson,
        now,
        now,
        idemExpiresAt,
      );
      return { kind: "done" as const, responseJson, archived: hadActiveRow };
    });

    if (result.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
    }
    if (result.kind === "forbidden") {
      throw new ApiError("FORBIDDEN", "sticker does not belong to user");
    }
    if (result.archived) await this.scheduleArchiveAlarm();
    return JSON.parse(result.responseJson) as DeleteStickerResult;
  }

  async presignUpload(
    userId: string,
    idempotencyKey: string,
    namespace: "attachment" | "avatar",
    body: {
      filename?: string;
      mime_type?: string;
      size_bytes?: number;
      width?: number | null;
      height?: number | null;
      blurhash?: string;
    },
  ): Promise<UploadPresignResult> {
    if (!userId) throw new ApiError("FORBIDDEN", "missing X-Verified-User-Id");
    const uploadKind = namespace === "avatar" ? "avatar" : "image";
    const presignOperation = uploadKind === "avatar" ? "avatar.presign" : "attachment.presign";
    if (!idempotencyKey) {
      throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
    }

    const validation = validatePresignBody(body);
    if (!validation.ok) {
      throw new ApiError(validation.code, validation.error, { httpStatus: HTTP_STATUS_BY_CODE[validation.code] ?? 422 });
    }
    const { filename, mimeType, sizeBytes, width, height, blurhash } = validation;
    const requestHash = JSON.stringify({ filename, mimeType, sizeBytes, width, height, blurhash });
    const now = this.nowIso();
    const expiresAt = idempotencyExpiresAt(Date.now());

    type PresignCoord =
      | { kind: "conflict" }
      | { kind: "cached"; responseJson: string }
      | { kind: "pending"; attachmentId: string }
      | { kind: "new"; attachmentId: string; storageKey: string };

    const coord = await this.ctx.storage.transaction(async (): Promise<PresignCoord> => {
      const row = this.ctx.storage.sql
        .exec(
          `SELECT request_hash, status, attachment_id, response_json FROM idempotency_keys WHERE operation='${presignOperation}' AND operation_id=?`,
          idempotencyKey,
        )
        .toArray()[0] as
        | { request_hash: string; status: string; attachment_id: string | null; response_json: string | null }
        | undefined;

      if (row) {
        if (row.request_hash !== requestHash) return { kind: "conflict" };
        if (row.status === "completed" && row.response_json) {
          return { kind: "cached", responseJson: row.response_json };
        }
        return { kind: "pending", attachmentId: row.attachment_id ?? "" };
      }

      const attachmentId = uuidv7();
      const storageKey = uploadKind === "avatar"
        ? avatarObjectKey(attachmentId, filename, mimeType)
        : attachmentObjectKey(attachmentId, filename, mimeType);
      const publicUrl = uploadKind === "avatar"
        ? avatarPublicUrl(this.env.S3_PUBLIC_BASE, attachmentId, filename, mimeType)
        : attachmentPublicUrl(this.env.S3_PUBLIC_BASE, attachmentId, filename, mimeType);
      this.ctx.storage.sql.exec(
        `INSERT INTO pending_attachments
          (attachment_id, owner_user_id, kind, filename, mime_type, size_bytes,
           width, height, blurhash, storage_key, url, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        attachmentId,
        userId,
        uploadKind,
        filename,
        mimeType,
        sizeBytes,
        width ?? null,
        height ?? null,
        blurhash ?? null,
        storageKey,
        publicUrl,
        expiresAt,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO idempotency_keys (operation, operation_id, request_hash, status, attachment_id, response_json, created_at, updated_at, expires_at) VALUES ('${presignOperation}', ?, ?, 'pending', ?, NULL, ?, ?, ?)`,
        idempotencyKey,
        requestHash,
        attachmentId,
        now,
        now,
        expiresAt,
      );
      return { kind: "new", attachmentId, storageKey };
    });

    if (coord.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "Idempotency-Key reused with different body");
    }
    if (coord.kind === "cached") {
      return JSON.parse(coord.responseJson) as UploadPresignResult;
    }

    const attachmentId = coord.attachmentId;
    const storageKey = coord.kind === "new" ? coord.storageKey : undefined;
    let rowToUse: { storage_key: string; mime_type: string } | undefined;
    if (storageKey === undefined) {
      rowToUse = this.ctx.storage.sql
        .exec("SELECT storage_key, mime_type FROM pending_attachments WHERE attachment_id=? AND owner_user_id=?", attachmentId, userId)
        .toArray()[0] as { storage_key: string; mime_type: string } | undefined;
      if (!rowToUse) {
        throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "attachment not found", { httpStatus: 415 });
      }
    }

    const presign = await presignPutUrl(
      this.env,
      storageKey ?? rowToUse!.storage_key,
      coord.kind === "new" ? mimeType : rowToUse!.mime_type,
    );
    const responseJson = JSON.stringify({
      attachment_id: attachmentId,
      upload_url: presign.upload_url,
      upload_method: "PUT",
      upload_headers: presign.upload_headers,
      expires_at: presign.expires_at,
    });

    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(
        `UPDATE idempotency_keys SET status='completed', response_json=?, updated_at=? WHERE operation='${presignOperation}' AND operation_id=?`,
        responseJson,
        now,
        idempotencyKey,
      );
    });

    await this.scheduleAlarm();
    return JSON.parse(responseJson) as UploadPresignResult;
  }

  async finalizeUpload(userId: string, idempotencyKey: string, body: { attachment_id: string; etag?: string }): Promise<FinalizeUploadResult> {
    if (!userId) throw new ApiError("FORBIDDEN", "missing X-Verified-User-Id");
    const attachmentId = body.attachment_id;
    if (!attachmentId) {
      throw new ApiError("INVALID_MESSAGE", "attachment_id required");
    }
    if (!idempotencyKey) {
      throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
    }

    const requestHash = JSON.stringify({ attachment_id: attachmentId, etag: body.etag ?? null });
    const now = this.nowIso();

    type FinalizeCoord =
      | { kind: "conflict" }
      | { kind: "cached"; responseJson: string }
      | { kind: "not_found" }
      | { kind: "forbidden" }
      | { kind: "unsupported" }
      | { kind: "pending"; row: AttachmentRow };

    const coord = await this.ctx.storage.transaction(async (): Promise<FinalizeCoord> => {
      const idem = this.ctx.storage.sql
        .exec(
          "SELECT request_hash, status, response_json FROM idempotency_keys WHERE operation='attachment.finalize' AND operation_id=?",
          idempotencyKey,
        )
        .toArray()[0] as { request_hash: string; status: string; response_json: string | null } | undefined;

      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" };
        if (idem.status === "completed" && idem.response_json) {
          return { kind: "cached", responseJson: idem.response_json };
        }
      }

      const row = this.ctx.storage.sql
        .exec(
          "SELECT attachment_id, owner_user_id, kind, filename, mime_type, size_bytes, width, height, blurhash, storage_key, url, status, created_at FROM pending_attachments WHERE attachment_id=?",
          attachmentId,
        )
        .toArray()[0] as AttachmentRow | undefined;
      if (!row) return { kind: "not_found" };
      if (row.owner_user_id !== userId) return { kind: "forbidden" };
      if (row.status === "finalized") {
        const projection = projectFinalizedAttachmentForBrowser(row);
        const responseJson = JSON.stringify({ attachment: projection });
        if (!idem) {
          const expiresAt = idempotencyExpiresAt(Date.now());
          this.ctx.storage.sql.exec(
            "INSERT INTO idempotency_keys (operation, operation_id, request_hash, status, attachment_id, response_json, created_at, updated_at, expires_at) VALUES ('attachment.finalize', ?, ?, 'completed', ?, ?, ?, ?, ?)",
            idempotencyKey,
            requestHash,
            attachmentId,
            responseJson,
            now,
            now,
            expiresAt,
          );
        }
        return { kind: "cached", responseJson };
      }
      if (row.status !== "pending") return { kind: "unsupported" };
      return { kind: "pending", row };
    });

    if (coord.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "Idempotency-Key reused with different body");
    }
    if (coord.kind === "cached") {
      return JSON.parse(coord.responseJson) as FinalizeUploadResult;
    }
    if (coord.kind === "not_found") {
      throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "attachment not found", { httpStatus: 415 });
    }
    if (coord.kind === "forbidden") {
      throw new ApiError("FORBIDDEN", "attachment does not belong to user");
    }
    if (coord.kind === "unsupported") {
      throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "attachment cannot be finalized", { httpStatus: 415 });
    }

    const head = await headObjectKey(this.env, coord.row.storage_key, coord.row.mime_type, coord.row.size_bytes);
    if (!head.ok) {
      throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "S3 object missing or mismatch", { httpStatus: 415 });
    }

    const responseJson = await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec("UPDATE pending_attachments SET status='finalized' WHERE attachment_id=?", attachmentId);
      const finalizedRow = this.ctx.storage.sql
        .exec(
          "SELECT attachment_id, owner_user_id, kind, filename, mime_type, size_bytes, width, height, blurhash, storage_key, url, status, created_at FROM pending_attachments WHERE attachment_id=?",
          attachmentId,
        )
        .toArray()[0] as AttachmentRow | undefined;
      const projection = projectFinalizedAttachmentForBrowser(finalizedRow!);
      const json = JSON.stringify({ attachment: projection });
      appendUserDirectoryArchive(this.ctx, userId, now, (sourceSeq) => {
        const rowVersion = rowVersionFromSeq(sourceSeq);
        return [
          archiveUpsert(
            "chat_attachments",
            { attachment_id: finalizedRow!.attachment_id },
            rowVersion,
            attachmentArchiveAfter(finalizedRow!),
          ),
        ];
      });
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO idempotency_keys (operation, operation_id, request_hash, status, attachment_id, response_json, created_at, updated_at, expires_at) VALUES ('attachment.finalize', ?, ?, 'completed', ?, ?, COALESCE((SELECT created_at FROM idempotency_keys WHERE operation='attachment.finalize' AND operation_id=?), ?), ?, ?)",
        idempotencyKey,
        requestHash,
        attachmentId,
        json,
        idempotencyKey,
        now,
        now,
        idempotencyExpiresAt(Date.now()),
      );
      return json;
    });

    await this.scheduleArchiveAlarm();
    return JSON.parse(responseJson) as FinalizeUploadResult;
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  resolveSticker(userId: string, stickerId: string): ResolvedSticker {
    if (!stickerId) {
      throw new ApiError("INVALID_MESSAGE", "sticker_id required");
    }
    const row = this.ctx.storage.sql
      .exec(
        "SELECT sticker_id, attachment_id, url, mime_type, width, height, size_bytes, blurhash FROM personal_stickers WHERE sticker_id=? AND user_id=? AND deleted_at IS NULL",
        stickerId,
        userId,
      )
      .toArray()[0] as
      | { sticker_id: string; attachment_id: string; url: string; mime_type: string; width: number | null; height: number | null; size_bytes: number; blurhash: string | null }
      | undefined;
    if (!row) {
      throw new ApiError("STICKER_NOT_FOUND", "sticker not found");
    }
    return row;
  }

  getAttachment(userId: string, attachmentId: string): AttachmentResult {
    if (!attachmentId) {
      throw new ApiError("INVALID_MESSAGE", "attachment_id required");
    }
    const row = this.ctx.storage.sql
      .exec(
        "SELECT attachment_id, owner_user_id, kind, filename, mime_type, size_bytes, width, height, blurhash, storage_key, url, status, created_at FROM pending_attachments WHERE attachment_id=? AND owner_user_id=?",
        attachmentId,
        userId,
      )
      .toArray()[0] as AttachmentRow | undefined;
    if (!row || row.status !== "finalized") {
      throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "attachment not finalized", { httpStatus: 415 });
    }
    return { attachment: row };
  }

  private pendingAttachmentDueTables(
    handler: (rows: Array<{ attachment_id: string; storage_key: string }>) => Promise<void>,
  ): DueTable[] {
    return [
      isoDueTable("pending_attachments", "expires_at", "status", "pending", async (rows) => {
        await handler(rows as unknown as Array<{ attachment_id: string; storage_key: string }>);
      }),
    ];
  }

  private async scheduleAlarm(): Promise<void> {
    await scheduleNextAlarm(
      this.ctx,
      [...this.pendingAttachmentDueTables(async () => Promise.resolve()), archiveOutboxDueTable()],
      { respectExistingAlarm: true },
    );
  }

  async scheduleArchiveAlarm(): Promise<void> {
    await this.scheduleAlarm();
  }

  async alarm(): Promise<void> {
    const now = this.nowIso();
    await runDueJobs(this.ctx, now, this.pendingAttachmentDueTables(async (expired) => {
      for (const row of expired) {
        try {
          await deleteObject(this.env, row.storage_key);
        } catch (err) {
          logSwallowedError("pending_attachment_object_delete_failed", err, {
            attachment_id: row.attachment_id,
            storage_key: row.storage_key,
          });
        }
        this.ctx.storage.sql.exec("DELETE FROM pending_attachments WHERE attachment_id=?", row.attachment_id);
      }
    }));
    try {
      await flushArchiveOutboxToQueue(this.ctx, this.env.CHAT_ARCHIVE_QUEUE, { now });
    } catch (err) {
      logSwallowedError("user_directory_archive_flush_failed", err);
    }
    await this.scheduleAlarm();
  }
}
