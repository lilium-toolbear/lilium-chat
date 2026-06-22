import { jwtVerify } from "jose";
import { ApiError } from "../errors";

export interface BrowserIdentity {
  user_id: string;
}

interface JwtPayload {
  sub?: unknown;
  client_id?: unknown;
  managed_session?: unknown;
  owner_user_id?: unknown;
  effective_account_user_id?: unknown;
  [k: string]: unknown;
}

export async function verifyBrowserJwt(token: string, secret: string): Promise<BrowserIdentity> {
  let payload: JwtPayload;
  try {
    const { payload: p } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
    payload = p as JwtPayload;
  } catch {
    throw new ApiError("UNAUTHORIZED", "Invalid or expired token");
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new ApiError("UNAUTHORIZED", "Invalid or expired token");
  }

  if (payload.client_id !== undefined && payload.client_id !== null) {
    throw new ApiError("MACHINE_TOKEN_NOT_ALLOWED", "Machine tokens are not allowed");
  }

  const rejected =
    payload.managed_session === true ||
    (payload.owner_user_id !== undefined && String(payload.owner_user_id) !== sub) ||
    (payload.effective_account_user_id !== undefined && String(payload.effective_account_user_id) !== sub);
  if (rejected) {
    throw new ApiError("SESSION_NOT_ALLOWED", "Chat requires a direct user session");
  }

  return { user_id: sub };
}
