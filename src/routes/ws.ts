import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError, errorResponse } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { uuidv7 } from "../ids/uuidv7";

const ALLOWED_ORIGINS = new Set(["https://lilium.kuma.homes", "http://localhost:5173"]);

interface ParsedSubprotocol {
  api: boolean;
  token: string | null;
}

function parseSubprotocol(header: string | null | undefined): ParsedSubprotocol {
  if (!header) return { api: false, token: null };
  const parts = header.split(",").map((s) => s.trim());
  let api = false;
  let token: string | null = null;
  for (const p of parts) {
    if (p === "lilium.chat.v1") api = true;
    else if (p.startsWith("bearer.")) token = p.slice("bearer.".length);
  }
  return { api, token };
}

export async function wsUpgradeHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const requestId = (c.get("requestId") as string | undefined) ?? `req_${uuidv7()}`;
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(new ApiError("UNAUTHORIZED", "Expected WebSocket upgrade"), requestId);
  }
  const origin = c.req.header("Origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return errorResponse(new ApiError("FORBIDDEN", "origin not allowed"), requestId);
  }
  const { api, token } = parseSubprotocol(c.req.header("Sec-WebSocket-Protocol"));
  if (!api || !token) {
    return errorResponse(new ApiError("UNAUTHORIZED", "missing required subprotocol", { httpStatus: 400 }), requestId);
  }

  let userId: string;
  try {
    const id = await verifyBrowserJwt(token, c.env.JWT_SECRET);
    userId = id.user_id;
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err, requestId);
    return errorResponse(new ApiError("UNAUTHORIZED", "Invalid or expired token"), requestId);
  }

  // Forward the verified user_id to the DO via a header on the proxied request.
  const upstream = new Request(c.req.raw, c.req.raw);
  upstream.headers.set("X-Verified-User-Id", userId);
  const stub = c.env.USER_CONNECTION.getByName(userId);
  return stub.fetch(upstream);
}
