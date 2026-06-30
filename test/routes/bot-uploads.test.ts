import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { hashBotToken } from "../../src/auth/bot";
import { PUBLIC_OBJECT_CACHE_CONTROL, setTestS3Client } from "../../src/s3/presign";
import { createTestChannel, fakeS3PublicPath, getNamedDo } from "../helpers";
import { FakeS3 } from "../fake-s3";
import type { ChatChannel } from "../../src/do/chat-channel";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown) => Promise<Response> | Response;
};

const REGISTRY = () =>
  getNamedDo(env.BOT_REGISTRY as unknown as DurableObjectNamespace, "registry");

const seededBotIds = new Set<string>();

async function withRegistry(
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(REGISTRY(), async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function withChannel(
  channelId: string,
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  const stub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL, channelId);
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function seedBot(opts: {
  botId: string;
  token: string;
  scopes?: string[];
}): Promise<void> {
  const tokenHash = await hashBotToken(opts.token);
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      opts.botId,
      "owner-1",
      "Upload Bot",
      null,
      null,
      "private",
      "active",
      "2026-06-30T00:00:00.000Z",
      "2026-06-30T00:00:00.000Z",
    );
    ctx.storage.sql.exec(
      `INSERT INTO bot_tokens (token_id, bot_id, name, token_hash, scopes_json, created_at, expires_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      opts.botId,
      "default",
      tokenHash,
      JSON.stringify(opts.scopes ?? ["chat:messages:write"]),
      "2026-06-30T00:00:00.000Z",
      null,
      null,
      null,
    );
  });
  seededBotIds.add(opts.botId);
}

async function seedBotBinding(channelId: string, botId: string, userId: string): Promise<void> {
  await withChannel(channelId, (ctx) => {
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

afterEach(async () => {
  for (const botId of seededBotIds) {
    await withRegistry((ctx) => {
      ctx.storage.sql.exec("DELETE FROM bot_tokens WHERE bot_id=?", botId);
      ctx.storage.sql.exec("DELETE FROM bot_apps WHERE bot_id=?", botId);
    });
  }
  seededBotIds.clear();
});

async function botReq(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  idemKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  return SELF.fetch(new Request(`https://chat.kuma.homes${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }), env);
}

describe("POST /api/chat/bot/channels/:channel_id/uploads/images/presign", () => {
  let fake: FakeS3;

  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("returns an upload URL and attachment_id for an installed bot", async () => {
    const botId = `bot-upload-${crypto.randomUUID()}`;
    const token = `tok-${botId}`;
    const channelId = crypto.randomUUID();
    const ownerId = `owner-${crypto.randomUUID()}`;
    await createTestChannel(env, { channelId, ownerId });
    await seedBot({ botId, token });
    await seedBotBinding(channelId, botId, ownerId);

    const res = await botReq(token, "POST", `/api/chat/bot/channels/${channelId}/uploads/images/presign`, {
      filename: "test.png",
      mime_type: "image/png",
      size_bytes: 12345,
      width: 512,
      height: 512,
    }, "idem-bot-presign-1");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachment_id: string;
      upload_url: string;
      upload_method: string;
      upload_headers: { "Content-Type": string; "Cache-Control": string };
      expires_at: string;
    };
    expect(body.attachment_id).toBeTruthy();
    expect(body.upload_method).toBe("PUT");
    expect(body.upload_url).toContain("s3.kuma.homes");
    expect(body.upload_headers["Content-Type"]).toBe("image/png");
    expect(body.upload_headers["Cache-Control"]).toBe(PUBLIC_OBJECT_CACHE_CONTROL);
  });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/bot/channels/ch-1/uploads/images/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "x.png", mime_type: "image/png", size_bytes: 1 }),
    }), env);
    expect(res.status).toBe(401);
  });

  it("returns 403 when bot is not installed in channel", async () => {
    const botId = `bot-no-bind-${crypto.randomUUID()}`;
    const token = `tok-${botId}`;
    const channelId = crypto.randomUUID();
    await createTestChannel(env, { channelId, ownerId: `owner-${crypto.randomUUID()}` });
    await seedBot({ botId, token });

    const res = await botReq(token, "POST", `/api/chat/bot/channels/${channelId}/uploads/images/presign`, {
      filename: "test.png",
      mime_type: "image/png",
      size_bytes: 12345,
    }, "idem-bot-presign-2");
    expect(res.status).toBe(403);
  });
});

describe("POST /api/chat/bot/channels/:channel_id/uploads/images/:attachment_id/finalize", () => {
  let fake: FakeS3;

  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  async function presign(channelId: string, token: string): Promise<{ attachment_id: string }> {
    const res = await botReq(token, "POST", `/api/chat/bot/channels/${channelId}/uploads/images/presign`, {
      filename: "test.png",
      mime_type: "image/png",
      size_bytes: 12345,
    }, `idem-${channelId}-presign`);
    expect(res.status).toBe(200);
    return (await res.json()) as { attachment_id: string };
  }

  it("finalizes a uploaded image and returns the projection", async () => {
    const botId = `bot-finalize-${crypto.randomUUID()}`;
    const token = `tok-${botId}`;
    const channelId = crypto.randomUUID();
    const ownerId = `owner-${crypto.randomUUID()}`;
    await createTestChannel(env, { channelId, ownerId });
    await seedBot({ botId, token });
    await seedBotBinding(channelId, botId, ownerId);

    const { attachment_id } = await presign(channelId, token);
    fake.objects.set(fakeS3PublicPath(attachment_id), { contentType: "image/png", contentLength: 12345 });

    const res = await botReq(token, "POST", `/api/chat/bot/channels/${channelId}/uploads/images/${attachment_id}/finalize`, {
      etag: '"abc"',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachment: { attachment_id: string; mime_type: string; kind: string } };
    expect(body.attachment.attachment_id).toBe(attachment_id);
    expect(body.attachment.mime_type).toBe("image/png");
    expect(body.attachment.kind).toBe("image");
    expect((body.attachment as Record<string, unknown>).storage_key).toBeUndefined();
  });

  it("returns 415 when the S3 object is missing", async () => {
    const botId = `bot-finalize-miss-${crypto.randomUUID()}`;
    const token = `tok-${botId}`;
    const channelId = crypto.randomUUID();
    const ownerId = `owner-${crypto.randomUUID()}`;
    await createTestChannel(env, { channelId, ownerId });
    await seedBot({ botId, token });
    await seedBotBinding(channelId, botId, ownerId);

    const { attachment_id } = await presign(channelId, token);

    const res = await botReq(token, "POST", `/api/chat/bot/channels/${channelId}/uploads/images/${attachment_id}/finalize`, {});
    expect(res.status).toBe(415);
  });
});
