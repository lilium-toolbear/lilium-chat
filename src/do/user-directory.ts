import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
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
        .exec("SELECT channel_id, kind, last_read_event_id FROM my_channels WHERE user_id = ? AND status = 'active'", userId)
        .toArray() as { channel_id: string; kind: string; last_read_event_id: string | null }[];
      return Response.json({ items: rows });
    }

    if (url.pathname === "/internal/upsert-channel") {
      const userId = request.headers.get("X-Verified-User-Id");
      if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
      const now = new Date().toISOString();

      const body = (await request.json()) as {
        action: string;
        channel_id: string;
        kind: string;
        membership_version: number;
      };
      if (body.action !== "join") {
        return Response.json({ error: "unsupported action" }, { status: 400 });
      }

      if (!body.channel_id || !body.kind) {
        return Response.json({ error: "invalid payload" }, { status: 400 });
      }

      const existing = this.ctx.storage.sql
        .exec("SELECT status, left_at FROM my_channels WHERE user_id = ? AND channel_id = ?", userId, body.channel_id)
        .toArray()[0] as { status: string; left_at: string | null } | undefined;

      if (existing?.status === "active" && existing.left_at === null) {
        return Response.json({ ok: true });
      }

      if (existing === undefined) {
        this.ctx.storage.sql.exec(
          "INSERT INTO my_channels (user_id, channel_id, kind, joined_at, status, membership_version) VALUES (?, ?, ?, ?, 'active', ?)",
          userId,
          body.channel_id,
          body.kind,
          now,
          body.membership_version,
        );
        return Response.json({ ok: true });
      }

      this.ctx.storage.sql.exec(
        "UPDATE my_channels SET status='active', left_at=NULL, joined_at=?, kind=?, membership_version=? WHERE user_id=? AND channel_id=?",
        now,
        body.kind,
        body.membership_version,
        userId,
        body.channel_id,
      );
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    // Phase 0: no pending attachment GC yet.
  }
}
