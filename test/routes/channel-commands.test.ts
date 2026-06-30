import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { PLATFORM_HELP_BOT_COMMAND_ID, PLATFORM_PERMISSION_BOT_COMMAND_ID } from "../../src/chat/platform-commands";
import { createTestDmChannel, getNamedDo, makeJwt, TEST_SECRET } from "../helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown) => Promise<Response> | Response;
};

const CHANNEL = (channelId: string) =>
  getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);

const REGISTRY = () =>
  getNamedDo(env.BOT_REGISTRY as unknown as Parameters<typeof getNamedDo>[0], "registry");

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
  await runInDurableObject(CHANNEL(channelId), async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

const seededBotIds = new Set<string>();

async function seedBotCommand(opts: {
  botId: string;
  botCommandId: string;
  displayName: string;
  commandName: string;
  aliases: string[];
}): Promise<void> {
  const now = "2026-06-29T00:00:00.000Z";
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (
         bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, NULL, 'private', 'active', ?, ?)`,
      opts.botId,
      "owner-1",
      opts.displayName,
      now,
      now,
    );
    ctx.storage.sql.exec(
      `INSERT INTO bot_commands (
         bot_command_id, bot_id, name, description, options_json, default_member_permission,
         execution_mode, stateful_config_json, status, schema_version, definition_hash, created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, 'member', 'stateless', NULL, 'active', 1, ?, ?, ?, NULL)`,
      opts.botCommandId,
      opts.botId,
      opts.commandName,
      `Run ${opts.commandName}`,
      "[]",
      `hash-${opts.botCommandId}`,
      now,
      now,
    );
    for (const alias of opts.aliases) {
      ctx.storage.sql.exec(
        "INSERT INTO bot_command_aliases (bot_command_id, bot_id, alias, created_at) VALUES (?, ?, ?, ?)",
        opts.botCommandId,
        opts.botId,
        alias,
        now,
      );
    }
  });
  seededBotIds.add(opts.botId);
}

async function cleanupBot(botId: string): Promise<void> {
  await withRegistry((ctx) => {
    ctx.storage.sql.exec("DELETE FROM bot_command_names WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_command_aliases WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_commands WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_tokens WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_apps WHERE bot_id=?", botId);
  });
  seededBotIds.delete(botId);
}

afterEach(async () => {
  for (const botId of [...seededBotIds]) await cleanupBot(botId);
});

async function browserReq(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  idemKey?: string,
): Promise<Response> {
  const token = await makeJwt({ sub: userId }, TEST_SECRET);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  return SELF.fetch(
    new Request(`https://chat.kuma.homes${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    { ...env, JWT_SECRET: "test-jwt-secret-do-not-use-in-prod" } as typeof env,
  );
}

async function createChannel(ownerId: string, title: string): Promise<string> {
  const res = await browserReq(ownerId, "POST", "/api/chat/channels", {
    title,
    visibility: "private",
    initial_members: [],
  }, `key-create-${ownerId}`);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { channel: { channel_id: string } };
  return body.channel.channel_id;
}

describe("channel command bindings", () => {
  it("admin allow writes snapshot and emits command.binding_updated with manifest delta", async () => {
    const ownerId = `owner-allow-${crypto.randomUUID()}`;
    const botId = `bot-allow-${crypto.randomUUID()}`;
    const botCommandId = `cmd-allow-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Command Allow");
    await seedBotCommand({
      botId,
      botCommandId,
      displayName: "Allow Bot",
      commandName: "ask",
      aliases: ["ai"],
    });

    const patchRes = await browserReq(
      ownerId,
      "PATCH",
      `/api/chat/channels/${channelId}/commands/${botCommandId}`,
      { status: "allowed", permission_override: "member" },
      `key-allow-${crypto.randomUUID()}`,
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      bot_command_id: string;
      status: string;
      permission_override: string | null;
    };
    expect(patchBody.bot_command_id).toBe(botCommandId);
    expect(patchBody.status).toBe("allowed");
    expect(patchBody.permission_override).toBe("member");

    const manifestRes = await browserReq(ownerId, "GET", `/api/chat/channels/${channelId}/commands?prefix=zz`);
    expect(manifestRes.status).toBe(200);
    const manifest = (await manifestRes.json()) as {
      version: number;
      items: Array<{ bot_command_id: string; name: string }>;
    };
    expect(manifest.version).toBe(1);
    const boundItems = manifest.items.filter(
      (item) =>
        item.bot_command_id !== PLATFORM_HELP_BOT_COMMAND_ID &&
        item.bot_command_id !== PLATFORM_PERMISSION_BOT_COMMAND_ID,
    );
    expect(boundItems).toHaveLength(1);
    expect(boundItems[0]?.bot_command_id).toBe(botCommandId);
    expect(boundItems[0]?.name).toBe("ask");

    await withChannel(channelId, (ctx) => {
      const binding = ctx.storage.sql
        .exec(
          "SELECT status, command_snapshot_json FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
          channelId,
          botCommandId,
        )
        .toArray()[0] as { status: string; command_snapshot_json: string } | undefined;
      expect(binding?.status).toBe("allowed");
      const snapshot = JSON.parse(binding?.command_snapshot_json ?? "{}") as { bot_command_id?: string };
      expect(snapshot.bot_command_id).toBe(botCommandId);

      const meta = ctx.storage.sql
        .exec("SELECT command_manifest_version FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { command_manifest_version: number } | undefined;
      expect(meta?.command_manifest_version).toBe(1);

      const event = ctx.storage.sql
        .exec(
          "SELECT payload_json FROM events WHERE channel_id=? AND event_type='command.binding_updated' ORDER BY event_id DESC LIMIT 1",
          channelId,
        )
        .toArray()[0] as { payload_json: string } | undefined;
      expect(event).toBeTruthy();
      const payload = JSON.parse(event?.payload_json ?? "{}") as {
        command_manifest_delta?: { op?: string; manifest_version?: number; item?: { bot_command_id?: string } };
      };
      expect(payload.command_manifest_delta?.op).toBe("upsert");
      expect(payload.command_manifest_delta?.manifest_version).toBe(1);
      expect(payload.command_manifest_delta?.item?.bot_command_id).toBe(botCommandId);
    });
  });

  it("dm commands get returns empty manifest", async () => {
    const userA = `dm-a-${crypto.randomUUID()}`;
    const userB = `dm-b-${crypto.randomUUID()}`;
    const { channelId } = await createTestDmChannel(env, userA, userB, userA);
    const res = await browserReq(userA, "GET", `/api/chat/channels/${channelId}/commands`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; items: unknown[] };
    expect(body).toEqual({ version: 0, items: [] });
  });

  it("dm command patch returns UNSUPPORTED_CHANNEL_KIND", async () => {
    const userA = `dm-a-${crypto.randomUUID()}`;
    const userB = `dm-b-${crypto.randomUUID()}`;
    const { channelId } = await createTestDmChannel(env, userA, userB, userA);
    const botId = `bot-dm-${crypto.randomUUID()}`;
    const botCommandId = `cmd-dm-${crypto.randomUUID()}`;
    await seedBotCommand({
      botId,
      botCommandId,
      displayName: "DM Bot",
      commandName: "askdm",
      aliases: [],
    });

    const res = await browserReq(
      userA,
      "PATCH",
      `/api/chat/channels/${channelId}/commands/${botCommandId}`,
      { status: "allowed" },
      `key-dm-allow-${crypto.randomUUID()}`,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_CHANNEL_KIND");
  });
});
