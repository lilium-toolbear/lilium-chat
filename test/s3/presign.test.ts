import { describe, it, expect, beforeEach } from "vitest";
import { presignPutUrl, headObject, setTestS3Client, type S3Client } from "../../src/s3/presign";
import type { Env } from "../../src/env";

class FakeS3 implements S3Client {
  objects = new Map<string, { contentType: string; contentLength: number }>();

  async sign(input: string | URL, init?: RequestInit & { aws?: any }): Promise<Request> {
    const url = new URL(input instanceof URL ? input.toString() : input);
    url.searchParams.set("X-Amz-Fake", "signed");
    return new Request(url, init);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const u = new URL(input instanceof Request ? input.url : input.toString());
    const method = input instanceof Request ? input.method : (init?.method ?? "GET");
    if (method === "HEAD") {
      const obj = this.objects.get(u.pathname);
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

function makeEnv(): Pick<Env, "S3_ENDPOINT" | "S3_BUCKET" | "S3_REGION"> {
  return {
    S3_ENDPOINT: "https://s3.kuma.homes",
    S3_BUCKET: "lilium-chat-attachments",
    S3_REGION: "us-east-1",
  };
}

describe("S3 presign helpers", () => {
  beforeEach(() => setTestS3Client(new FakeS3()));

  it("presignPutUrl returns a signed PUT URL + expiry with X-Amz-Expires in query", async () => {
    const r = await presignPutUrl(makeEnv() as Env, "chat/img-1", "image/png", 12345);
    const u = new URL(r.upload_url);
    expect(u.host).toBe("s3.kuma.homes");
    expect(u.pathname).toBe("/lilium-chat-attachments/chat/img-1");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.get("X-Amz-Fake")).toBe("signed");
    expect(r.expires_at).toBeTruthy();
  });

  it("headObject returns ok when object matches", async () => {
    const fake = new FakeS3();
    fake.objects.set("/lilium-chat-attachments/chat/img-1", { contentType: "image/png", contentLength: 12345 });
    setTestS3Client(fake);
    const r = await headObject(
      makeEnv() as Env,
      "https://s3.kuma.homes/lilium-chat-attachments/chat/img-1",
      "image/png",
      12345,
    );
    expect(r.ok).toBe(true);
    expect(r.contentType).toBe("image/png");
    expect(r.contentLength).toBe(12345);
  });

  it("headObject returns ok=false for missing object", async () => {
    const r = await headObject(
      makeEnv() as Env,
      "https://s3.kuma.homes/lilium-chat-attachments/missing",
      "image/png",
      12345,
    );
    expect(r.ok).toBe(false);
  });

  it("headObject returns ok=false when Content-Length mismatches", async () => {
    const fake = new FakeS3();
    fake.objects.set("/lilium-chat-attachments/chat/img-1", { contentType: "image/png", contentLength: 999 });
    setTestS3Client(fake);
    const r = await headObject(
      makeEnv() as Env,
      "https://s3.kuma.homes/lilium-chat-attachments/chat/img-1",
      "image/png",
      12345,
    );
    expect(r.ok).toBe(false);
    expect(r.contentLength).toBe(999);
  });

  it("headObject returns ok=false when Content-Type mismatches", async () => {
    const fake = new FakeS3();
    fake.objects.set("/lilium-chat-attachments/chat/img-1", { contentType: "image/jpeg", contentLength: 12345 });
    setTestS3Client(fake);
    const r = await headObject(
      makeEnv() as Env,
      "https://s3.kuma.homes/lilium-chat-attachments/chat/img-1",
      "image/png",
      12345,
    );
    expect(r.ok).toBe(false);
    expect(r.contentType).toBe("image/jpeg");
  });
});
