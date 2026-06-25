import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { uuidv7 } from "../ids/uuidv7";
import { execSchema } from "./sql";
import { projectAttachmentForBrowser, type AttachmentRow } from "../chat/attachment-projection";
import { presignPutUrl, headObject, deleteObject } from "../s3/presign";
import { HTTP_STATUS_BY_CODE } from "../errors";

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024; // 20 MiB

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

function validatePresignBody(body: {
  filename?: string;
  mime_type?: string;
  size_bytes?: number;
  width?: number;
  height?: number;
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
  return {
    ok: true,
    filename,
    mimeType,
    sizeBytes,
    width: body.width,
    height: body.height,
    blurhash: body.blurhash,
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS my_channels (
    user_id TEXT NOT NULL, channel_id TEXT NOT NULL, kind TEXT NOT NULL,
    joined_at TEXT NOT NULL, left_at TEXT, removed_at TEXT,
    status TEXT NOT NULL DEFAULT 'active', membership_version INTEGER NOT NULL,
    last_read_event_id TEXT, PRIMARY KEY (user_id, channel_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_my_channels ON my_channels(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_my_channels_active ON my_channels(user_id) WHERE status='active'`,
  `CREATE TABLE IF NOT EXISTS pending_attachments (
    attachment_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL,
    filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    width INTEGER, height INTEGER, blurhash TEXT, storage_key TEXT NOT NULL, url TEXT NOT NULL,
    status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_attachments(status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    operation TEXT NOT NULL, operation_id TEXT NOT NULL, -- HTTP Idempotency-Key or WS command_id
    request_hash TEXT NOT NULL, status TEXT NOT NULL,
    channel_id TEXT, response_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ud_idem_expires ON idempotency_keys(expires_at)`,
];

export class UserDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    execSchema(this.ctx, SCHEMA);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (url.pathname === "/my-channels") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      const rows = this.ctx.storage.sql
        .exec("SELECT channel_id, kind, last_read_event_id, membership_version FROM my_channels WHERE user_id = ? AND status = 'active'", userId)
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
        action: "join" | "leave";
        channel_id: string;
        kind: string;
        membership_version: number;
      };

      if (!body.channel_id || !body.kind) {
        return Response.json({ error: "invalid payload" }, { status: 400 });
      }
      if (body.action !== "join" && body.action !== "leave") {
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
      const expiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();

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
        if (!row || row.status !== "active") return { forbidden: true };

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

    if (url.pathname === "/internal/attachment-presign") {
      const userId = request.headers.get("X-Verified-User-Id");
      if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
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
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
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
            "SELECT request_hash, status, channel_id, response_json FROM idempotency_keys WHERE operation='attachment.presign' AND operation_id=?",
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
        const storageKey = `chat/${attachmentId}`;
        const publicUrl = `${this.env.S3_PUBLIC_BASE}/${this.env.S3_BUCKET}/${storageKey}`;
        this.ctx.storage.sql.exec(
          `INSERT INTO pending_attachments
            (attachment_id, owner_user_id, kind, filename, mime_type, size_bytes,
             width, height, blurhash, storage_key, url, status, expires_at, created_at)
           VALUES (?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          attachmentId,
          userId,
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
          "INSERT INTO idempotency_keys (operation, operation_id, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('attachment.presign', ?, ?, 'pending', ?, NULL, ?, ?, ?)",
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
          "UPDATE idempotency_keys SET status='completed', response_json=?, updated_at=? WHERE operation='attachment.presign' AND operation_id=?",
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
          const projection = projectAttachmentForBrowser(row);
          const responseJson = JSON.stringify({ attachment: projection });
          if (!idem) {
            // No prior idempotency row but attachment is already finalized: create one so future retries hit cache.
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
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
      const head = await headObject(this.env, row.url, row.mime_type, row.size_bytes);
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
        const projection = projectAttachmentForBrowser(finalizedRow!);
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
          new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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
