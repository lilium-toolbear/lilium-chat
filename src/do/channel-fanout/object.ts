import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { migrateChannelFanoutSchema } from "./migrations";
import { bumpFanoutRetry, scheduleFanoutAlarm } from "./fanout-scheduler";
import { rpcErrorMessage, shouldRetryRpcError } from "../shared/rpc-errors";
import { logSwallowedError } from "../../errors";

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

interface FanoutLeaseTarget {
  user_id: string;
  session_id: string;
  lease_id: string;
}

export interface ChannelFanoutDebugDump {
  leases: Array<{
    channel_id: string;
    lease_id: string;
    user_id: string;
    session_id: string;
    membership_version: number;
    expires_at: string;
    created_at: string;
    updated_at: string;
    last_error: string | null;
  }>;
  sessions: Array<{
    channel_id: string;
    user_id: string;
    session_id: string;
    membership_version: number;
    last_seen_at: string;
  }>;
  events: Array<{
    channel_id: string;
    event_id: string;
    event_json: string;
    membership_version_at_event: number;
    created_at: string;
  }>;
  queue: Array<{
    queue_id: string;
    channel_id: string;
    event_id: string;
    target_session_id: string;
    target_user_id: string;
    target_lease_id: string | null;
    status: string;
    attempts: number;
    next_attempt_at: string;
    created_at: string;
    last_error: string | null;
  }>;
}

export class ChannelFanout extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      migrateChannelFanoutSchema(this.ctx);
    });
  }

  async leaseUpsert(input: {
    channel_id: string;
    lease_id: string;
    user_id: string;
    session_id: string;
    membership_version?: number;
    expires_at?: string;
  }): Promise<{ ok: true; expires_at: string }> {
    if (!input.channel_id || !input.lease_id || !input.user_id || !input.session_id) {
      throw new Error("missing lease_id/user_id/session_id");
    }
    const ts = nowIso();
    const expiresAt = capLeaseExpires(input.expires_at);
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
      input.channel_id,
      input.lease_id,
      input.user_id,
      input.session_id,
      input.membership_version ?? 0,
      expiresAt,
      ts,
      ts,
    );
    return { ok: true, expires_at: expiresAt };
  }

  async leaseRevoke(input: { channel_id: string; lease_id: string }): Promise<{ ok: true }> {
    if (!input.channel_id) throw new Error("missing channel_id");
    this.ctx.storage.sql.exec(
      "DELETE FROM fanout_leases WHERE channel_id=? AND lease_id=?",
      input.channel_id,
      input.lease_id ?? "",
    );
    console.log("fanout_lease_deleted", { channel_id: input.channel_id, lease_id: input.lease_id, reason: "lease_revoke" });
    return { ok: true };
  }

  async leaseRevokeSession(input: { channel_id: string; session_id: string }): Promise<{ ok: true; revoked: number }> {
    if (!input.channel_id) throw new Error("missing channel_id");
    const sessionId = input.session_id ?? "";
    const rows = this.ctx.storage.sql
      .exec("SELECT lease_id FROM fanout_leases WHERE channel_id=? AND session_id=?", input.channel_id, sessionId)
      .toArray() as Array<{ lease_id: string }>;
    this.ctx.storage.sql.exec(
      "DELETE FROM fanout_leases WHERE channel_id=? AND session_id=?",
      input.channel_id,
      sessionId,
    );
    for (const row of rows) {
      console.log("fanout_lease_deleted", { channel_id: input.channel_id, lease_id: row.lease_id, reason: "session_revoke" });
    }
    return { ok: true, revoked: rows.length };
  }

  async unregisterUser(input: { channel_id: string; user_id: string }): Promise<{ ok: true }> {
    if (!input.channel_id) throw new Error("missing channel_id");
    const userId = input.user_id ?? "";
    this.ctx.storage.sql.exec(
      "DELETE FROM fanout_leases WHERE channel_id=? AND user_id=?",
      input.channel_id,
      userId,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM online_sessions WHERE channel_id=? AND user_id=?",
      input.channel_id,
      userId,
    );
    this.ctx.storage.sql.exec(
      "UPDATE fanout_queue SET status='dead_letter', last_error='member_left' WHERE channel_id=? AND target_user_id=? AND status='pending'",
      input.channel_id,
      userId,
    );
    return { ok: true };
  }

  async fanoutEnqueue(input: {
    channel_id: string;
    event_id: string;
    event_json: string;
    membership_version_at_event?: number;
  }): Promise<{ ok: true; delivered_to: number }> {
    if (!input.channel_id) throw new Error("missing channel_id");
    if (!input.event_id || !input.event_json) throw new Error("missing event_id/event_json");
    const ts = nowIso();
    this.pruneExpiredLeases(input.channel_id, ts);

    const sessions = this.ctx.storage.sql
      .exec(
        "SELECT user_id, session_id, lease_id FROM fanout_leases WHERE channel_id=? AND expires_at > ?",
        input.channel_id,
        ts,
      )
      .toArray() as unknown as FanoutLeaseTarget[];
    let queued = false;
    for (const s of sessions) {
      let result: { delivered: boolean; stale: boolean };
      try {
        result = await this.deliverToLease(input.channel_id, s, input.event_id, input.event_json, input.membership_version_at_event ?? 0);
      } catch (err) {
        if (!shouldRetryRpcError(err)) {
          console.warn("fanout_direct_delivery_dropped", {
            channel_id: input.channel_id,
            lease_id: s.lease_id,
            error: rpcErrorMessage(err),
          });
          continue;
        }
        result = { delivered: false, stale: false };
      }
      if (result.delivered || result.stale) continue;
      this.enqueueFanoutRetry(input.channel_id, s, input.event_id, input.event_json, input.membership_version_at_event ?? 0, ts);
      queued = true;
    }

    if (queued) await scheduleFanoutAlarm(this.ctx, ts);
    return { ok: true, delivered_to: sessions.length };
  }

  async fanoutDeliverStreamFrame(input: {
    channel_id: string;
    frame: unknown;
  }): Promise<{ ok: true; delivered_to: number; lease_count: number }> {
    if (!input.channel_id) throw new Error("missing channel_id");
    if (input.frame === undefined || input.frame === null) throw new Error("missing frame");
    const frameJson = JSON.stringify(input.frame);
    const ts = nowIso();
    this.pruneExpiredLeases(input.channel_id, ts);

    const sessions = this.ctx.storage.sql
      .exec(
        "SELECT user_id, session_id, lease_id FROM fanout_leases WHERE channel_id=? AND expires_at > ?",
        input.channel_id,
        ts,
      )
      .toArray() as unknown as FanoutLeaseTarget[];

    let deliveredCount = 0;
    for (const s of sessions) {
      try {
        const result = await this.deliverStreamFrameToLease(input.channel_id, s, frameJson);
        if (result.delivered) deliveredCount += 1;
      } catch (err) {
        logSwallowedError("channel_fanout_live_delivery_failed", err, {
          channel_id: input.channel_id,
          lease_id: s.lease_id,
        });
      }
    }

    return { ok: true, delivered_to: deliveredCount, lease_count: sessions.length };
  }

  /** Test-only RPC inspection; production paths do not call this method. */
  async debugDump(input: { channel_id: string }): Promise<ChannelFanoutDebugDump> {
    if (this.env.ALLOW_INTERNAL_TEST_ROUTES !== "1") {
      throw new Error("forbidden");
    }
    const channelId = input.channel_id;
    if (!channelId) throw new Error("missing channel_id");
    return {
      leases: this.ctx.storage.sql.exec("SELECT * FROM fanout_leases WHERE channel_id=?", channelId).toArray() as ChannelFanoutDebugDump["leases"],
      sessions: this.ctx.storage.sql.exec("SELECT * FROM online_sessions WHERE channel_id=?", channelId).toArray() as ChannelFanoutDebugDump["sessions"],
      events: this.ctx.storage.sql.exec("SELECT * FROM fanout_events WHERE channel_id=?", channelId).toArray() as ChannelFanoutDebugDump["events"],
      queue: this.ctx.storage.sql.exec("SELECT * FROM fanout_queue WHERE channel_id=?", channelId).toArray() as ChannelFanoutDebugDump["queue"],
    };
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
        const deliverBody = await target.deliver({
          lease_id: leaseId,
          channel_id: row.channel_id,
          session_id: row.target_session_id,
          event_id: row.event_id,
          event_json: event.event_json,
          membership_version_at_event: event.membership_version_at_event,
        });
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
        const msg = rpcErrorMessage(err);
        if (shouldRetryRpcError(err)) {
          bumpFanoutRetry(this.ctx, row.queue_id, ts, msg);
        } else {
          this.deadLetterQueue(row.queue_id, ts, msg);
        }
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

  private async deliverToLease(
    channelId: string,
    targetLease: FanoutLeaseTarget,
    eventId: string,
    eventJson: string,
    membershipVersionAtEvent: number,
  ): Promise<{ delivered: boolean; stale: boolean }> {
    const target = this.env.USER_CONNECTION.getByName(targetLease.user_id);
    const body = await target.deliver({
      lease_id: targetLease.lease_id,
      channel_id: channelId,
      session_id: targetLease.session_id,
      event_id: eventId,
      event_json: eventJson,
      membership_version_at_event: membershipVersionAtEvent,
    });
    if (body.delivered) return { delivered: true, stale: false };

    const reason = body.reason ?? "unknown";
    if (!STALE_LEASE_REASONS.has(reason)) return { delivered: false, stale: false };

    this.ctx.storage.sql.exec(
      "DELETE FROM fanout_leases WHERE channel_id=? AND lease_id=?",
      channelId,
      targetLease.lease_id,
    );
    console.log("fanout_lease_deleted", {
      channel_id: channelId,
      lease_id: targetLease.lease_id,
      reason,
    });
    return { delivered: false, stale: true };
  }

  private async deliverStreamFrameToLease(
    channelId: string,
    targetLease: FanoutLeaseTarget,
    frameJson: string,
  ): Promise<{ delivered: boolean }> {
    const target = this.env.USER_CONNECTION.getByName(targetLease.user_id);
    const body = await target.deliverStreamFrame({
      lease_id: targetLease.lease_id,
      channel_id: channelId,
      session_id: targetLease.session_id,
      frame_json: frameJson,
    });
    if (body.delivered) return { delivered: true };

    const reason = body.reason ?? "unknown";
    if (STALE_LEASE_REASONS.has(reason)) {
      this.ctx.storage.sql.exec(
        "DELETE FROM fanout_leases WHERE channel_id=? AND lease_id=?",
        channelId,
        targetLease.lease_id,
      );
      console.log("fanout_lease_deleted", {
        channel_id: channelId,
        lease_id: targetLease.lease_id,
        reason,
      });
    }
    return { delivered: false };
  }

  private enqueueFanoutRetry(
    channelId: string,
    targetLease: FanoutLeaseTarget,
    eventId: string,
    eventJson: string,
    membershipVersionAtEvent: number,
    ts: string,
  ): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO fanout_events (channel_id, event_id, event_json, membership_version_at_event, created_at) VALUES (?, ?, ?, ?, ?)",
      channelId,
      eventId,
      eventJson,
      membershipVersionAtEvent,
      ts,
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO fanout_queue (queue_id, channel_id, event_id, target_session_id, target_user_id, target_lease_id, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      `${eventId}:${targetLease.session_id}`,
      channelId,
      eventId,
      targetLease.session_id,
      targetLease.user_id,
      targetLease.lease_id,
      ts,
      ts,
    );
  }

  private deadLetterQueue(queueId: string, ts: string, error: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE fanout_queue SET status='dead_letter', last_error=?, failed_at=? WHERE queue_id=?",
      error,
      ts,
      queueId,
    );
  }
}
