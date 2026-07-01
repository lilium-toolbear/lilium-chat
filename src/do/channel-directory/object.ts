import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { CHANNEL_DIRECTORY_DO_SCHEMA } from "./migrations";
import { migrateDoSchema } from "../shared/sql-migrations";
import { logSwallowedError } from "../../errors";
import { sqlRows } from "../shared/sql";
import { runDebugSql, type DebugSqlInput, type DebugSqlResult } from "../shared/debug-sql";

interface PublicChannelRow {
  channel_id: string;
  title: string;
  avatar_url: string | null;
  member_count: number;
  last_message_at: string | null;
  status: string;
  updated_at: string;
}

interface ListRow extends PublicChannelRow {
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
    migrateDoSchema(this.ctx, CHANNEL_DIRECTORY_DO_SCHEMA);
  }

  async applyProjection(body: {
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
  }): Promise<void> {
    const channelId = body.channel_id ?? "";
    if (!channelId) throw new Error("missing channel_id");

    if (body.action === "delete") {
      this.ctx.storage.sql.exec("DELETE FROM public_channels WHERE channel_id=?", channelId);
      return;
    }

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
    void body.fields_present;
  }

  listPublicChannels(input: { q: string; limit: number; cursor: string | null }): { items: PublicChannelRow[]; next_cursor: string | null } {
    const q = input.q ?? "";
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(100, Math.floor(input.limit))) : 50;
    const cursor = input.cursor ?? null;

    let lastActivity: string | null = null;
    let cursorChannelId: string | null = null;
    if (cursor) {
      try {
        const dec = JSON.parse(base64urlDecode(cursor)) as { last_activity?: string; channel_id?: string };
        lastActivity = typeof dec.last_activity === "string" ? dec.last_activity : null;
        cursorChannelId = typeof dec.channel_id === "string" ? dec.channel_id : null;
      } catch (err) {
        logSwallowedError("channel_directory_invalid_cursor", err, { cursor });
      }
    }

    const where: string[] = ["status='active'"];
    const args: unknown[] = [];
    if (q) {
      where.push("title LIKE '%' || ? || '%'");
      args.push(q);
    }
    if (lastActivity !== null && cursorChannelId !== null) {
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
    const rows = sqlRows<ListRow>(this.ctx.storage.sql.exec(sql, ...args).toArray());

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && page.length > 0
      ? base64urlEncode(JSON.stringify({ last_activity: page[page.length - 1]!.last_activity, channel_id: page[page.length - 1]!.channel_id }))
      : null;

    const items: PublicChannelRow[] = page.map(({ last_activity: _lastActivity, ...item }) => item);
    return { items, next_cursor: nextCursor };
  }

  /** Debug enumeration: all known channel_ids regardless of status. */
  async listAllChannelIds(): Promise<{ channel_ids: string[] }> {
    const rows = sqlRows<{ channel_id: string }>(
      this.ctx.storage.sql.exec("SELECT channel_id FROM public_channels ORDER BY channel_id ASC").toArray(),
    );
    return { channel_ids: rows.map((r) => r.channel_id) };
  }

  /** Read-only SQL debug surface, gated by DEBUG_TOKEN at the route layer. */
  async debugSql(input: DebugSqlInput): Promise<DebugSqlResult> {
    return runDebugSql(this.ctx, input);
  }
}
