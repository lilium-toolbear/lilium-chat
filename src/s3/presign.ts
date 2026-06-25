import type { Env } from "../env";
import { createS3Client, getS3Client, type S3Client } from "./client";

export interface S3EnvLike {
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_REGION: string;
}

export const PRESIGN_TTL_SECONDS = 5 * 60; // 5 minutes

export async function presignPutUrl(
  env: S3EnvLike,
  key: string,
  contentType: string,
  _sizeBytes?: number,
): Promise<{ upload_url: string; expires_at: string }> {
  const client = getS3Client(env as Env);
  const url = new URL(`${env.S3_ENDPOINT}/${env.S3_BUCKET}/${key}`);
  url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));
  const signedReq = await client.sign(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    aws: { signQuery: true, allHeaders: true },
  });
  return {
    upload_url: signedReq.url,
    expires_at: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
  };
}

export async function headObject(
  env: S3EnvLike,
  url: string,
  expectedContentType: string,
  expectedSize: number,
): Promise<{ ok: boolean; contentType?: string; contentLength?: number }> {
  const client = getS3Client(env as Env);
  try {
    const res = await client.fetch(new URL(url), { method: "HEAD" });
    if (!res.ok) return { ok: false };
    const contentType = res.headers.get("Content-Type") ?? undefined;
    const contentLengthRaw = res.headers.get("Content-Length");
    const contentLength = contentLengthRaw ? Number(contentLengthRaw) : 0;
    if (contentType !== expectedContentType) return { ok: false, contentType, contentLength };
    if (contentLength !== expectedSize) return { ok: false, contentType, contentLength };
    return { ok: true, contentType, contentLength };
  } catch {
    return { ok: false };
  }
}

export { createS3Client, getS3Client, setTestS3Client } from "./client";
export type { S3Client };
