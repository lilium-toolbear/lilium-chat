import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { uuidv7 } from "../ids/uuidv7";
import { handleSchemaVersionRequest } from "./sql-migrations";
import { migrateUserDirectorySchema } from "./migrations/user-directory";
import { projectAttachmentForBrowser, projectFinalizedAttachmentForBrowser, type AttachmentRow } from "../chat/attachment-projection";
import { presignPutUrl, headObjectKey, deleteObject } from "../s3/presign";
import { attachmentObjectKey, attachmentPublicUrl, avatarObjectKey, avatarPublicUrl } from "../s3/object-key";
import { HTTP_STATUS_BY_CODE } from "../errors";
import { canonicalDmPairKey, isUuidString } from "../chat/dm-pair";
import { resolveUserSummaries } from "../profile/resolve";
import { idempotencyExpiresAt } from "../contract/idempotency";

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024; // 20 MiB
const MAX_PERSONAL_STICKERS = 200; // contract §8.3 sticker library limit

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
    migrateUserDirectorySchema(this.ctx);
  }

  async fetch(request: Request): Promise<Response> {
    const schemaVersion = handleSchemaVersionRequest(this.ctx, "UserDirectory", request);
    if (schemaVersion) return schemaVersion;

    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (url.pathname === "/internal/test-my-channels-failure") {
      if (request.headers.get("X-Test-Only") !== "1") return new Response("forbidden", { status: 403 });
      const body = await request.json().catch(() => ({})) as { enabled?: boolean };
      if (body.enabled === false) {
        await this.ctx.storage.delete("test:my-channels-failure");
      } else {
        await this.ctx.storage.put("test:my-channels-failure", true);
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/my-channels") {
      if (await this.ctx.storage.get("test:my-channels-failure") === true) {
        return new Response("test my-channels failure", { status: 503 });
      }
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      const rows = this.ctx.storage.sql
        .exec("SELECT channel_id, kind, last_read_event_id, membership_version FROM my_channels WHERE user_id = ? AND status IN ('active', 'dissolved')", userId)
        .toArray() as {
          channel_id: string;
          kind: string;
          last_read_event_id: string | null;
          membership_version: number;
        }[];
      return Response.json({ items: rows });
    }

    if (url.pathname === "/internal/upsert-channel") {
      const userId = request.headers.get("X-Verified-User-Id");
      if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const now = new Date().toISOString();

      const body = (await request.json()) as {
        action: "join" | "leave" | "dissolve";
        channel_id: string;
        kind: string;
        membership_version: number;
      };

      if (!body.channel_id || !body.kind) {
        return Response.json({ error: "invalid payload" }, { status: 400 });
      }
      if (body.action !== "join" && body.action !== "leave" && body.action !== "dissolve") {
        return Response.json({ error: "unsupported action" }, { status: 400 });
      }

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
          return Response.json({ ok: true });
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
            return Response.json({ ok: true });
          }

          this.ctx.storage.sql.exec(
            "UPDATE my_channels SET status='active', left_at=NULL, removed_at=NULL, membership_version=?, joined_at=COALESCE(joined_at, ?), kind=? WHERE user_id=? AND channel_id=?",
            body.membership_version,
            now,
            body.kind,
            userId,
            body.channel_id,
          );
          return Response.json({ ok: true });
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
            return Response.json({ ok: true });
          }

          this.ctx.storage.sql.exec(
            "UPDATE my_channels SET status='dissolved', left_at=NULL, removed_at=NULL, membership_version=?, kind=? WHERE user_id=? AND channel_id=?",
            body.membership_version,
            body.kind,
            userId,
            body.channel_id,
          );
          return Response.json({ ok: true });
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
        return Response.json({ ok: true });
      });
    }

    if (url.pathname === "/internal/channel-create-coordinate") {
      const creatorUserId = request.headers.get("X-Verified-User-Id");
      if (creatorUserId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const b = (await request.json()) as {
        idempotency_key: string; title: string; topic: string | null;
        avatar_attachment_id: string | null; visibility: string;
        initial_members: Array<{ user_id: string; role: string }>;
      };
      if (!b.idempotency_key) return Response.json({ error: { code: "INVALID_MESSAGE", message: "idempotency_key required", retryable: false } }, { status: 422 });

      const requestHash = JSON.stringify({
        title: b.title, topic: b.topic ?? null, avatar_attachment_id: b.avatar_attachment_id ?? null,
        visibility: b.visibility ?? "private", initial_members: b.initial_members ?? [],
      });
      const now = new Date().toISOString();
      const expiresAt = idempotencyExpiresAt(Date.parse(now));

      // Txn 1: resolve idempotency state + mint channel_id (if new).
      const coord = await this.ctx.storage.transaction(async () => {
        const row = this.ctx.storage.sql
          .exec("SELECT request_hash, status, channel_id, response_json FROM idempotency_keys WHERE operation='channel.create' AND operation_id=?", b.idempotency_key)
          .toArray()[0] as { request_hash: string; status: string; channel_id: string | null; response_json: string | null } | undefined;

        if (row) {
          if (row.request_hash !== requestHash) {
            return { kind: "conflict" as const };
          }
          if (row.status === "completed" && row.response_json) {
            return { kind: "cached" as const, responseJson: row.response_json };
          }
          // status === 'creating' (crash window) — reuse the persisted channel_id.
          return { kind: "creating" as const, channelId: row.channel_id ?? "" };
        }

        const channelId = uuidv7();
        this.ctx.storage.sql.exec(
          "INSERT INTO idempotency_keys (operation, operation_id, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('channel.create', ?, ?, 'creating', ?, NULL, ?, ?, ?)",
          b.idempotency_key, requestHash, channelId, now, now, expiresAt,
        );
        return { kind: "creating" as const, channelId };
      });

      if (coord.kind === "conflict") {
        return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
      }
      if (coord.kind === "cached") {
        return new Response(coord.responseJson, { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Call ChatChannel(channel_id).createChannel — idempotent via channel_meta existence.
      const channelId = coord.channelId;
      const chStub = this.env.CHAT_CHANNEL.getByName(channelId);
      const createRes = await chStub.fetch(new Request("https://x/internal/create-channel", {
        method: "POST",
        headers: { "X-Verified-User-Id": creatorUserId, "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId, creator_user_id: creatorUserId,
          title: b.title, topic: b.topic ?? null, avatar_attachment_id: b.avatar_attachment_id ?? null,
          visibility: b.visibility ?? "private", initial_members: b.initial_members ?? [],
        }),
      }));
      if (!createRes.ok) {
        // Leave row as 'creating' — client retry re-calls createChannel (idempotent) and recovers.
        const text = await createRes.text();
        return new Response(text, { status: createRes.status });
      }
      const createBody = await createRes.text();

      // Txn 2: mark completed with the create response.
      await this.ctx.storage.transaction(async () => {
        this.ctx.storage.sql.exec(
          "UPDATE idempotency_keys SET status='completed', response_json=?, updated_at=? WHERE operation='channel.create' AND operation_id=?",
          createBody, now, b.idempotency_key,
        );
      });

      return new Response(createBody, { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/internal/open-dm") {
      const currentUserId = request.headers.get("X-Verified-User-Id");
      if (currentUserId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const b = (await request.json()) as { idempotency_key: string; recipient_user_id: string };
      if (!b.idempotency_key) {
        return Response.json({ error: { code: "INVALID_MESSAGE", message: "idempotency_key required", retryable: false } }, { status: 422 });
      }

      const requestHash = JSON.stringify({ recipient_user_id: b.recipient_user_id });
      const now = new Date().toISOString();
      const expiresAt = idempotencyExpiresAt(Date.parse(now));

      const coord = await this.ctx.storage.transaction(async () => {
        const row = this.ctx.storage.sql
          .exec("SELECT request_hash, status, response_json FROM idempotency_keys WHERE operation='dm.open' AND operation_id=?", b.idempotency_key)
          .toArray()[0] as { request_hash: string; status: string; response_json: string | null } | undefined;

        if (row) {
          if (row.request_hash !== requestHash) {
            return { kind: "conflict" as const };
          }
          if (row.status === "completed" && row.response_json) {
            return { kind: "cached" as const, responseJson: row.response_json };
          }
          return { kind: "resume" as const };
        }

        return { kind: "new" as const };
      });

      if (coord.kind === "conflict") {
        return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
      }
      if (coord.kind === "cached") {
        return Response.json({ kind: "cached", response: JSON.parse(coord.responseJson) });
      }

      if (coord.kind === "new") {
        if (!b.recipient_user_id || !isUuidString(b.recipient_user_id)) {
          return Response.json({ error: { code: "INVALID_DM_TARGET", message: "invalid recipient_user_id", retryable: false } }, { status: 422 });
        }
        if (b.recipient_user_id === currentUserId) {
          return Response.json({ error: { code: "INVALID_DM_TARGET", message: "cannot open DM with yourself", retryable: false } }, { status: 422 });
        }

        const recipientMap = await resolveUserSummaries([b.recipient_user_id], this.env);
        if (!recipientMap.has(b.recipient_user_id)) {
          return Response.json({ error: { code: "DM_TARGET_NOT_FOUND", message: "recipient user not found", retryable: false } }, { status: 404 });
        }

        await this.ctx.storage.transaction(async () => {
          this.ctx.storage.sql.exec(
            "INSERT INTO idempotency_keys (operation, operation_id, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('dm.open', ?, ?, 'creating', NULL, NULL, ?, ?, ?)",
            b.idempotency_key, requestHash, now, now, expiresAt,
          );
        });
      }

      if (!b.recipient_user_id || !isUuidString(b.recipient_user_id)) {
        return Response.json({ error: { code: "INVALID_DM_TARGET", message: "invalid recipient_user_id", retryable: false } }, { status: 422 });
      }
      const { pair_key, user_low, user_high } = canonicalDmPairKey(currentUserId, b.recipient_user_id);
      const dmStub = this.env.DM_DIRECTORY.getByName(pair_key);
      const dmRes = await dmStub.fetch(new Request("https://x/internal/get-or-create-dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_a: user_low, user_b: user_high, created_by: currentUserId }),
      }));
      if (!dmRes.ok) {
        const text = await dmRes.text();
        return new Response(text, { status: dmRes.status });
      }
      const dmBody = await dmRes.json() as { channel_id: string; status: "active" | "creating"; created: boolean };

      const chStub = this.env.CHAT_CHANNEL.getByName(dmBody.channel_id);
      const createRes = await chStub.fetch(new Request("https://x/internal/create-dm", {
        method: "POST",
        headers: { "X-Verified-User-Id": currentUserId, "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: dmBody.channel_id,
          user_a: user_low,
          user_b: user_high,
          created_by: currentUserId,
        }),
      }));
      if (!createRes.ok) {
        const text = await createRes.text();
        return new Response(text, { status: createRes.status });
      }
      const createBody = await createRes.json() as { joined_at_by_user: Record<string, string> };
      const joinedAt = createBody.joined_at_by_user[currentUserId];
      if (!joinedAt) {
        return Response.json({ error: { code: "CHAT_WORKER_UNAVAILABLE", message: "missing joined_at for opener", retryable: true } }, { status: 503 });
      }

      if (dmBody.status === "creating") {
        const completeRes = await dmStub.fetch(new Request("https://x/internal/complete-dm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pair_key, channel_id: dmBody.channel_id }),
        }));
        if (!completeRes.ok) {
          const text = await completeRes.text();
          return new Response(text, { status: completeRes.status });
        }
      }

      return Response.json({
        kind: "needs_inflate",
        channel_id: dmBody.channel_id,
        joined_at: joinedAt,
        role: "member",
      });
    }

    if (url.pathname === "/internal/open-dm-complete") {
      const currentUserId = request.headers.get("X-Verified-User-Id");
      if (currentUserId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const b = (await request.json()) as { idempotency_key: string; response_json: string };
      const now = new Date().toISOString();
      await this.ctx.storage.transaction(async () => {
        this.ctx.storage.sql.exec(
          "UPDATE idempotency_keys SET status='completed', response_json=?, updated_at=? WHERE operation='dm.open' AND operation_id=?",
          b.response_json, now, b.idempotency_key,
        );
      });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/internal/read-state") {
      const userId = request.headers.get("X-Verified-User-Id");
      if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const b = (await request.json()) as { channel_id: string; last_read_event_id: string };

      // Three-state floor result. The Worker decides whether to emit read_state.updated.
      const floor = await this.ctx.storage.transaction(async (): Promise<
        | { forbidden: true }
        | { stored: string; advanced: boolean }
      > => {
        const row = this.ctx.storage.sql
          .exec("SELECT last_read_event_id, status FROM my_channels WHERE user_id=? AND channel_id=?", userId, b.channel_id)
          .toArray()[0] as { last_read_event_id: string | null; status: string } | undefined;
        if (!row || (row.status !== "active" && row.status !== "dissolved")) return { forbidden: true };

        const current = row.last_read_event_id;
        if (current === null || b.last_read_event_id > current) {
          // advance
          this.ctx.storage.sql.exec("UPDATE my_channels SET last_read_event_id=? WHERE user_id=? AND channel_id=?", b.last_read_event_id, userId, b.channel_id);
          return { stored: b.last_read_event_id, advanced: true };
        }
        if (b.last_read_event_id === current) {
          // identical cursor — no floor change, but no emit anymore: UserConnection handles sync fanout.
          return { stored: current, advanced: false };
        }
        // stale (requested < current) — keep stored floor, no event
        return { stored: current, advanced: false };
      });

      if ("forbidden" in floor) return new Response("forbidden", { status: 403 });
      return Response.json({
        channel_id: b.channel_id,
        last_read_event_id: floor.stored, // ALWAYS the stored floor, never the request cursor (P0-2)
        advanced: floor.advanced,
      });
    }

    if (url.pathname === "/internal/sticker-resolve") {
      const userId = request.headers.get("X-Verified-User-Id");
      if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const stickerId = url.searchParams.get("sticker_id");
      if (!stickerId) {
        return Response.json(
          { error: { code: "INVALID_MESSAGE", message: "sticker_id required", retryable: false } },
          { status: 422 },
        );
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
        return Response.json(
          { error: { code: "STICKER_NOT_FOUND", message: "sticker not found", retryable: false } },
          { status: 404 },
        );
      }
      return Response.json(row);
    }

    if (url.pathname === "/internal/sticker-save") {
      const userId = request.headers.get("X-Verified-User-Id");
      if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const body = (await request.json()) as {
        operation_id?: string;
        channel_id?: string;
        attachment_id?: string;
      };
      const operationId = body.operation_id ?? "";
      const channelId = body.channel_id ?? "";
      const attachmentId = body.attachment_id ?? "";
      if (!operationId || !channelId || !attachmentId) {
        return Response.json(
          { error: { code: "INVALID_MESSAGE", message: "operation_id, channel_id and attachment_id required", retryable: false } },
          { status: 422 },
        );
      }

      const requestHash = JSON.stringify({ channel_id: channelId, attachment_id: attachmentId });
      const now = this.nowIso();
      const idemExpiresAt = idempotencyExpiresAt(Date.now());

      type SaveCoord =
        | { kind: "conflict" }
        | { kind: "cached"; responseJson: string }
        | { kind: "resolve"; projection: StickerSourceAttachment };

      const coord = (await this.ctx.storage.transaction(async () => {
        const idem = this.ctx.storage.sql
          .exec(
            "SELECT request_hash, status, response_json FROM idempotency_keys WHERE operation='sticker.save' AND operation_id=?",
            operationId,
          )
          .toArray()[0] as { request_hash: string; status: string; response_json: string | null } | undefined;
        if (idem) {
          if (idem.request_hash !== requestHash) {
            return { kind: "conflict" as const };
          }
          if (idem.status === "completed" && idem.response_json) {
            return { kind: "cached" as const, responseJson: idem.response_json };
          }
        }

        // Own finalized attachment path: no ChatChannel call needed.
        const ownRow = this.ctx.storage.sql
          .exec(
            "SELECT attachment_id, url, mime_type, width, height, size_bytes, blurhash FROM pending_attachments WHERE attachment_id=? AND owner_user_id=? AND status='finalized'",
            attachmentId,
            userId,
          )
          .toArray()[0] as StickerSourceAttachment | undefined;
        if (ownRow) {
          return { kind: "resolve" as const, projection: ownRow };
        }

        return { kind: "resolve" as const, projection: null as unknown as StickerSourceAttachment };
      })) as SaveCoord;

      if (coord.kind === "conflict") {
        return Response.json(
          { error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } },
          { status: 409 },
        );
      }
      if (coord.kind === "cached") {
        return new Response(coord.responseJson, { status: 200, headers: { "Content-Type": "application/json" } });
      }

      let projection = coord.projection;
      if (!projection) {
        // Channel-visible path: ask ChatChannel for the canonical projection.
        const chatStub = this.env.CHAT_CHANNEL.getByName(channelId);
        const res = await chatStub.fetch(
          new Request(`https://x/internal/resolve-visible-attachment?attachment_id=${encodeURIComponent(attachmentId)}`, {
            headers: { "X-Verified-User-Id": userId },
          }),
        );
        if (!res.ok) {
          const failBody = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; retryable?: boolean } };
          return Response.json(failBody, { status: res.status });
        }
        const resBody = (await res.json()) as { attachment: StickerSourceAttachment };
        projection = resBody.attachment;
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
          if (idem.request_hash !== requestHash) {
            return { kind: "conflict" as const };
          }
          if (idem.status === "completed" && idem.response_json) {
            return { kind: "done" as const, responseJson: idem.response_json };
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
        if (existing) {
          if (existing.deleted_at !== null) {
            // Restoring a soft-deleted row: this does not grow the library, so no limit check.
            this.ctx.storage.sql.exec(
              "UPDATE personal_stickers SET deleted_at=NULL, blurhash=?, created_at=? WHERE sticker_id=?",
              projection.blurhash ?? null,
              now,
              stickerId,
            );
          }
        } else {
          // Library limit applies only to genuinely new items (contract §8.3).
          const countRow = this.ctx.storage.sql
            .exec("SELECT COUNT(*) AS n FROM personal_stickers WHERE user_id=? AND deleted_at IS NULL", userId)
            .toArray()[0] as { n: number };
          if (countRow.n >= MAX_PERSONAL_STICKERS) {
            return { kind: "limit" as const };
          }
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
        return { kind: "done" as const, responseJson: json };
      });

      if (saveResult.kind === "conflict") {
        return Response.json(
          { error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } },
          { status: 409 },
        );
      }
      if (saveResult.kind === "limit") {
        return Response.json(
          { error: { code: "STICKER_LIBRARY_LIMIT_EXCEEDED", message: "personal sticker library is full", retryable: false } },
          { status: 409 },
        );
      }
      return new Response(saveResult.responseJson, { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/internal/sticker-list") {
      const userId = request.headers.get("X-Verified-User-Id");
      if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50")));
      const cursor = url.searchParams.get("cursor");
      const rows = cursor
        ? this.ctx.storage.sql
          .exec(
            "SELECT sticker_id, attachment_id, url, mime_type, width, height, size_bytes, blurhash, created_at FROM personal_stickers WHERE user_id=? AND deleted_at IS NULL AND created_at < ? ORDER BY created_at DESC LIMIT ?",
            userId,
            cursor,
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
      const raw = rows as Array<{
        sticker_id: string;
        attachment_id: string;
        url: string;
        mime_type: string;
        width: number | null;
        height: number | null;
        size_bytes: number;
        blurhash: string | null;
        created_at: string;
      }>;
      const items = raw.map((r) => ({
        sticker_id: r.sticker_id,
        attachment: {
          attachment_id: r.attachment_id,
          url: r.url,
          mime_type: r.mime_type,
          width: r.width,
          height: r.height,
          size_bytes: r.size_bytes,
          blurhash: r.blurhash,
        },
        created_at: r.created_at,
      }));
      const nextCursor = items.length > 0 ? raw[raw.length - 1]!.created_at : null;
      return Response.json({ items, next_cursor: nextCursor });
    }

    if (url.pathname === "/internal/sticker-delete") {
      const userId = request.headers.get("X-Verified-User-Id");
      if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const body = (await request.json()) as { sticker_id?: string; operation_id?: string };
      const stickerId = body.sticker_id ?? "";
      const operationId = body.operation_id ?? "";
      if (!stickerId) {
        return Response.json(
          { error: { code: "INVALID_MESSAGE", message: "sticker_id required", retryable: false } },
          { status: 422 },
        );
      }
      if (!operationId) {
        return Response.json(
          { error: { code: "INVALID_MESSAGE", message: "operation_id required", retryable: false } },
          { status: 422 },
        );
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
          if (idem.request_hash !== requestHash) {
            return { kind: "conflict" as const };
          }
          return { kind: "done" as const, responseJson: idem.response_json ?? responseJson };
        }

        const row = this.ctx.storage.sql
          .exec("SELECT user_id, deleted_at FROM personal_stickers WHERE sticker_id=?", stickerId)
          .toArray()[0] as { user_id: string; deleted_at: string | null } | undefined;
        if (row && row.user_id !== userId) {
          return { kind: "forbidden" as const };
        }
        // Idempotent soft-delete: no-op if already deleted or absent (contract §8.3).
        this.ctx.storage.sql.exec(
          "UPDATE personal_stickers SET deleted_at=? WHERE sticker_id=? AND user_id=? AND deleted_at IS NULL",
          now,
          stickerId,
          userId,
        );
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO idempotency_keys (operation, operation_id, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('sticker.delete', ?, ?, 'completed', NULL, ?, ?, ?, ?)",
          operationId,
          requestHash,
          responseJson,
          now,
          now,
          idemExpiresAt,
        );
        return { kind: "done" as const, responseJson };
      });

      if (result.kind === "conflict") {
        return Response.json(
          { error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } },
          { status: 409 },
        );
      }
      if (result.kind === "forbidden") {
        return Response.json(
          { error: { code: "FORBIDDEN", message: "sticker does not belong to user", retryable: false } },
          { status: 403 },
        );
      }
      return new Response(result.responseJson, { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/internal/attachment-presign" || url.pathname === "/internal/avatar-presign") {
      const userId = request.headers.get("X-Verified-User-Id");
      if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const uploadKind = url.pathname === "/internal/avatar-presign" ? "avatar" : "image";
      const presignOperation = uploadKind === "avatar" ? "avatar.presign" : "attachment.presign";
      const body = (await request.json()) as {
        filename?: string;
        mime_type?: string;
        size_bytes?: number;
        width?: number;
        height?: number;
        blurhash?: string;
      };
      const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
      if (!idempotencyKey) {
        return Response.json(
          { error: { code: "INVALID_MESSAGE", message: "Idempotency-Key required", retryable: false } },
          { status: 422 },
        );
      }

      const validation = validatePresignBody(body);
      if (!validation.ok) {
        return Response.json(
          { error: { code: validation.code, message: validation.error, retryable: false } },
          { status: HTTP_STATUS_BY_CODE[validation.code] ?? 422 },
        );
      }
      const { filename, mimeType, sizeBytes, width, height, blurhash } = validation;

      const requestHash = JSON.stringify({ filename, mimeType, sizeBytes, width, height, blurhash });
      const now = this.nowIso();
      const expiresAt = idempotencyExpiresAt(Date.now());
      const idemExpiresAt = expiresAt;

      type PresignCoord =
        | { kind: "conflict" }
        | { kind: "cached"; responseJson: string }
        | { kind: "pending"; attachmentId: string }
        | { kind: "new"; attachmentId: string; storageKey: string; publicUrl: string };

      // Idempotency + pending row creation (no network inside txn).
      const coord = (await this.ctx.storage.transaction(async () => {
        const row = this.ctx.storage.sql
          .exec(
            `SELECT request_hash, status, channel_id, response_json FROM idempotency_keys WHERE operation='${presignOperation}' AND operation_id=?`,
            idempotencyKey,
          )
          .toArray()[0] as
          | { request_hash: string; status: string; channel_id: string | null; response_json: string | null }
          | undefined;

        if (row) {
          if (row.request_hash !== requestHash) {
            return { kind: "conflict" as const };
          }
          if (row.status === "completed" && row.response_json) {
            return { kind: "cached" as const, responseJson: row.response_json };
          }
          // pending / creating: reuse attachment_id (stored in channel_id column).
          return { kind: "pending" as const, attachmentId: row.channel_id ?? "" };
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
          `INSERT INTO idempotency_keys (operation, operation_id, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('${presignOperation}', ?, ?, 'pending', ?, NULL, ?, ?, ?)`,
          idempotencyKey,
          requestHash,
          attachmentId,
          now,
          now,
          idemExpiresAt,
        );
        return { kind: "new" as const, attachmentId, storageKey, publicUrl };
      })) as PresignCoord;

      if (coord.kind === "conflict") {
        return Response.json(
          { error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency-Key reused with different body", retryable: false } },
          { status: 409 },
        );
      }
      if (coord.kind === "cached") {
        return new Response(coord.responseJson, { status: 200, headers: { "Content-Type": "application/json" } });
      }

      const attachmentId = coord.attachmentId;
      const storageKey = coord.kind === "new" ? coord.storageKey : undefined;
      // For pending/retry, load the pending row to get the current storage_key/url.
      let rowToUse: { storage_key: string; url: string; mime_type: string } | undefined;
      if (storageKey === undefined) {
        rowToUse = this.ctx.storage.sql
          .exec("SELECT storage_key, url, mime_type FROM pending_attachments WHERE attachment_id=? AND owner_user_id=?", attachmentId, userId)
          .toArray()[0] as { storage_key: string; url: string; mime_type: string } | undefined;
        if (!rowToUse) {
          return Response.json(
            { error: { code: "UNSUPPORTED_ATTACHMENT_TYPE", message: "attachment not found", retryable: false } },
            { status: 415 },
          );
        }
      }

      const key = storageKey ?? rowToUse!.storage_key;
      const contentType = coord.kind === "new" ? mimeType : rowToUse!.mime_type;
      const presign = await presignPutUrl(this.env, key, contentType);

      const responseJson = JSON.stringify({
        attachment_id: attachmentId,
        upload_url: presign.upload_url,
        upload_method: "PUT",
        upload_headers: { "Content-Type": contentType },
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

      this.schedulePendingAlarm();
      return new Response(responseJson, { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/internal/attachment-finalize") {
      const userId = request.headers.get("X-Verified-User-Id");
      if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const body = (await request.json()) as { attachment_id?: string; etag?: string };
      const attachmentId = body.attachment_id;
      if (!attachmentId) {
        return Response.json(
          { error: { code: "INVALID_MESSAGE", message: "attachment_id required", retryable: false } },
          { status: 422 },
        );
      }
      const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
      if (!idempotencyKey) {
        return Response.json(
          { error: { code: "INVALID_MESSAGE", message: "Idempotency-Key required", retryable: false } },
          { status: 422 },
        );
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

      // Idempotency + load row (no network inside txn).
      const coord = (await this.ctx.storage.transaction(async () => {
        const idem = this.ctx.storage.sql
          .exec(
            "SELECT request_hash, status, response_json FROM idempotency_keys WHERE operation='attachment.finalize' AND operation_id=?",
            idempotencyKey,
          )
          .toArray()[0] as { request_hash: string; status: string; response_json: string | null } | undefined;

        if (idem) {
          if (idem.request_hash !== requestHash) {
            return { kind: "conflict" as const };
          }
          if (idem.status === "completed" && idem.response_json) {
            return { kind: "cached" as const, responseJson: idem.response_json };
          }
        }

        const row = this.ctx.storage.sql
          .exec(
            "SELECT attachment_id, owner_user_id, kind, filename, mime_type, size_bytes, width, height, blurhash, storage_key, url, status, created_at FROM pending_attachments WHERE attachment_id=?",
            attachmentId,
          )
          .toArray()[0] as AttachmentRow | undefined;

        if (!row) {
          return { kind: "not_found" as const };
        }
        if (row.owner_user_id !== userId) {
          return { kind: "forbidden" as const };
        }
        if (row.status === "finalized") {
          // Idempotent without re-HEAD: build projection and cache it.
          const projection = projectFinalizedAttachmentForBrowser(row);
          const responseJson = JSON.stringify({ attachment: projection });
          if (!idem) {
            // No prior idempotency row but attachment is already finalized: create one so future retries hit cache.
            const expiresAt = idempotencyExpiresAt(Date.now());
            this.ctx.storage.sql.exec(
              "INSERT INTO idempotency_keys (operation, operation_id, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('attachment.finalize', ?, ?, 'completed', ?, ?, ?, ?, ?)",
              idempotencyKey,
              requestHash,
              attachmentId,
              responseJson,
              now,
              now,
              expiresAt,
            );
          }
          return { kind: "cached" as const, responseJson };
        }
        if (row.status !== "pending") {
          return { kind: "unsupported" as const };
        }
        return { kind: "pending" as const, row };
      })) as FinalizeCoord;

      if (coord.kind === "conflict") {
        return Response.json(
          { error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency-Key reused with different body", retryable: false } },
          { status: 409 },
        );
      }
      if (coord.kind === "cached") {
        return new Response(coord.responseJson, { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (coord.kind === "not_found") {
        return Response.json(
          { error: { code: "UNSUPPORTED_ATTACHMENT_TYPE", message: "attachment not found", retryable: false } },
          { status: 415 },
        );
      }
      if (coord.kind === "forbidden") {
        return Response.json(
          { error: { code: "FORBIDDEN", message: "attachment does not belong to user", retryable: false } },
          { status: 403 },
        );
      }
      if (coord.kind === "unsupported") {
        return Response.json(
          { error: { code: "UNSUPPORTED_ATTACHMENT_TYPE", message: "attachment cannot be finalized", retryable: false } },
          { status: 415 },
        );
      }

      const row = coord.row;

      // Network call outside txn.
      const head = await headObjectKey(this.env, row.storage_key, row.mime_type, row.size_bytes);
      if (!head.ok) {
        return Response.json(
          { error: { code: "UNSUPPORTED_ATTACHMENT_TYPE", message: "S3 object missing or mismatch", retryable: false } },
          { status: 415 },
        );
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
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO idempotency_keys (operation, operation_id, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('attachment.finalize', ?, ?, 'completed', ?, ?, COALESCE((SELECT created_at FROM idempotency_keys WHERE operation='attachment.finalize' AND operation_id=?), ?), ?, ?)",
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

      this.schedulePendingAlarm();
      return new Response(responseJson, { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/internal/attachment-get") {
      const userId = request.headers.get("X-Verified-User-Id");
      if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const attachmentId = url.searchParams.get("attachment_id");
      if (!attachmentId) {
        return Response.json(
          { error: { code: "INVALID_MESSAGE", message: "attachment_id required", retryable: false } },
          { status: 422 },
        );
      }
      const row = this.ctx.storage.sql
        .exec(
          "SELECT attachment_id, owner_user_id, kind, filename, mime_type, size_bytes, width, height, blurhash, storage_key, url, status, created_at FROM pending_attachments WHERE attachment_id=? AND owner_user_id=?",
          attachmentId,
          userId,
        )
        .toArray()[0] as AttachmentRow | undefined;
      if (!row || row.status !== "finalized") {
        return Response.json(
          { error: { code: "UNSUPPORTED_ATTACHMENT_TYPE", message: "attachment not finalized", retryable: false } },
          { status: 415 },
        );
      }
      // Internal endpoint: ChatChannel copies the full metadata row into its own attachments table.
      return Response.json({ attachment: row });
    }

    return new Response("not found", { status: 404 });
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private schedulePendingAlarm(): void {
    const earliest = this.ctx.storage.sql
      .exec("SELECT expires_at FROM pending_attachments WHERE status='pending' ORDER BY expires_at ASC LIMIT 1")
      .toArray()[0] as { expires_at: string } | undefined;
    if (earliest) {
      this.ctx.storage.setAlarm(new Date(earliest.expires_at).getTime());
    } else {
      this.ctx.storage.deleteAlarm();
    }
  }

  async alarm(): Promise<void> {
    const now = this.nowIso();
    const expired = this.ctx.storage.sql
      .exec("SELECT attachment_id, storage_key FROM pending_attachments WHERE status='pending' AND expires_at <= ?", now)
      .toArray() as { attachment_id: string; storage_key: string }[];

    for (const row of expired) {
      try {
        await deleteObject(this.env, row.storage_key);
      } catch {
        // GC best-effort: object may already be gone.
      }
      this.ctx.storage.sql.exec("DELETE FROM pending_attachments WHERE attachment_id=?", row.attachment_id);
    }

    this.schedulePendingAlarm();
  }
}
