import { AwsClient } from "aws4fetch";
import type { Env } from "../env";

function client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION,
    service: "s3",
  });
}

function objectUrl(env: Env, key: string): URL {
  return new URL(`${env.S3_ENDPOINT}/${env.S3_BUCKET}/${key}`);
}

export function publicReadUrl(env: Env, key: string): string {
  return `${env.S3_PUBLIC_BASE}/${env.S3_BUCKET}/${key}`;
}

export interface PresignPutOptions {
  mimeType: string;
  sizeBytes: number;
  expiresSeconds?: number;
}

export async function presignPut(
  env: Env,
  key: string,
  opts: PresignPutOptions,
): Promise<{ url: string; method: "PUT"; headers: Record<string, string> }> {
  const url = objectUrl(env, key);
  url.searchParams.set("X-Amz-Expires", String(opts.expiresSeconds ?? 300));
  const aws = client(env);
  const signed = await aws.sign(url, {
    method: "PUT",
    headers: { "Content-Type": opts.mimeType, "Content-Length": String(opts.sizeBytes) },
    aws: { signQuery: true },
  });
  // signed is a Request; pull the presigned URL string off .url
  return {
    url: new URL(signed.url).toString(),
    method: "PUT",
    headers: { "Content-Type": opts.mimeType },
  };
}

export async function headObject(env: Env, key: string): Promise<{ exists: boolean; contentLength: number | null; contentType: string | null }> {
  const aws = client(env);
  const url = objectUrl(env, key);
  const signed = await aws.sign(url, { method: "HEAD", aws: { signQuery: true } });
  const res = await fetch(signed);
  if (res.status === 404) return { exists: false, contentLength: null, contentType: null };
  if (!res.ok) throw new Error(`headObject ${key} failed: ${res.status}`);
  const cl = res.headers.get("Content-Length");
  return {
    exists: true,
    contentLength: cl ? Number(cl) : null,
    contentType: res.headers.get("Content-Type"),
  };
}

export async function deleteObject(env: Env, key: string): Promise<void> {
  const aws = client(env);
  const url = objectUrl(env, key);
  const signed = await aws.sign(url, { method: "DELETE", aws: { signQuery: true } });
  const res = await fetch(signed, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`deleteObject ${key} failed: ${res.status}`);
}
