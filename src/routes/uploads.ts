import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { uuidv7 } from "../ids/uuidv7";

export async function presignUploadHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id: userId } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => null)) as {
    filename?: string;
    mime_type?: string;
    size_bytes?: number;
    width?: number;
    height?: number;
    blurhash?: string;
  } | null;
  if (!body || typeof body.filename !== "string" || typeof body.mime_type !== "string" || typeof body.size_bytes !== "number") {
    throw new ApiError("INVALID_MESSAGE", "filename, mime_type and size_bytes are required");
  }

  const stub = c.env.USER_DIRECTORY.getByName(userId);
  const res = await stub.fetch(
    new Request("https://x/internal/attachment-presign", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Idempotency-Key": idempotencyKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: body.filename,
        mime_type: body.mime_type,
        size_bytes: body.size_bytes,
        width: body.width ?? null,
        height: body.height ?? null,
        blurhash: body.blurhash ?? null,
      }),
    }),
  );

  if (res.status === 415) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(e.error?.code ?? "UNSUPPORTED_ATTACHMENT_TYPE", e.error?.message ?? "unsupported attachment type", { httpStatus: 415 });
  }
  if (res.status === 413) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(e.error?.code ?? "PAYLOAD_TOO_LARGE", e.error?.message ?? "attachment too large", { httpStatus: 413 });
  }
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "upload presign failed");

  const out = await res.json() as Record<string, unknown>;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function finalizeUploadHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id: userId } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  const attachmentId = c.req.param("attachment_id") ?? "";
  if (!attachmentId) throw new ApiError("INVALID_MESSAGE", "attachment_id is required");

  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => ({}))) as { etag?: string };
  const stub = c.env.USER_DIRECTORY.getByName(userId);
  const res = await stub.fetch(
    new Request("https://x/internal/attachment-finalize", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Idempotency-Key": idempotencyKey, "Content-Type": "application/json" },
      body: JSON.stringify({ attachment_id: attachmentId, etag: body.etag ?? undefined }),
    }),
  );

  if (res.status === 409) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError("IDEMPOTENCY_CONFLICT", e.error?.message ?? "idempotency conflict");
  }
  if (res.status === 415) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(e.error?.code ?? "UNSUPPORTED_ATTACHMENT_TYPE", e.error?.message ?? "attachment not finalized", { httpStatus: 415 });
  }
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "upload finalize failed");

  const out = await res.json() as Record<string, unknown>;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
