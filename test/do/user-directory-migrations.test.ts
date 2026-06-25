import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { applyBaselineSchema, columnExists } from "../../src/do/sql-migrations";
import {
  USER_DIRECTORY_CURRENT_SCHEMA_VERSION,
  USER_DIRECTORY_LEGACY_BASELINE_SCHEMA,
  migrateUserDirectorySchema,
} from "../../src/do/migrations/user-directory";

function udStub(userId: string) {
  return getNamedDo(env.USER_DIRECTORY as unknown as DurableObjectNamespace, userId);
}

async function withDoState(stub: DurableObjectStub, fn: (ctx: DurableObjectState) => void | Promise<void>): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

describe("UserDirectory migrations", () => {
  it("upgrades legacy schema and preserves existing rows", async () => {
    const userId = `legacy-ud-${crypto.randomUUID()}`;
    const stub = udStub(userId);

    await withDoState(stub, (ctx) => {
      for (const table of ["schema_migrations", "personal_stickers", "pending_attachments", "my_channels"]) {
        ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }

      applyBaselineSchema(ctx, USER_DIRECTORY_LEGACY_BASELINE_SCHEMA);
      ctx.storage.sql.exec(
        `INSERT INTO pending_attachments (
          attachment_id, owner_user_id, kind, filename, mime_type, size_bytes,
          width, height, storage_key, url, status, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "pending-legacy",
        userId,
        "image",
        "legacy.png",
        "image/png",
        100,
        10,
        10,
        "key-pending",
        "https://example.test/pending.png",
        "pending",
        "2999-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      migrateUserDirectorySchema(ctx);

      expect(columnExists(ctx, "pending_attachments", "blurhash")).toBe(true);
      expect(columnExists(ctx, "personal_stickers", "blurhash")).toBe(true);

      const pending = ctx.storage.sql
        .exec("SELECT attachment_id, blurhash FROM pending_attachments WHERE attachment_id=?", "pending-legacy")
        .toArray()[0] as { attachment_id: string; blurhash: string | null } | undefined;
      expect(pending?.attachment_id).toBe("pending-legacy");
      expect(pending?.blurhash).toBeNull();
    });

    const res = await stub.fetch(
      new Request("https://x/internal/schema-version", { headers: { "X-Test-Only": "1" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current_version: number };
    expect(body.current_version).toBe(USER_DIRECTORY_CURRENT_SCHEMA_VERSION);
  });
});
