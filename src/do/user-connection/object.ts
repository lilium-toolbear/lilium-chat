import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { migrateUserConnectionSchema } from "./migrations";
import { parseFrame, type CommandAckFrame, type CommandErrorFrame, type EventFrame, type UserEventFrame } from "../../ws/frames";
import { dedupePrincipalKeyForUser, parseMessageDeleteCommand, parseMessageEditCommand, parseMessageRecallCommand, parseMessageSendCommand } from "../../chat/command";
import { parseCommandInvokePayload } from "../../chat/command-invoke";
import { parseChannelCommandFrame } from "../../chat/ws-command-frame";
import { parseInteractionSubmitCommand } from "../../chat/interaction-submit";
import type { MessageMutationAckPayload, MessageMutationInternalRequest } from "../../contract/idempotency";
import { apiErrorFromRemote, logSwallowedError } from "../../errors";
import { assertTestRoutesEnabled } from "../shared/test-gates";
import type { ChatChannel } from "../chat-channel";
import { rpcErrorMessage, shouldRetryRpcError } from "../shared/rpc-errors";

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

const LIVE_MEMBERSHIP_JOIN_REASONS = new Set(["channel_joined", "member_added"]);

function activeChannelsWithMembershipHint(
  channels: MyChannelRow[],
  hint: { reason?: string; changed_channel_id?: string; membership_version?: number },
): MyChannelRow[] {
  const changedChannelId = hint.changed_channel_id;
  if (!changedChannelId || !LIVE_MEMBERSHIP_JOIN_REASONS.has(hint.reason ?? "")) {
    return channels;
  }
  if (channels.some((ch) => ch.channel_id === changedChannelId)) {
    return channels;
  }
  return [
    ...channels,
    {
      channel_id: changedChannelId,
      membership_version: hint.membership_version ?? 0,
    },
  ];
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
  } catch (err) {
    logSwallowedError("user_connection_event_frame_parse_failed", err);
  }
  return { channel_id: "", event_id: "" };
}

function normalizeEventError(payload: unknown): SendError {
  if (payload && typeof payload === "object") {
    const e = payload as {
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
    this.ctx.blockConcurrencyWhile(async () => {
      migrateUserConnectionSchema(this.ctx);
    });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async deliver(input: {
    lease_id?: string;
    channel_id?: string;
    session_id?: string;
    event_id?: string;
    event_json?: string;
    membership_version_at_event?: number;
  }): Promise<DeliverResult> {
    return this.handleDeliver(input);
  }

  async deliverStreamFrame(input: {
    lease_id?: string;
    channel_id?: string;
    session_id?: string;
    frame_json?: string;
  }): Promise<DeliverResult> {
    return this.handleDeliverStreamFrame(input);
  }

  debugLastDeliver(): { event_json: string | null } {
    assertTestRoutesEnabled(this.env);
    const first = this.ctx.getWebSockets()[0] as WebSocket | undefined;
    if (!first) return { event_json: null };
    const att = first.deserializeAttachment() as ConnectionAttachment | null;
    return { event_json: att?.last_deliver ?? null };
  }

  async fetch(request: Request): Promise<Response> {
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
    } catch (err) {
      logSwallowedError("user_connection_malformed_frame", err);
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
      let floor: { last_read_event_id: string; advanced: boolean };
      try {
        floor = await dir.updateReadState(attachment.user_id, { channel_id: channelId, last_read_event_id: lastReadEventId });
      } catch (err) {
        sendCommandError(ws, frame.command_id, normalizeEventError(err));
        return;
      }
      const chStub = this.env.CHAT_CHANNEL.getByName(channelId);
      let unreadCount: number;
      try {
        const uc = await chStub.getUnreadCount(attachment.user_id, floor.last_read_event_id);
        unreadCount = uc.unread_count;
      } catch (err) {
        sendCommandError(ws, frame.command_id, normalizeEventError(apiErrorFromRemote(err) ?? err));
        return;
      }
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
      let parsed: { ok: true; command: { channel_id: string; message_id: string; text?: string; reason?: string | null } } | { ok: false; error: { code: string; message: string; retryable: boolean } };
      if (frame.command === "message.edit") parsed = parseMessageEditCommand(frame);
      else if (frame.command === "message.recall") parsed = parseMessageRecallCommand(frame);
      else parsed = parseMessageDeleteCommand(frame);
      if (!parsed.ok) { sendCommandError(ws, frame.command_id, parsed.error); return; }
      const channelId = parsed.command.channel_id;

      const isMember = await this.ensureActiveMember(attachment.user_id, channelId);
      if (!isMember) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found or not a member")); return; }
      try {
        const stub = this.env.CHAT_CHANNEL.getByName(channelId) as DurableObjectStub<ChatChannel>;
        const out = await stub.mutateMessage({
          user_id: attachment.user_id,
          operation: frame.command as "message.edit" | "message.recall" | "message.delete",
          operation_id: frame.command_id,
          message_id: parsed.command.message_id,
          channel_id: channelId,
          ...(frame.command === "message.edit" ? { text: parsed.command.text } : {}),
          ...(frame.command === "message.delete" ? { reason: parsed.command.reason ?? null } : {}),
        }) as MessageMutationAckPayload;
        ws.send(JSON.stringify({ frame_type: "command_ack", command: frame.command, command_id: frame.command_id, status: "committed", payload: { channel_id: out.channel_id, event_id: out.event_id, message: out.message } }));
      } catch (err) {
        const apiErr = apiErrorFromRemote(err);
        sendCommandError(ws, frame.command_id, apiErr ? normalizeEventError(apiErr) : responseError("CHAT_WORKER_UNAVAILABLE", err instanceof Error ? err.message : "mutation failed"));
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
      try {
        const summary = await chStub.getSummary(attachment.user_id);
        if (summary.kind === "dm") {
          sendCommandError(ws, frame.command_id, responseError("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels", false));
          return;
        }
      } catch (err) {
        const apiErr = apiErrorFromRemote(err);
        if (!apiErr || (apiErr.code !== "FORBIDDEN" && apiErr.code !== "CHANNEL_NOT_FOUND")) {
          sendCommandError(ws, frame.command_id, normalizeEventError(apiErr ?? err));
          return;
        }
      }

      const scoped = parseChannelCommandFrame(frame, "command.invoke");
      if (!scoped.ok) {
        sendCommandError(ws, frame.command_id, scoped.error);
        return;
      }
      const parsed = parseCommandInvokePayload(frame, scoped.frame);
      if (!parsed.ok) {
        sendCommandError(ws, frame.command_id, parsed.error);
        return;
      }

      const isMember = await this.ensureActiveMember(attachment.user_id, parsed.command.channel_id);
      if (!isMember) {
        sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found or not a member"));
        return;
      }
      try {
        const out = await chStub.invokeCommand({
          user_id: attachment.user_id,
          operation_id: parsed.command.command_id,
          channel_id: parsed.command.channel_id,
          bot_command_id: parsed.command.bot_command_id,
          invoked_name: parsed.command.invoked_name,
          command_manifest_version: parsed.command.command_manifest_version,
          options: parsed.command.options,
          reply_to_message_id: parsed.command.reply_to_message_id,
        });
        ws.send(JSON.stringify({
          frame_type: "command_ack",
          command: "command.invoke",
          command_id: frame.command_id,
          status: "committed",
          payload: out,
        }));
      } catch (err) {
        const apiErr = apiErrorFromRemote(err);
        sendCommandError(ws, frame.command_id, normalizeEventError(apiErr ?? err));
      }
      return;
    }

    if (frame.command === "interaction.submit") {
      const channelId = frame.channel_id ?? "";
      if (!channelId) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "missing channel_id")); return; }
      const chStub = this.env.CHAT_CHANNEL.getByName(channelId);
      try {
        const summary = await chStub.getSummary(attachment.user_id);
        if (summary.kind === "dm") {
          sendCommandError(ws, frame.command_id, responseError("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels", false));
          return;
        }
      } catch (err) {
        const apiErr = apiErrorFromRemote(err);
        if (!apiErr || (apiErr.code !== "FORBIDDEN" && apiErr.code !== "CHANNEL_NOT_FOUND")) {
          sendCommandError(ws, frame.command_id, normalizeEventError(apiErr ?? err));
          return;
        }
      }

      const parsed = parseInteractionSubmitCommand(frame);
      if (!parsed.ok) {
        sendCommandError(ws, frame.command_id, parsed.error);
        return;
      }

      const isMember = await this.ensureActiveMember(attachment.user_id, parsed.command.channel_id);
      if (!isMember) {
        sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found or not a member"));
        return;
      }

      try {
        const out = await chStub.submitInteraction({
          user_id: attachment.user_id,
          operation_id: parsed.command.command_id,
          channel_id: parsed.command.channel_id,
          message_id: parsed.command.message_id,
          component_id: parsed.command.component_id,
          custom_id: parsed.command.custom_id,
          value: parsed.command.value,
        });
        ws.send(JSON.stringify({
          frame_type: "command_ack",
          command: "interaction.submit",
          command_id: frame.command_id,
          status: "committed",
          payload: out,
        }));
      } catch (err) {
        const apiErr = apiErrorFromRemote(err);
        sendCommandError(ws, frame.command_id, normalizeEventError(apiErr ?? err));
      }
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
      const channel = this.env.CHAT_CHANNEL.getByName(frame.channel_id) as DurableObjectStub<ChatChannel>;
      const body = await channel.sendMessage({
        user_id: attachment.user_id,
        command_id: parsed.command.command_id,
        dedupe_principal_key: dedupePrincipalKeyForUser(attachment.user_id),
        type: parsed.command.type,
        text: parsed.command.text,
        reply_to: parsed.command.reply_to,
        attachment_ids: parsed.command.attachment_ids,
        ...(parsed.command.sticker_id !== null ? { sticker_id: parsed.command.sticker_id } : {}),
        mentions: parsed.command.mentions,
        channel_id: frame.channel_id,
      }) as MessageMutationAckPayload;

      const ack = {
        frame_type: "command_ack",
        command_id: frame.command_id,
        status: "committed",
        command: "message.send",
        payload: { channel_id: body.channel_id, event_id: body.event_id, message: body.message },
      };
      ws.send(JSON.stringify(ack));
    } catch (err) {
      const apiErr = apiErrorFromRemote(err);
      sendCommandError(
        ws,
        frame.command_id,
        apiErr ? normalizeEventError(apiErr) : responseError("CHAT_WORKER_UNAVAILABLE", err instanceof Error ? err.message : "worker temporarily unavailable", true),
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
    try {
      const body = await channel.getSummary(userId);
      if (body.my_role == null) return { active: false, membership_version: 0 };
      return { active: true, membership_version: 0 };
    } catch (err) {
      const apiErr = apiErrorFromRemote(err);
      if (apiErr?.code === "FORBIDDEN" || apiErr?.code === "CHANNEL_NOT_FOUND") {
        return { active: false, membership_version: 0 };
      }
      throw apiErr ?? err;
    }
  }

  private async fetchActiveChannelsFromDirectory(userId: string): Promise<MyChannelRow[]> {
    const dir = this.env.USER_DIRECTORY.getByName(userId);
    const channels = await dir.listMyChannels(userId) as { items: MyChannelRow[] };
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
    try {
      await fanout.leaseUpsert({
        channel_id: channelId,
        lease_id: leaseId,
        user_id: userId,
        session_id: sessionId,
        membership_version: membershipVersion,
        expires_at: expiresAt,
      });
      return true;
    } catch (err) {
      if (shouldRetryRpcError(err)) throw err;
      console.warn("fanout_lease_upsert_failed", { channel_id: channelId, lease_id: leaseId, error: rpcErrorMessage(err) });
      return false;
    }
  }

  private async revokeFanoutLease(channelId: string, leaseId: string): Promise<void> {
    const fanout = this.env.CHANNEL_FANOUT.getByName(channelId);
    try {
      await fanout.leaseRevoke({ channel_id: channelId, lease_id: leaseId });
    } catch (err) {
      if (shouldRetryRpcError(err)) {
        console.warn("fanout_lease_revoke_retryable_failed", { channel_id: channelId, lease_id: leaseId, error: rpcErrorMessage(err) });
      }
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

      try {
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
      } catch (err) {
        if (!shouldRetryRpcError(err)) throw err;
        console.warn("fanout_lease_upsert_retryable_failed", {
          channel_id: ch.channel_id,
          lease_id: leaseId,
          error: rpcErrorMessage(err),
        });
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

  async liveMembershipsChanged(body: {
    affected_user_id?: string;
    reason?: string;
    changed_channel_id?: string;
    membership_version?: number;
  }): Promise<LeaseSyncResult & { live_session_count: number }> {
    const affectedUserId = body.affected_user_id ?? "";
    if (!affectedUserId) throw new Error("affected_user_id required");
    const name = this.durableObjectName();
    if (name !== null && name !== affectedUserId) throw new Error("affected_user_id does not match UserConnection");

    const activeChannels = activeChannelsWithMembershipHint(
      await this.fetchActiveChannelsFromDirectory(affectedUserId),
      body,
    );
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
    } catch (err) {
      logSwallowedError("user_connection_live_hint_failed", err);
    }
    }

    return {
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
    } catch (err) {
      logSwallowedError("user_connection_event_delivery_failed", err);
      return { delivered: false, reason: "socket_send_failed" };
    }
  }

  private async handleDeliverStreamFrame(body: {
    lease_id?: string;
    channel_id?: string;
    session_id?: string;
    frame_json?: string;
  }): Promise<DeliverResult> {
    const sessionId = body.session_id ?? "";
    const channelId = body.channel_id ?? "";
    const leaseId = body.lease_id ?? "";
    const frameJson = body.frame_json ?? "";

    if (!sessionId || !channelId || !frameJson) {
      return { delivered: false, reason: "invalid_frame" };
    }

    const session = this.getSessionRow(sessionId);
    if (!session) return { delivered: false, reason: "session_not_found" };
    if (session.status === "closed") return { delivered: false, reason: "session_closed" };

    const lease = this.getLeaseRow(sessionId, channelId);
    if (!lease) return { delivered: false, reason: "lease_not_found" };
    if (lease.status !== "active") return { delivered: false, reason: "lease_closed" };
    if (leaseId && lease.lease_id !== leaseId) return { delivered: false, reason: "lease_not_found" };
    if (lease.expires_at <= nowIso()) return { delivered: false, reason: "lease_closed" };

    const ws = this.findSocketBySession(sessionId);
    if (!ws) return { delivered: false, reason: "socket_not_found" };

    const membership = await this.confirmActiveMembership(session.user_id, channelId);
    if (!membership.active) {
      await this.closeLocalLease(sessionId, channelId, lease.lease_id);
      return { delivered: false, reason: "membership_not_active" };
    }

    try {
      ws.send(frameJson);
      if (this.env.ALLOW_INTERNAL_TEST_ROUTES === "1") {
        const att = ws.deserializeAttachment() as ConnectionAttachment | null;
        if (att) {
          ws.serializeAttachment({ ...att, last_deliver: frameJson });
        }
      }
      return { delivered: true };
    } catch (err) {
      logSwallowedError("user_connection_event_delivery_failed", err);
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
