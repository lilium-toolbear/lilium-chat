import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { handleSchemaVersionRequest } from "./sql-migrations";
import { migrateUserConnectionSchema } from "./migrations/user-connection";
import { parseFrame, type CommandAckFrame, type CommandErrorFrame, type EventFrame, type UserEventFrame } from "../ws/frames";
import { dedupePrincipalKeyForUser, parseMessageDeleteCommand, parseMessageEditCommand, parseMessageRecallCommand, parseMessageSendCommand } from "../chat/command";
import { parseCommandInvokeCommand } from "../chat/command-invoke";
import type { MessageMutationAckPayload, MessageMutationInternalRequest } from "../contract/idempotency";
import { requireTestOnly } from "./do-errors";

export interface ConnectionAttachment {
  user_id: string;
  session_id: string;
  last_deliver?: string;
}

interface MyChannelRow {
  channel_id: string;
  membership_version: number;
}

interface SendError {
  code: string;
  message: string;
  retryable: boolean;
  active_session?: {
    session_id: string;
    command_name: string;
    started_by: { user_id: string; display_name: string; avatar_url: string | null };
    started_at: string;
    expires_at: string;
  };
}

interface DeliverResult {
  delivered: boolean;
  reason?: string;
  buffered?: boolean;
}

interface LiveChannelLeaseRow {
  session_id: string;
  channel_id: string;
  route_name: string;
  lease_id: string;
  membership_version: number;
  status: string;
  expires_at: string;
}

const LEASE_TTL_MS = 10 * 60 * 1000;
/** Matches browser `session.heartbeat` interval (see toolbear_ui useChatSocket). */
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
/** Refresh lease TTL when expiry is within one heartbeat + safety margin. */
const LEASE_REFRESH_LEAD_MS = HEARTBEAT_INTERVAL_MS + 60_000;

interface LeaseSyncResult {
  active_count: number;
  upserted_count: number;
  closed_count: number;
  lease_expires_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function leaseExpiresAt(): string {
  return new Date(Date.now() + LEASE_TTL_MS).toISOString();
}

function leaseNeedsRefresh(
  existing: LiveChannelLeaseRow | null,
  targetMembershipVersion: number,
  reopenClosed: boolean,
): boolean {
  if (!existing) return true;
  if (existing.status === "closed") return reopenClosed;
  if (existing.status !== "active") return true;
  if (existing.membership_version < targetMembershipVersion) return true;
  const remainingMs = Date.parse(existing.expires_at) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= LEASE_REFRESH_LEAD_MS) return true;
  return false;
}

function sessionSeenNeedsRefresh(lastSeenAt: string, nowMs: number): boolean {
  const lastSeenMs = Date.parse(lastSeenAt);
  return !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= HEARTBEAT_INTERVAL_MS;
}

function responseError(code: string, message: string, retryable = false): SendError {
  return { code, message, retryable };
}

function sendCommandError(ws: WebSocket, commandId: string, err: SendError): void {
  const frame: CommandErrorFrame = {
    frame_type: "command_error",
    command_id: commandId,
    error: err,
  };
  ws.send(JSON.stringify(frame));
}

function parseEventIdAndChannel(eventJson: string): { channel_id: string; event_id: string } {
  try {
    const parsed = JSON.parse(eventJson) as EventFrame;
    if (
      parsed
      && parsed.frame_type === "event"
      && typeof parsed.channel_id === "string"
      && typeof parsed.event_id === "string"
    ) {
      return {
        channel_id: parsed.channel_id,
        event_id: parsed.event_id,
      };
    }
  } catch {
    // ignore
  }
  return { channel_id: "", event_id: "" };
}

function normalizeEventError(payload: unknown): SendError {
  if (
    payload
    && typeof payload === "object"
    && "error" in payload
    && payload.error !== null
    && typeof payload.error === "object"
  ) {
    const e = payload.error as {
      code?: unknown;
      message?: unknown;
      retryable?: unknown;
      active_session?: SendError["active_session"];
    };
    if (typeof e.code === "string" && typeof e.message === "string") {
      return {
        code: e.code,
        message: e.message,
        retryable: typeof e.retryable === "boolean" ? e.retryable : false,
        ...(e.active_session ? { active_session: e.active_session } : {}),
      };
    }
  }
  return responseError("CHAT_WORKER_UNAVAILABLE", "worker temporarily unavailable", true);
}

export class UserConnection extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateUserConnectionSchema(this.ctx);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const schemaVersion = handleSchemaVersionRequest(this.ctx, "UserConnection", request);
    if (schemaVersion) return schemaVersion;

    const url = new URL(request.url);

    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (url.pathname === "/deliver") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = (await request.json()) as {
        lease_id?: string;
        channel_id?: string;
        session_id?: string;
        event_id?: string;
        event_json?: string;
        membership_version_at_event?: number;
      };
      const result = await this.handleDeliver(body);
      return Response.json(result);
    }

    if (url.pathname === "/internal/live-memberships-changed") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = (await request.json()) as {
        affected_user_id?: string;
        reason?: string;
        changed_channel_id?: string;
        membership_version?: number;
      };
      try {
        const result = await this.handleLiveMembershipsChanged(body);
        return Response.json(result);
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : "live membership resync failed",
        }, { status: 503 });
      }
    }

    if (url.pathname === "/test-last-deliver") {
      const gate = requireTestOnly(request, this.env);
      if (gate) return gate;
      const sockets = this.ctx.getWebSockets();
      const first = sockets[0] as WebSocket | undefined;
      if (!first) return Response.json({ event_json: null });
      const att = first.deserializeAttachment() as ConnectionAttachment | null;
      return Response.json({ event_json: att?.last_deliver ?? null });
    }

    const userId = request.headers.get("X-Verified-User-Id");
    if (!userId) return new Response("missing verified user", { status: 401 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const sessionId = crypto.randomUUID();
    const openedAt = nowIso();
    this.ctx.storage.sql.exec(
      `INSERT INTO live_sessions (session_id, user_id, status, opened_at, last_seen_at)
       VALUES (?, ?, 'open', ?, ?)`,
      sessionId,
      userId,
      openedAt,
      openedAt,
    );

    const attachment: ConnectionAttachment = {
      user_id: userId,
      session_id: sessionId,
    };

    const pair = new WebSocketPair();
    const [client, server] = pair as unknown as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [`user-conn:${userId}`]);
    server.serializeAttachment(attachment);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "lilium.chat.v2" },
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment) return;

    if (typeof message !== "string") {
      sendCommandError(ws, "unknown", responseError("INVALID_MESSAGE", "message payload must be text"));
      return;
    }

    let frame: ReturnType<typeof parseFrame>;
    try {
      frame = parseFrame(message);
    } catch {
      sendCommandError(ws, "unknown", responseError("INVALID_COMMAND", "malformed frame"));
      return;
    }

    if (frame.frame_type !== "command") {
      sendCommandError(ws, "unknown", responseError("INVALID_COMMAND", "unsupported command"));
      return;
    }

    if (frame.command === "session.live_start") {
      await this.handleSessionLiveStart(ws, attachment, frame.command_id);
      return;
    }

    if (frame.command === "session.heartbeat") {
      await this.handleSessionHeartbeat(ws, attachment, frame.command_id);
      return;
    }

    if (frame.command === "channel.mark_read") {
      const channelId = frame.channel_id ?? "";
      if (!channelId) {
        sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "missing channel_id"));
        return;
      }
      const payload = (frame as { payload?: { last_read_event_id?: string } }).payload ?? {};
      const lastReadEventId = typeof payload.last_read_event_id === "string" ? payload.last_read_event_id : "";
      if (!lastReadEventId) {
        sendCommandError(ws, frame.command_id, responseError("INVALID_MESSAGE", "last_read_event_id required"));
        return;
      }
      const dir = this.env.USER_DIRECTORY.getByName(attachment.user_id);
      const rsRes = await dir.fetch(new Request("https://x/internal/read-state", {
        method: "POST", headers: { "X-Verified-User-Id": attachment.user_id, "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: channelId, last_read_event_id: lastReadEventId }),
      }));
      if (rsRes.status === 403) { sendCommandError(ws, frame.command_id, responseError("FORBIDDEN", "not an active member")); return; }
      if (!rsRes.ok) { sendCommandError(ws, frame.command_id, responseError("CHAT_WORKER_UNAVAILABLE", "read-state failed")); return; }
      const floor = (await rsRes.json()) as { last_read_event_id: string; advanced: boolean };
      const chStub = this.env.CHAT_CHANNEL.getByName(channelId);
      const ucRes = await chStub.fetch(new Request(`https://x/internal/unread-count?after=${encodeURIComponent(floor.last_read_event_id)}`, { headers: { "X-Verified-User-Id": attachment.user_id } }));
      const unreadCount = ucRes.ok ? ((await ucRes.json()) as { unread_count: number }).unread_count : 0;
      ws.send(JSON.stringify({ frame_type: "command_ack", command: "channel.mark_read", command_id: frame.command_id, status: "committed", payload: { channel_id: channelId, last_read_event_id: floor.last_read_event_id, unread_count: unreadCount } }));
      if (floor.advanced) {
        for (const other of this.ctx.getWebSockets(`user-conn:${attachment.user_id}`)) {
          if (other === ws) continue;
          try {
            other.send(JSON.stringify({ frame_type: "read_state_updated", channel_id: channelId, last_read_event_id: floor.last_read_event_id, unread_count: unreadCount }));
          } catch { /* session gone */ }
        }
      }
      return;
    }

    if (frame.command === "message.edit" || frame.command === "message.recall" || frame.command === "message.delete") {
      const channelId = frame.channel_id ?? "";
      if (!channelId) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "missing channel_id")); return; }
      let parsed: { ok: true; command: { message_id: string; text?: string; reason?: string | null } } | { ok: false; error: { code: string; message: string; retryable: boolean } };
      if (frame.command === "message.edit") parsed = parseMessageEditCommand(frame);
      else if (frame.command === "message.recall") parsed = parseMessageRecallCommand(frame);
      else parsed = parseMessageDeleteCommand(frame);
      if (!parsed.ok) { sendCommandError(ws, frame.command_id, parsed.error); return; }
      const isMember = await this.ensureActiveMember(attachment.user_id, channelId);
      if (!isMember) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found or not a member")); return; }
      try {
        const stub = this.env.CHAT_CHANNEL.getByName(channelId);
        const endpoint = frame.command === "message.edit" ? "/internal/message-edit" : frame.command === "message.recall" ? "/internal/message-recall" : "/internal/message-delete";
        const body: MessageMutationInternalRequest = {
          operation_id: frame.command_id,
          message_id: parsed.command.message_id,
          channel_id: channelId,
        };
        if (frame.command === "message.edit") body.text = parsed.command.text;
        if (frame.command === "message.delete") body.reason = parsed.command.reason ?? null;
        const res = await stub.fetch(new Request(`https://x${endpoint}`, { method: "POST", headers: { "X-Verified-User-Id": attachment.user_id, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
        if (!res.ok) { const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } }; sendCommandError(ws, frame.command_id, responseError(e.error?.code ?? "CHAT_WORKER_UNAVAILABLE", e.error?.message ?? "mutation failed")); return; }
        const out = await res.json() as MessageMutationAckPayload;
        ws.send(JSON.stringify({ frame_type: "command_ack", command: frame.command, command_id: frame.command_id, status: "committed", payload: { channel_id: out.channel_id, event_id: out.event_id, message: out.message } }));
      } catch (err) {
        sendCommandError(ws, frame.command_id, responseError("CHAT_WORKER_UNAVAILABLE", err instanceof Error ? err.message : "mutation failed"));
      }
      return;
    }

    if (frame.command === "command.invoke") {
      const channelId = frame.channel_id ?? "";
      if (!channelId) {
        sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "missing channel_id"));
        return;
      }
      const chStub = this.env.CHAT_CHANNEL.getByName(channelId);
      const summaryRes = await chStub.fetch(new Request("https://x/internal/summary", {
        headers: { "X-Verified-User-Id": attachment.user_id },
      }));
      if (summaryRes.ok) {
        const summary = await summaryRes.json() as { kind?: string };
        if (summary.kind === "dm") {
          sendCommandError(ws, frame.command_id, responseError("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels", false));
          return;
        }
      }

      const parsed = parseCommandInvokeCommand(frame);
      if (!parsed.ok) {
        sendCommandError(ws, frame.command_id, parsed.error);
        return;
      }

      const isMember = await this.ensureActiveMember(attachment.user_id, parsed.command.channel_id);
      if (!isMember) {
        sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found or not a member"));
        return;
      }
      const invokeRes = await chStub.fetch(new Request("https://x/internal/command-invoke", {
        method: "POST",
        headers: {
          "X-Verified-User-Id": attachment.user_id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operation_id: parsed.command.command_id,
          channel_id: parsed.command.channel_id,
          bot_command_id: parsed.command.bot_command_id,
          invoked_name: parsed.command.invoked_name,
          command_manifest_version: parsed.command.command_manifest_version,
          options: parsed.command.options,
        }),
      }));
      if (!invokeRes.ok) {
        const body = await invokeRes.json().catch(() => null);
        sendCommandError(ws, frame.command_id, normalizeEventError(body));
        return;
      }
      const out = await invokeRes.json() as {
        channel_id: string;
        invocation_id: string;
        event_id: string;
        message_id?: string;
        message?: unknown;
        session_id?: string;
      };
      ws.send(JSON.stringify({
        frame_type: "command_ack",
        command: "command.invoke",
        command_id: frame.command_id,
        status: "committed",
        payload: out,
      }));
      return;
    }

    if (frame.command === "interaction.submit") {
      const channelId = frame.channel_id ?? "";
      if (!channelId) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "missing channel_id")); return; }
      const chStub = this.env.CHAT_CHANNEL.getByName(channelId);
      const summaryRes = await chStub.fetch(new Request("https://x/internal/summary", {
        headers: { "X-Verified-User-Id": attachment.user_id },
      }));
      if (summaryRes.ok) {
        const summary = await summaryRes.json() as { kind?: string };
        if (summary.kind === "dm") {
          sendCommandError(ws, frame.command_id, responseError("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels", false));
          return;
        }
      }
      sendCommandError(ws, frame.command_id, responseError("INVALID_MESSAGE", "unsupported command"));
      return;
    }

    if (frame.command !== "message.send") {
      sendCommandError(ws, frame.command_id, responseError("INVALID_MESSAGE", "unsupported command"));
      return;
    }

    const parsed = parseMessageSendCommand(frame, attachment.user_id);
    if (!parsed.ok) {
      sendCommandError(ws, frame.command_id, parsed.error);
      return;
    }

    if (!frame.channel_id) {
      sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "missing channel_id"));
      return;
    }

    const isMember = await this.ensureActiveMember(attachment.user_id, frame.channel_id);
    if (!isMember) {
      sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found or not a member"));
      return;
    }

    try {
      const channel = this.env.CHAT_CHANNEL.getByName(frame.channel_id);
      const res = await channel.fetch(new Request("https://x/internal/message-send", {
        method: "POST",
        headers: {
          "X-Verified-User-Id": attachment.user_id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          command_id: parsed.command.command_id,
          dedupe_principal_key: dedupePrincipalKeyForUser(attachment.user_id),
          type: parsed.command.type,
          text: parsed.command.text,
          reply_to: parsed.command.reply_to,
          attachment_ids: parsed.command.attachment_ids,
          sticker_id: parsed.command.sticker_id,
          mentions: parsed.command.mentions,
          channel_id: frame.channel_id,
        }),
      }));

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        sendCommandError(ws, frame.command_id, normalizeEventError(body));
        return;
      }

      const body = (await res.json()) as MessageMutationAckPayload;
      const ack = {
        frame_type: "command_ack",
        command_id: frame.command_id,
        status: "committed",
        command: "message.send",
        payload: { channel_id: body.channel_id, event_id: body.event_id, message: body.message },
      };
      ws.send(JSON.stringify(ack));
    } catch (err) {
      sendCommandError(
        ws,
        frame.command_id,
        responseError("CHAT_WORKER_UNAVAILABLE", err instanceof Error ? err.message : "worker temporarily unavailable", true),
      );
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const att = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (!att) return;
    await this.closeSessionCleanup(att.session_id, "ws_close");
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const att = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (!att) return;
    await this.closeSessionCleanup(att.session_id, "ws_error");
  }

  async alarm(): Promise<void> {}

  private findSocketBySession(sessionId: string): WebSocket | null {
    if (!sessionId) return null;
    for (const ws of this.ctx.getWebSockets() as WebSocket[]) {
      const att = ws.deserializeAttachment() as ConnectionAttachment | null;
      if (att?.session_id === sessionId) return ws;
    }
    return null;
  }

  private getSessionRow(sessionId: string): { status: string; user_id: string; last_seen_at: string } | null {
    const row = this.ctx.storage.sql
      .exec("SELECT status, user_id, last_seen_at FROM live_sessions WHERE session_id=?", sessionId)
      .toArray()[0] as { status: string; user_id: string; last_seen_at: string } | undefined;
    return row ?? null;
  }

  private async fetchActiveChannels(userId: string): Promise<MyChannelRow[]> {
    return this.fetchActiveChannelsFromDirectory(userId);
  }

  private async ensureActiveMember(userId: string, channelId: string): Promise<boolean> {
    const membership = await this.confirmActiveMembership(userId, channelId);
    return membership.active;
  }

  private async confirmActiveMembership(
    userId: string,
    channelId: string,
  ): Promise<{ active: boolean; membership_version: number }> {
    const channel = this.env.CHAT_CHANNEL.getByName(channelId);
    const res = await channel.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": userId },
    }));
    if (!res.ok) return { active: false, membership_version: 0 };

    const body = await res.json() as { my_role?: string | null; membership_version?: number };
    if (body.my_role == null) return { active: false, membership_version: 0 };
    return { active: true, membership_version: body.membership_version ?? 0 };
  }

  private async fetchActiveChannelsFromDirectory(userId: string): Promise<MyChannelRow[]> {
    const dir = this.env.USER_DIRECTORY.getByName(userId);
    const dirRes = await dir.fetch(new Request("https://x/my-channels", {
      headers: { "X-Verified-User-Id": userId },
    }));
    if (!dirRes.ok) {
      throw new Error(`user directory my-channels failed: ${dirRes.status}`);
    }
    const channels = (await dirRes.json()) as { items: MyChannelRow[] };
    return channels.items ?? [];
  }

  private getLeaseRow(sessionId: string, channelId: string): LiveChannelLeaseRow | null {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT session_id, channel_id, route_name, lease_id, membership_version, status, expires_at FROM live_channel_leases WHERE session_id=? AND channel_id=?",
        sessionId,
        channelId,
      )
      .toArray()[0] as LiveChannelLeaseRow | undefined;
    return row ?? null;
  }

  private async upsertFanoutLease(
    channelId: string,
    leaseId: string,
    userId: string,
    sessionId: string,
    membershipVersion: number,
    expiresAt: string,
  ): Promise<boolean> {
    const fanout = this.env.CHANNEL_FANOUT.getByName(channelId);
    const res = await fanout.fetch(new Request("https://x/lease-upsert", {
      method: "POST",
      headers: {
        "X-Channel-Id": channelId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        lease_id: leaseId,
        user_id: userId,
        session_id: sessionId,
        membership_version: membershipVersion,
        expires_at: expiresAt,
      }),
    }));
    return res.ok;
  }

  private async revokeFanoutLease(channelId: string, leaseId: string): Promise<void> {
    const fanout = this.env.CHANNEL_FANOUT.getByName(channelId);
    try {
      await fanout.fetch(new Request("https://x/lease-revoke", {
        method: "POST",
        headers: {
          "X-Channel-Id": channelId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ lease_id: leaseId }),
      }));
    } catch {
      // best-effort
    }
  }

  private async upsertLocalLease(
    sessionId: string,
    userId: string,
    channelId: string,
    membershipVersion: number,
    freshLeaseId = false,
  ): Promise<{ lease_id: string; expires_at: string }> {
    const ts = nowIso();
    const expiresAt = leaseExpiresAt();
    const existing = this.getLeaseRow(sessionId, channelId);
    const leaseId = existing && !freshLeaseId ? existing.lease_id : crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO live_channel_leases (
        session_id, channel_id, route_name, lease_id, membership_version,
        status, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(session_id, channel_id) DO UPDATE SET
        route_name=excluded.route_name,
        lease_id=excluded.lease_id,
        membership_version=excluded.membership_version,
        status='active',
        expires_at=excluded.expires_at,
        updated_at=excluded.updated_at`,
      sessionId,
      channelId,
      channelId,
      leaseId,
      membershipVersion,
      expiresAt,
      ts,
      ts,
    );
    return { lease_id: leaseId, expires_at: expiresAt };
  }

  private async closeLocalLease(sessionId: string, channelId: string, leaseId: string): Promise<void> {
    const ts = nowIso();
    this.ctx.storage.sql.exec(
      "UPDATE live_channel_leases SET status='closed', updated_at=? WHERE session_id=? AND channel_id=?",
      ts,
      sessionId,
      channelId,
    );
    await this.revokeFanoutLease(channelId, leaseId);
  }

  private async resyncSessionLeasesWithActiveChannels(input: {
    session_id: string;
    user_id: string;
    active_channels: MyChannelRow[];
    allow_reopen_closed: boolean;
  }): Promise<LeaseSyncResult> {
    const { session_id: sessionId, user_id: userId, active_channels: channels, allow_reopen_closed: allowReopenClosed } = input;
    const activeMap = new Map(channels.map((ch) => [ch.channel_id, ch.membership_version ?? 0]));
    const activeIds = new Set(activeMap.keys());
    let latestExpires = leaseExpiresAt();
    let upsertedCount = 0;
    let closedCount = 0;

    const localLeases = this.ctx.storage.sql
      .exec(
        "SELECT session_id, channel_id, route_name, lease_id, membership_version, status, expires_at FROM live_channel_leases WHERE session_id=?",
        sessionId,
      )
      .toArray() as unknown as LiveChannelLeaseRow[];

    for (const lease of localLeases) {
      if (lease.status === "closed") continue;
      if (!activeIds.has(lease.channel_id)) {
        await this.closeLocalLease(sessionId, lease.channel_id, lease.lease_id);
        closedCount += 1;
      }
    }

    for (const ch of channels) {
      const existing = this.getLeaseRow(sessionId, ch.channel_id);
      if (existing?.status === "closed" && !allowReopenClosed) continue;

      const targetMembershipVersion = ch.membership_version ?? 0;
      if (!leaseNeedsRefresh(existing, targetMembershipVersion, allowReopenClosed)) {
        if (existing && existing.expires_at > latestExpires) latestExpires = existing.expires_at;
        continue;
      }

      const { lease_id: leaseId, expires_at: expiresAt } = await this.upsertLocalLease(
        sessionId,
        userId,
        ch.channel_id,
        targetMembershipVersion,
        existing?.status === "closed",
      );
      if (expiresAt > latestExpires) latestExpires = expiresAt;

      const ok = await this.upsertFanoutLease(
        ch.channel_id,
        leaseId,
        userId,
        sessionId,
        targetMembershipVersion,
        expiresAt,
      );
      if (!ok) {
        throw new Error("fanout lease upsert failed");
      }
      upsertedCount += 1;
    }

    return { active_count: channels.length, upserted_count: upsertedCount, closed_count: closedCount, lease_expires_at: latestExpires };
  }

  private async handleSessionLiveStart(ws: WebSocket, attachment: ConnectionAttachment, commandId: string): Promise<void> {
    const session = this.getSessionRow(attachment.session_id);
    if (!session || (session.status !== "open" && session.status !== "live")) {
      sendCommandError(ws, commandId, responseError("SESSION_NOT_LIVE", "session is not open"));
      return;
    }

    try {
      const channels = await this.fetchActiveChannels(attachment.user_id);
      const sync = await this.resyncSessionLeasesWithActiveChannels({
        session_id: attachment.session_id,
        user_id: attachment.user_id,
        active_channels: channels,
        allow_reopen_closed: true,
      });
      const ts = nowIso();
      this.ctx.storage.sql.exec(
        `UPDATE live_sessions SET status='live', live_started_at=COALESCE(live_started_at, ?), last_seen_at=? WHERE session_id=?`,
        ts,
        ts,
        attachment.session_id,
      );
      console.log("live_start_committed", {
        session_id: attachment.session_id,
        user_id: attachment.user_id,
        subscribed_channel_count: sync.active_count,
      });
      const ack: CommandAckFrame = {
        frame_type: "command_ack",
        command: "session.live_start",
        command_id: commandId,
        status: "committed",
        payload: {
          session_id: attachment.session_id,
          subscribed_channel_count: sync.active_count,
          lease_expires_at: sync.lease_expires_at,
        },
      };
      ws.send(JSON.stringify(ack));
    } catch (err) {
      sendCommandError(
        ws,
        commandId,
        responseError("CHAT_WORKER_UNAVAILABLE", err instanceof Error ? err.message : "live start failed", true),
      );
    }
  }

  private async handleSessionHeartbeat(ws: WebSocket, attachment: ConnectionAttachment, commandId: string): Promise<void> {
    const session = this.getSessionRow(attachment.session_id);
    if (!session || session.status !== "live") {
      sendCommandError(ws, commandId, responseError("SESSION_NOT_LIVE", "session live not started"));
      return;
    }

    if (sessionSeenNeedsRefresh(session.last_seen_at, Date.now())) {
      this.ctx.storage.sql.exec(
        "UPDATE live_sessions SET last_seen_at=? WHERE session_id=?",
        nowIso(),
        attachment.session_id,
      );
    }

    let sync: LeaseSyncResult;
    try {
      sync = await this.resyncSessionLeasesWithActiveChannels({
        session_id: attachment.session_id,
        user_id: attachment.user_id,
        active_channels: await this.fetchActiveChannels(attachment.user_id),
        allow_reopen_closed: true,
      });
    } catch (err) {
      sendCommandError(
        ws,
        commandId,
        responseError("CHAT_WORKER_UNAVAILABLE", err instanceof Error ? err.message : "heartbeat failed", true),
      );
      return;
    }

    const ack: CommandAckFrame = {
      frame_type: "command_ack",
      command: "session.heartbeat",
      command_id: commandId,
      status: "committed",
      payload: {
        session_id: attachment.session_id,
        lease_expires_at: sync.lease_expires_at,
      },
    };
    ws.send(JSON.stringify(ack));
  }

  private durableObjectName(): string | null {
    const id = this.ctx.id as unknown as { name?: string };
    return typeof id.name === "string" ? id.name : null;
  }

  private async handleLiveMembershipsChanged(body: {
    affected_user_id?: string;
    reason?: string;
    changed_channel_id?: string;
    membership_version?: number;
  }): Promise<LeaseSyncResult & { ok: true; live_session_count: number }> {
    const affectedUserId = body.affected_user_id ?? "";
    if (!affectedUserId) throw new Error("affected_user_id required");
    const name = this.durableObjectName();
    if (name !== null && name !== affectedUserId) throw new Error("affected_user_id does not match UserConnection");

    const activeChannels = await this.fetchActiveChannelsFromDirectory(affectedUserId);
    const sessions = this.ctx.storage.sql
      .exec("SELECT session_id FROM live_sessions WHERE user_id=? AND status='live'", affectedUserId)
      .toArray() as Array<{ session_id: string }>;

    let upserted = 0;
    let closed = 0;
    let leaseExpires = leaseExpiresAt();
    for (const session of sessions) {
      const result = await this.resyncSessionLeasesWithActiveChannels({
        session_id: session.session_id,
        user_id: affectedUserId,
        active_channels: activeChannels,
        allow_reopen_closed: true,
      });
      upserted += result.upserted_count;
      closed += result.closed_count;
      if (result.lease_expires_at > leaseExpires) leaseExpires = result.lease_expires_at;
    }

    const event: UserEventFrame = {
      frame_type: "user_event",
      event: "my_channels_changed",
      reason: body.reason ?? "system_resync",
      changed_channel_id: body.changed_channel_id,
    };
    for (const ws of this.ctx.getWebSockets(`user-conn:${affectedUserId}`)) {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // best-effort hint only
      }
    }

    return {
      ok: true,
      live_session_count: sessions.length,
      active_count: activeChannels.length,
      upserted_count: upserted,
      closed_count: closed,
      lease_expires_at: leaseExpires,
    };
  }

  private async handleDeliver(body: {
    lease_id?: string;
    channel_id?: string;
    session_id?: string;
    event_id?: string;
    event_json?: string;
    membership_version_at_event?: number;
  }): Promise<DeliverResult> {
    const sessionId = body.session_id ?? "";
    const channelId = body.channel_id ?? "";
    const leaseId = body.lease_id ?? "";
    const eventJson = body.event_json ?? "";
    const membershipVersionAtEvent = body.membership_version_at_event ?? 0;

    if (!sessionId) return { delivered: false, reason: "session_not_found" };

    const session = this.getSessionRow(sessionId);
    if (!session) return { delivered: false, reason: "session_not_found" };
    if (session.status === "closed") return { delivered: false, reason: "session_closed" };

    const parsed = parseEventIdAndChannel(eventJson);
    const resolvedChannelId = channelId || parsed.channel_id;
    if (!resolvedChannelId || !parsed.event_id) {
      return { delivered: false, reason: "invalid_event" };
    }

    const lease = this.getLeaseRow(sessionId, resolvedChannelId);
    if (!lease) return { delivered: false, reason: "lease_not_found" };
    if (lease.status !== "active") return { delivered: false, reason: "lease_closed" };
    if (leaseId && lease.lease_id !== leaseId) return { delivered: false, reason: "lease_not_found" };
    if (lease.expires_at <= nowIso()) return { delivered: false, reason: "lease_closed" };

    const ws = this.findSocketBySession(sessionId);
    if (!ws) return { delivered: false, reason: "socket_not_found" };

    if (membershipVersionAtEvent > lease.membership_version) {
      const membership = await this.confirmActiveMembership(session.user_id, resolvedChannelId);
      if (!membership.active) {
        await this.closeLocalLease(sessionId, resolvedChannelId, lease.lease_id);
        return { delivered: false, reason: "membership_not_active" };
      }
      const ts = nowIso();
      const expiresAt = leaseExpiresAt();
      this.ctx.storage.sql.exec(
        "UPDATE live_channel_leases SET membership_version=?, expires_at=?, updated_at=? WHERE session_id=? AND channel_id=?",
        membership.membership_version,
        expiresAt,
        ts,
        sessionId,
        resolvedChannelId,
      );
      await this.upsertFanoutLease(
        resolvedChannelId,
        lease.lease_id,
        session.user_id,
        sessionId,
        membership.membership_version,
        expiresAt,
      );
    }

    try {
      ws.send(eventJson);
      if (this.env.ALLOW_INTERNAL_TEST_ROUTES === "1") {
        const att = ws.deserializeAttachment() as ConnectionAttachment | null;
        if (att) {
          ws.serializeAttachment({ ...att, last_deliver: eventJson });
        }
      }
      return { delivered: true };
    } catch {
      return { delivered: false, reason: "socket_send_failed" };
    }
  }

  private async closeSessionCleanup(sessionId: string, reason: string): Promise<void> {
    const leases = this.ctx.storage.sql
      .exec(
        "SELECT channel_id, lease_id FROM live_channel_leases WHERE session_id=? AND status='active'",
        sessionId,
      )
      .toArray() as Array<{ channel_id: string; lease_id: string }>;

    const ts = nowIso();
    this.ctx.storage.sql.exec(
      "UPDATE live_sessions SET status='closed', closed_at=?, close_reason=? WHERE session_id=?",
      ts,
      reason,
      sessionId,
    );
    this.ctx.storage.sql.exec(
      "UPDATE live_channel_leases SET status='closed', updated_at=? WHERE session_id=? AND status='active'",
      ts,
      sessionId,
    );

    await Promise.all(
      leases.map(async (lease) => this.revokeFanoutLease(lease.channel_id, lease.lease_id)),
    );

    console.log("session_closed_cleanup", { session_id: sessionId, reason, lease_count: leases.length });
  }
}
