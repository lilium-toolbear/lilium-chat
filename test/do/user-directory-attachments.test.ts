import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, fakeS3PublicPath } from "../helpers";
import { setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";

function udStub(userId: string) {
  return getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], userId);
}

async function presign(
  stub: ReturnType<typeof udStub>,
  userId: string,
  idempotencyKey: string,
  opts: { filename?: string; mime_type?: string; size_bytes?: number; width?: number; height?: number; blurhash?: string } = {},
) {
  const res = await stub.fetch(
    new Request("https://x/internal/attachment-presign", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Idempotency-Key": idempotencyKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: opts.filename ?? "img.png",
        mime_type: opts.mime_type ?? "image/png",
        size_bytes: opts.size_bytes ?? 12345,
        width: opts.width ?? 512,
        height: opts.height ?? 512,
        blurhash: opts.blurhash ?? "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
      }),
    }),
  );
  return res;
}

describe("UserDirectory attachment presign + finalize", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("presign creates a pending attachment and returns a PUT URL", async () => {
    const stub = udStub("u-presign-1");
    const res = await presign(stub, "u-presign-1", "idem-presign-1");
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

  it("presign is idempotent (same key + body returns cached response)", async () => {
    const stub = udStub("u-presign-2");
    const key = "idem-presign-2";
    const r1 = await presign(stub, "u-presign-2", key);
    const b1 = await r1.json();
    const r2 = await presign(stub, "u-presign-2", key);
    const b2 = await r2.json();
    expect(b1).toEqual(b2);
  });

  it("presign rejects reused idempotency key with different body", async () => {
    const stub = udStub("u-presign-3");
    const key = "idem-presign-3";
    const r1 = await presign(stub, "u-presign-3", key, { filename: "a.png" });
    expect(r1.status).toBe(200);
    const r2 = await presign(stub, "u-presign-3", key, { filename: "b.png" });
    expect(r2.status).toBe(409);
    const b2 = (await r2.json()) as { error: { code: string } };
    expect(b2.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("presign rejects unsupported mime type", async () => {
    const stub = udStub("u-presign-4");
    const res = await presign(stub, "u-presign-4", "idem-presign-4", { mime_type: "application/pdf" });
    expect(res.status).toBe(415);
  });

  it("presign rejects oversized attachment", async () => {
    const stub = udStub("u-presign-5");
    const res = await presign(stub, "u-presign-5", "idem-presign-5", { size_bytes: 21 * 1024 * 1024 });
    expect(res.status).toBe(413);
  });

  it("finalize verifies S3 HEAD and returns attachment projection with blurhash", async () => {
    const userId = "u-finalize-1";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-finalize-1");
    const presignBody = (await presignRes.json()) as { attachment_id: string; upload_url: string };
    fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });

    const res = await stub.fetch(
      new Request("https://x/internal/attachment-finalize", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Idempotency-Key": "idem-finalize-1a", "Content-Type": "application/json" },
        body: JSON.stringify({ attachment_id: presignBody.attachment_id, etag: '"x"' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachment: { attachment_id: string; url: string; mime_type: string; blurhash: string } };
    expect(body.attachment.attachment_id).toBe(presignBody.attachment_id);
    expect(body.attachment.url).toContain("s3.kuma.homes");
    expect(body.attachment.mime_type).toBe("image/png");
    expect(body.attachment.blurhash).toBe("LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB");
  });

  it("finalize is idempotent", async () => {
    const userId = "u-finalize-2";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-finalize-2");
    const presignBody = (await presignRes.json()) as { attachment_id: string; upload_url: string };
    fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });
    const key = "idem-finalize-2a";

    const r1 = await stub.fetch(
      new Request("https://x/internal/attachment-finalize", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Idempotency-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ attachment_id: presignBody.attachment_id }),
      }),
    );
    expect(r1.status).toBe(200);
    const b1 = await r1.json();

    const r2 = await stub.fetch(
      new Request("https://x/internal/attachment-finalize", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Idempotency-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ attachment_id: presignBody.attachment_id }),
      }),
    );
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b1).toEqual(b2);
  });

  it("finalize returns 415 when S3 object is missing", async () => {
    const userId = "u-finalize-3";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-finalize-3");
    const presignBody = (await presignRes.json()) as { attachment_id: string };
    // do not register the object in fake S3
    const res = await stub.fetch(
      new Request("https://x/internal/attachment-finalize", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Idempotency-Key": "idem-finalize-3a", "Content-Type": "application/json" },
        body: JSON.stringify({ attachment_id: presignBody.attachment_id }),
      }),
    );
    expect(res.status).toBe(415);
  });

  it("finalize returns 415 for a non-existent attachment_id", async () => {
    const userId = "u-finalize-missing";
    const stub = udStub(userId);
    const res = await stub.fetch(
      new Request("https://x/internal/attachment-finalize", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Idempotency-Key": "idem-finalize-missing", "Content-Type": "application/json" },
        body: JSON.stringify({ attachment_id: "does-not-exist" }),
      }),
    );
    expect(res.status).toBe(415);
  });

  it("attachment-get returns finalized attachment projection", async () => {
    const userId = "u-get-1";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-get-1");
    const presignBody = (await presignRes.json()) as { attachment_id: string; upload_url: string };
    fake.objects.set(fakeS3PublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });

    await stub.fetch(
      new Request("https://x/internal/attachment-finalize", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Idempotency-Key": "idem-get-1a", "Content-Type": "application/json" },
        body: JSON.stringify({ attachment_id: presignBody.attachment_id }),
      }),
    );

    const res = await stub.fetch(
      new Request(`https://x/internal/attachment-get?attachment_id=${presignBody.attachment_id}`, {
        headers: { "X-Verified-User-Id": userId },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachment: { attachment_id: string } };
    expect(body.attachment.attachment_id).toBe(presignBody.attachment_id);
  });

  it("attachment-get returns 415 for a pending attachment", async () => {
    const userId = "u-get-2";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-get-2");
    const presignBody = (await presignRes.json()) as { attachment_id: string };
    const res = await stub.fetch(
      new Request(`https://x/internal/attachment-get?attachment_id=${presignBody.attachment_id}`, {
        headers: { "X-Verified-User-Id": userId },
      }),
    );
    expect(res.status).toBe(415);
  });

  it("alarm GC deletes expired pending attachments", async () => {
    const userId = "u-gc-1";
    const stub = udStub(userId);
    const presignRes = await presign(stub, userId, "idem-gc-1");
    const presignBody = (await presignRes.json()) as { attachment_id: string };

    const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test") as {
      runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
      runDurableObjectAlarm: (stub: unknown) => Promise<void>;
    };

    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (instance as { ctx: { storage: { sql: { exec: (query: string, ...params: unknown[]) => void } } } }).ctx.storage.sql;
      sql.exec("UPDATE pending_attachments SET expires_at=? WHERE attachment_id=?", "2000-01-01T00:00:00.000Z", presignBody.attachment_id);
      await (instance as { schedulePendingAlarm: () => void }).schedulePendingAlarm();
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
    const res = await stub.fetch(
      new Request("https://x/internal/avatar-presign", {
        method: "POST",
        headers: { "X-Verified-User-Id": "u-avatar-1", "Idempotency-Key": "idem-avatar-1", "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "avatar.png",
          mime_type: "image/png",
          size_bytes: 12345,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachment_id: string; upload_url: string };
    expect(body.upload_url).toContain(`chat/avatars/${body.attachment_id}.png`);
  });
});
