const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024; // 20 MiB

export type PresignValidation =
  | { ok: false; error: string; code: string }
  | {
      ok: true;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      width: number | undefined;
      height: number | undefined;
      blurhash: string | undefined;
    };

export function validatePresignBody(body: {
  filename?: string;
  mime_type?: string;
  size_bytes?: number;
  width?: number | null;
  height?: number | null;
  blurhash?: string;
}): PresignValidation {
  const filename = body.filename?.trim();
  const mimeType = body.mime_type?.trim().toLowerCase();
  const sizeBytes = body.size_bytes;
  if (!filename) return { ok: false, error: "filename required", code: "INVALID_MESSAGE" };
  if (!mimeType) return { ok: false, error: "mime_type required", code: "INVALID_MESSAGE" };
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    return { ok: false, error: "unsupported attachment type", code: "UNSUPPORTED_ATTACHMENT_TYPE" };
  }
  if (typeof sizeBytes !== "number" || sizeBytes <= 0 || sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    return { ok: false, error: "attachment too large", code: "ATTACHMENT_TOO_LARGE" };
  }
  if (body.width != null && (typeof body.width !== "number" || !Number.isInteger(body.width) || body.width <= 0)) {
    return { ok: false, error: "width must be a positive integer", code: "INVALID_MESSAGE" };
  }
  if (body.height != null && (typeof body.height !== "number" || !Number.isInteger(body.height) || body.height <= 0)) {
    return { ok: false, error: "height must be a positive integer", code: "INVALID_MESSAGE" };
  }
  return {
    ok: true,
    filename,
    mimeType,
    sizeBytes,
    width: body.width ?? undefined,
    height: body.height ?? undefined,
    blurhash: body.blurhash,
  };
}
