import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { BOT_STREAM_API_VERSION } from "../contract/bot-stream";
import {
  buildBotStreamPong,
  buildBotStreamReady,
  parseBotStreamHello,
  parseBotStreamPing,
} from "../chat/bot-stream-protocol";
import { handleSchemaVersionRequest } from "./sql-migrations";
import { migrateBotStreamConnectionSchema } from "./migrations/bot-stream-connection";
import { requireTestOnly } from "./do-errors";

export interface BotStreamConnectionAttachment {
  channel_id: string;
  message_id: string;
  bot_id: string;
  pending_text: string;
  pending_start_seq: number | null;
  pending_end_seq: number;
  received_seq: number;
  recent_unacked_hashes: Map<number, string>;
  fanout_pending_text: string;
  fanout_due_at_ms: number;
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
      const sockets = this.ctx.getWebSockets();
      return Response.json({ stream_state: rows, websocket_count: sockets.length });
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
      } catch {
        return new Response("invalid payload", { status: 400 });
      }
      if (
        typeof body.channel_id !== "string" ||
        typeof body.message_id !== "string" ||
        typeof body.bot_id !== "string"
      ) {
        return new Response("missing channel_id/message_id/bot_id", { status: 400 });
      }
      const now = new Date().toISOString();
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
    if (row.status !== "streaming") {
      return new Response("stream not active", { status: 409 });
    }

    const attachment = this.attachmentFromState(row, botId);
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
      if (parseBotStreamHello(message)) {
        ws.send(
          JSON.stringify(
            buildBotStreamReady({
              channel_id: attachment.channel_id,
              message_id: attachment.message_id,
              expires_at: attachment.expires_at,
              ack_seq: attachment.received_seq,
            }),
          ),
        );
        return;
      }
      if (parseBotStreamPing(message)) {
        ws.send(JSON.stringify(buildBotStreamPong()));
      }
    } catch {
      // append/finalize handling lands in later tasks
    }
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // disconnect alone does not abandon — expiry task handles cleanup
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "stream websocket error");
    } catch {
      // socket may already be closed
    }
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

    const now = new Date().toISOString();
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
    return this.loadStreamState(channelId, messageId);
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
    return {
      channel_id: row.channel_id,
      message_id: row.message_id,
      bot_id: botId,
      pending_text: "",
      pending_start_seq: null,
      pending_end_seq: ackSeq,
      received_seq: ackSeq,
      recent_unacked_hashes: new Map(),
      fanout_pending_text: "",
      fanout_due_at_ms: 0,
      expires_at: row.expires_at,
    };
  }
}
