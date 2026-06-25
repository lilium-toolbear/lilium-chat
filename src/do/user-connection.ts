import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { parseFrame, type CommandAckFrame, type CommandErrorFrame, type EventFrame } from "../ws/frames";
import { channelRouteNameFor } from "../chat/system-channel";
import { dedupePrincipalKeyForUser, parseMessageDeleteCommand, parseMessageEditCommand, parseMessageRecallCommand, parseMessageSendCommand } from "../chat/command";

export interface ConnectionAttachment {
  user_id: string;
  session_id: string;
  per_channel_cursors: Record<string, string>;
  subscribed_channels: Record<string, number>;
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
}

interface DeliverResult {
  delivered: boolean;
  dropped?: string;
}

function parsePerChannelCursors(searchParams: string): Record<string, string> {
  if (!searchParams) {
    return {};
  }
  try {
    const normalized = `${searchParams.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (searchParams.length % 4)) % 4)}`;
    return JSON.parse(atob(normalized)) as Record<string, string>;
  } catch {
    return {};
  }
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
    const e = payload.error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof e.code === "string" && typeof e.message === "string") {
      return {
        code: e.code,
        message: e.message,
        retryable: typeof e.retryable === "boolean" ? e.retryable : false,
      };
    }
  }
  return responseError("CHAT_WORKER_UNAVAILABLE", "worker temporarily unavailable", true);
}

export class UserConnection extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (url.pathname === "/deliver") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = (await request.json()) as {
        session_id?: string;
        event_json?: string;
        membership_version_at_event?: number;
      };
      const result = await this.handleDeliver(
        body.session_id ?? "",
        body.event_json ?? "",
        body.membership_version_at_event ?? 0,
      );
      return Response.json(result);
    }

    if (url.pathname === "/test-last-deliver") {
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

    const perChannelCursors = parsePerChannelCursors(url.searchParams.get("cursors") ?? "");
    const sessionId = crypto.randomUUID();
    const attachment: ConnectionAttachment = {
      user_id: userId,
      session_id: sessionId,
      per_channel_cursors: perChannelCursors,
      subscribed_channels: {},
    };

    const pair = new WebSocketPair();
    const [client, server] = pair as unknown as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [`user-conn:${userId}`]);
    server.serializeAttachment(attachment);

    this.ctx.waitUntil(
      (async () => {
        const subscribed = await this.registerOnlineOnConnect(userId, sessionId, perChannelCursors);
        const ws = this.findSocketBySession(sessionId);
        if (ws) {
          const current = ws.deserializeAttachment() as ConnectionAttachment | null;
          if (current) {
            ws.serializeAttachment({
              ...current,
              subscribed_channels: { ...current.subscribed_channels, ...subscribed },
            });
          }
        }
      })(),
    );

    return new Response(null, { status: 101, webSocket: client });
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
      // floor in UserDirectory
      const dir = this.env.USER_DIRECTORY.getByName(attachment.user_id);
      const rsRes = await dir.fetch(new Request("https://x/internal/read-state", {
        method: "POST", headers: { "X-Verified-User-Id": attachment.user_id, "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: channelId, last_read_event_id: lastReadEventId }),
      }));
      if (rsRes.status === 403) { sendCommandError(ws, frame.command_id, responseError("FORBIDDEN", "not an active member")); return; }
      if (!rsRes.ok) { sendCommandError(ws, frame.command_id, responseError("CHAT_WORKER_UNAVAILABLE", "read-state failed")); return; }
      const floor = (await rsRes.json()) as { last_read_event_id: string; advanced: boolean };
      // unread count from ChatChannel (best-effort)
      const routeName = await channelRouteNameFor(this.env, attachment.user_id, channelId);
      if (routeName === null) {
        sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found"));
        return;
      }
      const chStub = this.env.CHAT_CHANNEL.getByName(routeName);
      const ucRes = await chStub.fetch(new Request(`https://x/internal/unread-count?after=${encodeURIComponent(floor.last_read_event_id)}`, { headers: { "X-Verified-User-Id": attachment.user_id } }));
      const unreadCount = ucRes.ok ? ((await ucRes.json()) as { unread_count: number }).unread_count : 0;
      // ack (NO event_id)
      ws.send(JSON.stringify({ frame_type: "command_ack", command: "channel.mark_read", command_id: frame.command_id, status: "committed", payload: { channel_id: channelId, last_read_event_id: floor.last_read_event_id, unread_count: unreadCount } }));
      // best-effort broadcast a user-local read_state_updated frame to the user's OTHER sessions
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
      const routeName = await channelRouteNameFor(this.env, attachment.user_id, channelId);
      if (routeName === null) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found")); return; }
      const subscribed = await this.ensureSubscribed(attachment, ws, channelId);
      if (!subscribed) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found or not a member")); return; }
      try {
        const stub = this.env.CHAT_CHANNEL.getByName(routeName);
        const endpoint = frame.command === "message.edit" ? "/internal/message-edit" : frame.command === "message.recall" ? "/internal/message-recall" : "/internal/message-delete";
        const body: Record<string, unknown> = { operation_id: frame.command_id, message_id: parsed.command.message_id, channel_id: channelId };
        if (frame.command === "message.edit") body.text = parsed.command.text;
        if (frame.command === "message.delete") body.reason = parsed.command.reason ?? null;
        const res = await stub.fetch(new Request(`https://x${endpoint}`, { method: "POST", headers: { "X-Verified-User-Id": attachment.user_id, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
        if (!res.ok) { const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } }; sendCommandError(ws, frame.command_id, responseError(e.error?.code ?? "CHAT_WORKER_UNAVAILABLE", e.error?.message ?? "mutation failed")); return; }
        const out = await res.json() as { channel_id: string; event_id: string; message: Record<string, unknown> };
        ws.send(JSON.stringify({ frame_type: "command_ack", command: frame.command, command_id: frame.command_id, status: "committed", payload: { channel_id: out.channel_id, event_id: out.event_id, message: out.message } }));
      } catch (err) {
        sendCommandError(ws, frame.command_id, responseError("CHAT_WORKER_UNAVAILABLE", err instanceof Error ? err.message : "mutation failed"));
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

    const routeName = await channelRouteNameFor(this.env, attachment.user_id, frame.channel_id);
    if (routeName === null) {
      sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found"));
      return;
    }

    const subscribed = await this.ensureSubscribed(attachment, ws, frame.channel_id);
    if (!subscribed) {
      sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found or not a member"));
      return;
    }

    try {
      const channel = this.env.CHAT_CHANNEL.getByName(routeName);
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

      const body = (await res.json()) as { channel_id: string; event_id: string; message: Record<string, unknown> };
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
    await this.unregisterAll(att);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const att = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (!att) return;
    await this.unregisterAll(att);
  }

  async alarm(): Promise<void> {}

  private findSocketBySession(sessionId: string): WebSocket | null {
    if (!sessionId) return null;
    const sockets = this.ctx.getWebSockets() as WebSocket[];

    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as ConnectionAttachment | null;
      if (att?.session_id === sessionId) return ws;
    }

    // Fail closed: no exact session_id match. ChannelFanout always passes a real
    // target_session_id; a miss means the session is gone (closed/hibernated away). Returning
    // null → /deliver reports not_connected → ChannelFanout marks the queue row delivered and
    // stops retrying; the repair path for a rejoined session is cursor-based replay on reconnect.
    // DO NOT fall back to an arbitrary socket — that could deliver a stale-session's event to a
    // different live socket of the same user (access-control fail-open).
    return null;
  }

  private async getChannelReplayAfterCursor(userId: string, routeName: string, fallbackCursor: string): Promise<string> {
    if (fallbackCursor) return fallbackCursor;
    const channel = this.env.CHAT_CHANNEL.getByName(routeName);
    const summaryRes = await channel.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": userId },
    }));
    if (!summaryRes.ok) return "";
    const summary = (await summaryRes.json()) as { last_event_id?: string | null };
    return summary.last_event_id ?? "";
  }

  private async registerChannelOnline(att: ConnectionAttachment, channelId: string, membershipVersion: number): Promise<void> {
    const fanout = this.env.CHANNEL_FANOUT.getByName(channelId);
    const res = await fanout.fetch(new Request("https://x/register-online", {
      method: "POST",
      headers: {
        "X-Channel-Id": channelId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: att.user_id,
        session_id: att.session_id,
        membership_version: membershipVersion,
      }),
    }));

    if (!res.ok) return;

    const ws = this.findSocketBySession(att.session_id);
    if (!ws) return;
    const current = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (!current) return;
    ws.serializeAttachment({
      ...current,
      subscribed_channels: { ...current.subscribed_channels, [channelId]: membershipVersion },
    });
  }

  private async registerOnlineOnConnect(
    userId: string,
    sessionId: string,
    perChannelCursors: Record<string, string>,
  ): Promise<Record<string, number>> {
    const dir = this.env.USER_DIRECTORY.getByName(userId);
    const dirRes = await dir.fetch(new Request("https://x/my-channels", {
      headers: { "X-Verified-User-Id": userId },
    }));
    if (!dirRes.ok) return {};

    const channels = (await dirRes.json()) as { items: MyChannelRow[] };
    const subscribed: Record<string, number> = {};

    for (const ch of channels.items ?? []) {
      const routeName = await channelRouteNameFor(this.env, userId, ch.channel_id);
      if (routeName === null) continue;

      await this.registerChannelOnline(
        {
          user_id: userId,
          session_id: sessionId,
          per_channel_cursors: perChannelCursors,
          subscribed_channels: {},
        },
        ch.channel_id,
        ch.membership_version ?? 0,
      );
      subscribed[ch.channel_id] = ch.membership_version ?? 0;

      const after = await this.getChannelReplayAfterCursor(
        userId,
        routeName,
        perChannelCursors[ch.channel_id] ?? "",
      );
      const channel = this.env.CHAT_CHANNEL.getByName(routeName);
      const replayRes = await channel.fetch(new Request(`https://x/internal/replay?after=${encodeURIComponent(after)}`, {
        headers: { "X-Verified-User-Id": userId },
      }));
      if (!replayRes.ok) continue;

      const replay = (await replayRes.json()) as { events: Array<{ event_json: string }> };
      const ws = this.findSocketBySession(sessionId);
      if (!ws) continue;
      const current = ws.deserializeAttachment() as ConnectionAttachment | null;
      if (!current) continue;

      for (const ev of replay.events ?? []) {
        ws.send(ev.event_json);
        const parsed = parseEventIdAndChannel(ev.event_json);
        const nextAtt: ConnectionAttachment = {
          ...current,
          last_deliver: ev.event_json,
          per_channel_cursors: {
            ...current.per_channel_cursors,
            [ch.channel_id]: parsed.event_id || current.per_channel_cursors[ch.channel_id] || "",
          },
        };
        ws.serializeAttachment(nextAtt);
      }
    }

    return subscribed;
  }

  private async ensureSubscribed(att: ConnectionAttachment, ws: WebSocket, channelId: string): Promise<boolean> {
    const existing = att.subscribed_channels[channelId];
    if (existing !== undefined) return true;

    const routeName = await channelRouteNameFor(this.env, att.user_id, channelId);
    if (routeName === null) return false;

    const dir = this.env.USER_DIRECTORY.getByName(att.user_id);
    const dirRes = await dir.fetch(new Request("https://x/my-channels", {
      headers: { "X-Verified-User-Id": att.user_id },
    }));
    if (!dirRes.ok) return false;
    const channels = (await dirRes.json()) as { items: MyChannelRow[] };
    const row = channels.items?.find((it) => it.channel_id === channelId);
    if (!row) return false;

    await this.registerChannelOnline(att, channelId, row.membership_version ?? 0);

    const current = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (!current) return true;
    ws.serializeAttachment({ ...current, subscribed_channels: { ...current.subscribed_channels, [channelId]: row.membership_version ?? 0 } });
    return true;
  }

  private async canDeliver(
    attachment: ConnectionAttachment,
    ws: WebSocket,
    channelId: string,
    membershipVersionAtEvent: number,
  ): Promise<boolean> {
    const subscribedVersion = attachment.subscribed_channels[channelId];
    // subscribedVersion === undefined: the socket has no subscription record for this channel
    // (e.g. registerOnlineOnConnect's waitUntil hasn't recorded it yet, or this is a direct
    // replay-style deliver). findSocketBySession already guaranteed we're on the EXACT session
    // ChannelFanout targeted, so delivering to this socket is not a cross-session leak; the
    // user is a member (ChannelFanout only has an online_sessions row for members). Allow.
    if (subscribedVersion === undefined) return true;
    if (membershipVersionAtEvent <= subscribedVersion) return true;

    // Event version exceeds the subscription snapshot — a member change happened after
    // subscription. Re-check active membership before delivering; drop if no longer a member.
    return this.confirmActiveMembershipAndBumpSubscription(attachment, ws, channelId, membershipVersionAtEvent);
  }

  private async confirmActiveMembershipAndBumpSubscription(
    attachment: ConnectionAttachment,
    ws: WebSocket,
    channelId: string,
    membershipVersionAtEvent: number,
  ): Promise<boolean> {
    const routeName = await channelRouteNameFor(this.env, attachment.user_id, channelId);
    if (routeName === null) return false;

    const channel = this.env.CHAT_CHANNEL.getByName(routeName);
    const res = await channel.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": attachment.user_id },
    }));
    if (!res.ok) return false;

    const body = await res.json() as { my_role?: string | null };
    if (body.my_role == null) return false;

    // Still an active member — record the subscription version so subsequent same-version
    // events take the cheap path.
    ws.serializeAttachment({ ...attachment, subscribed_channels: { ...attachment.subscribed_channels, [channelId]: membershipVersionAtEvent } });
    return true;
  }

  private async handleDeliver(sessionId: string, eventJson: string, membershipVersionAtEvent: number): Promise<DeliverResult> {
    const ws = this.findSocketBySession(sessionId);
    if (!ws) return { delivered: false, dropped: "not_connected" };

    const att = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (!att) return { delivered: false, dropped: "not_connected" };

    const parsed = parseEventIdAndChannel(eventJson);
    if (!parsed.channel_id || !parsed.event_id) {
      return { delivered: false, dropped: "invalid_event" };
    }

    const allowed = await this.canDeliver(att, ws, parsed.channel_id, membershipVersionAtEvent);
    if (!allowed) return { delivered: false, dropped: "not_member" };

    // Send synchronously: ChannelFanout marks the queue row 'delivered' on our 200 response,
    // so the bytes MUST be on the wire (or buffered by the hibernating socket) before we return.
    // Re-read attachment after canDeliver (it may have bumped the subscription version).
    const current = ws.deserializeAttachment() as ConnectionAttachment | null;
    const base = current ?? att;
    ws.send(eventJson);
    ws.serializeAttachment({
      ...base,
      last_deliver: eventJson,
      per_channel_cursors: { ...base.per_channel_cursors, [parsed.channel_id]: parsed.event_id },
    });
    return { delivered: true };
  }

  private async unregisterAll(attachment: ConnectionAttachment): Promise<void> {
    const channels = Object.keys(attachment.subscribed_channels);
    await Promise.all(
      channels.map(async (channelId) => {
        const fanout = this.env.CHANNEL_FANOUT.getByName(channelId);
        try {
          await fanout.fetch(new Request("https://x/unregister-online", {
            method: "POST",
            headers: {
              "X-Channel-Id": channelId,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ session_id: attachment.session_id }),
          }));
        } catch {
          // ignore close-timeout/rpc teardown issues
        }
      }),
    );
  }
}
