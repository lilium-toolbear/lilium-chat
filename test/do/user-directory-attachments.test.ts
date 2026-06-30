import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, fakeS3PublicPath } from "../helpers";
import { PUBLIC_OBJECT_CACHE_CONTROL, setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";
import type { UserDirectory } from "../../src/do/user-directory";

function udStub(userId: string) {
  return getNamedDo<UserDirectory>(env.USER_DIRECTORY, userId);
}

async function expectRemoteCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ${code}`);
  } catch (err) {
    expect((err as { remote?: unknown }).remote).toBe(true);
    expect((err as { code?: unknown }).code).toBe(code);
  }
}

async function presign(
  stub: ReturnType<typeof udStub>,
  userId: string,
  idempotencyKey: string,
  opts: { filename?: string; mime_type?: string; size_bytes?: number; width?: number; height?: number; blurhash?: string } = {},
) {
  return stub.presignUpload(userId, idempotencyKey, "attachment", {
    filename: opts.filename ?? "img.png",
    mime_type: opts.mime_type ?? "image/png",
    size_bytes: opts.size_bytes ?? 12345,
    width: opts.width ?? 512,
    height: opts.height ?? 512,
    blurhash: opts.blurhash ?? "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
  });
}

describe("UserDirectory attachment presign + finalize", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("presign creates a pending attachment and returns a PUT URL", async () => {
    const stub = udStub("u-presign-1");
    const body = await presign(stub, "u-presign-1", "idem-presign-1");
    expect(body.attachment_id).toBeTruthy();
    expect(body.upload_method).toBe("PUT");
    expect(body.upload_url).toContain("s3.kuma.homes");
    expect(body.upload_url).toContain(`chat/attachments/${body.attachment_id}.png`);
    expect(body.upload_headers["Content-Type"]).toBe("image/png");
    expect(body.upload_headers["Cache-Control"]).toBe(PUBLIC_OBJECT_CACHE_CONTROL);
    expect(body.expires_at).toBeTruthy();
  });

  it("presign is idempotent (same key + body returns cached response)", async () => {
    const stub = udStub("u-presign-2");
    const key = "idem-presign-2";
    const r1 = await presign(stub, "u-presign-2", key);
    const r2 = await presign(stub, "u-presign-2", key);
    expect(r1).toEqual(r2);
  });

  it("presign rejects reused idempotency key with different body", async () => {
    const stub = udStub("u-presign-3");
    const key = "idem-presign-3";
    const r1 = await presign(stub, "u-presign-3", key, { filename: "a.png" });
    expect(r1.attachment_id).toBeTruthy();
    await expectRemoteCode(
      () => presign(stub, "u-presign-3", key, { filename: "b.png" }),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("presign rejects unsupported mime type", async () => {
    const stub = udStub("u-presign-4");
    await expectRemoteCode(() => presign(stub, "u-presign-4", "idem-presign-4", { mime_type: "application/pdf" }), "UNSUPPORTED_ATTACHMENT_TYPE");
  });

  it("presign rejects oversized attachment", async () => {
    const stub = udStub("u-presign-5");
    await expectRemoteCode(() => presign(stub, "u-presign-5", "idem-presign-5", { size_bytes: 21 * 1024 * 1024 }), "ATTACHMENT_TOO_LARGE");
  });

  it("finalize verifies S3 HEAD and returns attachment projection with blurhash", async () => {
    const userId = "u-finalize-1";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-finalize-1");
    const presignBody = presignRes;
    fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });

    const body = await stub.finalizeUpload(userId, "idem-finalize-1a", { attachment_id: presignBody.attachment_id, etag: '"x"' });
    expect(body.attachment.attachment_id).toBe(presignBody.attachment_id);
    expect(body.attachment.url).toContain("s3.kuma.homes");
    expect(body.attachment.mime_type).toBe("image/png");
    expect(body.attachment.blurhash).toBe("LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB");
  });

  it("finalize is idempotent", async () => {
    const userId = "u-finalize-2";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-finalize-2");
    const presignBody = presignRes;
    fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });
    const key = "idem-finalize-2a";

    const r1 = await stub.finalizeUpload(userId, key, { attachment_id: presignBody.attachment_id });

    const r2 = await stub.finalizeUpload(userId, key, { attachment_id: presignBody.attachment_id });
    expect(r1).toEqual(r2);
  });

  it("finalize returns 415 when S3 object is missing", async () => {
    const userId = "u-finalize-3";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-finalize-3");
    const presignBody = presignRes;
    // do not register the object in fake S3
    await expectRemoteCode(() => stub.finalizeUpload(userId, "idem-finalize-3a", { attachment_id: presignBody.attachment_id }), "UNSUPPORTED_ATTACHMENT_TYPE");
  });

  it("finalize returns 415 for a non-existent attachment_id", async () => {
    const userId = "u-finalize-missing";
    const stub = udStub(userId);
    await expectRemoteCode(() => stub.finalizeUpload(userId, "idem-finalize-missing", { attachment_id: "does-not-exist" }), "UNSUPPORTED_ATTACHMENT_TYPE");
  });

  it("attachment-get returns finalized attachment projection", async () => {
    const userId = "u-get-1";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-get-1");
    const presignBody = presignRes;
    fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });

    await stub.finalizeUpload(userId, "idem-get-1a", { attachment_id: presignBody.attachment_id });

    const body = await stub.getAttachment(userId, presignBody.attachment_id);
    expect(body.attachment.attachment_id).toBe(presignBody.attachment_id);
  });

  it("attachment-get returns 415 for a pending attachment", async () => {
    const userId = "u-get-2";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-get-2");
    const presignBody = presignRes;
    await expectRemoteCode(() => stub.getAttachment(userId, presignBody.attachment_id), "UNSUPPORTED_ATTACHMENT_TYPE");
  });

  it("alarm GC deletes expired pending attachments", async () => {
    const userId = "u-gc-1";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-gc-1");
    const presignBody = presignRes;

    const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test") as {
      runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
      runDurableObjectAlarm: (stub: unknown) => Promise<void>;
    };

    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (instance as { ctx: { storage: { sql: { exec: (query: string, ...params: unknown[]) => void } } } }).ctx.storage.sql;
      sql.exec("UPDATE pending_attachments SET expires_at=? WHERE attachment_id=?", "2000-01-01T00:00:00.000Z", presignBody.attachment_id);
    });

    await runDurableObjectAlarm(stub);

    let gone = false;
    await runInDurableObject(stub, async (instance: unknown) => {
      const rows = (instance as { ctx: { storage: { sql: { exec: (query: string, ...params: unknown[]) => { toArray: () => Array<unknown> } } } } }).ctx.storage.sql
        .exec("SELECT 1 FROM pending_attachments WHERE attachment_id=?", presignBody.attachment_id)
        .toArray();
      gone = rows.length === 0;
    });
    expect(gone).toBe(true);
  });

  it("presign creates a pending avatar upload under chat/avatars", async () => {
    const stub = udStub("u-avatar-1");
    const body = await stub.presignUpload("u-avatar-1", "idem-avatar-1", "avatar", {
      filename: "avatar.png",
      mime_type: "image/png",
      size_bytes: 12345,
    });
    expect(body.upload_url).toContain(`chat/avatars/${body.attachment_id}.png`);
  });
});
