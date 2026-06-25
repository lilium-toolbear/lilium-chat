import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

function udStub(userId: string) {
  return getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], userId);
}

async function insertSticker(stub: ReturnType<typeof udStub>, values: {
  sticker_id: string;
  user_id: string;
  attachment_id: string;
  url: string;
  mime_type: string;
  width?: number;
  height?: number;
  size_bytes: number;
  created_at: string;
  deleted_at?: string;
}) {
  const { runInDurableObject } = await import("cloudflare:test") as {
    runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
  };
  await runInDurableObject(stub, async (instance: unknown) => {
    const sql = (instance as { ctx: { storage: { sql: { exec: (query: string, ...params: unknown[]) => void } } } }).ctx.storage.sql;
    sql.exec(
      `INSERT INTO personal_stickers (
        sticker_id, user_id, attachment_id, url, mime_type, width, height, size_bytes, created_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values.sticker_id,
      values.user_id,
      values.attachment_id,
      values.url,
      values.mime_type,
      values.width ?? null,
      values.height ?? null,
      values.size_bytes,
      values.created_at,
      values.deleted_at ?? null,
    );
  });
}

describe("UserDirectory personal_stickers + /internal/sticker-resolve", () => {
  it("resolves an owned active sticker", async () => {
    const userId = "u-sticker-resolve-1";
    const stub = udStub(userId);
    await insertSticker(stub, {
      sticker_id: "s1",
      user_id: userId,
      attachment_id: "a1",
      url: "https://s3.kuma.homes/chat/a1",
      mime_type: "image/png",
      width: 128,
      height: 128,
      size_bytes: 4096,
      created_at: "2026-01-01T00:00:00.000Z",
    });

    const res = await stub.fetch(
      new Request("https://x/internal/sticker-resolve?sticker_id=s1", { headers: { "X-Verified-User-Id": userId } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sticker_id: string; attachment_id: string; url: string; width: number; height: number };
    expect(body.sticker_id).toBe("s1");
    expect(body.attachment_id).toBe("a1");
    expect(body.width).toBe(128);
    expect(body.height).toBe(128);
  });

  it("returns 404 for a deleted sticker", async () => {
    const userId = "u-sticker-resolve-2";
    const stub = udStub(userId);
    await insertSticker(stub, {
      sticker_id: "s2",
      user_id: userId,
      attachment_id: "a2",
      url: "https://s3.kuma.homes/chat/a2",
      mime_type: "image/png",
      size_bytes: 4096,
      created_at: "2026-01-01T00:00:00.000Z",
      deleted_at: "2026-01-02T00:00:00.000Z",
    });

    const res = await stub.fetch(
      new Request("https://x/internal/sticker-resolve?sticker_id=s2", { headers: { "X-Verified-User-Id": userId } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("STICKER_NOT_FOUND");
  });

  it("returns 404 for another user's sticker", async () => {
    const ownerId = "u-sticker-resolve-3-owner";
    const otherId = "u-sticker-resolve-3-other";
    const stub = udStub(ownerId);
    await insertSticker(stub, {
      sticker_id: "s3",
      user_id: ownerId,
      attachment_id: "a3",
      url: "https://s3.kuma.homes/chat/a3",
      mime_type: "image/png",
      size_bytes: 4096,
      created_at: "2026-01-01T00:00:00.000Z",
    });

    const res = await stub.fetch(
      new Request("https://x/internal/sticker-resolve?sticker_id=s3", { headers: { "X-Verified-User-Id": otherId } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("STICKER_NOT_FOUND");
  });
});
