import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  CHAT_CHANNEL_BASELINE_SCHEMA,
  CHAT_CHANNEL_CURRENT_SCHEMA_VERSION,
  CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA,
  chatChannelBaseline,
  chatChannelMigrations,
  migrateChatChannelSchema,
} from "../../src/do/chat-channel/data/migrations";
import {
  applyBaselineSchema,
  columnExists,
  migrateSqlite,
  tableExists,
} from "../../src/do/shared/sql-migrations";
import { createTestChannel, expectDoRpcError, fakeS3PublicPath, getNamedDo, readDoSchemaVersion } from "../helpers";
import { setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";
import type { ChatChannel } from "../../src/do/chat-channel";

function chatStub(channelId: string) {
  return getNamedDo<ChatChannel>(env.CHAT_CHANNEL, channelId);
}

async function withDoState(
  stub: DurableObjectStub,
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function seedBotBinding(channelId: string, botId: string, userId: string): Promise<void> {
  await withDoState(chatStub(channelId), (ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO channel_command_bindings (
         channel_id, bot_command_id, bot_id, status, permission_override,
         command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
       ) VALUES (?, ?, ?, 'allowed', NULL, ?, NULL, ?, ?)`,
      channelId,
      `${botId}-cmd`,
      botId,
      JSON.stringify({ bot_command_id: `${botId}-cmd`, name: "upload", aliases: [] }),
      userId,
      new Date().toISOString(),
    );
  });
}

describe("ChatChannel bot attachment RPC", () => {
  let fake: FakeS3;

  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("fresh schema includes bot attachment columns", async () => {
    const channelId = `fresh-bot-att-${crypto.randomUUID()}`;
    const stub = chatStub(channelId);
    await readDoSchemaVersion(stub);

    await withDoState(stub, (ctx) => {
      expect(columnExists(ctx, "attachments", "owner_bot_id")).toBe(true);
      expect(columnExists(ctx, "attachments", "channel_id")).toBe(true);
      expect(columnExists(ctx, "attachments", "expires_at")).toBe(true);
    });
    expect((await readDoSchemaVersion(stub)).current_version).toBe(CHAT_CHANNEL_CURRENT_SCHEMA_VERSION);
  });

  it("migrates legacy attachments table to nullable owner_user_id with bot columns", async () => {
    const channelId = `legacy-bot-att-${crypto.randomUUID()}`;
    const stub = chatStub(channelId);

    await withDoState(stub, (ctx) => {
      for (const table of ["schema_migrations", "attachments", "channel_meta"]) {
        ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      applyBaselineSchema(ctx, CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA);
      ctx.storage.sql.exec(
        `INSERT INTO channel_meta (
          channel_id, kind, visibility, title, topic, avatar_url, status,
          created_by, created_at, updated_at, member_count, membership_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        channelId,
        "group",
        "private",
        "Legacy",
        null,
        null,
        "active",
        "user-1",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        1,
        1,
      );
      ctx.storage.sql.exec(
        `INSERT INTO attachments (
          attachment_id, owner_user_id, kind, filename, mime_type, size_bytes,
          width, height, storage_key, url, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "att-legacy-user",
        "user-1",
        "image",
        "legacy.png",
        "image/png",
        100,
        10,
        10,
        "key-legacy",
        "https://example.test/legacy.png",
        "finalized",
        "2026-01-01T00:00:00.000Z",
      );

      migrateChatChannelSchema(ctx);

      expect(columnExists(ctx, "attachments", "owner_bot_id")).toBe(true);
      expect(columnExists(ctx, "attachments", "channel_id")).toBe(true);
      expect(columnExists(ctx, "attachments", "expires_at")).toBe(true);
      const row = ctx.storage.sql
        .exec("SELECT owner_user_id, owner_bot_id, channel_id FROM attachments WHERE attachment_id=?", "att-legacy-user")
        .toArray()[0] as { owner_user_id: string; owner_bot_id: string | null; channel_id: string | null };
      expect(row.owner_user_id).toBe("user-1");
      expect(row.owner_bot_id).toBeNull();
      expect(row.channel_id).toBeNull();
    });
  });

  it("presign and finalize store channel-scoped bot attachment rows", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = `owner-${crypto.randomUUID()}`;
    const botId = `bot-${crypto.randomUUID()}`;
    const stub = await createTestChannel(env, { channelId, ownerId });
    await seedBotBinding(channelId, botId, ownerId);

    const presign = await stub.botAttachmentPresign({
      channel_id: channelId,
      bot_id: botId,
      idempotency_key: "idem-bot-do-1",
      filename: "img.png",
      mime_type: "image/png",
      size_bytes: 5000,
      width: 100,
      height: 100,
    });
    expect(presign.attachment_id).toBeTruthy();
    expect(presign.upload_url).toContain("s3.kuma.homes");

    fake.objects.set(fakeS3PublicPath(presign.attachment_id), { contentType: "image/png", contentLength: 5000 });

    const finalize = await stub.botAttachmentFinalize({
      channel_id: channelId,
      bot_id: botId,
      attachment_id: presign.attachment_id,
    });
    expect(finalize.attachment.attachment_id).toBe(presign.attachment_id);
    expect(finalize.attachment.kind).toBe("image");

    await withDoState(stub, (ctx) => {
      const row = ctx.storage.sql
        .exec(
          "SELECT owner_user_id, owner_bot_id, channel_id, status, expires_at FROM attachments WHERE attachment_id=?",
          presign.attachment_id,
        )
        .toArray()[0] as {
        owner_user_id: string | null;
        owner_bot_id: string;
        channel_id: string;
        status: string;
        expires_at: string;
      };
      expect(row.owner_user_id).toBeNull();
      expect(row.owner_bot_id).toBe(botId);
      expect(row.channel_id).toBe(channelId);
      expect(row.status).toBe("finalized");
      expect(row.expires_at).toBeTruthy();
    });
  });

  it("presign sets expires_at on pending bot attachments", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = `owner-${crypto.randomUUID()}`;
    const botId = `bot-${crypto.randomUUID()}`;
    const stub = await createTestChannel(env, { channelId, ownerId });
    await seedBotBinding(channelId, botId, ownerId);

    const presign = await stub.botAttachmentPresign({
      channel_id: channelId,
      bot_id: botId,
      idempotency_key: "idem-bot-expires-1",
      filename: "img.png",
      mime_type: "image/png",
      size_bytes: 5000,
    });

    await withDoState(stub, (ctx) => {
      const row = ctx.storage.sql
        .exec("SELECT status, expires_at FROM attachments WHERE attachment_id=?", presign.attachment_id)
        .toArray()[0] as { status: string; expires_at: string };
      expect(row.status).toBe("pending");
      expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now());
    });
  });

  it("alarm GC deletes expired pending bot attachments", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = `owner-${crypto.randomUUID()}`;
    const botId = `bot-${crypto.randomUUID()}`;
    const stub = await createTestChannel(env, { channelId, ownerId });
    await seedBotBinding(channelId, botId, ownerId);

    const presign = await stub.botAttachmentPresign({
      channel_id: channelId,
      bot_id: botId,
      idempotency_key: "idem-bot-gc-1",
      filename: "img.png",
      mime_type: "image/png",
      size_bytes: 5000,
    });
    fake.objects.set(fakeS3PublicPath(presign.attachment_id), { contentType: "image/png", contentLength: 5000 });

    const { runDurableObjectAlarm } = await import("cloudflare:test") as {
      runDurableObjectAlarm: (stub: unknown) => Promise<void>;
    };

    await withDoState(stub, (ctx) => {
      ctx.storage.sql.exec(
        "UPDATE attachments SET expires_at=? WHERE attachment_id=?",
        "2000-01-01T00:00:00.000Z",
        presign.attachment_id,
      );
    });

    await runDurableObjectAlarm(stub);

    let gone = false;
    await withDoState(stub, (ctx) => {
      const rows = ctx.storage.sql
        .exec("SELECT 1 FROM attachments WHERE attachment_id=?", presign.attachment_id)
        .toArray();
      gone = rows.length === 0;
    });
    expect(gone).toBe(true);
  });

  it("rejects presign when bot is not installed in channel", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = `owner-${crypto.randomUUID()}`;
    const botId = `bot-${crypto.randomUUID()}`;
    const stub = await createTestChannel(env, { channelId, ownerId });

    await expectDoRpcError(
      () => stub.botAttachmentPresign({
        channel_id: channelId,
        bot_id: botId,
        idempotency_key: "idem-bot-do-2",
        filename: "img.png",
        mime_type: "image/png",
        size_bytes: 5000,
      }),
      "FORBIDDEN",
    );
  });

  it("rejects finalize when bot does not own the attachment in channel", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = `owner-${crypto.randomUUID()}`;
    const botA = `bot-a-${crypto.randomUUID()}`;
    const botB = `bot-b-${crypto.randomUUID()}`;
    const stub = await createTestChannel(env, { channelId, ownerId });
    await seedBotBinding(channelId, botA, ownerId);
    await seedBotBinding(channelId, botB, ownerId);

    const presign = await stub.botAttachmentPresign({
      channel_id: channelId,
      bot_id: botA,
      idempotency_key: "idem-bot-do-3",
      filename: "img.png",
      mime_type: "image/png",
      size_bytes: 5000,
    });
    fake.objects.set(fakeS3PublicPath(presign.attachment_id), { contentType: "image/png", contentLength: 5000 });

    await expectDoRpcError(
      () => stub.botAttachmentFinalize({
        channel_id: channelId,
        bot_id: botB,
        attachment_id: presign.attachment_id,
      }),
      "FORBIDDEN",
    );
  });

  it("baseline schema defines bot attachment owner check", async () => {
    const channelId = `baseline-check-${crypto.randomUUID()}`;
    const stub = chatStub(channelId);

    await withDoState(stub, (ctx) => {
      ctx.storage.sql.exec("DROP TABLE IF EXISTS schema_migrations");
      applyBaselineSchema(ctx, CHAT_CHANNEL_BASELINE_SCHEMA);
      expect(tableExists(ctx, "attachments")).toBe(true);
      expect(columnExists(ctx, "attachments", "owner_bot_id")).toBe(true);
      expect(columnExists(ctx, "attachments", "channel_id")).toBe(true);

      ctx.storage.sql.exec(
        `INSERT INTO attachments (
          attachment_id, owner_user_id, owner_bot_id, channel_id, kind, filename, mime_type, size_bytes,
          width, height, storage_key, url, status, created_at
        ) VALUES (?, NULL, ?, ?, 'image', 'a.png', 'image/png', 1, 1, 1, 'k', 'https://x/a.png', 'pending', ?)`,
        "att-bot-only",
        "bot-1",
        channelId,
        new Date().toISOString(),
      );
      const count = ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM attachments WHERE attachment_id='att-bot-only'").toArray()[0] as { c: number };
      expect(count.c).toBe(1);
    });
  });

  it("migration idempotency is noop on re-run", async () => {
    const channelId = `idempotent-bot-att-${crypto.randomUUID()}`;
    const stub = chatStub(channelId);
    await readDoSchemaVersion(stub);

    let extraRuns = 0;
    const extra = {
      version: CHAT_CHANNEL_CURRENT_SCHEMA_VERSION + 1,
      name: "count bot att runs",
      up() {
        extraRuns += 1;
      },
    };

    await withDoState(stub, (ctx) => {
      migrateSqlite(ctx, "ChatChannel", chatChannelBaseline, [...chatChannelMigrations, extra]);
      migrateSqlite(ctx, "ChatChannel", chatChannelBaseline, [...chatChannelMigrations, extra]);
    });
    expect(extraRuns).toBe(1);
  });
});
