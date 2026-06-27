import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { handleSchemaVersionRequest } from "./sql-migrations";
import { migrateChannelFanoutSchema } from "./migrations/channel-fanout";
import { bumpFanoutRetry, scheduleFanoutAlarm } from "./fanout-scheduler";
import { requireTestOnly } from "./do-errors";

const LEASE_TTL_MS = 10 * 60 * 1000;

const STALE_LEASE_REASONS = new Set([
  "session_not_found",
  "session_closed",
  "lease_not_found",
  "lease_closed",
  "socket_not_found",
  "socket_send_failed",
  "membership_not_active",
  "membership_stale",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function capLeaseExpires(requested: string | undefined): string {
  const cap = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  if (!requested) return cap;
  return requested < cap ? requested : cap;
}

interface DeliverResponse {
  delivered: boolean;
  reason?: string;
}

export class ChannelFanout extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateChannelFanoutSchema(this.ctx);
  }

  async fetch(request: Request): Promise<Response> {
    const schemaVersion = handleSchemaVersionRequest(this.ctx, "ChannelFanout", request);
    if (schemaVersion) return schemaVersion;

    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    const channelId = request.headers.get("X-Channel-Id") ?? "";
    if (!channelId && url.pathname !== "/dump") {
      return new Response("missing X-Channel-Id", { status: 400 });
    }

    if (url.pathname === "/register-online" || url.pathname === "/unregister-online") {
      return new Response("gone", { status: 410 });
    }

    if (url.pathname === "/lease-upsert") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = (await request.json()) as {
        lease_id?: string;
        user_id?: string;
        session_id?: string;
        membership_version?: number;
        expires_at?: string;
      };
      if (!body.lease_id || !body.user_id || !body.session_id) {
        return new Response("missing lease_id/user_id/session_id", { status: 400 });
      }
      const ts = nowIso();
      const expiresAt = capLeaseExpires(body.expires_at);
      this.ctx.storage.sql.exec(
        `INSERT INTO fanout_leases (
          channel_id, lease_id, user_id, session_id, membership_version,
          expires_at, created_at, updated_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(channel_id, lease_id) DO UPDATE SET
          user_id=excluded.user_id,
          session_id=excluded.session_id,
          membership_version=excluded.membership_version,
          expires_at=excluded.expires_at,
          updated_at=excluded.updated_at,
          last_error=NULL`,
        channelId,
        body.lease_id,
        body.user_id,
        body.session_id,
        body.membership_version ?? 0,
        expiresAt,
        ts,
        ts,
      );
      return Response.json({ ok: true, expires_at: expiresAt });
    }

    if (url.pathname === "/lease-revoke") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = (await request.json()) as { lease_id?: string };
      this.ctx.storage.sql.exec(
        "DELETE FROM fanout_leases WHERE channel_id=? AND lease_id=?",
        channelId,
        body.lease_id ?? "",
      );
      console.log("fanout_lease_deleted", { channel_id: channelId, lease_id: body.lease_id, reason: "lease_revoke" });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/lease-revoke-session") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = (await request.json()) as { session_id?: string };
      const sessionId = body.session_id ?? "";
      const rows = this.ctx.storage.sql
        .exec("SELECT lease_id FROM fanout_leases WHERE channel_id=? AND session_id=?", channelId, sessionId)
        .toArray() as Array<{ lease_id: string }>;
      this.ctx.storage.sql.exec(
        "DELETE FROM fanout_leases WHERE channel_id=? AND session_id=?",
        channelId,
        sessionId,
      );
      for (const row of rows) {
        console.log("fanout_lease_deleted", { channel_id: channelId, lease_id: row.lease_id, reason: "session_revoke" });
      }
      return Response.json({ ok: true, revoked: rows.length });
    }

    if (url.pathname === "/unregister-user") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = (await request.json()) as { user_id?: string };
      const userId = body.user_id ?? "";
      this.ctx.storage.sql.exec(
        "DELETE FROM fanout_leases WHERE channel_id=? AND user_id=?",
        channelId,
        userId,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM online_sessions WHERE channel_id=? AND user_id=?",
        channelId,
        userId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE fanout_queue SET status='dead_letter', last_error='member_left' WHERE channel_id=? AND target_user_id=? AND status='pending'",
        channelId,
        userId,
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
      this.pruneExpiredLeases(channelId, ts);

      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fanout_events (channel_id, event_id, event_json, membership_version_at_event, created_at) VALUES (?, ?, ?, ?, ?)",
        channelId,
        body.event_id,
        body.event_json,
        body.membership_version_at_event ?? 0,
        ts,
      );

      const sessions = this.ctx.storage.sql
        .exec(
          "SELECT user_id, session_id, lease_id FROM fanout_leases WHERE channel_id=? AND expires_at > ?",
          channelId,
          ts,
        )
        .toArray() as Array<{ user_id: string; session_id: string; lease_id: string }>;
      for (const s of sessions) {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO fanout_queue (queue_id, channel_id, event_id, target_session_id, target_user_id, target_lease_id, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
          `${body.event_id}:${s.session_id}`,
          channelId,
          body.event_id,
          s.session_id,
          s.user_id,
          s.lease_id,
          ts,
          ts,
        );
      }

      await scheduleFanoutAlarm(this.ctx, ts);
      return Response.json({ ok: true, delivered_to: sessions.length });
    }

    if (url.pathname === "/dump") {
      const gate = requireTestOnly(request, this.env);
      if (gate) return gate;
      const leases = this.ctx.storage.sql.exec("SELECT * FROM fanout_leases WHERE channel_id=?", channelId).toArray();
      const sessions = this.ctx.storage.sql.exec("SELECT * FROM online_sessions WHERE channel_id=?", channelId).toArray();
      const events = this.ctx.storage.sql.exec("SELECT * FROM fanout_events WHERE channel_id=?", channelId).toArray();
      const queue = this.ctx.storage.sql.exec("SELECT * FROM fanout_queue WHERE channel_id=?", channelId).toArray();
      return Response.json({ leases, sessions, events, queue });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const ts = nowIso();
    const channelIds = this.ctx.storage.sql
      .exec("SELECT DISTINCT channel_id FROM fanout_queue WHERE status='pending' AND next_attempt_at <= ?", ts)
      .toArray() as Array<{ channel_id: string }>;
    for (const { channel_id: chId } of channelIds) {
      this.pruneExpiredLeases(chId, ts);
    }

    const rows = this.ctx.storage.sql
      .exec(
        "SELECT queue_id, channel_id, event_id, target_session_id, target_user_id, target_lease_id FROM fanout_queue WHERE status='pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC",
        ts,
      )
      .toArray() as Array<{
        queue_id: string;
        channel_id: string;
        event_id: string;
        target_session_id: string;
        target_user_id: string;
        target_lease_id: string | null;
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

      let leaseId = row.target_lease_id ?? "";
      if (!leaseId) {
        const leaseRow = this.ctx.storage.sql
          .exec(
            "SELECT lease_id FROM fanout_leases WHERE channel_id=? AND session_id=? AND expires_at > ?",
            row.channel_id,
            row.target_session_id,
            ts,
          )
          .toArray()[0] as { lease_id: string } | undefined;
        leaseId = leaseRow?.lease_id ?? "";
      }

      if (!leaseId) {
        this.ctx.storage.sql.exec(
          "UPDATE fanout_queue SET status='delivered', attempts=attempts+1, last_error='lease_expired' WHERE queue_id=?",
          row.queue_id,
        );
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
            lease_id: leaseId,
            channel_id: row.channel_id,
            session_id: row.target_session_id,
            event_id: row.event_id,
            event_json: event.event_json,
            membership_version_at_event: event.membership_version_at_event,
          }),
        }));
        if (!res.ok) {
          const text = await res.text();
          bumpFanoutRetry(this.ctx, row.queue_id, ts, `${res.status}: ${text}`);
          continue;
        }

        const deliverBody = (await res.json()) as DeliverResponse;
        if (deliverBody.delivered) {
          this.ctx.storage.sql.exec(
            "UPDATE fanout_queue SET status='delivered', attempts=attempts+1, last_error=NULL WHERE queue_id=?",
            row.queue_id,
          );
          continue;
        }

        const reason = deliverBody.reason ?? "unknown";
        if (STALE_LEASE_REASONS.has(reason)) {
          this.ctx.storage.sql.exec(
            "DELETE FROM fanout_leases WHERE channel_id=? AND lease_id=?",
            row.channel_id,
            leaseId,
          );
          console.log("fanout_lease_deleted", {
            channel_id: row.channel_id,
            lease_id: leaseId,
            reason,
          });
          this.ctx.storage.sql.exec(
            "UPDATE fanout_queue SET status='delivered', attempts=attempts+1, last_error=? WHERE queue_id=?",
            reason,
            row.queue_id,
          );
          continue;
        }

        bumpFanoutRetry(this.ctx, row.queue_id, ts, reason);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bumpFanoutRetry(this.ctx, row.queue_id, ts, msg);
      }
    }

    await scheduleFanoutAlarm(this.ctx, ts);
  }

  private pruneExpiredLeases(channelId: string, ts: string): void {
    const expired = this.ctx.storage.sql
      .exec(
        "SELECT lease_id FROM fanout_leases WHERE channel_id=? AND expires_at <= ?",
        channelId,
        ts,
      )
      .toArray() as Array<{ lease_id: string }>;
    if (expired.length === 0) return;
    this.ctx.storage.sql.exec(
      "DELETE FROM fanout_leases WHERE channel_id=? AND expires_at <= ?",
      channelId,
      ts,
    );
    for (const row of expired) {
      console.log("fanout_lease_deleted", {
        channel_id: channelId,
        lease_id: row.lease_id,
        reason: "expired",
      });
    }
  }
}
