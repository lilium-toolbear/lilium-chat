import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { handleSchemaVersionRequest } from "./sql-migrations";
import { migrateChannelDirectorySchema } from "./migrations/channel-directory";

interface PublicChannelRow {
  channel_id: string;
  title: string;
  avatar_url: string | null;
  member_count: number;
  last_message_at: string | null;
  status: string;
  updated_at: string;
}

interface ListRow {
  channel_id: string;
  title: string;
  avatar_url: string | null;
  member_count: number;
  last_message_at: string | null;
  status: string;
  updated_at: string;
  last_activity: string;
}

function base64urlEncode(s: string): string {
  // base64url without padding; safe for cursor strings.
  const b64 = btoa(s);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return atob(b64);
}

export class ChannelDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateChannelDirectorySchema(this.ctx);
  }

  async fetch(request: Request): Promise<Response> {
    const schemaVersion = handleSchemaVersionRequest(this.ctx, "ChannelDirectory", request);
    if (schemaVersion) return schemaVersion;

    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (request.method === "POST" && url.pathname === "/internal/apply-projection") {
      const body = (await request.json()) as {
        action: "upsert" | "delete";
        channel_id: string;
        fields?: {
          title?: string;
          avatar_url?: string | null;
          member_count?: number;
          last_message_at?: string | null;
          status?: string;
        };
        fields_present?: string[];
      };
      const channelId = body.channel_id ?? "";
      if (!channelId) return new Response("missing channel_id", { status: 400 });

      if (body.action === "delete") {
        this.ctx.storage.sql.exec("DELETE FROM public_channels WHERE channel_id=?", channelId);
        return Response.json({ ok: true });
      }

      // Full-snapshot upsert (P0-3): every upsert carries all NOT NULL fields; the SET clause always
      // writes excluded.X so a missing row is restored by any call site. fields_present is kept only
      // to mark intentional nulls for nullable columns (avatar_url, last_message_at) — informational
      // here, but retained for forward-compat if a future schema adds optional columns.
      const f = body.fields ?? {};
      const title = typeof f.title === "string" ? f.title : "";
      const avatarUrl = f.avatar_url === undefined ? null : f.avatar_url;
      const memberCount = typeof f.member_count === "number" ? f.member_count : 0;
      const lastMessageAt = f.last_message_at === undefined ? null : f.last_message_at;
      const status = typeof f.status === "string" ? f.status : "active";
      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        `INSERT INTO public_channels (channel_id, title, avatar_url, member_count, last_message_at, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           title=excluded.title,
           avatar_url=excluded.avatar_url,
           member_count=excluded.member_count,
           last_message_at=excluded.last_message_at,
           status=excluded.status,
           updated_at=excluded.updated_at`,
        channelId, title, avatarUrl, memberCount, lastMessageAt, status, now,
      );
      void body.fields_present; // informational only (full-row upsert always writes excluded.X)
      return Response.json({ ok: true });
    }

    if (url.pathname === "/internal/list") {
      const q = url.searchParams.get("q") ?? "";
      const rawLimit = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 50;
      const cursor = url.searchParams.get("cursor") ?? null;

      // Sort: COALESCE(last_message_at, updated_at) DESC, channel_id DESC (P1-1).
      // Cursor is a base64url of JSON { last_activity, channel_id } keyset on that tuple.
      let lastActivity: string | null = null;
      let cursorChannelId: string | null = null;
      if (cursor) {
        try {
          const dec = JSON.parse(base64urlDecode(cursor)) as { last_activity?: string; channel_id?: string };
          lastActivity = typeof dec.last_activity === "string" ? dec.last_activity : null;
          cursorChannelId = typeof dec.channel_id === "string" ? dec.channel_id : null;
        } catch {
          // invalid cursor → ignore (return first page)
        }
      }

      const where: string[] = ["status='active'"];
      const args: unknown[] = [];
      if (q) {
        where.push("title LIKE '%' || ? || '%'");
        args.push(q);
      }
      if (lastActivity !== null && cursorChannelId !== null) {
        // keyset: rows strictly before (last_activity, channel_id) in DESC order.
        // (last_activity < ?) OR (last_activity = ? AND channel_id < ?)
        where.push("(COALESCE(last_message_at, updated_at) < ? OR (COALESCE(last_message_at, updated_at) = ? AND channel_id < ?))");
        args.push(lastActivity, lastActivity, cursorChannelId);
      }
      const sql = `SELECT channel_id, title, avatar_url, member_count, last_message_at, status, updated_at,
                      COALESCE(last_message_at, updated_at) AS last_activity
                   FROM public_channels
                   WHERE ${where.join(" AND ")}
                   ORDER BY COALESCE(last_message_at, updated_at) DESC, channel_id DESC
                   LIMIT ?`;
      args.push(limit + 1);
      const rows = this.ctx.storage.sql.exec(sql, ...args).toArray() as unknown as ListRow[];

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore && page.length > 0
        ? base64urlEncode(JSON.stringify({ last_activity: page[page.length - 1]!.last_activity, channel_id: page[page.length - 1]!.channel_id }))
        : null;

      const items: PublicChannelRow[] = page.map((r) => ({
        channel_id: r.channel_id,
        title: r.title,
        avatar_url: r.avatar_url,
        member_count: r.member_count,
        last_message_at: r.last_message_at,
        status: r.status,
        updated_at: r.updated_at,
      }));
      return Response.json({ items, next_cursor: nextCursor });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    // Phase 0: no due jobs yet.
  }
}
