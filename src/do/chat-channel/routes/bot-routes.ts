import type { ChatChannelHost } from "../host";
import {
  flushStatefulSessionTimeouts,
  handleBotSessionCloseFromBot,
  handleBotSessionInputAck,
  handleBotSessionStarted,
  handleGetStatefulSession,
  handleStatefulSessionInputs,
  handleStatefulSessionStop,
  type StatefulSessionHost,
} from "../stateful-session-handlers";

function asStatefulHost(host: ChatChannelHost): StatefulSessionHost {
  return host as unknown as StatefulSessionHost;
}

export async function dispatchBotRoutes(host: ChatChannelHost, request: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/internal/command-binding-update") {
    return host.handleCommandBindingUpdate(request);
  }
  if (url.pathname === "/internal/channel-commands") {
    return host.handleChannelCommands(request);
  }
  if (url.pathname === "/internal/command-manifest") {
    return host.handleCommandManifest(request);
  }
  if (url.pathname === "/internal/command-invoke") {
    return host.handleCommandInvoke(request);
  }

  const statefulHost = asStatefulHost(host);

  if (url.pathname === "/internal/stateful-session-inputs" && request.method === "GET") {
    const sessionId = url.searchParams.get("session_id") ?? "";
    if (!sessionId) return new Response("missing session_id", { status: 400 });
    return handleStatefulSessionInputs(statefulHost, sessionId);
  }

  if (url.pathname === "/internal/stateful-session" && request.method === "GET") {
    const channelId = url.searchParams.get("channel_id") ?? "";
    if (!channelId) return new Response("missing channel_id", { status: 400 });
    return handleGetStatefulSession(statefulHost, channelId);
  }

  if (url.pathname === "/internal/stateful-session-stop" && request.method === "POST") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const body = (await request.json().catch(() => null)) as {
      channel_id?: unknown;
      session_id?: unknown;
      reason?: unknown;
    } | null;
    if (!body || typeof body.channel_id !== "string" || typeof body.session_id !== "string") {
      return new Response("invalid payload", { status: 400 });
    }
    return handleStatefulSessionStop(statefulHost, {
      userId,
      channelId: body.channel_id,
      sessionId: body.session_id,
      reason: typeof body.reason === "string" ? body.reason : "admin_stop",
    });
  }

  if (url.pathname === "/internal/bot-session-started" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { session_id?: unknown } | null;
    if (!body || typeof body.session_id !== "string") {
      return new Response("invalid payload", { status: 400 });
    }
    return handleBotSessionStarted(statefulHost, { session_id: body.session_id });
  }

  if (url.pathname === "/internal/bot-session-input-ack" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as {
      session_id?: unknown;
      last_received_seq?: unknown;
    } | null;
    if (!body || typeof body.session_id !== "string" || typeof body.last_received_seq !== "number") {
      return new Response("invalid payload", { status: 400 });
    }
    return handleBotSessionInputAck(statefulHost, {
      session_id: body.session_id,
      last_received_seq: body.last_received_seq,
    });
  }

  if (url.pathname === "/internal/bot-session-close" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as {
      session_id?: unknown;
      reason?: unknown;
    } | null;
    if (!body || typeof body.session_id !== "string") {
      return new Response("invalid payload", { status: 400 });
    }
    return handleBotSessionCloseFromBot(statefulHost, {
      session_id: body.session_id,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    });
  }

  if (url.pathname === "/internal/stateful-session-timeouts" && request.method === "POST") {
    await flushStatefulSessionTimeouts(statefulHost, host.nowIso());
    return Response.json({ ok: true });
  }

  return null;
}
