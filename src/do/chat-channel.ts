import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { execSchema } from "./sql";
import { uuidv7, monotonicUuidV7, type EventSeq } from "../ids/uuidv7";
import {
  buildEventFrame,
  buildMessageCreatedPayload,
  resolveSenderForLiveBroadcast,
  type UserSummary as LiveUserSummary,
} from "../chat/event-broadcast";
import { resolveUserSummaries } from "../profile/resolve";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS channel_meta (
    channel_id TEXT PRIMARY KEY, kind TEXT NOT NULL, visibility TEXT NOT NULL,
    title TEXT NOT NULL, topic TEXT, avatar_url TEXT, status TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    member_count INTEGER NOT NULL DEFAULT 0, membership_version INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    channel_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
    joined_at TEXT NOT NULL, left_at TEXT, PRIMARY KEY (channel_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_members_active ON members(user_id) WHERE left_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY, client_message_id TEXT NOT NULL,
    dedupe_principal_key TEXT NOT NULL, channel_id TEXT NOT NULL,
    sender_kind TEXT NOT NULL, -- user | bot | system
    sender_user_id TEXT, sender_bot_id TEXT,
    type TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'plain',
    status TEXT NOT NULL DEFAULT 'normal', text TEXT, reply_to TEXT,
    reply_snapshot_json TEXT, stream_state TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, edited_at TEXT,
    deleted_at TEXT, deleted_by TEXT, recalled_at TEXT,
    UNIQUE (channel_id, dedupe_principal_key, client_message_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_history ON messages(channel_id, message_id DESC)`,
  `CREATE TABLE IF NOT EXISTS message_edits (
    edit_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, old_text TEXT NOT NULL,
    new_text TEXT NOT NULL, editor_user_id TEXT NOT NULL, request_id TEXT, edited_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_edits_message ON message_edits(message_id, edited_at)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    audit_id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL,
    action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
    before_json TEXT, after_json TEXT, reason TEXT, request_id TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_kind, actor_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS attachments (
    attachment_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL,
    filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    width INTEGER, height INTEGER, storage_key TEXT NOT NULL, url TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS message_attachments (
    message_id TEXT NOT NULL, attachment_id TEXT NOT NULL, PRIMARY KEY (message_id, attachment_id)
  )`,
  `CREATE TABLE IF NOT EXISTS mentions (
    message_id TEXT NOT NULL, user_id TEXT NOT NULL, start INTEGER NOT NULL, end_ INTEGER NOT NULL,
    PRIMARY KEY (message_id, start, end_)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(user_id)`,
  `CREATE TABLE IF NOT EXISTS bot_installations (
    bot_id TEXT PRIMARY KEY, installed_by TEXT NOT NULL, scopes TEXT NOT NULL, installed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commands (
    command_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
    options_json TEXT NOT NULL, default_perm TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL, UNIQUE (bot_id, name)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_enabled_command_name ON commands(name) WHERE enabled = 1`,
  `CREATE TABLE IF NOT EXISTS invocations (
    invocation_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, bot_id TEXT NOT NULL,
    invoker_user_id TEXT NOT NULL, dedupe_principal_key TEXT NOT NULL,
    client_invocation_id TEXT NOT NULL, options_json TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, error_code TEXT,
    UNIQUE (command_id, dedupe_principal_key, client_invocation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS interactions (
    interaction_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, component_id TEXT NOT NULL,
    custom_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, dedupe_principal_key TEXT NOT NULL,
    client_interaction_id TEXT NOT NULL,
    value_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE (message_id, dedupe_principal_key, client_interaction_id)
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    invite_code TEXT PRIMARY KEY, created_by TEXT NOT NULL, expires_at TEXT NOT NULL,
    max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, revoked_at TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, channel_id TEXT NOT NULL,
    actor_kind TEXT, actor_id TEXT, actor_session_id TEXT, payload_json TEXT NOT NULL,
    membership_version_at_event INTEGER NOT NULL DEFAULT 0, occurred_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_after ON events(event_id)`,
  `CREATE TABLE IF NOT EXISTS event_seq ( id INTEGER PRIMARY KEY CHECK (id = 1), last_ms INTEGER NOT NULL, counter INTEGER NOT NULL )`,
  `INSERT OR IGNORE INTO event_seq (id, last_ms, counter) VALUES (1, 0, 0)`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL, operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT,
    status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY (principal_kind, principal_id, operation, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys(expires_at)`,
  `CREATE TABLE IF NOT EXISTS projection_outbox (
    outbox_id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_key TEXT NOT NULL,
    event_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error TEXT, failed_at TEXT, next_attempt_at TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projection_outbox_due ON projection_outbox(status, next_attempt_at)`,
  `CREATE TABLE IF NOT EXISTS rate_buckets (
    bucket_key TEXT PRIMARY KEY, tokens REAL NOT NULL, refill_rate REAL NOT NULL,
    capacity REAL NOT NULL, updated_at TEXT NOT NULL
  )`,
];

interface OutboxRow {
  outbox_id: string;
  target_kind: string;
  target_key: string;
  payload_json: string;
}

interface MessageRow {
  message_id: string;
  client_message_id: string;
  channel_id: string;
  sender_kind: string;
  sender_user_id: string | null;
  sender_bot_id: string | null;
  type: string;
  format: string;
  status: string;
  text: string | null;
  reply_to: string | null;
  reply_snapshot_json: string | null;
  stream_state: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  recalled_at: string | null;
}

interface ReplayEventRow {
  event_id: string;
  event_type: string;
  payload_json: string;
  occurred_at: string;
}

interface ReplayEnvelope {
  event_id: string;
  event_json: string;
}

function rowToMessage(r: MessageRow): Record<string, unknown> {
  let replySnapshot: unknown = null;
  if (r.reply_snapshot_json) {
    try {
      replySnapshot = JSON.parse(r.reply_snapshot_json);
    } catch {
      replySnapshot = null;
    }
  }

  return {
    message_id: r.message_id,
    client_message_id: r.client_message_id,
    channel_id: r.channel_id,
    sender: {
      kind: r.sender_kind,
      user_id: r.sender_user_id,
      bot_id: r.sender_bot_id,
    },
    type: r.type,
    format: r.format,
    status: r.status,
    text: r.text,
    reply_to: r.reply_to,
    reply_snapshot: replySnapshot,
    stream_state: r.stream_state,
    created_at: r.created_at,
    updated_at: r.updated_at,
    edited_at: r.edited_at,
    deleted_at: r.deleted_at,
    deleted_by: r.deleted_by,
    recalled_at: r.recalled_at,
    attachments: [],
    components: [],
    mentions: [],
  };
}

export class ChatChannel extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    execSchema(this.ctx, SCHEMA);
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private async insertOutboxRow(
    targetKind: string,
    targetKey: string,
    payload: Record<string, unknown>,
    nowIso: string,
  ): Promise<void> {
    const payloadOut = { ...payload } as Record<string, unknown>;
    const eventId = this.nextEventId(Date.parse(nowIso));
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, 5)",
      `${targetKind}:${targetKey}:${eventId}:${Math.random()}`,
      targetKind,
      targetKey,
      eventId,
      JSON.stringify(payloadOut),
      nowIso,
      nowIso,
      nowIso,
    );
  }

  private async markMemberLeftAndEnqueueFanoutUnregister(
    channelId: string,
    userId: string,
    nowIso: string,
  ): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(
        "UPDATE members SET left_at=? WHERE channel_id=? AND user_id=?",
        nowIso,
        channelId,
        userId,
      );
      const meta = this.ctx.storage.sql
        .exec("SELECT membership_version, member_count FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { membership_version: number; member_count: number } | undefined;
      const nextMv = (meta?.membership_version ?? 0) + 1;
      const nextCount = Math.max(0, (meta?.member_count ?? 1) - 1);
      this.ctx.storage.sql.exec(
        "UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?",
        nextMv,
        nextCount,
        nowIso,
        channelId,
      );
      const fanoutPayload = { action: "unregister-user", channel_id: channelId, user_id: userId };
      this.ctx.storage.sql.exec(
        "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'channel_fanout', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
        `channel_fanout:unregister:${channelId}:${userId}:${nowIso}`,
        channelId,
        JSON.stringify(fanoutPayload),
        nowIso,
        nowIso,
        nowIso,
      );
    });
  }

  private insertOutboxRowForFanout(
    channelId: string,
    eventId: string,
    eventFrameJson: string,
    membershipVersionAtEvent: number,
    nowIso: string,
  ): void {
    const payload = {
      action: "fanout",
      event_id: eventId,
      event_json: eventFrameJson,
      membership_version_at_event: membershipVersionAtEvent,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'channel_fanout', ?, ?, ?, 'pending', ?, ?, ?, 0, 5)",
      `channel_fanout:${channelId}:${eventId}`,
      channelId,
      eventId,
      JSON.stringify(payload),
      nowIso,
      nowIso,
      nowIso,
    );
  }

  private async scheduleOutboxAlarm(nowIso: string): Promise<void> {
    const row = this.ctx.storage.sql
      .exec("SELECT MIN(next_attempt_at) AS due FROM projection_outbox WHERE status='pending'")
      .toArray()[0] as { due: string | null } | undefined;
    const due = row?.due ?? null;
    if (due === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const dueMs = Date.parse(due);
    if (Number.isNaN(dueMs)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || dueMs < currentAlarm) {
      await this.ctx.storage.setAlarm(dueMs);
      return;
    }

    // Keep the existing alarm if it is already earlier/equal.
    void nowIso;
  }

  private async bumpOutboxRetry(outboxId: string, nowIso: string, error: string): Promise<void> {
    const row = this.ctx.storage.sql
      .exec("SELECT attempts, max_attempts FROM projection_outbox WHERE outbox_id=?", outboxId)
      .toArray()[0] as { attempts: number | null; max_attempts: number | null } | undefined;
    const attempts = row?.attempts ?? 0;
    const maxAttempts = row?.max_attempts ?? 5;
    const nextAttempts = attempts + 1;

    if (nextAttempts >= maxAttempts) {
      this.ctx.storage.sql.exec(
        "UPDATE projection_outbox SET status='dead_letter', attempts=?, last_error=?, failed_at=?, updated_at=? WHERE outbox_id=?",
        nextAttempts,
        error,
        nowIso,
        nowIso,
        outboxId,
      );
      return;
    }

    const backoffMs = 1000 * Math.pow(2, attempts);
    this.ctx.storage.sql.exec(
      "UPDATE projection_outbox SET status='pending', attempts=?, last_error=?, next_attempt_at=?, updated_at=? WHERE outbox_id=?",
      nextAttempts,
      error,
      new Date(Date.parse(nowIso) + backoffMs).toISOString(),
      nowIso,
      outboxId,
    );
  }

  nextEventId(nowMs: number = Date.now()): string {
    const rows = this.ctx.storage.sql.exec("SELECT last_ms, counter FROM event_seq WHERE id=1").toArray();
    const row = rows[0] as { last_ms: number; counter: number } | undefined;
    const seq: EventSeq = row ?? { last_ms: 0, counter: 0 };
    const { id, seq: next } = monotonicUuidV7(seq, nowMs);
    this.ctx.storage.sql.exec("UPDATE event_seq SET last_ms=?, counter=? WHERE id=1", next.last_ms, next.counter);
    return id;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (url.pathname === "/outbox-insert") {
      const b = (await request.json()) as {
        outbox_id: string;
        target_key: string;
        payload: Record<string, unknown>;
      };
      const now = this.nowIso();
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at) VALUES (?, 'message_index', ?, '', ?, 'pending', ?, ?, ?)",
        b.outbox_id,
        b.target_key,
        JSON.stringify(b.payload),
        now,
        now,
        now,
      );
      return new Response("ok");
    }

    if (url.pathname === "/outbox-flush") {
      const rows = this.ctx.storage.sql
        .exec("SELECT outbox_id, target_key, payload_json FROM projection_outbox WHERE status='pending'")
        .toArray() as Array<{ outbox_id: string; target_key: string; payload_json: string }>;
      for (const r of rows) {
        const target = this.env.MESSAGE_INDEX.getByName(r.target_key);
        await target.fetch(new Request("https://x/upsert", { method: "POST", body: r.payload_json }));
        this.ctx.storage.sql.exec(
          "UPDATE projection_outbox SET status='delivered', updated_at=? WHERE outbox_id=?",
          this.nowIso(),
          r.outbox_id,
        );
      }
      return new Response("ok");
    }

    if (url.pathname === "/next-event-id") {
      const count = Math.max(0, Number(url.searchParams.get("count") ?? "1"));
      const ms = Number(url.searchParams.get("ms") ?? String(Date.now()));
      const ids: string[] = [];

      await this.ctx.storage.transaction(async () => {
        for (let i = 0; i < count; i++) {
          ids.push(this.nextEventId(ms));
        }
      });
      return Response.json({ ids });
    }

    if (url.pathname === "/internal/maybe-create-system") {
      const b = (await request.json()) as { title: string };
      const now = this.nowIso();

      const existing = this.ctx.storage.sql
        .exec("SELECT channel_id FROM channel_meta")
        .toArray()[0] as { channel_id: string } | undefined;
      if (existing !== undefined) {
        return Response.json({ channel_id: existing.channel_id });
      }

      const channelId = uuidv7();
      const title = b?.title?.trim() ?? "Lilium";
      this.ctx.storage.sql.exec(
        `INSERT INTO channel_meta (
          channel_id, kind, visibility, title, topic, avatar_url, status,
          created_by, created_at, updated_at, member_count, membership_version
        ) VALUES (?, 'channel', 'public_listed', ?, NULL, NULL, 'active', 'system', ?, ?, 0, 0)`,
        channelId,
        title,
        now,
        now,
      );
      return Response.json({ channel_id: channelId });
    }

    if (url.pathname === "/internal/join") {
      const b = (await request.json()) as { user_id: string };
      const userId = b.user_id;
      const now = this.nowIso();
      let channelId = "";
      let membershipVersion = 0;
      let joinedAt = now;
      let writeProjection = false;

      const meta = this.ctx.storage.sql.exec("SELECT channel_id, kind, membership_version, member_count FROM channel_meta").toArray()[0] as
        | { channel_id: string; kind: string; membership_version: number; member_count: number }
        | undefined;
      if (meta === undefined) {
        return new Response("not found", { status: 404 });
      }
      channelId = meta.channel_id;

      const m = this.ctx.storage.sql
        .exec("SELECT joined_at, left_at FROM members WHERE channel_id=? AND user_id=?", channelId, userId)
        .toArray()[0] as { joined_at: string; left_at: string | null } | undefined;

      if (m && m.left_at === null) {
        membershipVersion = meta.membership_version;
        joinedAt = m.joined_at;
      } else {
        membershipVersion = meta.membership_version + 1;
        joinedAt = now;
        if (m === undefined) {
          this.ctx.storage.sql.exec(
            "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'member', ?, NULL)",
            channelId,
            userId,
            joinedAt,
          );
        } else {
          this.ctx.storage.sql.exec(
            "UPDATE members SET joined_at=?, left_at=NULL, role='member' WHERE channel_id=? AND user_id=?",
            joinedAt,
            channelId,
            userId,
          );
        }

        const nextCount = (meta.member_count ?? 0) + 1;
        this.ctx.storage.sql.exec(
          "UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?",
          membershipVersion,
          nextCount,
          now,
          channelId,
        );

        const eventId = this.nextEventId(Date.parse(now));
        this.ctx.storage.sql.exec(
          "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'member.joined', ?, 'system', 'system', ?, ?, ?)",
          eventId,
          channelId,
          JSON.stringify({
            channel_id: channelId,
            user_id: userId,
            membership_version: membershipVersion,
          }),
          membershipVersion,
          now,
        );

        await this.insertOutboxRow(
          "user_directory",
          userId,
          {
            action: "join",
            channel_id: channelId,
            kind: meta.kind,
            membership_version: membershipVersion,
          },
          now,
        );
        writeProjection = true;
      }

      if (writeProjection) await this.scheduleOutboxAlarm(now);
      return Response.json({ channel_id: channelId, membership_version: membershipVersion, joined_at: joinedAt });
    }

    if (url.pathname === "/internal/outbox-pending") {
      const targetKind = url.searchParams.get("target_kind");
      const rows = targetKind === null
        ? this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM projection_outbox WHERE status='pending'")
        : this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM projection_outbox WHERE status='pending' AND target_kind=?", targetKind);
      const row = rows.toArray()[0] as { count: number | bigint } | undefined;
      const count = Number(row?.count ?? 0);
      return Response.json({ count });
    }

    if (url.pathname === "/internal/summary") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";

      const meta = this.ctx.storage.sql
        .exec(
          "SELECT channel_id, kind, visibility, title, topic, avatar_url, status, created_at, updated_at, member_count FROM channel_meta LIMIT 1",
        )
        .toArray()[0] as
        | {
            channel_id: string;
            kind: string;
            visibility: string;
            title: string;
            topic: string | null;
            avatar_url: string | null;
            status: string;
            created_at: string;
            updated_at: string;
            member_count: number;
          }
        | undefined;

      if (meta === undefined) {
        return new Response("channel not created", { status: 409 });
      }

      const member = userId
        ? (this.ctx.storage.sql
            .exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", meta.channel_id, userId)
            .toArray()[0] as { role: string } | undefined)
        : undefined;
      if (!member && meta.visibility === "private") {
        return new Response("forbidden", { status: 403 });
      }

      const lastEvent = this.ctx.storage.sql
        .exec("SELECT event_id FROM events WHERE channel_id=? ORDER BY event_id DESC LIMIT 1", meta.channel_id)
        .toArray()[0] as { event_id: string } | undefined;
      const lastMsg = this.ctx.storage.sql
        .exec(
          "SELECT message_id, sender_user_id, sender_bot_id, text, created_at FROM messages WHERE channel_id=? AND status NOT IN ('deleted','recalled') ORDER BY message_id DESC LIMIT 1",
          meta.channel_id,
        )
        .toArray()[0] as
        | {
            message_id: string;
            sender_user_id: string | null;
            sender_bot_id: string | null;
            text: string | null;
            created_at: string;
          }
        | undefined;

      return Response.json({
        channel_id: meta.channel_id,
        kind: meta.kind,
        visibility: meta.visibility,
        title: meta.title,
        topic: meta.topic,
        avatar_url: meta.avatar_url,
        member_count: meta.member_count,
        status: meta.status,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        last_message_at: lastMsg?.created_at ?? null,
        last_message_preview: lastMsg?.text ?? null,
        last_message_sender_id: lastMsg?.sender_user_id ?? lastMsg?.sender_bot_id ?? null,
        last_event_id: lastEvent?.event_id ?? null,
        my_role: member?.role ?? null,
      });
    }

    if (url.pathname === "/internal/messages") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      const rawLimit = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 50;
      const before = url.searchParams.get("before");

      const meta = this.ctx.storage.sql.exec("SELECT channel_id, visibility FROM channel_meta LIMIT 1").toArray()[0] as
        | { channel_id: string; visibility: string }
        | undefined;
      if (meta === undefined) {
        return new Response("channel not created", { status: 409 });
      }

      const member = userId
        ? (this.ctx.storage.sql
            .exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", meta.channel_id, userId)
            .toArray()[0] as { x: number } | undefined)
        : undefined;
      if (!member && meta.visibility === "private") {
        return new Response("forbidden", { status: 403 });
      }

      const query = before === null
        ?
          "SELECT message_id, client_message_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE channel_id=? AND status NOT IN ('deleted','recalled') ORDER BY message_id DESC LIMIT ?"
        : "SELECT message_id, client_message_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE channel_id=? AND status NOT IN ('deleted','recalled') AND message_id < ? ORDER BY message_id DESC LIMIT ?";

      const rows = (before === null
        ? this.ctx.storage.sql.exec(query, meta.channel_id, limit + 1)
        : this.ctx.storage.sql.exec(query, meta.channel_id, before, limit + 1)
      ).toArray() as unknown as MessageRow[];

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]!.message_id : null;

      return Response.json({
        items: page.map((r) => rowToMessage(r)),
        next_cursor: nextCursor,
      });
    }

    if (url.pathname === "/internal/test-leave") {
      const testOnly = request.headers.get("X-Test-Only");
      if (testOnly !== "1") return new Response("forbidden", { status: 403 });

      const b = (await request.json()) as { user_id: string };
      const userId = b.user_id;
      const meta = this.ctx.storage.sql.exec("SELECT channel_id FROM channel_meta").toArray()[0] as { channel_id: string } | undefined;
      if (meta === undefined) {
        return new Response("not found", { status: 404 });
      }
      const now = this.nowIso();
      await this.markMemberLeftAndEnqueueFanoutUnregister(meta.channel_id, userId, now);
      await this.scheduleOutboxAlarm(now);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/spike-create") {
      const b = (await request.json()) as { message_id: string; event_id: string; text: string };
      const now = this.nowIso();
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO messages (message_id, client_message_id, dedupe_principal_key, channel_id, sender_kind, type, status, text, created_at, updated_at) VALUES (?, 'c', 'user:x', 'replay-1', 'user', 'text', 'normal', ?, ?, ?)",
        b.message_id,
        b.text,
        now,
        now,
      );
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO events (event_id, event_type, channel_id, payload_json, occurred_at) VALUES (?, 'message.created', 'replay-1', ?, ?)",
        b.event_id,
        JSON.stringify({ message_id: b.message_id, text: b.text }),
        now,
      );
      return new Response("ok");
    }

    if (url.pathname === "/spike-delete") {
      const b = (await request.json()) as { message_id: string };
      const now = this.nowIso();
      this.ctx.storage.sql.exec("UPDATE messages SET status='deleted', deleted_at=? WHERE message_id=?", now, b.message_id);
      this.ctx.storage.sql.exec(
        "INSERT INTO events (event_id, event_type, channel_id, payload_json, occurred_at) VALUES (?, 'message.deleted', 'replay-1', ?, ?)",
        "e-r-del",
        JSON.stringify({ message_id: b.message_id, status: "deleted" }),
        now,
      );
      return new Response("ok");
    }

    if (url.pathname === "/spike-replay") {
      const after = url.searchParams.get("after") ?? "";
      const rows = this.ctx.storage.sql.exec(
        "SELECT event_id, event_type, payload_json FROM events WHERE event_id > ? ORDER BY event_id",
        after,
      ).toArray() as Array<{ event_id: string; event_type: string; payload_json: string }>;
      const out: Array<{ event_id: string; event_type: string }> = [];
      for (const r of rows) {
        if (r.event_type === "message.created") {
          const p = JSON.parse(r.payload_json) as { message_id: string };
          const statusRow = this.ctx.storage.sql.exec("SELECT status FROM messages WHERE message_id=?", p.message_id).toArray()[0] as
            | { status: string }
            | undefined;
          if (statusRow && (statusRow.status === "deleted" || statusRow.status === "recalled")) {
            continue;
          }
        }
        out.push({ event_id: r.event_id, event_type: r.event_type });
      }
      return Response.json({ events: out });
    }

    if (url.pathname === "/internal/message-send") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      if (!userId) return new Response("missing verified user", { status: 401 });
      const b = (await request.json()) as {
        client_message_id: string;
        dedupe_principal_key: string;
        type: string;
        text: string;
        reply_to: string | null;
        mentions: Array<{ user_id: string; start: number; end: number }>;
        channel_id: string;
      };

      const now = this.nowIso();
      const nowMs = Date.parse(now);

      const meta = this.ctx.storage.sql
        .exec("SELECT channel_id, membership_version FROM channel_meta LIMIT 1")
        .toArray()[0] as { channel_id: string; membership_version: number } | undefined;
      if (meta === undefined) {
        return new Response("channel not created", { status: 409 });
      }
      const channelId = meta.channel_id;
      const requestedChannelId = b.channel_id ?? "";
      if (requestedChannelId && requestedChannelId !== channelId) {
        return Response.json(
          { error: { code: "CHANNEL_NOT_FOUND", message: "channel_id mismatch", retryable: false } },
          { status: 404 },
        );
      }

      const member = this.ctx.storage.sql
        .exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, userId)
        .toArray()[0] as { x: number } | undefined;
      if (!member) {
        return Response.json(
          { error: { code: "FORBIDDEN", message: "not a member", retryable: false } },
          { status: 403 },
        );
      }

      const requestHash = JSON.stringify({
        type: b.type,
        text: b.text,
        reply_to: b.reply_to,
        mentions: b.mentions ?? [],
      });

      const messageId = uuidv7(nowMs);
      const eventId = this.nextEventId(nowMs);
      const mv = meta.membership_version;
      const persistedPayload = buildMessageCreatedPayload({
        message_id: messageId,
        client_message_id: b.client_message_id,
        channel_id: channelId,
        sender_kind: "user",
        sender_user_id: userId,
        sender_bot_id: null,
        status: "normal",
        created_at: now,
        type: b.type,
        format: "plain",
        text: b.text,
      });
      const payloadJson = JSON.stringify(persistedPayload);

      const livePayload = await resolveSenderForLiveBroadcast(
        persistedPayload,
        async (userIds: string[]) => {
          const raw = await resolveUserSummaries(userIds, this.env);
          const normalized = new Map<string, LiveUserSummary>();
          for (const [id, v] of raw) {
            normalized.set(id, {
              user_id: v.user_id,
              display_name: v.display_name ?? `user-${id.slice(0, 8)}`,
              avatar_url: v.avatar_url,
            });
          }
          return normalized;
        },
      );
      const eventFrame = buildEventFrame({
        event_id: eventId,
        type: "message.created",
        channel_id: channelId,
        occurred_at: now,
        payload: livePayload,
      });
      const eventFrameJson = JSON.stringify(eventFrame);
      const responseJson = JSON.stringify({ message_id: messageId, event_id: eventId });
      const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();

      type SendResult =
        | { kind: "created"; message_id: string; event_id: string }
        | { kind: "cached"; message_id: string; event_id: string }
        | { kind: "conflict" };

      const txResult = await this.ctx.storage.transaction(async (): Promise<SendResult> => {
        const idemRow = this.ctx.storage.sql
          .exec(
            "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='message.send' AND idempotency_key=?",
            userId,
            b.client_message_id,
          )
          .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
        if (idemRow) {
          if (idemRow.request_hash !== requestHash) {
            return { kind: "conflict" };
          }
          const cached = idemRow.response_json
            ? (JSON.parse(idemRow.response_json) as { message_id: string; event_id: string })
            : { message_id: "", event_id: "" };
          return { kind: "cached", message_id: cached.message_id, event_id: cached.event_id };
        }

        this.ctx.storage.sql.exec(
          `INSERT INTO messages (
              message_id, client_message_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
              sender_bot_id, type, format, status, text, reply_to, stream_state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'user', ?, NULL, ?, 'plain', 'normal', ?, ?, 'none', ?, ?)`,
          messageId,
          b.client_message_id,
          b.dedupe_principal_key,
          channelId,
          userId,
          b.type,
          b.text,
          b.reply_to,
          now,
          now,
        );
        if (Array.isArray(b.mentions)) {
          for (const m of b.mentions) {
            this.ctx.storage.sql.exec(
              "INSERT OR IGNORE INTO mentions (message_id, user_id, start, end_) VALUES (?, ?, ?, ?)",
              messageId,
              m.user_id,
              m.start,
              m.end,
            );
          }
        }
        this.ctx.storage.sql.exec(
          "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'message.created', ?, 'user', ?, ?, ?, ?)",
          eventId,
          channelId,
          userId,
          payloadJson,
          mv,
          now,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, idempotency_key, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'message.send', ?, ?, ?, 'completed', ?, ?)",
          userId,
          b.client_message_id,
          requestHash,
          responseJson,
          now,
          idemExpiresAt,
        );
        this.insertOutboxRowForFanout(channelId, eventId, eventFrameJson, mv, now);
        this.ctx.storage.sql.exec(
          "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'message_index', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
          `message_index:${messageId}`,
          messageId,
          JSON.stringify({ message_id: messageId, channel_id: channelId }),
          now,
          now,
          now,
        );
        return { kind: "created", message_id: messageId, event_id: eventId };
      });

      if (txResult.kind === "conflict") {
        return Response.json(
          {
            error: {
              code: "IDEMPOTENCY_CONFLICT",
              message: "client_message_id reused with different body",
              retryable: false,
            },
          },
          { status: 409 },
        );
      }
      if (txResult.kind === "created") {
        await this.scheduleOutboxAlarm(now);
      }
      return Response.json({ message_id: txResult.message_id, event_id: txResult.event_id });
    }

    if (url.pathname === "/internal/replay") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      const after = url.searchParams.get("after") ?? "";
      const meta = this.ctx.storage.sql.exec("SELECT channel_id, visibility FROM channel_meta LIMIT 1").toArray()[0] as
        | { channel_id: string; visibility: string }
        | undefined;
      if (meta === undefined) return Response.json({ events: [] });
      const member = userId
        ? (this.ctx.storage.sql.exec(
            "SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL",
            meta.channel_id,
            userId,
          ).toArray()[0] as { x: number } | undefined)
        : undefined;
      if (!member && meta.visibility === "private") {
        return new Response("forbidden", { status: 403 });
      }

      const rows = this.ctx.storage.sql
        .exec(
          "SELECT event_id, event_type, payload_json, occurred_at FROM events WHERE channel_id=? AND event_id > ? ORDER BY event_id",
          meta.channel_id,
          after,
        )
        .toArray() as Array<Record<string, unknown>>;
      const parsedRows: ReplayEventRow[] = rows.map((row) => ({
        event_id: typeof row.event_id === "string" ? row.event_id : String(row.event_id ?? ""),
        event_type: typeof row.event_type === "string" ? row.event_type : String(row.event_type ?? ""),
        payload_json: typeof row.payload_json === "string" ? row.payload_json : "",
        occurred_at: typeof row.occurred_at === "string" ? row.occurred_at : "",
      }));
      const allSenderIds: string[] = [];
      for (const r of parsedRows) {
        if (r.event_type === "message.created" || r.event_type === "message.updated") {
          try {
            const p = JSON.parse(r.payload_json) as { message?: { sender?: { kind?: string; user_id?: string | null } } };
            if (p.message?.sender?.kind === "user" && p.message.sender.user_id) allSenderIds.push(p.message.sender.user_id);
          } catch {
            // ignore malformed payload
          }
        }
      }

      const senderMap = await resolveUserSummaries(Array.from(new Set(allSenderIds)), this.env);
      const liveSenderMap = new Map<string, LiveUserSummary>();
      for (const [id, summary] of senderMap) {
        liveSenderMap.set(id, {
          user_id: summary.user_id,
          display_name: summary.display_name ?? `user-${id.slice(0, 8)}`,
          avatar_url: summary.avatar_url,
        });
      }
      const out: Array<ReplayEnvelope> = [];

      for (const r of parsedRows) {
        if (r.event_type === "message.created" || r.event_type === "message.updated") {
          try {
            const p = JSON.parse(r.payload_json) as { message?: { message_id?: string } };
            const messageId = p.message?.message_id;
            if (messageId) {
              const st = this.ctx.storage.sql.exec(
                "SELECT status FROM messages WHERE message_id=?",
                messageId,
              ).toArray()[0] as { status: string } | undefined;
              if (st && (st.status === "deleted" || st.status === "recalled")) continue;
            }
          } catch {
            // malformed payload or missing payload message_id
          }
        }

        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(r.payload_json) as Record<string, unknown>;
        } catch {
          payload = {};
        }

        if (r.event_type === "message.created" || r.event_type === "message.updated") {
          payload = await resolveSenderForLiveBroadcast(
            payload,
            async (_userIds: string[]) => liveSenderMap,
          );
        }

        out.push({
          event_id: r.event_id,
          event_json: JSON.stringify(
            buildEventFrame({
              event_id: r.event_id,
              type: r.event_type,
              channel_id: meta.channel_id,
              occurred_at: r.occurred_at,
              payload,
            }),
          ),
        });
      }
      return Response.json({ events: out });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const nowIso = this.nowIso();
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT outbox_id, target_kind, target_key, payload_json FROM projection_outbox WHERE status='pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC",
        nowIso,
      )
      .toArray() as unknown as Array<OutboxRow>;

    for (const r of rows) {
      if (r.target_kind === "user_directory") {
        const req = new Request("https://x/internal/upsert-channel", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Verified-User-Id": r.target_key,
          },
          body: r.payload_json,
        });
        const target = this.env.USER_DIRECTORY.getByName(r.target_key);
        try {
          const res = await target.fetch(req);
          if (!res.ok) {
            const text = await res.text();
            await this.bumpOutboxRetry(r.outbox_id, nowIso, `${res.status}: ${text}`);
            continue;
          }
          this.ctx.storage.sql.exec(
            "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
            nowIso,
            r.outbox_id,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
        }
        continue;
      }

      if (r.target_kind === "channel_fanout") {
        let payload: { action?: string; event_id?: string; event_json?: string; membership_version_at_event?: number; user_id?: string };
        try {
          payload = JSON.parse(r.payload_json) as {
            action?: string;
            event_id?: string;
            event_json?: string;
            membership_version_at_event?: number;
            user_id?: string;
          };
        } catch {
          await this.bumpOutboxRetry(r.outbox_id, nowIso, "invalid payload_json");
          continue;
        }

        const target = this.env.CHANNEL_FANOUT.getByName(r.target_key);
        let res: Response;
        try {
          if (payload.action === "unregister-user") {
            res = await target.fetch(new Request("https://x/unregister-user", {
              method: "POST",
              headers: {
                "X-Channel-Id": r.target_key,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ user_id: payload.user_id ?? "" }),
            }));
          } else {
            res = await target.fetch(new Request("https://x/fanout-enqueue", {
              method: "POST",
              headers: {
                "X-Channel-Id": r.target_key,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                event_id: payload.event_id ?? "",
                event_json: payload.event_json ?? "",
                membership_version_at_event: payload.membership_version_at_event ?? 0,
              }),
            }));
          }
          if (!res.ok) {
            const text = await res.text();
            await this.bumpOutboxRetry(r.outbox_id, nowIso, `${res.status}: ${text}`);
            continue;
          }
          this.ctx.storage.sql.exec(
            "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
            nowIso,
            r.outbox_id,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
        }
        continue;
      }

      if (r.target_kind === "message_index") {
        const target = this.env.MESSAGE_INDEX.getByName(r.target_key);
        try {
          const res = await target.fetch(new Request("https://x/upsert", {
            method: "POST",
            body: r.payload_json,
            headers: { "Content-Type": "application/json" },
          }));
          if (!res.ok) {
            const text = await res.text();
            await this.bumpOutboxRetry(r.outbox_id, nowIso, `${res.status}: ${text}`);
            continue;
          }
          this.ctx.storage.sql.exec(
            "UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?",
            nowIso,
            r.outbox_id,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
        }
        continue;
      }

      await this.bumpOutboxRetry(r.outbox_id, nowIso, `unsupported target_kind=${r.target_kind}`);
    }

    await this.scheduleOutboxAlarm(nowIso);
  }
}
