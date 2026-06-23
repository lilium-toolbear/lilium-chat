import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { execSchema } from "./sql";
import { bumpFanoutRetry, scheduleFanoutAlarm } from "./fanout-scheduler";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS online_sessions (
    channel_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
    membership_version INTEGER NOT NULL, registered_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, session_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_online_user ON online_sessions(channel_id, user_id)`,
  `CREATE TABLE IF NOT EXISTS fanout_events (
    channel_id TEXT NOT NULL, event_id TEXT NOT NULL, event_json TEXT NOT NULL,
    membership_version_at_event INTEGER NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, event_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fanout_events_cleanup ON fanout_events(created_at)`,
  `CREATE TABLE IF NOT EXISTS fanout_queue (
    queue_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, event_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL, target_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error TEXT, failed_at TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fanout_due ON fanout_queue(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_fanout_event ON fanout_queue(channel_id, event_id)`,
];

function nowIso(): string {
  return new Date().toISOString();
}

export class ChannelFanout extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    execSchema(this.ctx, SCHEMA);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    const channelId = request.headers.get("X-Channel-Id") ?? "";
    if (!channelId && url.pathname !== "/dump") {
      return new Response("missing X-Channel-Id", { status: 400 });
    }

    if (url.pathname === "/register-online") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = (await request.json()) as {
        user_id?: string;
        session_id?: string;
        membership_version?: number;
      };
      if (!body.user_id || !body.session_id) {
        return new Response("missing user_id/session_id", { status: 400 });
      }

      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO online_sessions (channel_id, user_id, session_id, membership_version, registered_at) VALUES (?, ?, ?, ?, ?)",
        channelId,
        body.user_id,
        body.session_id,
        body.membership_version ?? 0,
        nowIso(),
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/unregister-online") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = (await request.json()) as { session_id?: string };
      this.ctx.storage.sql.exec(
        "DELETE FROM online_sessions WHERE channel_id=? AND session_id=?",
        channelId,
        body.session_id ?? "",
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/unregister-user") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = (await request.json()) as { user_id?: string };
      this.ctx.storage.sql.exec(
        "DELETE FROM online_sessions WHERE channel_id=? AND user_id=?",
        channelId,
        body.user_id ?? "",
      );
      this.ctx.storage.sql.exec(
        "UPDATE fanout_queue SET status='failed', last_error='member_left' WHERE channel_id=? AND target_user_id=? AND status='pending'",
        channelId,
        body.user_id ?? "",
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/fanout-enqueue") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = (await request.json()) as {
        event_id?: string;
        event_json?: string;
        membership_version_at_event?: number;
      };
      if (!body.event_id || !body.event_json) {
        return new Response("missing event_id/event_json", { status: 400 });
      }

      const ts = nowIso();
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fanout_events (channel_id, event_id, event_json, membership_version_at_event, created_at) VALUES (?, ?, ?, ?, ?)",
        channelId,
        body.event_id,
        body.event_json,
        body.membership_version_at_event ?? 0,
        ts,
      );

      const sessions = this.ctx.storage.sql
        .exec("SELECT user_id, session_id FROM online_sessions WHERE channel_id=?", channelId)
        .toArray() as Array<{ user_id: string; session_id: string }>;
      for (const s of sessions) {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO fanout_queue (queue_id, channel_id, event_id, target_session_id, target_user_id, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
          `${body.event_id}:${s.session_id}`,
          channelId,
          body.event_id,
          s.session_id,
          s.user_id,
          ts,
          ts,
        );
      }

      await scheduleFanoutAlarm(this.ctx, ts);
      return Response.json({ ok: true, delivered_to: sessions.length });
    }

    if (url.pathname === "/dump") {
      const sessions = this.ctx.storage.sql.exec("SELECT * FROM online_sessions WHERE channel_id=?", channelId).toArray();
      const events = this.ctx.storage.sql.exec("SELECT * FROM fanout_events WHERE channel_id=?", channelId).toArray();
      const queue = this.ctx.storage.sql.exec("SELECT * FROM fanout_queue WHERE channel_id=?", channelId).toArray();
      return Response.json({ sessions, events, queue });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const ts = nowIso();
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT queue_id, channel_id, event_id, target_session_id, target_user_id FROM fanout_queue WHERE status='pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC",
        ts,
      )
      .toArray() as Array<{
        queue_id: string;
        channel_id: string;
        event_id: string;
        target_session_id: string;
        target_user_id: string;
      }>;

    for (const row of rows) {
      const event = this.ctx.storage.sql
        .exec(
          "SELECT event_json, membership_version_at_event FROM fanout_events WHERE channel_id=? AND event_id=?",
          row.channel_id,
          row.event_id,
        )
        .toArray()[0] as { event_json: string; membership_version_at_event: number } | undefined;
      if (event === undefined) {
        bumpFanoutRetry(this.ctx, row.queue_id, ts, "event_json missing");
        continue;
      }

      const target = this.env.USER_CONNECTION.getByName(row.target_user_id);
      try {
        const res = await target.fetch(new Request("https://x/deliver", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Channel-Id": row.channel_id,
          },
          body: JSON.stringify({
            session_id: row.target_session_id,
            event_json: event.event_json,
            membership_version_at_event: event.membership_version_at_event,
          }),
        }));
        if (!res.ok) {
          const text = await res.text();
          bumpFanoutRetry(this.ctx, row.queue_id, ts, `${res.status}: ${text}`);
          continue;
        }

        this.ctx.storage.sql.exec(
          "UPDATE fanout_queue SET status='delivered', attempts=attempts+1, last_error=NULL WHERE queue_id=?",
          row.queue_id,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bumpFanoutRetry(this.ctx, row.queue_id, ts, msg);
      }
    }

    await scheduleFanoutAlarm(this.ctx, ts);
  }
}
