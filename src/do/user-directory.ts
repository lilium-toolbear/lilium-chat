import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { uuidv7 } from "../ids/uuidv7";
import { execSchema } from "./sql";

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
    width INTEGER, height INTEGER, storage_key TEXT NOT NULL, url TEXT NOT NULL,
    status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_attachments(status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    operation TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL, status TEXT NOT NULL,
    channel_id TEXT, response_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, idempotency_key)
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
          .exec("SELECT request_hash, status, channel_id, response_json FROM idempotency_keys WHERE operation='channel.create' AND idempotency_key=?", b.idempotency_key)
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
          "INSERT INTO idempotency_keys (operation, idempotency_key, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('channel.create', ?, ?, 'creating', ?, NULL, ?, ?, ?)",
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
          "UPDATE idempotency_keys SET status='completed', response_json=?, updated_at=? WHERE operation='channel.create' AND idempotency_key=?",
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
        | { stored: string; advanced: boolean; emit: boolean }
      > => {
        const row = this.ctx.storage.sql
          .exec("SELECT last_read_event_id, status FROM my_channels WHERE user_id=? AND channel_id=?", userId, b.channel_id)
          .toArray()[0] as { last_read_event_id: string | null; status: string } | undefined;
        if (!row || row.status !== "active") return { forbidden: true };

        const current = row.last_read_event_id;
        if (current === null || b.last_read_event_id > current) {
          // advance
          this.ctx.storage.sql.exec("UPDATE my_channels SET last_read_event_id=? WHERE user_id=? AND channel_id=?", b.last_read_event_id, userId, b.channel_id);
          return { stored: b.last_read_event_id, advanced: true, emit: true };
        }
        if (b.last_read_event_id === current) {
          // identical cursor — no floor change, but emit so ChatChannel idempotency can repair a prior failed event
          return { stored: current, advanced: false, emit: true };
        }
        // stale (requested < current) — keep stored floor, no event
        return { stored: current, advanced: false, emit: false };
      });

      if ("forbidden" in floor) return new Response("forbidden", { status: 403 });
      return Response.json({
        channel_id: b.channel_id,
        last_read_event_id: floor.stored, // ALWAYS the stored floor, never the request cursor (P0-2)
        advanced: floor.advanced,
        emit: floor.emit,
      });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    // Phase 0: no pending attachment GC yet.
  }
}
