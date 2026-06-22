import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export interface ConnectionAttachment {
  user_id: string;
  session_id: string;
  per_channel_cursors: Record<string, string>;
}

function parsePerChannelCursors(searchParams: string): Record<string, string> {
  const cursorsParam = searchParams;
  if (!cursorsParam) {
    return {};
  }
  try {
    const normalized = `${cursorsParam.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (cursorsParam.length % 4)) % 4)}`;
    return JSON.parse(atob(normalized)) as Record<string, string>;
  } catch {
    return {};
  }
}

export class UserConnection extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    const userId = request.headers.get("X-Verified-User-Id");
    if (!userId) return new Response("missing verified user", { status: 401 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const sessionId = crypto.randomUUID();
    const per_channel_cursors = parsePerChannelCursors(url.searchParams.get("cursors") ?? "");

    const pair = new WebSocketPair();
    const [client, server] = pair as unknown as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [`user-conn:${userId}`]);
    server.serializeAttachment({ user_id: userId, session_id: sessionId, per_channel_cursors } satisfies ConnectionAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return;
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    return;
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    return;
  }

  async alarm(): Promise<void> {}
}
