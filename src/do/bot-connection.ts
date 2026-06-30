import { DurableObject } from "cloudflare:workers";
import {
  BOT_GATEWAY_API_VERSION,
  buildDeliveryAck,
  buildDeliveryFrame,
  buildPong,
  buildReady,
  type BotDeliveryBody,
  type BotDeliveryFrame,
  type BotDeliveryRequestBody,
  MainGatewayEffectValidationError,
  parseDeliveryResult,
  parseHello,
  type ParsedDeliveryResult,
  validateMainGatewayEffects,
} from "../chat/bot-gateway-protocol";
import { effectUsesUnsafeMarkdown } from "../chat/bot-message-format";
import type { EffectResult } from "../contract/bot-gateway";
import { uuidv7 } from "../ids/uuidv7";
import { handleSchemaVersionRequest } from "./sql-migrations";
import { migrateBotConnectionSchema } from "./migrations/bot-connection";
import { runDueJobs, scheduleNextAlarm, type DueRow, type DueTable } from "./scheduler";
import {
  deleteStatefulSessionRef,
  forwardBotSessionFrameToChatChannel,
  resumeStatefulSessions,
  upsertStatefulSessionRef,
} from "./bot-connection-stateful";
import {
  parseSessionClose,
  parseSessionInputAck,
  parseSessionStartAck,
  type SessionInputFrame,
} from "../chat/bot-gateway-session";

interface BotConnectionAttachment {
  bot_id: string;
  session_id: string;
}

interface EnqueueDeliveryInput {
  outbox_id: string;
  channel_id: string;
  kind: "command_invocation" | "message_interaction" | "message_event";
  target_id: string;
  request_json: string;
}

interface BotDeliveryRow {
  delivery_id: string;
  bot_id: string;
  channel_id: string;
  kind: "command_invocation" | "message_interaction" | "message_event";
  source_outbox_id: string;
  target_id: string;
  request_json: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
}

interface BotConnectionStateRow {
  bot_id: string;
  status: string;
  session_id: string | null;
  expires_at: string | null;
  is_official: number;
}

const MAX_BOT_DELIVERY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1000;
const MESSAGE_EVENT_TTL_MS = 30000;
const CONNECTION_LEASE_TTL_MS = 60000;

import { isRecord } from "../contract/utils";

function deliveryPayloadFromJson(raw: string): BotDeliveryRequestBody {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("invalid delivery request");
  }
  return parsed;
}

function botDeliveryFrameForWs(row: BotDeliveryRow): BotDeliveryFrame {
  const rest = deliveryPayloadFromJson(row.request_json);

  return buildDeliveryFrame({
    ...rest,
    delivery_id: row.delivery_id,
    kind: row.kind,
    channel_id: row.channel_id,
  });
}

// Phase 7 Bot Gateway WebSocket RPC: BotConnection DO (by bot_id).
//
// Owns the bot runtime WebSocket (hibernation) + delivery queue. The bot
// connects outbound to /api/chat/bot/ws; the Worker verifies the bot token via
// BotRegistry and routes the accepted socket here. ChatChannel flushes
// bot_delivery_outbox rows to /internal/enqueue-delivery; BotConnection
// persists a bot_deliveries row, pushes a `delivery` frame, and routes the
// bot's `delivery_result` back to the source ChatChannel
// /internal/bot-delivery-result (effect application stays in ChatChannel).
export class BotConnection extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateBotConnectionSchema(this.ctx);
  }

  async fetch(request: Request): Promise<Response> {
    const schemaVersion = handleSchemaVersionRequest(
      this.ctx,
      "BotConnection",
      request,
    );
    if (schemaVersion) return schemaVersion;

    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (url.pathname === "/internal/connection-state") {
      const row = this.ctx.storage.sql
        .exec("SELECT bot_id, status, session_id, expires_at FROM bot_connection_state LIMIT 1")
        .toArray()[0] as BotConnectionStateRow | undefined;
      const connected = row ? this.healthyConnectedState(row.bot_id) : null;
      return Response.json({
        status: connected ? "connected" : "disconnected",
        session_id: connected?.session_id ?? null,
      });
    }

    if (url.pathname === "/internal/enqueue-delivery") {
      if (request.method !== "POST")
        return new Response("method not allowed", { status: 405 });
      const botId = request.headers.get("X-Verified-Bot-Id");
      if (!botId)
        return new Response("missing verified bot id", { status: 401 });
      let body: EnqueueDeliveryInput;
      try {
        body = (await request.json()) as EnqueueDeliveryInput;
      } catch {
        return new Response("invalid delivery payload", { status: 400 });
      }

      if (
        typeof body?.outbox_id !== "string" ||
        typeof body.channel_id !== "string" ||
        (body.kind !== "command_invocation" &&
          body.kind !== "message_interaction" &&
          body.kind !== "message_event") ||
        typeof body.target_id !== "string" ||
        typeof body.request_json !== "string"
      ) {
        return new Response("invalid delivery payload", { status: 400 });
      }
      try {
        deliveryPayloadFromJson(body.request_json);
      } catch {
        return new Response("invalid delivery payload", { status: 400 });
      }

      const nowIso = this.nowIso();
      const nowDue = String(Date.now());
      let deliveryId = "";
      let deliveryStatus = "pending";
      let inserted = false;

      await this.ctx.storage.transaction(async () => {
        const existing = this.ctx.storage.sql
          .exec(
            "SELECT delivery_id, status FROM bot_deliveries WHERE bot_id=? AND source_outbox_id=?",
            botId,
            body.outbox_id,
          )
          .toArray()[0] as
          | { delivery_id: string; status: string }
          | undefined;
        if (existing) {
          deliveryId = existing.delivery_id;
          deliveryStatus = existing.status;
          return;
        }
        deliveryId = uuidv7();
        inserted = true;
        this.ctx.storage.sql.exec(
          "INSERT INTO bot_deliveries (delivery_id, bot_id, channel_id, kind, source_outbox_id, target_id, request_json, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          deliveryId,
          botId,
          body.channel_id,
          body.kind,
          body.outbox_id,
          body.target_id,
          body.request_json,
          "pending",
          0,
          nowDue,
          nowIso,
          nowIso,
        );
      });

      if (inserted && this.healthyConnectedState(botId)) {
        await this.trySendDelivery(botId, deliveryId, nowDue);
        const row = this.ctx.storage.sql
          .exec("SELECT status FROM bot_deliveries WHERE delivery_id=?", deliveryId)
          .toArray()[0] as { status: string } | undefined;
        deliveryStatus = row?.status ?? deliveryStatus;
      }

      await this.scheduleDeliveryAlarm();
      return Response.json({
        delivery_id: deliveryId,
        status: deliveryStatus,
      });
    }

    if (url.pathname === "/internal/stateful-session-ref-upsert" && request.method === "POST") {
      const botId = request.headers.get("X-Verified-Bot-Id");
      if (!botId) return new Response("missing verified bot id", { status: 401 });
      const body = (await request.json().catch(() => null)) as {
        session_id?: unknown;
        channel_id?: unknown;
        bot_id?: unknown;
        status?: unknown;
        updated_at?: unknown;
      } | null;
      if (
        !body ||
        typeof body.session_id !== "string" ||
        typeof body.channel_id !== "string" ||
        typeof body.bot_id !== "string" ||
        typeof body.status !== "string" ||
        typeof body.updated_at !== "string"
      ) {
        return new Response("invalid payload", { status: 400 });
      }
      upsertStatefulSessionRef(this.ctx, {
        session_id: body.session_id,
        channel_id: body.channel_id,
        bot_id: body.bot_id,
        status: body.status,
        updated_at: body.updated_at,
      });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/internal/stateful-session-ref-delete" && request.method === "POST") {
      const botId = request.headers.get("X-Verified-Bot-Id");
      if (!botId) return new Response("missing verified bot id", { status: 401 });
      const body = (await request.json().catch(() => null)) as { session_id?: unknown } | null;
      if (!body || typeof body.session_id !== "string") {
        return new Response("invalid payload", { status: 400 });
      }
      deleteStatefulSessionRef(this.ctx, body.session_id);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/internal/push-session-frame" && request.method === "POST") {
      const botId = request.headers.get("X-Verified-Bot-Id");
      if (!botId) return new Response("missing verified bot id", { status: 401 });
      const frame = await request.json().catch(() => null);
      if (!frame) return new Response("invalid payload", { status: 400 });
      const connection = this.healthyConnectedState(botId);
      if (!connection) return Response.json({ ok: true, delivered: false });
      try {
        connection.socket.send(JSON.stringify(frame));
        return Response.json({ ok: true, delivered: true });
      } catch {
        return Response.json({ ok: true, delivered: false });
      }
    }

    const botId = request.headers.get("X-Verified-Bot-Id");
    if (!botId) return new Response("missing verified bot id", { status: 401 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = pair as unknown as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [botId]);
    server.serializeAttachment({ bot_id: botId, session_id: "" });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": BOT_GATEWAY_API_VERSION },
    });
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private connectionRow(
    botId: string,
  ): BotConnectionStateRow | null {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT bot_id, status, session_id, expires_at FROM bot_connection_state WHERE bot_id=?",
        botId,
      )
      .toArray()[0] as BotConnectionStateRow | undefined;
    if (!row) return null;
    return row;
  }

  private activeSocketForBot(
    botId: string,
    sessionId: string,
  ): WebSocket | null {
    const sockets = this.ctx.getWebSockets(botId) as WebSocket[];
    for (const socket of sockets) {
      const att =
        socket.deserializeAttachment() as BotConnectionAttachment | null;
      if (!att?.bot_id) continue;
      if (att.bot_id !== botId) continue;
      if (att.session_id && sessionId && att.session_id !== sessionId) continue;
      if (!att.session_id && sessionId) continue;
      return socket;
    }
    return null;
  }

  private leaseExpiresAt(nowMs = Date.now()): string {
    return new Date(nowMs + CONNECTION_LEASE_TTL_MS).toISOString();
  }

  private markDisconnected(botId: string, sessionId: string | null): void {
    const now = this.nowIso();
    if (sessionId) {
      this.ctx.storage.sql.exec(
        "UPDATE bot_connection_state SET status='disconnected', disconnected_at=?, expires_at=? WHERE bot_id=? AND session_id=?",
        now,
        now,
        botId,
        sessionId,
      );
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE bot_connection_state SET status='disconnected', disconnected_at=?, expires_at=? WHERE bot_id=?",
      now,
      now,
      botId,
    );
  }

  private healthyConnectedState(botId: string): { session_id: string; socket: WebSocket } | null {
    const row = this.connectionRow(botId);
    if (!row || row.status !== "connected" || !row.session_id) return null;
    const expiresAtMs = Date.parse(row.expires_at ?? "");
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      this.markDisconnected(botId, row.session_id);
      return null;
    }
    const socket = this.activeSocketForBot(botId, row.session_id);
    if (!socket) {
      this.markDisconnected(botId, row.session_id);
      return null;
    }
    return { session_id: row.session_id, socket };
  }

  private async trySendDelivery(
    botId: string,
    deliveryId: string,
    nowDue: string,
  ): Promise<void> {
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM bot_deliveries WHERE delivery_id=?", deliveryId)
      .toArray()[0] as BotDeliveryRow | undefined;
    if (!row) return;

    const connection = this.healthyConnectedState(botId);
    if (!connection) return;

    try {
      connection.socket.send(JSON.stringify(botDeliveryFrameForWs(row)));
      const nowIso = this.nowIso();
      this.ctx.storage.sql.exec(
        "UPDATE bot_deliveries SET status='sent', updated_at=?, next_attempt_at=? WHERE delivery_id=?",
        nowIso,
        String(Date.now() + RETRY_BACKOFF_MS),
        deliveryId,
      );
    } catch {
      this.handleDeliverySendFailure(row, nowDue);
    }
  }

  private handleDeliverySendFailure(row: BotDeliveryRow, nowDue: string): void {
    if (row.kind === "message_event") {
      this.deferMessageEventUntilExpiry(row);
      return;
    }
    this.bumpDeliveryRetry(row, nowDue);
  }

  private bumpDeliveryRetry(row: BotDeliveryRow, nowDue: string): void {
    const attempts = Number(row.attempts ?? 0) + 1;
    const now = this.nowIso();
    if (attempts >= MAX_BOT_DELIVERY_ATTEMPTS) {
      this.ctx.storage.sql.exec(
        "UPDATE bot_deliveries SET status='failed', attempts=?, updated_at=?, next_attempt_at=? WHERE delivery_id=?",
        attempts,
        now,
        nowDue,
        row.delivery_id,
      );
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE bot_deliveries SET status='pending', attempts=?, updated_at=?, next_attempt_at=? WHERE delivery_id=?",
      attempts,
      now,
      String(Date.now() + RETRY_BACKOFF_MS),
      row.delivery_id,
    );
  }

  private async scheduleDeliveryAlarm(): Promise<void> {
    await scheduleNextAlarm(this.ctx, this.deliveryDueTables(async () => Promise.resolve()));
  }

  private isMessageEventExpired(row: BotDeliveryRow): boolean {
    const createdAtMs = Date.parse(row.created_at);
    if (!Number.isFinite(createdAtMs)) return false;
    return Date.now() - createdAtMs > MESSAGE_EVENT_TTL_MS;
  }

  private messageEventExpiryMs(row: BotDeliveryRow): number {
    const createdAtMs = Date.parse(row.created_at);
    if (Number.isFinite(createdAtMs)) return createdAtMs + MESSAGE_EVENT_TTL_MS;
    return Date.now() + MESSAGE_EVENT_TTL_MS;
  }

  private deferMessageEventUntilExpiry(row: BotDeliveryRow): void {
    this.ctx.storage.sql.exec(
      "UPDATE bot_deliveries SET status='pending', updated_at=?, next_attempt_at=? WHERE delivery_id=?",
      this.nowIso(),
      String(this.messageEventExpiryMs(row)),
      row.delivery_id,
    );
  }

  private toDeliveryRow(row: unknown): BotDeliveryRow {
    const typed = row as BotDeliveryRow;
    return {
      delivery_id: String(typed.delivery_id),
      bot_id: String(typed.bot_id),
      channel_id: String(typed.channel_id),
      kind: typed.kind,
      source_outbox_id: String(typed.source_outbox_id),
      target_id: String(typed.target_id),
      request_json: String(typed.request_json),
      status: String(typed.status),
      attempts: Number(typed.attempts ?? 0),
      next_attempt_at: String(typed.next_attempt_at),
      created_at: String(typed.created_at),
    };
  }

  private async flushPendingAndSentDeliveries(
    rows: BotDeliveryRow[],
    nowMs: number,
  ): Promise<void> {
    for (const raw of rows) {
      const row = this.toDeliveryRow(raw as unknown);
      if (row.kind === "message_event" && this.isMessageEventExpired(row)) {
        this.ctx.storage.sql.exec(
          "UPDATE bot_deliveries SET status='expired', updated_at=? WHERE delivery_id=?",
          this.nowIso(),
          row.delivery_id,
        );
        continue;
      }

      const state = this.healthyConnectedState(row.bot_id);
      if (!state) {
        this.handleDeliverySendFailure(row, String(Date.now()));
        continue;
      }

      try {
        state.socket.send(JSON.stringify(botDeliveryFrameForWs(row)));
        this.ctx.storage.sql.exec(
          "UPDATE bot_deliveries SET status='sent', attempts=?, updated_at=?, next_attempt_at=? WHERE delivery_id=?",
          row.attempts,
          this.nowIso(),
          String(nowMs + RETRY_BACKOFF_MS),
          row.delivery_id,
        );
      } catch {
        this.handleDeliverySendFailure(row, String(Date.now()));
      }
    }
  }

  private deliveryDueTables(handler: (rows: DueRow[]) => Promise<void>): DueTable[] {
    return [
      {
        table: "bot_deliveries",
        dueColumn: "next_attempt_at",
        statusColumn: "status",
        pendingStatus: "pending",
        handler,
      },
      {
        table: "bot_deliveries",
        dueColumn: "next_attempt_at",
        statusColumn: "status",
        pendingStatus: "sent",
        handler,
      },
    ];
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment =
      ws.deserializeAttachment() as BotConnectionAttachment | null;
    if (!attachment?.bot_id || typeof message !== "string") return;

    try {
      const frame = JSON.parse(message) as { type?: unknown };
      if (frame.type === "hello") {
        const parsed = parseHello(message);
        void parsed.last_received_delivery_id;
        const now = new Date().toISOString();
        const nowMs = Date.now();
        const expiresAt = this.leaseExpiresAt(nowMs);
        const sessionId = uuidv7();
        const isOfficial = await this.fetchBotIsOfficial(attachment.bot_id);
        this.ctx.storage.sql.exec(
          `INSERT INTO bot_connection_state (
             bot_id, session_id, status, connected_at, disconnected_at, last_seen_at, expires_at, is_official
           ) VALUES (?, ?, 'connected', ?, NULL, ?, ?, ?)
           ON CONFLICT(bot_id) DO UPDATE SET
             session_id = excluded.session_id,
             status = 'connected',
             connected_at = excluded.connected_at,
             disconnected_at = NULL,
             last_seen_at = excluded.last_seen_at,
             expires_at = excluded.expires_at,
             is_official = excluded.is_official`,
          attachment.bot_id,
          sessionId,
          now,
          now,
          expiresAt,
          isOfficial ? 1 : 0,
        );
        ws.serializeAttachment({
          bot_id: attachment.bot_id,
          session_id: sessionId,
        });
        ws.send(JSON.stringify(buildReady(attachment.bot_id, sessionId, now)));
        await resumeStatefulSessions(this.ctx, this.env, attachment.bot_id, (frame: SessionInputFrame) => {
          const connection = this.healthyConnectedState(attachment.bot_id);
          if (!connection) return false;
          try {
            connection.socket.send(JSON.stringify(frame));
            return true;
          } catch {
            return false;
          }
        });
        return;
      }

      if (frame.type === "ping") {
        this.touchConnected(attachment.bot_id, attachment.session_id);
        ws.send(JSON.stringify(buildPong()));
        return;
      }

      if (frame.type === "delivery_result") {
        const parsed = parseDeliveryResult(message);
        await this.handleDeliveryResult(ws, parsed);
        return;
      }

      if (frame.type === "session.start_ack") {
        const parsed = parseSessionStartAck(message);
        this.touchConnected(attachment.bot_id, attachment.session_id);
        const ref = this.ctx.storage.sql
          .exec(
            "SELECT channel_id FROM active_stateful_session_refs WHERE session_id=?",
            parsed.session_id,
          )
          .toArray()[0] as { channel_id: string } | undefined;
        if (ref) {
          await forwardBotSessionFrameToChatChannel(
            this.env,
            ref.channel_id,
            "/internal/bot-session-started",
            parsed,
          );
        }
        return;
      }

      if (frame.type === "session.input_ack") {
        const parsed = parseSessionInputAck(message);
        this.touchConnected(attachment.bot_id, attachment.session_id);
        const ref = this.ctx.storage.sql
          .exec(
            "SELECT channel_id FROM active_stateful_session_refs WHERE session_id=?",
            parsed.session_id,
          )
          .toArray()[0] as { channel_id: string } | undefined;
        if (ref) {
          await forwardBotSessionFrameToChatChannel(
            this.env,
            ref.channel_id,
            "/internal/bot-session-input-ack",
            parsed,
          );
        }
        return;
      }

      if (frame.type === "session.close") {
        const parsed = parseSessionClose(message);
        this.touchConnected(attachment.bot_id, attachment.session_id);
        const ref = this.ctx.storage.sql
          .exec(
            "SELECT channel_id FROM active_stateful_session_refs WHERE session_id=?",
            parsed.session_id,
          )
          .toArray()[0] as { channel_id: string } | undefined;
        if (ref) {
          await forwardBotSessionFrameToChatChannel(
            this.env,
            ref.channel_id,
            "/internal/bot-session-close",
            parsed,
          );
        }
        return;
      }
    } catch {
      // Protocol parse failures are ignored at WS layer for this phase.
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as {
      bot_id?: string;
      session_id?: string;
    } | null;
    if (!attachment?.bot_id) return;
    await this.markDisconnectedIfCurrentAttachment({
      bot_id: attachment.bot_id,
      session_id: attachment.session_id,
    });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as {
      bot_id?: string;
      session_id?: string;
    } | null;
    if (!attachment?.bot_id) return;
    await this.markDisconnectedIfCurrentAttachment({
      bot_id: attachment.bot_id,
      session_id: attachment.session_id,
    });
  }

  private async markDisconnectedIfCurrentAttachment(attachment: {
    bot_id: string;
    session_id?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const row = this.ctx.storage.sql
      .exec(
        "SELECT session_id FROM bot_connection_state WHERE bot_id=?",
        attachment.bot_id,
      )
      .toArray()[0] as { session_id: string | null } | undefined;
    if (row && row.session_id !== attachment.session_id) return;
    this.ctx.storage.sql.exec(
      "UPDATE bot_connection_state SET status='disconnected', disconnected_at=?, expires_at=? WHERE bot_id=? AND session_id=?",
      now,
      now,
      attachment.bot_id,
      attachment.session_id,
    );
  }

  async handleDeliveryResult(
    ws: WebSocket,
    parsed: ParsedDeliveryResult,
  ): Promise<void> {
    const attachment = ws.deserializeAttachment() as BotConnectionAttachment | null;
    this.touchConnected(attachment?.bot_id ?? "", attachment?.session_id);
    const now = this.nowIso();

    const row = this.ctx.storage.sql
      .exec(
        "SELECT delivery_id, bot_id, channel_id, source_outbox_id, status FROM bot_deliveries WHERE delivery_id=?",
        parsed.delivery_id,
      )
      .toArray()[0] as BotDeliveryRow | undefined;

    if (!row) {
      ws.send(
        JSON.stringify(
          buildDeliveryAck(parsed.delivery_id, "failed", {
            error: { code: "BOT_EFFECT_INVALID", message: "unknown delivery_id" },
          }),
        ),
      );
      return;
    }

    if (row.status === "completed") {
      ws.send(JSON.stringify(buildDeliveryAck(parsed.delivery_id, "applied")));
      return;
    }

    let validatedEffects;
    try {
      validatedEffects = validateMainGatewayEffects(parsed.effects);
      const connectionState = this.ctx.storage.sql
        .exec("SELECT is_official FROM bot_connection_state WHERE bot_id=?", row.bot_id)
        .toArray()[0] as { is_official: number } | undefined;
      const isOfficial = connectionState?.is_official === 1;
      for (const effect of validatedEffects) {
        if (effectUsesUnsafeMarkdown(effect) && !isOfficial) {
          throw new MainGatewayEffectValidationError(
            "unsafe-markdown format is only allowed for official bots",
          );
        }
      }
    } catch (err) {
      const message =
        err instanceof MainGatewayEffectValidationError
          ? err.message
          : err instanceof Error
            ? err.message
            : "invalid effects";
      this.ctx.storage.sql.exec(
        "UPDATE bot_deliveries SET status='failed', updated_at=?, next_attempt_at=? WHERE delivery_id=? AND status IN ('pending', 'sent')",
        now,
        String(Date.now()),
        parsed.delivery_id,
      );
      ws.send(
        JSON.stringify(
          buildDeliveryAck(parsed.delivery_id, "failed", {
            error: { code: "BOT_EFFECT_INVALID", message },
          }),
        ),
      );
      return;
    }

    const channelStub = this.env.CHAT_CHANNEL.getByName(row.channel_id);
    const applyRes = await channelStub.fetch(
      new Request("https://x/internal/bot-delivery-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          delivery_id: parsed.delivery_id,
          outbox_id: row.source_outbox_id,
          bot_id: row.bot_id,
          channel_id: row.channel_id,
          effects: validatedEffects,
        }),
      }),
    );

    const applyBody = (await applyRes.json().catch(() => ({}))) as {
      status?: string;
      effect_results?: EffectResult[];
      error?: { code?: string; message?: string };
    };

    if (applyRes.ok && applyBody.status === "applied") {
      this.ctx.storage.sql.exec(
        "UPDATE bot_deliveries SET status='completed', updated_at=?, next_attempt_at=? WHERE delivery_id=?",
        now,
        String(Date.now()),
        parsed.delivery_id,
      );
      ws.send(
        JSON.stringify(
          buildDeliveryAck(parsed.delivery_id, "applied", {
            ...(Array.isArray(applyBody.effect_results)
              ? { effect_results: applyBody.effect_results }
              : {}),
          }),
        ),
      );
      return;
    }

    const errorCode = applyBody.error?.code ?? "BOT_EFFECT_INVALID";
    const errorMessage = applyBody.error?.message ?? "effect application failed";
    this.ctx.storage.sql.exec(
      "UPDATE bot_deliveries SET status='failed', updated_at=?, next_attempt_at=? WHERE delivery_id=? AND status IN ('pending', 'sent')",
      now,
      String(Date.now()),
      parsed.delivery_id,
    );
    ws.send(
      JSON.stringify(
        buildDeliveryAck(parsed.delivery_id, "failed", {
          error: { code: errorCode, message: errorMessage },
        }),
      ),
    );
  }

  private async fetchBotIsOfficial(botId: string): Promise<boolean> {
    const res = await this.env.BOT_REGISTRY.getByName("registry").fetch(
      new Request(`https://x/internal/bot-get?bot_id=${encodeURIComponent(botId)}`),
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { is_official?: unknown };
    return body.is_official === true;
  }

  touchConnected(botId: string, sessionId?: string): void {
    if (!botId || !sessionId) return;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    this.ctx.storage.sql.exec(
      "UPDATE bot_connection_state SET last_seen_at=?, expires_at=? WHERE bot_id=? AND session_id=? AND status='connected'",
      now,
      this.leaseExpiresAt(nowMs),
      botId,
      sessionId,
    );
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    const dueTables = this.deliveryDueTables(async (rows) => {
      await this.flushPendingAndSentDeliveries(
        rows.map((row) => this.toDeliveryRow(row)),
        nowMs,
      );
    });

    await runDueJobs(this.ctx, nowMs, dueTables);
    await scheduleNextAlarm(this.ctx, dueTables);
  }
}
