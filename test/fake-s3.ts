import type { S3Client } from "../src/s3/presign";
import { s3WeedPathname } from "../src/s3/url";
import { TEST_S3_BUCKET } from "./helpers";

/** In-memory S3 stub; HEAD resolves clean browser paths to weed path-style keys. */
export class FakeS3 implements S3Client {
  objects = new Map<string, { contentType: string; contentLength: number }>();

  async sign(input: string | URL, init?: RequestInit & { aws?: { signQuery?: boolean; allHeaders?: boolean } }): Promise<Request> {
    const url = new URL(input instanceof URL ? input.toString() : input);
    url.searchParams.set("X-Amz-Fake", "signed");
    return new Request(url, init);
  }

  weedPathname(pathname: string): string {
    if (pathname.startsWith(`/${TEST_S3_BUCKET}/`)) return pathname;
    return s3WeedPathname(TEST_S3_BUCKET, pathname.replace(/^\//, ""));
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const u = new URL(input instanceof Request ? input.url : input.toString());
    const method = input instanceof Request ? input.method : (init?.method ?? "GET");
    if (method === "HEAD") {
      const obj = this.objects.get(this.weedPathname(u.pathname));
      if (!obj) return new Response("Not Found", { status: 404 });
      return new Response(new ArrayBuffer(0), {
        status: 200,
        headers: {
          "Content-Type": obj.contentType,
          "Content-Length": String(obj.contentLength),
        },
      });
    }
    return new Response("ok", { status: 200 });
  }
}
