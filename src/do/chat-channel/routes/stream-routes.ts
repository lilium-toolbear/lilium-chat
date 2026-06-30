import type { ChatChannelHost } from "../host";
import {
  handleStreamAbandon,
  handleStreamFinalize,
  handleStreamRegistryCheck,
  handleStreamRegistryPeek,
  handleStreamRegistryRegister,
} from "../stream-registry-handlers";

export async function dispatchStreamRoutes(
  host: ChatChannelHost,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/internal/stream-registry-check" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return new Response("invalid payload", { status: 400 });
    return handleStreamRegistryCheck(host, body);
  }

  if (url.pathname === "/internal/stream-registry-peek" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return new Response("invalid payload", { status: 400 });
    return handleStreamRegistryPeek(host, body);
  }

  if (url.pathname === "/internal/stream-registry-register" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return new Response("invalid payload", { status: 400 });
    return handleStreamRegistryRegister(host, body);
  }

  if (url.pathname === "/internal/stream-finalize" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return new Response("invalid payload", { status: 400 });
    return handleStreamFinalize(host, body);
  }

  if (url.pathname === "/internal/stream-abandon" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return new Response("invalid payload", { status: 400 });
    return handleStreamAbandon(host, body);
  }

  return null;
}
