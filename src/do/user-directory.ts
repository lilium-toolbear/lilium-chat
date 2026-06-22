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

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    // Phase 0: no pending attachment GC yet.
  }
}
