import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";

export async function getIdentity(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<{ userId: string; env: Env }> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id } = await verifyBrowserJwt(token, c.env.JWT_SECRET);
  return { userId: user_id, env: c.env };
}

export function requireIdempotencyKey(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): string {
  const key = c.req.header("Idempotency-Key") ?? "";
  if (!key) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  return key;
}
