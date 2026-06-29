import { describe, it, expect, beforeEach } from "vitest";
import { presignPutUrl, headObjectKey, PUBLIC_OBJECT_CACHE_CONTROL, setTestS3Client } from "../../src/s3/presign";
import { s3WeedPathname } from "../../src/s3/url";
import type { Env } from "../../src/env";
import { FakeS3 } from "../fake-s3";
import { TEST_S3_BUCKET } from "../helpers";

function makeEnv(): Pick<Env, "S3_ENDPOINT" | "S3_BUCKET" | "S3_REGION" | "S3_PUBLIC_BASE"> {
  return {
    S3_ENDPOINT: "https://s3.kuma.homes",
    S3_BUCKET: "s3.kuma.homes",
    S3_PUBLIC_BASE: "https://s3.kuma.homes",
    S3_REGION: "us-east-1",
  };
}

describe("S3 presign helpers", () => {
  beforeEach(() => setTestS3Client(new FakeS3()));

  it("presignPutUrl signs weed path but returns a clean browser PUT URL", async () => {
    let signedPath = "";
    const fake = new FakeS3();
    const baseSign = fake.sign.bind(fake);
    fake.sign = async (input, init) => {
      signedPath = new URL(input instanceof URL ? input.toString() : input).pathname;
      return baseSign(input, init);
    };
    setTestS3Client(fake);

    const r = await presignPutUrl(makeEnv() as Env, "chat/attachments/img-1.png", "image/png", 12345);
    const u = new URL(r.upload_url);
    expect(signedPath).toBe("/s3.kuma.homes/chat/attachments/img-1.png");
    expect(u.host).toBe("s3.kuma.homes");
    expect(u.pathname).toBe("/chat/attachments/img-1.png");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.get("X-Amz-Fake")).toBe("signed");
    expect(r.expires_at).toBeTruthy();
    expect(r.upload_headers).toEqual({
      "Content-Type": "image/png",
      "Cache-Control": PUBLIC_OBJECT_CACHE_CONTROL,
    });
  });

  it("headObjectKey returns ok when object matches via clean HEAD URL", async () => {
    const fake = new FakeS3();
    fake.objects.set(s3WeedPathname(TEST_S3_BUCKET, "chat/attachments/img-1.png"), {
      contentType: "image/png",
      contentLength: 12345,
    });
    setTestS3Client(fake);
    const r = await headObjectKey(makeEnv() as Env, "chat/attachments/img-1.png", "image/png", 12345);
    expect(r.ok).toBe(true);
    expect(r.contentType).toBe("image/png");
    expect(r.contentLength).toBe(12345);
  });

  it("headObjectKey returns ok=false for missing object", async () => {
    const r = await headObjectKey(makeEnv() as Env, "chat/attachments/missing", "image/png", 12345);
    expect(r.ok).toBe(false);
  });

  it("headObjectKey returns ok=false when Content-Length mismatches", async () => {
    const fake = new FakeS3();
    fake.objects.set(s3WeedPathname(TEST_S3_BUCKET, "chat/attachments/img-1.png"), {
      contentType: "image/png",
      contentLength: 999,
    });
    setTestS3Client(fake);
    const r = await headObjectKey(makeEnv() as Env, "chat/attachments/img-1.png", "image/png", 12345);
    expect(r.ok).toBe(false);
    expect(r.contentLength).toBe(999);
  });

  it("headObjectKey returns ok=false when Content-Type mismatches", async () => {
    const fake = new FakeS3();
    fake.objects.set(s3WeedPathname(TEST_S3_BUCKET, "chat/attachments/img-1.png"), {
      contentType: "image/jpeg",
      contentLength: 12345,
    });
    setTestS3Client(fake);
    const r = await headObjectKey(makeEnv() as Env, "chat/attachments/img-1.png", "image/png", 12345);
    expect(r.ok).toBe(false);
    expect(r.contentType).toBe("image/jpeg");
  });
});
