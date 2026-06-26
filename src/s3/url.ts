/** Path-style path SeaweedFS sees after nginx injects the bucket prefix on gina. */
export function s3WeedPathname(bucket: string, objectKey: string): string {
  const b = bucket.replace(/^\//, "").replace(/\/$/, "");
  const key = objectKey.replace(/^\//, "");
  return `/${b}/${key}`;
}

/** Path-style S3 URL for signing: canonical URI matches what weed verifies. */
export function s3ObjectUrl(endpoint: string, bucket: string, objectKey: string): URL {
  const base = endpoint.replace(/\/$/, "");
  return new URL(`${base}${s3WeedPathname(bucket, objectKey)}`);
}

/** Clean public read URL (nginx injects bucket prefix on gina): {publicBase}/{objectKey}. */
export function s3PublicObjectUrl(publicBase: string, objectKey: string): string {
  const base = publicBase.replace(/\/$/, "");
  const key = objectKey.replace(/^\//, "");
  return `${base}/${key}`;
}

/** Browser PUT/HEAD URL: same host/query as signed URL, path without bucket (nginx re-injects prefix). */
export function s3BrowserUploadUrl(signedUrl: string | URL, objectKey: string): string {
  const u = new URL(signedUrl instanceof URL ? signedUrl.toString() : signedUrl);
  u.pathname = `/${objectKey.replace(/^\//, "")}`;
  return u.toString();
}
