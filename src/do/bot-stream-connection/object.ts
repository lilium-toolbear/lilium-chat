import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { BOT_STREAM_API_VERSION } from "../../contract/bot-stream";
import {
  buildBotStreamAppendAck,
  buildBotStreamError,
  buildBotStreamFinalizedAck,
  buildBotStreamPong,
  buildBotStreamReady,
  parseBotStreamAppend,
  parseBotStreamFinalize,
  parseBotStreamHello,
  parseBotStreamPing,
} from "../../chat/bot-stream-protocol";
import { callChatChannelStreamAbandon, streamAbandonErrorFromThrown } from "../../chat/stream-abandon-client";
import { callChatChannelStreamFinalize, streamFinalizeErrorFromThrown } from "../../chat/stream-finalize-client";
import { logSwallowedError } from "../../errors";
import { computeFinalizeRequestHash } from "../../chat/stream-registry";
import {
  STREAM_ACK_FLUSH_INTERVAL_MS,
  STREAM_FANOUT_INTERVAL_MS,
  STREAM_FANOUT_MAX_PENDING_BYTES,
  STREAM_PENDING_FLUSH_THRESHOLD_BYTES,
  WS_ATTACHMENT_MAX_BYTES,
} from "../../chat/stream-constants";
import { buildStreamAbandonCleanupFrame, deliverLiveStreamFrame } from "../../chat/stream-live-delivery";
import { hashStreamDelta, validateAppendSeq } from "../../chat/stream-seq";
import { buildWireStreamEventFrame } from "../../contract/wire-frames";
import { handleSchemaVersionRequest } from "../shared/sql-migrations";
import { migrateBotStreamConnectionSchema } from "./migrations";
import { requireTestOnly } from "../shared/do-errors";
import { runDueJobs, scheduleNextAlarm, type DueRow, type DueTable } from "../shared/scheduler";

export interface BotStreamConnectionAttachment {
  channel_id: string;
  message_id: string;
  bot_id: string;
  pending_text: string;
  pending_start_seq: number | null;
  pending_end_seq: number;
  received_seq: number;
  /** seq string -> delta hash; in-memory WS attachment only. */
  recent_unacked_hashes: Record<string, string>;
  fanout_pending_text: string;
  fanout_end_seq: number;
  fanout_due_at_ms: number;
  last_flush_at_ms: number;
  expires_at: string;
}

interface StreamStateRow {
  channel_id: string;
  message_id: string;
  bot_id: string;
  status: string;
  ack_seq: number;
  flushed_text: string;
  pending_bytes: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

type StreamDueJobKind = "flush" | "fanout" | "expiry";

function nowIso(): string {
  return new Date().toISOString();
}

export function botStreamDoName(channelId: string, messageId: string): string {
  return `${channelId}#${messageId}`;
}

export class BotStreamConnection extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateBotStreamConnectionSchema(this.ctx);
  }

  async fetch(request: Request): Promise<Response> {
    const schemaVersion = handleSchemaVersionRequest(
      this.ctx,
      "BotStreamConnection",
      request,
    );
    if (schemaVersion) return schemaVersion;

    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (url.pathname === "/dump") {
      const gate = requireTestOnly(request, this.env);
      if (gate) return gate;
      const rows = this.ctx.storage.sql.exec("SELECT * FROM stream_state").toArray();
      const dueJobs = this.ctx.storage.sql.exec("SELECT * FROM stream_due_jobs").toArray();
      const sockets = this.ctx.getWebSockets();
      return Response.json({ stream_state: rows, stream_due_jobs: dueJobs, websocket_count: sockets.length });
    }

    if (url.pathname === "/internal/expire-stream" && request.method === "POST") {
      let body: { channel_id?: string; message_id?: string; bot_id?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch (err) {
        logSwallowedError("bot_stream_internal_request_invalid", err);
        return new Response("invalid payload", { status: 400 });
      }
      if (
        typeof body.channel_id !== "string" ||
        typeof body.message_id !== "string" ||
        typeof body.bot_id !== "string"
      ) {
        return new Response("missing channel_id/message_id/bot_id", { status: 400 });
      }
      await this.expireStream({
        channel_id: body.channel_id,
        message_id: body.message_id,
        bot_id: body.bot_id,
      });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/internal/seed-stream-state" && request.method === "POST") {
      const gate = requireTestOnly(request, this.env);
      if (gate) return gate;
      let body: {
        channel_id?: string;
        message_id?: string;
        bot_id?: string;
        status?: string;
        expires_at?: string;
        ack_seq?: number;
        flushed_text?: string;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch (err) {
        logSwallowedError("bot_stream_internal_request_invalid", err);
        return new Response("invalid payload", { status: 400 });
      }
      if (
        typeof body.channel_id !== "string" ||
        typeof body.message_id !== "string" ||
        typeof body.bot_id !== "string"
      ) {
        return new Response("missing channel_id/message_id/bot_id", { status: 400 });
      }
      const now = nowIso();
      const expiresAt =
        body.expires_at ?? new Date(Date.now() + 300_000).toISOString();
      this.ctx.storage.sql.exec(
        `INSERT INTO stream_state (
          channel_id, message_id, bot_id, status, ack_seq, flushed_text,
          pending_bytes, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(channel_id, message_id) DO UPDATE SET
          bot_id=excluded.bot_id,
          status=excluded.status,
          ack_seq=excluded.ack_seq,
          flushed_text=excluded.flushed_text,
          expires_at=excluded.expires_at,
          updated_at=excluded.updated_at`,
        body.channel_id,
        body.message_id,
        body.bot_id,
        body.status ?? "streaming",
        body.ack_seq ?? 0,
        body.flushed_text ?? "",
        expiresAt,
        now,
        now,
      );
      const seeded = this.loadStreamState(body.channel_id, body.message_id);
      if (seeded) {
        this.scheduleStreamExpiry(seeded.expires_at);
        await scheduleNextAlarm(this.ctx, this.streamDueTables());
      }
      return Response.json({ ok: true });
    }

    const botId = request.headers.get("X-Verified-Bot-Id");
    if (!botId) return new Response("missing verified bot id", { status: 401 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const channelId = request.headers.get("X-Channel-Id") ?? "";
    const messageId = request.headers.get("X-Message-Id") ?? "";
    if (!channelId || !messageId) {
      return new Response("missing X-Channel-Id or X-Message-Id", { status: 400 });
    }

    const expiresAtHeader = request.headers.get("X-Stream-Expires-At") ?? "";
    const row = this.ensureStreamState(channelId, messageId, botId, expiresAtHeader);
    if (!row) return new Response("stream not found", { status: 404 });
    if (row.bot_id !== botId) return new Response("forbidden", { status: 403 });
    if (row.status !== "streaming" && row.status !== "finalized") {
      return new Response("stream not active", { status: 409 });
    }
    if (row.expires_at <= nowIso()) {
      return new Response("stream expired", { status: 410 });
    }

    const attachment = this.attachmentFromState(row, botId);
    this.scheduleStreamExpiry(row.expires_at);
    await scheduleNextAlarm(this.ctx, this.streamDueTables());
    for (const existing of this.ctx.getWebSockets()) {
      try {
        existing.close(1000, "stream reconnect");
      } catch (err) {
        logSwallowedError("bot_stream_ws_send_failed", err);
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = pair as unknown as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [botStreamDoName(channelId, messageId)]);
    server.serializeAttachment(attachment);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": BOT_STREAM_API_VERSION },
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as BotStreamConnectionAttachment | null;
    if (!attachment || typeof message !== "string") return;

    try {
      const frame = JSON.parse(message) as { type?: string };
      if (frame.type === "hello") {
        parseBotStreamHello(message);
        const row = this.loadStreamState(attachment.channel_id, attachment.message_id);
        const ackSeq = row ? Number(row.ack_seq) : attachment.received_seq;
        ws.send(
          JSON.stringify(
            buildBotStreamReady({
              channel_id: attachment.channel_id,
              message_id: attachment.message_id,
              expires_at: attachment.expires_at,
              ack_seq: ackSeq,
            }),
          ),
        );
        return;
      }
      if (frame.type === "ping") {
        parseBotStreamPing(message);
        ws.send(JSON.stringify(buildBotStreamPong()));
        return;
      }
      if (frame.type === "append") {
        const append = parseBotStreamAppend(message);
        await this.handleAppend(ws, attachment, append.seq, append.delta);
        return;
      }
      if (frame.type === "finalize") {
        const finalize = parseBotStreamFinalize(message);
        await this.handleFinalize(ws, attachment, finalize);
        return;
      }
    } catch (err) {
      logSwallowedError("bot_stream_ws_frame_invalid", err);
    }
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // disconnect alone does not abandon — expiry task handles cleanup
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "stream websocket error");
    } catch (err) {
      logSwallowedError("bot_stream_ws_close_failed", err);
    }
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    await runDueJobs(this.ctx, nowMs, this.streamDueTables());
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as BotStreamConnectionAttachment | null;
      if (!attachment) continue;
      const updated = await this.processPendingWork(ws, attachment, nowMs);
      ws.serializeAttachment(updated);
    }
    await scheduleNextAlarm(this.ctx, this.streamDueTables());
  }

  private streamDueTables(): DueTable[] {
    return [
      {
        table: "stream_due_jobs",
        dueColumn: "due_at_ms",
        statusColumn: "status",
        pendingStatus: "pending",
        dueValueKind: "epoch_ms",
        handler: async (rows: DueRow[]) => {
          const kinds = new Set(rows.map((row) => row.job_kind as string));
          if (kinds.has("expiry")) {
            const stateRows = this.ctx.storage.sql.exec("SELECT channel_id, message_id, bot_id, status, expires_at FROM stream_state").toArray() as Array<{
              channel_id: string;
              message_id: string;
              bot_id: string;
              status: string;
              expires_at: string;
            }>;
            const now = nowIso();
            for (const state of stateRows) {
              if (state.status !== "streaming") continue;
              if (state.expires_at > now) continue;
              await this.expireStream({
                channel_id: state.channel_id,
                message_id: state.message_id,
                bot_id: state.bot_id,
              });
            }
          }

          if (kinds.has("flush") || kinds.has("fanout")) {
            const nowMs = Date.now();
            for (const ws of this.ctx.getWebSockets()) {
              const attachment = ws.deserializeAttachment() as BotStreamConnectionAttachment | null;
              if (!attachment) continue;
              const updated = await this.processPendingWork(ws, attachment, nowMs);
              ws.serializeAttachment(updated);
            }
          }
        },
      },
    ];
  }

  private async handleFinalize(
    ws: WebSocket,
    attachment: BotStreamConnectionAttachment,
    finalize: {
      final_seq: number;
      components?: unknown[];
      attachment_ids?: string[];
    },
  ): Promise<void> {
    const row = this.loadStreamState(attachment.channel_id, attachment.message_id);
    if (!row) {
      this.sendStreamError(ws, "BOT_STREAM_NOT_FOUND", "stream not active", false);
      return;
    }
    if (row.status === "finalized") {
      await this.replayFinalize(ws, attachment, finalize);
      return;
    }
    if (row.status !== "streaming") {
      this.sendStreamError(ws, "BOT_STREAM_EXPIRED", "stream expired", false);
      return;
    }
    if (row.expires_at <= nowIso()) {
      this.sendStreamError(ws, "BOT_STREAM_EXPIRED", "stream expired", false);
      return;
    }

    if (finalize.final_seq > attachment.received_seq) {
      this.sendStreamError(ws, "BOT_STREAM_SEQUENCE_GAP", "finalize sequence gap", true);
      return;
    }
    if (finalize.final_seq < attachment.received_seq) {
      this.sendStreamError(ws, "BOT_STREAM_CONFLICT", "finalize sequence behind received", false);
      return;
    }

    const attachmentIds = Array.isArray(finalize.attachment_ids)
      ? finalize.attachment_ids.filter((id): id is string => typeof id === "string")
      : [];
    if (attachmentIds.length > 0) {
      this.sendStreamError(ws, "BOT_EFFECT_INVALID", "attachment_ids not supported yet", false);
      return;
    }

    let next = attachment;
    if (next.fanout_pending_text) {
      next = await this.fanoutPending(next);
    }
    while (next.pending_text) {
      next = await this.flushPending(ws, next);
    }
    ws.serializeAttachment(next);

    const freshRow = this.loadStreamState(attachment.channel_id, attachment.message_id);
    if (!freshRow || freshRow.status !== "streaming") {
      this.sendStreamError(ws, "BOT_STREAM_NOT_FOUND", "stream not active", false);
      return;
    }

    const ackSeq = Number(freshRow.ack_seq);
    if (ackSeq !== next.received_seq || finalize.final_seq !== next.received_seq) {
      this.sendStreamError(ws, "BOT_STREAM_CONFLICT", "finalize before flush complete", false);
      return;
    }

    const resolvedText = freshRow.flushed_text;
    const components = Array.isArray(finalize.components) ? finalize.components : [];
    const finalizeRequestHash = await computeFinalizeRequestHash({
      final_seq: finalize.final_seq,
      resolved_text: resolvedText,
      components,
      attachment_ids: attachmentIds,
    });

    try {
      const body = await callChatChannelStreamFinalize(this.env, {
        channel_id: attachment.channel_id,
        message_id: attachment.message_id,
        bot_id: attachment.bot_id,
        resolved_text: resolvedText,
        finalize_request_hash: finalizeRequestHash,
        final_seq: finalize.final_seq,
        components,
        attachment_ids: attachmentIds,
      });

      this.markStreamFinalized(attachment.channel_id, attachment.message_id);
      this.clearStreamDueJob("flush");
      this.clearStreamDueJob("fanout");
      ws.send(
        JSON.stringify(
          buildBotStreamFinalizedAck({
            message_id: body.message_id,
            event_id: body.event_id,
          }),
        ),
      );
      try {
        ws.close(1000, "stream finalized");
      } catch (err) {
        logSwallowedError("bot_stream_ws_send_failed", err);
      }
    } catch (err) {
      const parsed = streamFinalizeErrorFromThrown(err);
      this.sendStreamError(ws, parsed.code, parsed.message, parsed.retryable);
    }
  }

  private async replayFinalize(
    ws: WebSocket,
    attachment: BotStreamConnectionAttachment,
    finalize: {
      final_seq: number;
      components?: unknown[];
      attachment_ids?: string[];
    },
  ): Promise<void> {
    const row = this.loadStreamState(attachment.channel_id, attachment.message_id);
    if (!row) {
      this.sendStreamError(ws, "BOT_STREAM_NOT_FOUND", "stream not active", false);
      return;
    }

    const attachmentIds = Array.isArray(finalize.attachment_ids)
      ? finalize.attachment_ids.filter((id): id is string => typeof id === "string")
      : [];
    const components = Array.isArray(finalize.components) ? finalize.components : [];
    const resolvedText = row.flushed_text;
    const finalizeRequestHash = await computeFinalizeRequestHash({
      final_seq: finalize.final_seq,
      resolved_text: resolvedText,
      components,
      attachment_ids: attachmentIds,
    });

    try {
      const body = await callChatChannelStreamFinalize(this.env, {
        channel_id: attachment.channel_id,
        message_id: attachment.message_id,
        bot_id: attachment.bot_id,
        resolved_text: resolvedText,
        finalize_request_hash: finalizeRequestHash,
        final_seq: finalize.final_seq,
        components,
        attachment_ids: attachmentIds,
      });

      ws.send(
        JSON.stringify(
          buildBotStreamFinalizedAck({
            message_id: body.message_id,
            event_id: body.event_id,
          }),
        ),
      );
      try {
        ws.close(1000, "stream finalized");
      } catch (err) {
        logSwallowedError("bot_stream_ws_send_failed", err);
      }
    } catch (err) {
      const parsed = streamFinalizeErrorFromThrown(err);
      this.sendStreamError(ws, parsed.code, parsed.message, parsed.retryable);
    }
  }

  private markStreamFinalized(channelId: string, messageId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE stream_state SET status='finalized', updated_at=? WHERE channel_id=? AND message_id=?",
      nowIso(),
      channelId,
      messageId,
    );
    this.clearStreamDueJob("expiry");
  }

  private markStreamAbandoned(channelId: string, messageId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE stream_state SET status='abandoned', updated_at=? WHERE channel_id=? AND message_id=?",
      nowIso(),
      channelId,
      messageId,
    );
    this.clearStreamDueJob("flush");
    this.clearStreamDueJob("fanout");
    this.clearStreamDueJob("expiry");
  }

  private scheduleStreamExpiry(expiresAt: string): void {
    const dueAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(dueAtMs)) return;
    this.upsertStreamDueJob("expiry", dueAtMs);
  }

  private async isRegistryStillStreaming(
    channelId: string,
    messageId: string,
    botId: string,
  ): Promise<boolean> {
    try {
      const body = await this.env.CHAT_CHANNEL.getByName(channelId).streamRegistryPeek({
        channel_id: channelId,
        message_id: messageId,
        bot_id: botId,
      });
      return body.status === "streaming";
    } catch (err) {
      logSwallowedError("bot_stream_registry_peek_failed", err, { channel_id: channelId, message_id: messageId });
      return false;
    }
  }

  async expireStream(input: {
    channel_id: string;
    message_id: string;
    bot_id: string;
  }): Promise<void> {
    await this.runExpireStream(input.channel_id, input.message_id, input.bot_id);
  }

  private async runExpireStream(channelId: string, messageId: string, botId: string): Promise<void> {
    const row = this.loadStreamState(channelId, messageId);
    if (row && row.status !== "streaming") return;

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as BotStreamConnectionAttachment | null;
      if (!attachment) continue;
      if (attachment.channel_id !== channelId || attachment.message_id !== messageId) continue;
      let next = attachment;
      while (next.pending_text) {
        next = await this.flushPending(ws, next);
      }
      if (next.fanout_pending_text) {
        next = await this.fanoutPending(next);
      }
      ws.serializeAttachment(next);
    }

    const freshRow = this.loadStreamState(channelId, messageId);
    const resolvedPartial = freshRow?.flushed_text ?? "";

    if (resolvedPartial.length === 0) {
      const stillStreaming = await this.isRegistryStillStreaming(channelId, messageId, botId);
      if (stillStreaming) {
        await deliverLiveStreamFrame(this.env, {
          channel_id: channelId,
          frame: buildStreamAbandonCleanupFrame({
            channelId,
            messageId,
            occurredAt: nowIso(),
          }),
        });
      }
    }

    try {
      await callChatChannelStreamAbandon(this.env, {
        channel_id: channelId,
        message_id: messageId,
        bot_id: botId,
        resolved_partial: resolvedPartial,
      });
    } catch (err) {
      const parsed = streamAbandonErrorFromThrown(err);
      if (parsed.code !== "BOT_STREAM_CONFLICT") {
        return;
      }
    }

    if (freshRow && freshRow.status === "streaming") {
      this.markStreamAbandoned(channelId, messageId);
    } else if (!freshRow) {
      this.clearStreamDueJob("expiry");
    }

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as BotStreamConnectionAttachment | null;
      if (!attachment) continue;
      if (attachment.channel_id !== channelId || attachment.message_id !== messageId) continue;
      try {
        ws.close(1000, "stream expired");
      } catch (err) {
        logSwallowedError("bot_stream_ws_send_failed", err);
      }
    }
  }

  private async handleAppend(
    ws: WebSocket,
    attachment: BotStreamConnectionAttachment,
    seq: number,
    delta: string,
  ): Promise<void> {
    const row = this.loadStreamState(attachment.channel_id, attachment.message_id);
    if (!row || row.status !== "streaming") {
      this.sendStreamError(ws, row?.status === "abandoned" || row?.status === "expired" ? "BOT_STREAM_EXPIRED" : "BOT_STREAM_NOT_FOUND", row?.status === "abandoned" || row?.status === "expired" ? "stream expired" : "stream not active", false);
      return;
    }
    if (row.expires_at <= nowIso()) {
      this.sendStreamError(ws, "BOT_STREAM_EXPIRED", "stream expired", false);
      return;
    }

    const ackSeq = Number(row.ack_seq);
    const validation = validateAppendSeq({ seq, ackSeq, receivedSeq: attachment.received_seq });

    if (validation.kind === "durable_noop") {
      this.sendAppendAck(ws, ackSeq);
      return;
    }
    if (validation.kind === "sequence_gap") {
      this.sendStreamError(ws, "BOT_STREAM_SEQUENCE_GAP", "append sequence gap", true);
      return;
    }
    if (validation.kind === "unacked_duplicate") {
      const deltaHash = await hashStreamDelta(delta);
      const priorHash = attachment.recent_unacked_hashes[String(seq)];
      if (priorHash === deltaHash) return;
      this.sendStreamError(ws, "BOT_STREAM_CONFLICT", "append conflict for seq", false);
      return;
    }

    const deltaHash = await hashStreamDelta(delta);
    let next = { ...attachment };
    if (next.pending_start_seq === null) next.pending_start_seq = seq;
    next.pending_text += delta;
    next.pending_end_seq = seq;
    next.received_seq = seq;
    next.recent_unacked_hashes = { ...next.recent_unacked_hashes, [String(seq)]: deltaHash };

    if (!next.fanout_pending_text) {
      next.fanout_due_at_ms = Date.now() + STREAM_FANOUT_INTERVAL_MS;
      this.upsertStreamDueJob("fanout", next.fanout_due_at_ms);
    }
    next.fanout_pending_text += delta;
    next.fanout_end_seq = seq;

    next = await this.processPendingWork(ws, next, Date.now());
    await this.saveAttachment(ws, next);
    await scheduleNextAlarm(this.ctx, this.streamDueTables());
  }

  private async processPendingWork(
    ws: WebSocket,
    attachment: BotStreamConnectionAttachment,
    nowMs: number,
  ): Promise<BotStreamConnectionAttachment> {
    let next = attachment;
    if (this.shouldFanout(next, nowMs)) {
      next = await this.fanoutPending(next);
    }
    if (this.shouldFlush(next, nowMs)) {
      next = await this.flushPending(ws, next);
    }
    return next;
  }

  private shouldFlush(attachment: BotStreamConnectionAttachment, nowMs: number): boolean {
    if (!attachment.pending_text) return false;
    if (attachment.pending_text.length >= STREAM_PENDING_FLUSH_THRESHOLD_BYTES) return true;
    if (nowMs >= attachment.last_flush_at_ms + STREAM_ACK_FLUSH_INTERVAL_MS) return true;
    if (this.estimateAttachmentBytes(attachment) >= WS_ATTACHMENT_MAX_BYTES) return true;
    return false;
  }

  private shouldFanout(attachment: BotStreamConnectionAttachment, nowMs: number): boolean {
    if (!attachment.fanout_pending_text) return false;
    if (attachment.fanout_pending_text.length >= STREAM_FANOUT_MAX_PENDING_BYTES) return true;
    if (attachment.fanout_due_at_ms > 0 && nowMs >= attachment.fanout_due_at_ms) return true;
    return false;
  }

  private async flushPending(
    ws: WebSocket,
    attachment: BotStreamConnectionAttachment,
  ): Promise<BotStreamConnectionAttachment> {
    if (!attachment.pending_text) return attachment;

    const now = nowIso();
    const endSeq = attachment.pending_end_seq;
    const pendingText = attachment.pending_text;
    const flushed = this.ctx.storage.sql
      .exec(
        `UPDATE stream_state SET
          flushed_text = flushed_text || ?,
          ack_seq = ?,
          pending_bytes = 0,
          updated_at = ?
        WHERE channel_id = ? AND message_id = ? AND ack_seq < ?`,
        pendingText,
        endSeq,
        now,
        attachment.channel_id,
        attachment.message_id,
        endSeq,
      )
      .rowsWritten;
    if (flushed === 0) {
      const row = this.loadStreamState(attachment.channel_id, attachment.message_id);
      const ackSeq = row ? Number(row.ack_seq) : endSeq;
      this.sendAppendAck(ws, ackSeq);
      return {
        ...attachment,
        pending_text: "",
        pending_start_seq: null,
        pending_end_seq: ackSeq,
        recent_unacked_hashes: {},
        last_flush_at_ms: Date.now(),
      };
    }

    const ackSeq = endSeq;
    const prunedHashes: Record<string, string> = {};
    for (const [seqKey, hash] of Object.entries(attachment.recent_unacked_hashes)) {
      if (Number(seqKey) > ackSeq) prunedHashes[seqKey] = hash;
    }

    this.clearStreamDueJob("flush");
    this.sendAppendAck(ws, ackSeq);

    return {
      ...attachment,
      pending_text: "",
      pending_start_seq: null,
      pending_end_seq: ackSeq,
      recent_unacked_hashes: prunedHashes,
      last_flush_at_ms: Date.now(),
    };
  }

  private async fanoutPending(
    attachment: BotStreamConnectionAttachment,
  ): Promise<BotStreamConnectionAttachment> {
    if (!attachment.fanout_pending_text) return attachment;

    const frame = buildWireStreamEventFrame({
      type: "message.stream_delta",
      channel_id: attachment.channel_id,
      payload: {
        channel_id: attachment.channel_id,
        message_id: attachment.message_id,
        delta: attachment.fanout_pending_text,
      },
      stream_seq: attachment.fanout_end_seq,
      occurred_at: nowIso(),
    });

    await deliverLiveStreamFrame(this.env, {
      channel_id: attachment.channel_id,
      frame,
    });

    this.clearStreamDueJob("fanout");

    return {
      ...attachment,
      fanout_pending_text: "",
      fanout_end_seq: attachment.received_seq,
      fanout_due_at_ms: 0,
    };
  }

  private async saveAttachment(
    ws: WebSocket,
    attachment: BotStreamConnectionAttachment,
  ): Promise<BotStreamConnectionAttachment> {
    let next = attachment;
    const nowMs = Date.now();
    while (this.shouldFlush(next, nowMs) || this.estimateAttachmentBytes(next) >= WS_ATTACHMENT_MAX_BYTES) {
      next = await this.flushPending(ws, next);
    }
    ws.serializeAttachment(next);

    if (next.pending_text) {
      this.upsertStreamDueJob("flush", next.last_flush_at_ms + STREAM_ACK_FLUSH_INTERVAL_MS);
    }
    if (next.fanout_pending_text && !next.fanout_due_at_ms) {
      next.fanout_due_at_ms = nowMs + STREAM_FANOUT_INTERVAL_MS;
      this.upsertStreamDueJob("fanout", next.fanout_due_at_ms);
      ws.serializeAttachment(next);
    }

    return next;
  }

  private upsertStreamDueJob(kind: StreamDueJobKind, dueAtMs: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO stream_due_jobs (job_kind, due_at_ms, status)
       VALUES (?, ?, 'pending')
       ON CONFLICT(job_kind) DO UPDATE SET
         due_at_ms = MIN(due_at_ms, excluded.due_at_ms),
         status = 'pending'`,
      kind,
      dueAtMs,
    );
  }

  private clearStreamDueJob(kind: StreamDueJobKind): void {
    this.ctx.storage.sql.exec("DELETE FROM stream_due_jobs WHERE job_kind=?", kind);
  }

  private estimateAttachmentBytes(attachment: BotStreamConnectionAttachment): number {
    return JSON.stringify(attachment).length;
  }

  private sendAppendAck(ws: WebSocket, ackSeq: number): void {
    ws.send(JSON.stringify(buildBotStreamAppendAck({ ack_seq: ackSeq })));
  }

  private sendStreamError(ws: WebSocket, code: string, message: string, retryable: boolean): void {
    ws.send(JSON.stringify(buildBotStreamError({ code, message, retryable })));
  }

  private ensureStreamState(
    channelId: string,
    messageId: string,
    botId: string,
    expiresAt: string,
  ): StreamStateRow | null {
    const existing = this.loadStreamState(channelId, messageId);
    if (existing) return existing;
    if (!expiresAt) return null;

    const now = nowIso();
    this.ctx.storage.sql.exec(
      `INSERT INTO stream_state (
        channel_id, message_id, bot_id, status, ack_seq, flushed_text,
        pending_bytes, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'streaming', 0, '', 0, ?, ?, ?)
      ON CONFLICT(channel_id, message_id) DO NOTHING`,
      channelId,
      messageId,
      botId,
      expiresAt,
      now,
      now,
    );
    const created = this.loadStreamState(channelId, messageId);
    if (created) {
      this.scheduleStreamExpiry(created.expires_at);
    }
    return created;
  }

  private loadStreamState(channelId: string, messageId: string): StreamStateRow | null {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT channel_id, message_id, bot_id, status, ack_seq, flushed_text, pending_bytes, expires_at, created_at, updated_at FROM stream_state WHERE channel_id=? AND message_id=?",
        channelId,
        messageId,
      )
      .toArray()[0] as StreamStateRow | undefined;
    return row ?? null;
  }

  private attachmentFromState(row: StreamStateRow, botId: string): BotStreamConnectionAttachment {
    const ackSeq = Number(row.ack_seq);
    const nowMs = Date.now();
    return {
      channel_id: row.channel_id,
      message_id: row.message_id,
      bot_id: botId,
      pending_text: "",
      pending_start_seq: null,
      pending_end_seq: ackSeq,
      received_seq: ackSeq,
      recent_unacked_hashes: {},
      fanout_pending_text: "",
      fanout_end_seq: ackSeq,
      fanout_due_at_ms: 0,
      last_flush_at_ms: nowMs,
      expires_at: row.expires_at,
    };
  }
}
