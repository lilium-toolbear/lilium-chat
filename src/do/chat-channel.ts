import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { execSchema } from "./sql";
import { uuidv7, monotonicUuidV7, type EventSeq } from "../ids/uuidv7";
import {
  buildEventFrame,
  buildMessageCreatedPayload,
  type UserSummary as LiveUserSummary,
} from "../chat/event-broadcast";
import { projectMessageForBrowser } from "../chat/message-projection";
import {
  buildChannelCreatedPayload,
  buildChannelUpdatedPayload,
  buildChannelDissolvedPayload,
  buildMemberJoinedPayload,
  buildMemberRoleUpdatedPayload,
  buildMemberLeftPayload,
  buildSystemNoticePayload,
  resolveActorWithMap,
} from "../chat/channel-events";
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
    message_id TEXT PRIMARY KEY, command_id TEXT NOT NULL,
    dedupe_principal_key TEXT NOT NULL, channel_id TEXT NOT NULL,
    sender_kind TEXT NOT NULL, -- user | bot | system
    sender_user_id TEXT, sender_bot_id TEXT,
    type TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'plain',
    status TEXT NOT NULL DEFAULT 'normal', text TEXT, reply_to TEXT,
    reply_snapshot_json TEXT, stream_state TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, edited_at TEXT,
    deleted_at TEXT, deleted_by TEXT, recalled_at TEXT,
    UNIQUE (channel_id, dedupe_principal_key, command_id)
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
    operation_id TEXT NOT NULL, -- HTTP Idempotency-Key or WS command_id
    request_hash TEXT NOT NULL, response_json TEXT,
    status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY (principal_kind, principal_id, operation, operation_id)
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

export interface MessageRow {
  message_id: string;
  command_id: string;
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
    command_id: r.command_id,
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

  // SYNC core: co-atomic leave + fanout unregister outbox. Runs inside a caller transaction.
  // (P0-6: single leave implementation — /internal/test-leave and members-remove share this.)
  private markMemberLeftAndEnqueueFanoutUnregisterSync(channelId: string, userId: string, nowIso: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE members SET left_at=? WHERE channel_id=? AND user_id=?",
      nowIso, channelId, userId,
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
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'channel_fanout', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
      `channel_fanout:unregister:${channelId}:${userId}:${nowIso}`,
      channelId,
      JSON.stringify({ action: "unregister-user", channel_id: channelId, user_id: userId }),
      nowIso, nowIso, nowIso,
    );
  }

  // Phase 2 path (test-leave): wraps the sync core in its own transaction.
  private async markMemberLeftAndEnqueueFanoutUnregister(channelId: string, userId: string, nowIso: string): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      this.markMemberLeftAndEnqueueFanoutUnregisterSync(channelId, userId, nowIso);
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

  private async resolveActorMap(userIds: string[]): Promise<Map<string, import("../chat/event-broadcast").UserSummary>> {
    const raw = await resolveUserSummaries(userIds, this.env);
    const m = new Map<string, import("../chat/event-broadcast").UserSummary>();
    for (const [id, v] of raw) {
      m.set(id, { user_id: id, display_name: v.display_name ?? `user-${id.slice(0, 8)}`, avatar_url: v.avatar_url });
    }
    return m;
  }

  private assertNotDissolved(status: string): { code: string; message: string } | null {
    if (status === "dissolved") return { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" };
    return null;
  }

  // The caller's role if they are an ACTIVE member (left_at IS NULL), else null.
  private activeRole(channelId: string, userId: string): string | null {
    const row = this.ctx.storage.sql
      .exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, userId)
      .toArray()[0] as { role: string } | undefined;
    return row?.role ?? null;
  }

  // Maps a cached `{channel|member|error}` JSON (encoded inside a txn that cannot write business rows)
  // to the right HTTP status. Shared by all write handlers' cached branches (Tasks 7/8/9/11).
  private cachedResponse(j: string): Response {
    const cached = JSON.parse(j) as { channel?: unknown; member?: unknown; error?: { code?: string; message?: string } };
    if (cached.error) {
      const code = cached.error.code ?? "CHAT_WORKER_UNAVAILABLE";
      const status = code === "FORBIDDEN" ? 403
        : code === "CHANNEL_NOT_FOUND" ? 404
        : code === "MEMBER_NOT_FOUND" ? 404
        : code === "CHANNEL_DISSOLVED" ? 409
        : code === "INVALID_MESSAGE" ? 422
        : 503;
      return Response.json({ error: { code, message: cached.error.message ?? "error", retryable: false } }, { status });
    }
    return new Response(j, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // Sync: persists the event (ref payload) + writes a channel_fanout outbox row with the
  // LIVE-resolved frame. MUST run inside ctx.storage.transaction. The actor map is pre-resolved
  // BEFORE the txn (Hyperdrive is a network call). For read_state.updated (no actor_kind) the
  // caller passes an empty map and the payload is passed through unchanged.
  private persistEventAndFanout(
    eventId: string,
    type: string,
    channelId: string,
    occurredAt: string,
    persistedPayload: Record<string, unknown>,
    membershipVersion: number,
    nowIso: string,
    actorMap: Map<string, import("../chat/event-broadcast").UserSummary>,
  ): void {
    const actorKind = typeof persistedPayload.actor_kind === "string" ? persistedPayload.actor_kind : null;
    const actorId = typeof persistedPayload.actor_id === "string" ? persistedPayload.actor_id : null;
    this.ctx.storage.sql.exec(
      "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      eventId, type, channelId, actorKind, actorId, JSON.stringify(persistedPayload), membershipVersion, occurredAt,
    );
    const livePayload = type === "read_state.updated"
      ? persistedPayload
      : resolveActorWithMap(persistedPayload, actorMap);
    const frame = buildEventFrame({ event_id: eventId, type, channel_id: channelId, occurred_at: occurredAt, payload: livePayload });
    this.insertOutboxRowForFanout(channelId, eventId, JSON.stringify(frame), membershipVersion, nowIso);
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

      const meta = this.ctx.storage.sql.exec("SELECT channel_id, kind, status, membership_version, member_count FROM channel_meta").toArray()[0] as
        | { channel_id: string; kind: string; status: string; membership_version: number; member_count: number }
        | undefined;
      if (meta === undefined) {
        return new Response("not found", { status: 404 });
      }
      channelId = meta.channel_id;
      if (meta.status === "dissolved") {
        return Response.json(
          { error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } },
          { status: 409 },
        );
      }

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
          "SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE channel_id=? AND status NOT IN ('deleted','recalled') ORDER BY message_id DESC LIMIT ?"
        : "SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE channel_id=? AND status NOT IN ('deleted','recalled') AND message_id < ? ORDER BY message_id DESC LIMIT ?";

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
        "INSERT OR REPLACE INTO messages (message_id, command_id, dedupe_principal_key, channel_id, sender_kind, type, status, text, created_at, updated_at) VALUES (?, 'c', 'user:x', 'replay-1', 'user', 'text', 'normal', ?, ?, ?)",
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
        command_id: string;
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
      const messageRowForProjection: MessageRow = {
        message_id: messageId,
        command_id: b.command_id,
        channel_id: channelId,
        sender_kind: "user",
        sender_user_id: userId,
        sender_bot_id: null,
        type: b.type,
        format: "plain",
        status: "normal",
        text: b.text,
        reply_to: b.reply_to,
        reply_snapshot_json: null,
        stream_state: "none",
        created_at: now,
        updated_at: now,
        edited_at: null,
        deleted_at: null,
        deleted_by: null,
        recalled_at: null,
      };
      const persistedPayload = buildMessageCreatedPayload({
        message_id: messageRowForProjection.message_id,
        command_id: messageRowForProjection.command_id,
        channel_id: messageRowForProjection.channel_id,
        sender_kind: messageRowForProjection.sender_kind,
        sender_user_id: messageRowForProjection.sender_user_id,
        sender_bot_id: messageRowForProjection.sender_bot_id,
        status: messageRowForProjection.status,
        created_at: messageRowForProjection.created_at,
        updated_at: messageRowForProjection.updated_at,
        edited_at: messageRowForProjection.edited_at,
        deleted_at: messageRowForProjection.deleted_at,
        deleted_by: messageRowForProjection.deleted_by,
        recalled_at: messageRowForProjection.recalled_at,
        stream_state: messageRowForProjection.stream_state,
        reply_to: messageRowForProjection.reply_to,
        reply_snapshot_json: messageRowForProjection.reply_snapshot_json,
        type: messageRowForProjection.type,
        format: messageRowForProjection.format,
        text: messageRowForProjection.text,
      });
      const payloadJson = JSON.stringify(persistedPayload);
      const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();

      type SendResult =
        | { kind: "created"; message_id: string; event_id: string }
        | { kind: "cached"; response_json: string }
        | { kind: "conflict" }
        | { kind: "dissolved" };

      const txResult = await this.ctx.storage.transaction(async (): Promise<SendResult> => {
        const statusRow = this.ctx.storage.sql.exec("SELECT status FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string } | undefined;
        if (statusRow?.status === "dissolved") {
          return { kind: "dissolved" };
        }
        const idemRow = this.ctx.storage.sql
          .exec(
            "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='message.send' AND operation_id=?",
            userId,
            b.command_id,
          )
          .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
        if (idemRow) {
          if (idemRow.request_hash !== requestHash) {
            return { kind: "conflict" };
          }
          return { kind: "cached", response_json: idemRow.response_json ?? JSON.stringify({ payload: { channel_id: channelId, event_id: "", message: null } }) };
        }

        this.ctx.storage.sql.exec(
          `INSERT INTO messages (
              message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
              sender_bot_id, type, format, status, text, reply_to, stream_state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'user', ?, NULL, ?, 'plain', 'normal', ?, ?, 'none', ?, ?)`,
          messageId,
          b.command_id,
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
        const fallbackEvent = buildEventFrame({
          event_id: eventId,
          type: "message.created",
          channel_id: channelId,
          occurred_at: now,
          payload: { message: projectMessageForBrowser(messageRowForProjection, { senderSummary: { user_id: userId, display_name: `user-${userId.slice(0, 8)}`, avatar_url: null } }) },
        });
        this.ctx.storage.sql.exec(
          "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'message.send', ?, ?, ?, 'completed', ?, ?)",
          userId,
          b.command_id,
          requestHash,
          "{}",
          now,
          idemExpiresAt,
        );
        this.insertOutboxRowForFanout(channelId, eventId, JSON.stringify(fallbackEvent), mv, now);
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
              message: "command_id reused with different body",
              retryable: false,
            },
          },
          { status: 409 },
        );
      }
      if (txResult.kind === "dissolved") {
        return Response.json({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }, { status: 409 });
      }
      if (txResult.kind === "created") {
        let resolvedSender: LiveUserSummary = {
          user_id: userId,
          display_name: `user-${userId.slice(0, 8)}`,
          avatar_url: null,
        };
        try {
          const raw = await resolveUserSummaries([userId], this.env);
          const normalized = raw.get(userId);
          if (normalized) {
            resolvedSender = {
              user_id: normalized.user_id,
              display_name: normalized.display_name ?? `user-${userId.slice(0, 8)}`,
              avatar_url: normalized.avatar_url,
            };
          }
        } catch {
          // fallback handled by the projection builder
        }
        const messageRow = this.ctx.storage.sql.exec(
          "SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE message_id=?",
          txResult.message_id,
        ).toArray()[0] as MessageRow | undefined;
        const row = messageRow ?? messageRowForProjection;
        const message = projectMessageForBrowser(row, { senderSummary: resolvedSender });
        const responsePayload = {
          channel_id: channelId,
          event_id: txResult.event_id,
          message,
        };
        const responseJson = JSON.stringify({
          frame_type: "command_ack",
          command: "message.send",
          command_id: b.command_id,
          status: "committed",
          payload: responsePayload,
        });
        this.ctx.storage.sql.exec(
          "UPDATE idempotency_keys SET response_json=? WHERE principal_kind='user' AND principal_id=? AND operation='message.send' AND operation_id=?",
          responseJson,
          userId,
          b.command_id,
        );
        const fullEvent = buildEventFrame({
          event_id: txResult.event_id,
          type: "message.created",
          channel_id: channelId,
          occurred_at: now,
          payload: { message },
        });
        this.ctx.storage.sql.exec(
          "UPDATE projection_outbox SET payload_json=? WHERE outbox_id=?",
          JSON.stringify({ action: "fanout", event_id: txResult.event_id, event_json: JSON.stringify(fullEvent), membership_version_at_event: mv }),
          `channel_fanout:${channelId}:${txResult.event_id}`,
        );
        await this.scheduleOutboxAlarm(now);
        return Response.json(responsePayload);
      }
      if (txResult.kind === "cached") {
        type CachedAck = {
          payload?: {
            channel_id?: string;
            event_id?: string;
            message?: Record<string, unknown> | null;
          };
          frame_type?: string;
          command?: string;
          status?: string;
          command_id?: string;
        };
        let cachedPayload: { channel_id?: string; event_id?: string; message?: Record<string, unknown> | null } = {};
        try {
          const parsed = JSON.parse(txResult.response_json) as CachedAck;
          if (parsed.payload && typeof parsed.payload === "object") {
            cachedPayload = parsed.payload;
          }
        } catch {
          cachedPayload = { channel_id: channelId, event_id: "", message: null };
        }
        return Response.json({
          channel_id: cachedPayload.channel_id ?? channelId,
          event_id: cachedPayload.event_id ?? "",
          message: cachedPayload.message ?? null,
        });
      }
      await this.scheduleOutboxAlarm(now);
      return Response.json({
        channel_id: channelId,
        event_id: "",
        message: null,
      });
      
    }

    if (url.pathname === "/internal/dissolve") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      if (!userId) return new Response("missing verified user", { status: 401 });
      const b = (await request.json()) as { idempotency_key: string; channel_id: string };
      const channelId = b.channel_id;
      const now = this.nowIso();
      const nowMs = Date.parse(now);
      const requestHash = "{}";
      const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
      const actorMap = await this.resolveActorMap([userId]);

      const txResult = await this.ctx.storage.transaction(async (): Promise<
        | { kind: "conflict" }
        | { kind: "cached"; responseJson: string }
        | { kind: "dissolved"; channel: Record<string, unknown> }
      > => {
        const idem = this.ctx.storage.sql
          .exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.dissolve' AND operation_id=?", userId, b.idempotency_key)
          .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
        if (idem) {
          if (idem.request_hash !== requestHash) return { kind: "conflict" };
          return { kind: "cached", responseJson: idem.response_json ?? "{}" };
        }

        const meta = this.ctx.storage.sql.exec("SELECT status, created_by FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; created_by: string } | undefined;
        if (meta === undefined) return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };

        if (meta.status === "dissolved") {
          // already dissolved — idempotent cached result (no key recorded yet → record now)
          const responseJson = JSON.stringify({ channel: { channel_id: channelId, status: "dissolved", updated_at: now } });
          this.ctx.storage.sql.exec(
            "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.dissolve', ?, ?, ?, 'completed', ?, ?)",
            userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt,
          );
          return { kind: "cached", responseJson };
        }

        if (meta.created_by !== userId) {
          return { kind: "cached", responseJson: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may dissolve", retryable: false } }) };
        }

        const mvRow = this.ctx.storage.sql.exec("SELECT membership_version FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { membership_version: number } | undefined;
        const mv = mvRow?.membership_version ?? 0;
        this.ctx.storage.sql.exec("UPDATE channel_meta SET status='dissolved', updated_at=? WHERE channel_id=?", now, channelId);
        const dissolvedId = this.nextEventId(nowMs);
        this.persistEventAndFanout(dissolvedId, "channel.dissolved", channelId, now,
          buildChannelDissolvedPayload({ channel_id: channelId, dissolved_at: now, actor_kind: "user", actor_id: userId }), mv, now, actorMap);
        const noticeId = this.nextEventId(nowMs);
        this.persistEventAndFanout(noticeId, "system.notice", channelId, now,
          buildSystemNoticePayload({ notice_kind: "channel.dissolved", actor_kind: "user", actor_id: userId, target_user_id: null, message_id: null, channel_changes: null }), mv, now, actorMap);

        const responseJson = JSON.stringify({ channel: { channel_id: channelId, status: "dissolved", updated_at: now } });
        this.ctx.storage.sql.exec(
          "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.dissolve', ?, ?, ?, 'completed', ?, ?)",
          userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt,
        );
        return { kind: "dissolved", channel: { channel_id: channelId, status: "dissolved", updated_at: now } };
      });

      if (txResult.kind === "conflict") {
        return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
      }
      if (txResult.kind === "dissolved") {
        await this.scheduleOutboxAlarm(now);
        return Response.json({ channel: txResult.channel }, { status: 200 });
      }
      // cached (already-dissolved cached result OR an error shape encoded inside the txn).
      return this.cachedResponse(txResult.responseJson);
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
      const managementTypes = new Set([
        "channel.created",
        "channel.updated",
        "channel.dissolved",
        "member.joined",
        "member.left",
        "member.role_updated",
        "system.notice",
      ]);
      const userIdsToResolve: string[] = [];
      for (const r of parsedRows) {
        if (r.event_type === "message.created" || r.event_type === "message.updated") {
          try {
            const p = JSON.parse(r.payload_json) as { message?: { sender?: { kind?: string; user_id?: string | null } } };
            if (p.message?.sender?.kind === "user" && p.message.sender.user_id) userIdsToResolve.push(p.message.sender.user_id);
          } catch {
            // ignore malformed payload
          }
          continue;
        }
        if (managementTypes.has(r.event_type)) {
          try {
            const p = JSON.parse(r.payload_json) as {
              actor_kind?: string;
              actor_id?: string;
              target_user_id?: string | null;
            };
            if (p.actor_kind === "user" && typeof p.actor_id === "string" && p.actor_id) userIdsToResolve.push(p.actor_id);
            if (typeof p.target_user_id === "string" && p.target_user_id) userIdsToResolve.push(p.target_user_id);
          } catch {
            // ignore malformed payload
          }
        }
      }

      const rawMap = await resolveUserSummaries(Array.from(new Set(userIdsToResolve)), this.env);
      const liveSenderMap = new Map<string, LiveUserSummary>();
      const liveMap = new Map<string, LiveUserSummary>();
      for (const [id, summary] of rawMap) {
        const resolved = {
          user_id: summary.user_id,
          display_name: summary.display_name ?? `user-${id.slice(0, 8)}`,
          avatar_url: summary.avatar_url,
        };
        liveMap.set(id, resolved);
        liveSenderMap.set(id, resolved);
      }
      const out: Array<ReplayEnvelope> = [];

      for (const r of parsedRows) {
        if (r.event_type === "message.created" || r.event_type === "message.updated") {
          try {
            const p = JSON.parse(r.payload_json) as { message?: { message_id?: string } };
            const messageId = p.message?.message_id;
            if (messageId) {
              const messageRow = this.ctx.storage.sql.exec(
                "SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE message_id=?",
                messageId,
              ).toArray()[0] as MessageRow | undefined;
              if (messageRow && (messageRow.status === "deleted" || messageRow.status === "recalled")) continue;
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
          try {
            const p = JSON.parse(r.payload_json) as { message?: { message_id?: string } };
            const messageId = p.message?.message_id;
            if (!messageId) {
              throw new Error("missing message_id");
            }
            const messageRow = this.ctx.storage.sql.exec(
              "SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE message_id=?",
              messageId,
            ).toArray()[0] as MessageRow | undefined;
            if (!messageRow) {
              throw new Error("message row missing");
            }
            const senderSummary = messageRow.sender_kind === "user" && messageRow.sender_user_id
              ? liveSenderMap.get(messageRow.sender_user_id) ?? undefined
              : undefined;
            payload = { message: projectMessageForBrowser(messageRow, { senderSummary }) };
          } catch {
            // malformed payload or missing payload
          }
        }
        if (managementTypes.has(r.event_type) && r.event_type !== "read_state.updated") {
          payload = resolveActorWithMap(payload, liveMap);
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

    if (url.pathname === "/internal/create-channel") {
      const creatorUserId = request.headers.get("X-Verified-User-Id") ?? "";
      if (!creatorUserId) return new Response("missing verified user", { status: 401 });
      const b = (await request.json()) as {
        channel_id: string; creator_user_id: string; title: string; topic: string | null;
        avatar_attachment_id: string | null; visibility: string;
        initial_members: Array<{ user_id: string; role: string }>;
      };
      const channelId = b.channel_id;
      if (!channelId) return Response.json({ error: { code: "INVALID_MESSAGE", message: "channel_id required", retryable: false } }, { status: 422 });
      const title = typeof b.title === "string" ? b.title.trim() : "";
      if (title === "") return Response.json({ error: { code: "INVALID_MESSAGE", message: "title is required", retryable: false } }, { status: 422 });
      if (b.avatar_attachment_id !== null && b.avatar_attachment_id !== undefined) {
        return Response.json({ error: { code: "INVALID_MESSAGE", message: "avatar_attachment_id not supported in Phase 3", retryable: false } }, { status: 422 });
      }
      const visibility = b.visibility ?? "private";
      if (!["private", "public_unlisted", "public_listed"].includes(visibility)) {
        return Response.json({ error: { code: "INVALID_MESSAGE", message: "invalid visibility", retryable: false } }, { status: 422 });
      }
      const initialMembers = Array.isArray(b.initial_members) ? b.initial_members : [];
      for (const im of initialMembers) {
        if (im.role !== "member" && im.role !== "admin") {
          return Response.json({ error: { code: "INVALID_MESSAGE", message: "initial_members role must be member or admin", retryable: false } }, { status: 422 });
        }
        if (im.user_id === creatorUserId) {
          return Response.json({ error: { code: "INVALID_MESSAGE", message: "creator must not be in initial_members", retryable: false } }, { status: 422 });
        }
      }

      const now = this.nowIso();
      const nowMs = Date.parse(now);

      // Pre-resolve actor UserSummary BEFORE the txn (Hyperdrive is a network call).
      const actorMap = await this.resolveActorMap([creatorUserId]);

      // Build all persisted payloads + event ids + live frames up front (sync), then write in one txn.
      const ownerMv = 1;
      const events: Array<{ id: string; type: string; payload: Record<string, unknown>; mv: number }> = [];
      const channelCreatedId = this.nextEventId(nowMs);
      events.push({ id: channelCreatedId, type: "channel.created", payload: buildChannelCreatedPayload({ channel_id: channelId, kind: "channel", visibility, title, actor_kind: "user", actor_id: creatorUserId }), mv: ownerMv });
      const memberJoinedCreatorId = this.nextEventId(nowMs);
      events.push({ id: memberJoinedCreatorId, type: "member.joined", payload: buildMemberJoinedPayload({ channel_id: channelId, user_id: creatorUserId, role: "owner", membership_version: ownerMv, actor_kind: "system", actor_id: "system" }), mv: ownerMv });

      let mv = ownerMv;
      for (const im of initialMembers) {
        mv += 1;
        const eid = this.nextEventId(nowMs);
        events.push({ id: eid, type: "member.joined", payload: buildMemberJoinedPayload({ channel_id: channelId, user_id: im.user_id, role: im.role, membership_version: mv, actor_kind: "system", actor_id: "system" }), mv });
      }
      const noticeId = this.nextEventId(nowMs);
      events.push({ id: noticeId, type: "system.notice", payload: buildSystemNoticePayload({ notice_kind: "channel.created", actor_kind: "user", actor_id: creatorUserId, target_user_id: null, message_id: null, channel_changes: null }), mv });

      const finalMv = mv;
      const memberCount = 1 + initialMembers.length;

      const result = await this.ctx.storage.transaction(async (): Promise<
        | { kind: "cached"; channel: Record<string, unknown>; joinedAt: string }
        | { kind: "created"; channel: Record<string, unknown>; joinedAt: string }
      > => {
        const existing = this.ctx.storage.sql.exec("SELECT channel_id FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { channel_id: string } | undefined;
        if (existing !== undefined) {
          // Idempotent re-call (coordinator crashed after create committed, before marking completed).
          // Return the channel FROM THE DB, not from the request body — the re-call may carry a
          // different body shape than the original committed row.
          const meta = this.ctx.storage.sql.exec("SELECT channel_id, kind, visibility, title, topic, avatar_url, member_count, status, created_at, updated_at FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { channel_id: string; kind: string; visibility: string; title: string; topic: string | null; avatar_url: string | null; member_count: number; status: string; created_at: string; updated_at: string };
          const owner = this.ctx.storage.sql.exec("SELECT joined_at FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, creatorUserId).toArray()[0] as { joined_at: string } | undefined;
          const cachedChannel = { channel_id: meta.channel_id, kind: meta.kind, visibility: meta.visibility, title: meta.title, topic: meta.topic, avatar_url: meta.avatar_url, member_count: meta.member_count, status: meta.status, created_at: meta.created_at, updated_at: meta.updated_at };
          return { kind: "cached" as const, channel: cachedChannel, joinedAt: owner?.joined_at ?? meta.created_at };
        }

        this.ctx.storage.sql.exec(
          `INSERT INTO channel_meta (channel_id, kind, visibility, title, topic, avatar_url, status, created_by, created_at, updated_at, member_count, membership_version) VALUES (?, 'channel', ?, ?, ?, NULL, 'active', ?, ?, ?, ?, ?)`,
          channelId, visibility, title, b.topic ?? null, creatorUserId, now, now, memberCount, finalMv,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'owner', ?, NULL)",
          channelId, creatorUserId, now,
        );
        for (const im of initialMembers) {
          this.ctx.storage.sql.exec(
            "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, ?, ?, NULL)",
            channelId, im.user_id, im.role, now,
          );
        }
        for (const ev of events) {
          this.persistEventAndFanout(ev.id, ev.type, channelId, now, ev.payload, ev.mv, now, actorMap);
        }
        // user_directory join projections (creator + each initial member)
        this.ctx.storage.sql.exec(
          "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'user_directory', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
          `user_directory:join:${channelId}:${creatorUserId}:${now}`,
          creatorUserId,
          JSON.stringify({ action: "join", channel_id: channelId, kind: "channel", membership_version: ownerMv }),
          now, now, now,
        );
        for (const im of initialMembers) {
          this.ctx.storage.sql.exec(
            "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'user_directory', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
            `user_directory:join:${channelId}:${im.user_id}:${now}`,
            im.user_id,
            JSON.stringify({ action: "join", channel_id: channelId, kind: "channel", membership_version: finalMv }),
            now, now, now,
          );
        }
        return { kind: "created" as const, channel: { channel_id: channelId, kind: "channel", visibility, title, topic: b.topic ?? null, avatar_url: null, member_count: memberCount, status: "active", created_at: now, updated_at: now }, joinedAt: now };
      });

      if (result.kind === "created") await this.scheduleOutboxAlarm(now);

      return Response.json({
        channel: result.channel,
        membership: { role: "owner", joined_at: result.joinedAt },
        event_ids: result.kind === "created" ? events.map((e) => e.id) : [],
      });
    }

    if (url.pathname === "/internal/update-channel") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      if (!userId) return new Response("missing verified user", { status: 401 });
      const b = (await request.json()) as {
        idempotency_key: string; channel_id: string;
        title?: string; topic?: string | null; avatar_attachment_id?: string | null; visibility?: string;
      };
      const channelId = b.channel_id;
      const now = this.nowIso();
      const nowMs = Date.parse(now);

      // Presence-aware canonical request body: omitted field vs explicit null are DISTINCT.
      // `title:"x"` (only title set) must hash differently from `title:"x", topic:null`,
      // otherwise a second request that explicitly nulls `topic` would collide with an omit-topic
      // request and wrongly register as cached/conflict. Capture exactly the keys the client sent.
      const present: Record<string, unknown> = {};
      if (b.title !== undefined) present.title = b.title;
      if (b.topic !== undefined) present.topic = b.topic;
      if (b.avatar_attachment_id !== undefined) present.avatar_attachment_id = b.avatar_attachment_id;
      if (b.visibility !== undefined) present.visibility = b.visibility;
      const requestHash = JSON.stringify(present);
      const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();

      const actorMap = await this.resolveActorMap([userId]);

      const txResult = await this.ctx.storage.transaction(async (): Promise<
        | { kind: "conflict" }
        | { kind: "cached"; responseJson: string }
        | { kind: "ok"; channel: Record<string, unknown> }
      > => {
        const idem = this.ctx.storage.sql
          .exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.update' AND operation_id=?", userId, b.idempotency_key)
          .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
        if (idem) {
          if (idem.request_hash !== requestHash) return { kind: "conflict" };
          return { kind: "cached", responseJson: idem.response_json ?? "{}" };
        }

        const meta = this.ctx.storage.sql
          .exec("SELECT kind, visibility, title, topic, avatar_url, status, created_at, member_count, membership_version FROM channel_meta WHERE channel_id=?", channelId)
          .toArray()[0] as { kind: string; visibility: string; title: string; topic: string | null; avatar_url: string | null; status: string; created_at: string; member_count: number; membership_version: number } | undefined;
        if (meta === undefined) {
          // channel gone → 404 CHANNEL_NOT_FOUND (NOT a conflict).
          return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
        }
        const d = this.assertNotDissolved(meta.status);
        if (d) return { kind: "cached", responseJson: JSON.stringify({ error: { code: d.code, message: d.message, retryable: false } }) };

        const role = this.activeRole(channelId, userId);
        if (role !== "owner" && role !== "admin") {
          return { kind: "cached", responseJson: JSON.stringify({ error: { code: "FORBIDDEN", message: "not authorized to update channel", retryable: false } }) };
        }

        const changes: Record<string, { before: unknown; after: unknown }> = {};
        const newTitle = b.title !== undefined ? b.title : meta.title;
        const newTopic = b.topic !== undefined ? b.topic : meta.topic;
        const newVisibility = b.visibility !== undefined ? b.visibility : meta.visibility;
        const newAvatarUrl = meta.avatar_url; // avatar_attachment_id processed in Phase 5
        if (b.title !== undefined && b.title !== meta.title) changes.title = { before: meta.title, after: b.title };
        if (b.topic !== undefined && b.topic !== meta.topic) changes.topic = { before: meta.topic, after: b.topic };
        if (b.visibility !== undefined && b.visibility !== meta.visibility) {
          if (!["private", "public_unlisted", "public_listed"].includes(b.visibility)) return { kind: "cached", responseJson: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "invalid visibility", retryable: false } }) };
          changes.visibility = { before: meta.visibility, after: b.visibility };
        }

        this.ctx.storage.sql.exec(
          "UPDATE channel_meta SET title=?, topic=?, visibility=?, avatar_url=?, updated_at=? WHERE channel_id=?",
          newTitle, newTopic, newVisibility, newAvatarUrl, now, channelId,
        );

        const mv = meta.membership_version;
        const updatedId = this.nextEventId(nowMs);
        this.persistEventAndFanout(updatedId, "channel.updated", channelId, now,
          buildChannelUpdatedPayload({ channel_id: channelId, channel_changes: changes, actor_kind: "user", actor_id: userId }), mv, now, actorMap);
        const noticeId = this.nextEventId(nowMs);
        this.persistEventAndFanout(noticeId, "system.notice", channelId, now,
          buildSystemNoticePayload({ notice_kind: "channel.updated", actor_kind: "user", actor_id: userId, target_user_id: null, message_id: null, channel_changes: changes }), mv, now, actorMap);

        const channel = { channel_id: channelId, kind: meta.kind, visibility: newVisibility, title: newTitle, topic: newTopic, avatar_url: newAvatarUrl, member_count: meta.member_count, status: meta.status, created_at: meta.created_at, updated_at: now };
        const responseJson = JSON.stringify({ channel });
        this.ctx.storage.sql.exec(
          "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.update', ?, ?, ?, 'completed', ?, ?)",
          userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt,
        );
        return { kind: "ok", channel };
      });

      if (txResult.kind === "conflict") {
        return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
      }
      if (txResult.kind === "ok") {
        await this.scheduleOutboxAlarm(now);
        return Response.json({ channel: txResult.channel }, { status: 200 });
      }
      // cached branch (success cached OR an error shape encoded inside the txn).
      return this.cachedResponse(txResult.responseJson);
    }

    if (url.pathname === "/internal/members-add") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      if (!userId) return new Response("missing verified user", { status: 401 });
      const b = (await request.json()) as { idempotency_key: string; channel_id: string; user_id: string; role: string };
      const channelId = b.channel_id;
      const now = this.nowIso();
      const nowMs = Date.parse(now);
      const requestHash = JSON.stringify({ user_id: b.user_id, role: b.role });
      const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
      const actorMap = await this.resolveActorMap([userId, b.user_id]);

      const tx = await this.ctx.storage.transaction(async (): Promise<{ kind: "cached"; j: string } | { kind: "conflict" } | { kind: "ok"; member: Record<string, unknown> }> => {
        const idem = this.ctx.storage.sql.exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='members.add' AND operation_id=?", userId, b.idempotency_key).toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
        if (idem) { if (idem.request_hash !== requestHash) return { kind: "conflict" }; return { kind: "cached", j: idem.response_json ?? "{}" }; }

        const meta = this.ctx.storage.sql.exec("SELECT status, membership_version, member_count, kind, created_by FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; membership_version: number; member_count: number; kind: string; created_by: string } | undefined;
        if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
        if (meta.status === "dissolved") return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
        const callerRole = this.activeRole(channelId, userId);
        if (callerRole !== "owner" && callerRole !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "not authorized to add members", retryable: false } }) };
        if (b.role !== "member" && b.role !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "role must be member or admin", retryable: false } }) };
        if (b.user_id === userId) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "cannot add self", retryable: false } }) };
        if (b.user_id === meta.created_by) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner is fixed; cannot add the owner", retryable: false } }) };

        // Member state machine (P0-5): distinguish never-joined / left / active.
        const existing = this.ctx.storage.sql.exec("SELECT role, left_at FROM members WHERE channel_id=? AND user_id=?", channelId, b.user_id).toArray()[0] as { role: string; left_at: string | null } | undefined;

        if (existing !== undefined && existing.left_at === null) {
          // Already an ACTIVE member — adding must NOT mutate role (that's PATCH /members/{user_id}).
          if (existing.role !== b.role) {
            return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "member already active; use PATCH /members/{user_id} to change role", retryable: false } }) };
          }
          // Idempotent re-add, no state change.
          const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: b.user_id, role: existing.role } });
          this.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.add', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
          return { kind: "cached", j: responseJson };
        }

        const mv = meta.membership_version + 1;
        // never joined → INSERT; left → reactivate (clear left_at, set role). Count +1 either way.
        if (existing === undefined) {
          this.ctx.storage.sql.exec("INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, ?, ?, NULL)", channelId, b.user_id, b.role, now);
        } else {
          this.ctx.storage.sql.exec("UPDATE members SET role=?, joined_at=?, left_at=NULL WHERE channel_id=? AND user_id=?", b.role, now, channelId, b.user_id);
        }
        this.ctx.storage.sql.exec("UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?", mv, meta.member_count + 1, now, channelId);

        const joinedId = this.nextEventId(nowMs);
        this.persistEventAndFanout(joinedId, "member.joined", channelId, now, buildMemberJoinedPayload({ channel_id: channelId, user_id: b.user_id, role: b.role, membership_version: mv, actor_kind: "user", actor_id: userId }), mv, now, actorMap);
        const noticeId = this.nextEventId(nowMs);
        this.persistEventAndFanout(noticeId, "system.notice", channelId, now, buildSystemNoticePayload({ notice_kind: "member.joined", actor_kind: "user", actor_id: userId, target_user_id: b.user_id, message_id: null, channel_changes: null }), mv, now, actorMap);
        this.ctx.storage.sql.exec("INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'user_directory', ?, '', ?, 'pending', ?, ?, ?, 0, 5)", `user_directory:join:${channelId}:${b.user_id}:${now}`, b.user_id, JSON.stringify({ action: "join", channel_id: channelId, kind: meta.kind, membership_version: mv }), now, now, now);

        const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: b.user_id, role: b.role, joined_at: now } });
        this.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.add', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
        return { kind: "ok", member: { channel_id: channelId, user_id: b.user_id, role: b.role, joined_at: now } };
      });
      if (tx.kind === "conflict") return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
      if (tx.kind === "ok") await this.scheduleOutboxAlarm(now);
      return tx.kind === "ok" ? Response.json({ member: tx.member }, { status: 200 }) : this.cachedResponse(tx.j);
    }

    if (url.pathname === "/internal/members-update-role") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      if (!userId) return new Response("missing verified user", { status: 401 });
      const b = (await request.json()) as { idempotency_key: string; channel_id: string; user_id: string; role: string };
      const channelId = b.channel_id;
      const now = this.nowIso();
      const nowMs = Date.parse(now);
      const requestHash = JSON.stringify({ user_id: b.user_id, role: b.role });
      const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
      const actorMap = await this.resolveActorMap([userId, b.user_id]);

      const tx = await this.ctx.storage.transaction(async (): Promise<{ kind: "conflict" } | { kind: "cached"; j: string } | { kind: "ok"; member: Record<string, unknown> }> => {
        const idem = this.ctx.storage.sql.exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='members.role' AND operation_id=?", userId, b.idempotency_key).toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
        if (idem) { if (idem.request_hash !== requestHash) return { kind: "conflict" }; return { kind: "cached", j: idem.response_json ?? "{}" }; }

        const meta = this.ctx.storage.sql.exec("SELECT status, membership_version, created_by FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; membership_version: number; created_by: string } | undefined;
        if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
        if (meta.status === "dissolved") return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
        const callerRole = this.activeRole(channelId, userId);
        if (callerRole !== "owner") return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may change roles", retryable: false } }) };
        if (b.role !== "member" && b.role !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "role must be member or admin", retryable: false } }) };
        const target = this.ctx.storage.sql.exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, b.user_id).toArray()[0] as { role: string } | undefined;
        if (!target) return { kind: "cached", j: JSON.stringify({ error: { code: "MEMBER_NOT_FOUND", message: "target not an active member", retryable: false } }) };
        if (b.user_id === meta.created_by) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "cannot change the owner's role (owner is fixed)", retryable: false } }) };
        if (b.user_id === userId) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner cannot change own role", retryable: false } }) };

        const mv = meta.membership_version + 1;
        const beforeRole = target.role;
        this.ctx.storage.sql.exec("UPDATE members SET role=? WHERE channel_id=? AND user_id=?", b.role, channelId, b.user_id);
        this.ctx.storage.sql.exec("UPDATE channel_meta SET membership_version=?, updated_at=? WHERE channel_id=?", mv, now, channelId);

        const updatedId = this.nextEventId(nowMs);
        this.persistEventAndFanout(updatedId, "member.role_updated", channelId, now, buildMemberRoleUpdatedPayload({ channel_id: channelId, user_id: b.user_id, before_role: beforeRole, after_role: b.role, membership_version: mv, actor_kind: "user", actor_id: userId }), mv, now, actorMap);
        const noticeId = this.nextEventId(nowMs);
        this.persistEventAndFanout(noticeId, "system.notice", channelId, now, buildSystemNoticePayload({ notice_kind: "member.role_updated", actor_kind: "user", actor_id: userId, target_user_id: b.user_id, message_id: null, channel_changes: null }), mv, now, actorMap);

        const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: b.user_id, role: b.role } });
        this.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.role', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
        return { kind: "ok", member: { channel_id: channelId, user_id: b.user_id, role: b.role } };
      });
      if (tx.kind === "conflict") return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
      if (tx.kind === "ok") await this.scheduleOutboxAlarm(now);
      return tx.kind === "ok" ? Response.json({ member: tx.member }, { status: 200 }) : this.cachedResponse(tx.j);
    }

    if (url.pathname === "/internal/members-remove") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      if (!userId) return new Response("missing verified user", { status: 401 });
      const b = (await request.json()) as { idempotency_key: string; channel_id: string; user_id: string };
      const channelId = b.channel_id;
      const now = this.nowIso();
      const nowMs = Date.parse(now);
      const requestHash = JSON.stringify({ user_id: b.user_id });
      const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
      const actorMap = await this.resolveActorMap([userId, b.user_id]);

      const tx = await this.ctx.storage.transaction(async (): Promise<{ kind: "conflict" } | { kind: "cached"; j: string } | { kind: "ok" }> => {
        const idem = this.ctx.storage.sql.exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='members.remove' AND operation_id=?", userId, b.idempotency_key).toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
        if (idem) { if (idem.request_hash !== requestHash) return { kind: "conflict" }; return { kind: "cached", j: idem.response_json ?? "{}" }; }

        const meta = this.ctx.storage.sql.exec("SELECT status, membership_version, kind, created_by FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; membership_version: number; kind: string; created_by: string } | undefined;
        if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
        if (meta.status === "dissolved") return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
        const callerRole = this.activeRole(channelId, userId);
        const isSelf = b.user_id === userId;
        if (!isSelf && callerRole !== "owner") return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may remove others", retryable: false } }) };
        // Owner invariant (P1-6): the owner cannot self-leave (no owner-transfer in Phase 3; dissolve is the owner exit).
        if (isSelf && b.user_id === meta.created_by) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner cannot leave; dissolve the channel or transfer ownership in a future phase", retryable: false } }) };
        const target = this.ctx.storage.sql.exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, b.user_id).toArray()[0] as { role: string } | undefined;
        if (!target) return { kind: "cached", j: JSON.stringify({ error: { code: "MEMBER_NOT_FOUND", message: "target not an active member", retryable: false } }) };

        const mv = meta.membership_version + 1;
        // Reuse the SINGLE sync leave implementation (P0-6): co-atomic left_at + count + fanout unregister outbox.
        this.markMemberLeftAndEnqueueFanoutUnregisterSync(channelId, b.user_id, now);
        // Re-read the bumped mv/counts the sync core wrote, so the events below carry the authoritative mv.
        const mvAfter = (this.ctx.storage.sql.exec("SELECT membership_version FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { membership_version: number }).membership_version;

        const leftId = this.nextEventId(nowMs);
        this.persistEventAndFanout(leftId, "member.left", channelId, now, buildMemberLeftPayload({ channel_id: channelId, user_id: b.user_id, role: target.role, membership_version: mvAfter, actor_kind: "user", actor_id: userId }), mvAfter, now, actorMap);
        const noticeId = this.nextEventId(nowMs);
        this.persistEventAndFanout(noticeId, "system.notice", channelId, now, buildSystemNoticePayload({ notice_kind: "member.left", actor_kind: "user", actor_id: userId, target_user_id: b.user_id, message_id: null, channel_changes: null }), mvAfter, now, actorMap);
        // user_directory leave projection (so my_channels reflects status='left')
        this.ctx.storage.sql.exec("INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'user_directory', ?, '', ?, 'pending', ?, ?, ?, 0, 5)", `user_directory:leave:${channelId}:${b.user_id}:${now}`, b.user_id, JSON.stringify({ action: "leave", channel_id: channelId, kind: meta.kind, membership_version: mvAfter }), now, now, now);

        const responseJson = JSON.stringify({ channel_id: channelId, user_id: b.user_id, removed: true });
        this.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.remove', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
        return { kind: "ok" };
      });
      if (tx.kind === "conflict") return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
      if (tx.kind === "ok") await this.scheduleOutboxAlarm(now);
      if (tx.kind === "ok") return Response.json({ channel_id: channelId, user_id: b.user_id, removed: true }, { status: 200 });
      return this.cachedResponse((tx as { j: string }).j);
    }

    if (url.pathname === "/internal/members-list") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      const realMeta = this.ctx.storage.sql.exec("SELECT channel_id, status FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string; status: string } | undefined;
      if (!realMeta) return new Response("channel not created", { status: 409 });
      // Must be an ACTIVE member (even dissolved channels require it — no leaking member lists to ex-members).
      const activeMember = userId ? (this.ctx.storage.sql.exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", realMeta.channel_id, userId).toArray()[0] as { x: number } | undefined) : undefined;
      if (!activeMember) return new Response("forbidden", { status: 403 });
      // Cursor is the last user_id of the previous page; members-list pages by joined_at ASC (tiebreak user_id).
      const cursorUserId = url.searchParams.get("cursor") ?? "";
      const rows = this.ctx.storage.sql.exec(
        "SELECT user_id, role, joined_at FROM members WHERE channel_id=? AND left_at IS NULL AND user_id > ? ORDER BY user_id ASC LIMIT 101",
        realMeta.channel_id, cursorUserId,
      ).toArray() as Array<{ user_id: string; role: string; joined_at: string }>;
      // Return raw active members (the Worker resolves UserSummaries + applies the query filter).
      return Response.json({ items: rows.map((r) => ({ user_id: r.user_id, role: r.role, joined_at: r.joined_at })) });
    }

    if (url.pathname === "/internal/members-get") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      const targetUserId = url.searchParams.get("user_id") ?? "";
      const realMeta = this.ctx.storage.sql.exec("SELECT channel_id, status FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string; status: string } | undefined;
      if (!realMeta) return new Response("channel not created", { status: 409 });
      // Must be an ACTIVE member (P1-3): no member read for non-members, dissolved or not.
      const activeMember = userId ? (this.ctx.storage.sql.exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", realMeta.channel_id, userId).toArray()[0] as { x: number } | undefined) : undefined;
      if (!activeMember) return new Response("forbidden", { status: 403 });

      const row = this.ctx.storage.sql.exec("SELECT role, joined_at, left_at FROM members WHERE channel_id=? AND user_id=?", realMeta.channel_id, targetUserId).toArray()[0] as
        | { role: string; joined_at: string; left_at: string | null }
        | undefined;
      if (!row) return Response.json({ error: { code: "MEMBER_NOT_FOUND", message: "user is not a member of this channel", retryable: false } }, { status: 404 });
      const status = row.left_at === null ? "active" : "left";
      return Response.json({ user_id: targetUserId, role: row.role, joined_at: row.joined_at, status });
    }

    if (url.pathname === "/internal/unread-count") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      const after = url.searchParams.get("after") ?? "";
      const realMeta = this.ctx.storage.sql.exec("SELECT channel_id FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string } | undefined;
      if (!realMeta) return Response.json({ unread_count: 0 });
      // Count message.created events after the cursor that were not authored by this user.
      const rows = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS c FROM events WHERE channel_id=? AND event_id > ? AND event_type='message.created'",
        realMeta.channel_id, after,
      ).toArray()[0] as { c: number | bigint };
      // Subtract the user's own messages: count their messages after the cursor.
      const own = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS c FROM events WHERE channel_id=? AND event_id > ? AND event_type='message.created' AND actor_id=?",
        realMeta.channel_id, after, userId,
      ).toArray()[0] as { c: number | bigint };
      const total = Number(rows.c ?? 0);
      const ownCount = Number(own.c ?? 0);
      return Response.json({ unread_count: Math.max(0, total - ownCount) });
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
