import type { Env } from "../env";
import { getS3Client, isTestS3ClientActive, type S3Client } from "./client";
import { s3BrowserUploadUrl, s3ObjectUrl, s3PublicObjectUrl } from "./url";
import { logSwallowedError } from "../errors";

export interface S3EnvLike {
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_PUBLIC_BASE?: string;
}

export const PRESIGN_TTL_SECONDS = 5 * 60; // 5 minutes

/** Immutable public objects keyed by UUID; safe to cache at browser + CDN for 1 year. */
export const PUBLIC_OBJECT_CACHE_CONTROL = "public, max-age=31536000, immutable";

export async function presignPutUrl(
  env: S3EnvLike,
  key: string,
  contentType: string,
  _sizeBytes?: number,
): Promise<{ upload_url: string; expires_at: string; upload_headers: Record<string, string> }> {
  const client = getS3Client(env as Env);
  const url = s3ObjectUrl(env.S3_ENDPOINT, env.S3_BUCKET, key);
  url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));
  const uploadHeaders = {
    "Content-Type": contentType,
    "Cache-Control": PUBLIC_OBJECT_CACHE_CONTROL,
  };
  const signedReq = await client.sign(url, {
    method: "PUT",
    headers: uploadHeaders,
    aws: { signQuery: true, allHeaders: true },
  });
  return {
    upload_url: s3BrowserUploadUrl(signedReq.url, key),
    expires_at: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
    upload_headers: uploadHeaders,
  };
}

/** HEAD object by storage key via public URL (bucket is public-read; no SigV4). */
export async function headObjectKey(
  env: S3EnvLike,
  key: string,
  expectedContentType: string,
  expectedSize: number,
): Promise<{ ok: boolean; contentType?: string; contentLength?: number }> {
  const headUrl = s3PublicObjectUrl(env.S3_PUBLIC_BASE ?? env.S3_ENDPOINT, key);
  try {
    const res = isTestS3ClientActive()
      ? await getS3Client(env as Env).fetch(headUrl, { method: "HEAD" })
      : await fetch(headUrl, { method: "HEAD" });
    if (!res.ok) return { ok: false };
    const contentType = res.headers.get("Content-Type") ?? undefined;
    const contentLengthRaw = res.headers.get("Content-Length");
    const contentLength = contentLengthRaw ? Number(contentLengthRaw) : 0;
    if (contentType !== expectedContentType) return { ok: false, contentType, contentLength };
    if (contentLength !== expectedSize) return { ok: false, contentType, contentLength };
    return { ok: true, contentType, contentLength };
  } catch (err) {
    logSwallowedError("s3_head_object_failed", err, { key });
    return { ok: false };
  }
}

export async function deleteObject(env: S3EnvLike, key: string): Promise<void> {
  const client = getS3Client(env as Env);
  const url = s3ObjectUrl(env.S3_ENDPOINT, env.S3_BUCKET, key);
  const signedReq = await client.sign(url, {
    method: "DELETE",
    aws: { signQuery: true, allHeaders: true },
  });
  const res = await client.fetch(signedReq);
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    throw new Error(`deleteObject ${key} failed: ${res.status}`);
  }
}

export { createS3Client, getS3Client, setTestS3Client } from "./client";
export type { S3Client };
