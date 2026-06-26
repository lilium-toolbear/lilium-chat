import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET, fakeS3PublicPath } from "../helpers";
import { setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

async function authedReq(userId: string, method: string, path: string, body?: unknown, idemKey?: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await makeJwt({ sub: userId }, TEST_SECRET)}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  return SELF.fetch(new Request(`https://chat.kuma.homes${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

describe("POST /api/chat/uploads/images/presign", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("returns an upload URL and attachment_id", async () => {
    const res = await authedReq("u-upload-1", "POST", "/api/chat/uploads/images/presign", {
      filename: "test.png",
      mime_type: "image/png",
      size_bytes: 12345,
      width: 512,
      height: 512,
      blurhash: "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
    }, "idem-upload-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachment_id: string;
      upload_url: string;
      upload_method: string;
      upload_headers: { "Content-Type": string };
      expires_at: string;
    };
    expect(body.attachment_id).toBeTruthy();
    expect(body.upload_method).toBe("PUT");
    expect(body.upload_url).toContain("s3.kuma.homes");
    expect(body.upload_url).toContain(`chat/attachments/${body.attachment_id}.png`);
    expect(body.upload_headers["Content-Type"]).toBe("image/png");
    expect(body.expires_at).toBeTruthy();
  });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/uploads/images/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "x.png", mime_type: "image/png", size_bytes: 1 }),
    }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
    expect(res.status).toBe(401);
  });

  it("returns 422 for missing fields", async () => {
    const res = await authedReq("u-upload-2", "POST", "/api/chat/uploads/images/presign", {}, "idem-upload-2");
    expect(res.status).toBe(422);
  });
});

describe("POST /api/chat/uploads/images/:attachment_id/finalize", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  async function presign(userId: string): Promise<{ attachment_id: string; upload_url: string }> {
    const res = await authedReq(userId, "POST", "/api/chat/uploads/images/presign", {
      filename: "test.png",
      mime_type: "image/png",
      size_bytes: 12345,
    }, `idem-${userId}-presign`);
    expect(res.status).toBe(200);
    return (await res.json()) as { attachment_id: string; upload_url: string };
  }

  it("finalizes a uploaded image and returns the projection", async () => {
    const userId = "u-finalize-route-1";
    const { attachment_id, upload_url } = await presign(userId);
    fake.objects.set(fakeS3PublicPath(attachment_id), { contentType: "image/png", contentLength: 12345 });

    const res = await authedReq(userId, "POST", `/api/chat/uploads/images/${attachment_id}/finalize`, {}, `idem-${userId}-finalize`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachment: { attachment_id: string; url: string; mime_type: string } };
    expect(body.attachment.attachment_id).toBe(attachment_id);
    expect(body.attachment.mime_type).toBe("image/png");
    expect((body.attachment as Record<string, unknown>).storage_key).toBeUndefined();
  });

  it("returns 415 when the S3 object is missing", async () => {
    const userId = "u-finalize-route-2";
    const { attachment_id } = await presign(userId);
    // intentionally do not register the object in fake S3

    const res = await authedReq(userId, "POST", `/api/chat/uploads/images/${attachment_id}/finalize`, {}, `idem-${userId}-finalize`);
    expect(res.status).toBe(415);
  });
});
