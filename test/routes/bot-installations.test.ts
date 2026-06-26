import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET, getNamedDo } from "../helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown) => Promise<Response> | Response;
};

const REGISTRY = () =>
  getNamedDo(env.BOT_REGISTRY as unknown as DurableObjectNamespace, "registry");

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
  const stub = env.CHAT_CHANNEL.getByName(channelId);
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

const seededBots = new Set<string>();
/** Seed a bot with one command + aliases + a message.created capability. */
async function seedBotWithCatalog(opts: {
  botId: string;
  displayName?: string;
  commandName?: string;
  aliases?: string[];
  definitionHash?: string;
  defaultEnabledOnInstall?: boolean;
  eventCapability?: boolean;
}): Promise<void> {
  await withRegistry((ctx) => {
    const now = "2026-06-26T00:00:00.000Z";
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, callback_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      opts.botId,
      "owner-1",
      opts.displayName ?? "Install Bot",
      null,
      "https://example.test/callback",
      now,
      now,
    );
    const cmdName = opts.commandName ?? "ask";
    const cmdId = `cmd-${opts.botId}`;
    ctx.storage.sql.exec(
      `INSERT INTO bot_commands (
         bot_command_id, bot_id, name, description, options_json,
         default_member_permission, default_enabled_on_install, schema_version,
         definition_hash, enabled, created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, '[]', 'member', ?, 1, ?, 1, ?, ?, NULL)`,
      cmdId,
      opts.botId,
      cmdName,
      "Ask",
      opts.defaultEnabledOnInstall === false ? 0 : 1,
      opts.definitionHash ?? "hash-1",
      now,
      now,
    );
    for (const alias of opts.aliases ?? ["ai"]) {
      ctx.storage.sql.exec(
        "INSERT INTO bot_command_aliases (bot_command_id, bot_id, alias, created_at) VALUES (?, ?, ?, ?)",
        cmdId,
        opts.botId,
        alias,
        now,
      );
    }
    if (opts.eventCapability !== false) {
      ctx.storage.sql.exec(
        `INSERT INTO bot_event_capabilities (bot_id, event_type, filters_json, default_enabled_on_install, created_at, updated_at)
         VALUES (?, 'message.created', ?, ?, ?, ?)`,
        opts.botId,
        JSON.stringify({ message_types: ["text"], include_bot_messages: false, include_own_messages: false, only_when_mentioned: false }),
        0,
        now,
        now,
      );
    }
  });
  seededBots.add(opts.botId);
}

async function cleanupBot(botId: string): Promise<void> {
  await withRegistry((ctx) => {
    ctx.storage.sql.exec("DELETE FROM bot_command_aliases WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_commands WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_event_capabilities WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_idempotency_keys WHERE principal_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_tokens WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_apps WHERE bot_id=?", botId);
  });
  seededBots.delete(botId);
}

afterEach(async () => {
  for (const botId of [...seededBots]) await cleanupBot(botId);
});

async function browserReq(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  idemKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await makeJwt({ sub: userId }, TEST_SECRET)}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  return SELF.fetch(
    new Request(`https://chat.kuma.homes${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    { ...env, JWT_SECRET: TEST_SECRET } as typeof env,
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

describe("POST /api/chat/channels/:id/bot-installations (7a-install)", () => {
  it("installs a bot: creates bindings + names + subscriptions + bot summary snapshot", async () => {
    const ownerId = `owner-${crypto.randomUUID()}`;
    const botId = `bot-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Install Channel");
    await seedBotWithCatalog({ botId, displayName: "Lilium Bot", commandName: "ask", aliases: ["ai"] });

    const res = await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/bot-installations`, {
      bot_id: botId,
    }, "key-install-1");
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      bot_id: string;
      status: string;
      bindings: Array<{ name: string; aliases: string[]; status: string }>;
      subscriptions: Array<{ event_type: string; status: string }>;
    };
    expect(body.bot_id).toBe(botId);
    expect(body.status).toBe("active");
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0]!.name).toBe("ask");
    expect(body.bindings[0]!.aliases).toEqual(["ai"]);
    expect(body.bindings[0]!.status).toBe("enabled");
    expect(body.subscriptions[0]!.event_type).toBe("message.created");

    // persisted: bindings + names + bot summary snapshot
    await withChannel(channelId, (ctx) => {
      const names = ctx.storage.sql
        .exec("SELECT slash_name, kind FROM channel_command_names WHERE channel_id=? ORDER BY slash_name", channelId)
        .toArray() as Array<{ slash_name: string; kind: string }>;
      expect(names.map((n) => n.slash_name).sort()).toEqual(["ai", "ask"]);
      const install = ctx.storage.sql
        .exec("SELECT bot_display_name, status FROM bot_installations WHERE bot_id=?", botId)
        .toArray()[0] as { bot_display_name: string; status: string };
      expect(install.bot_display_name).toBe("Lilium Bot");
      expect(install.status).toBe("active");
    });
  });

  it("is idempotent: same Idempotency-Key + same body returns the same response", async () => {
    const ownerId = `owner-idem-${crypto.randomUUID()}`;
    const botId = `bot-idem-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Idem Channel");
    await seedBotWithCatalog({ botId });
    const r1 = await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/bot-installations`, { bot_id: botId }, "key-idem-install");
    const r2 = await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/bot-installations`, { bot_id: botId }, "key-idem-install");
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const b1 = (await r1.json()) as { bindings: Array<{ binding_id?: string }> };
    const b2 = (await r2.json()) as { bindings: Array<{ binding_id?: string }> };
    // bindings count stable (no duplicate rows)
    expect(b2.bindings).toHaveLength(b1.bindings.length);
  });

  it("returns 409 IDEMPOTENCY_CONFLICT on same key + different body", async () => {
    const ownerId = `owner-conf-${crypto.randomUUID()}`;
    const botId = `bot-conf-${crypto.randomUUID()}`;
    const botId2 = `bot-conf2-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Conflict Channel");
    await seedBotWithCatalog({ botId });
    await seedBotWithCatalog({ botId: botId2, commandName: "summarize", aliases: ["sum"] });
    await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/bot-installations`, { bot_id: botId }, "key-conflict-install");
    const r2 = await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/bot-installations`, { bot_id: botId2 }, "key-conflict-install");
    expect(r2.status).toBe(409);
  });

  it("returns 409 COMMAND_NAME_CONFLICT when two bots claim the same slash token", async () => {
    const ownerId = `owner-nameconf-${crypto.randomUUID()}`;
    const botIdA = `bot-nameconf-a-${crypto.randomUUID()}`;
    const botIdB = `bot-nameconf-b-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Name Conflict Channel");
    await seedBotWithCatalog({ botId: botIdA, commandName: "ask", aliases: ["ai"] });
    await seedBotWithCatalog({ botId: botIdB, commandName: "ask", aliases: ["ai"] });
    const r1 = await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/bot-installations`, { bot_id: botIdA }, "key-nc-1");
    expect(r1.status).toBe(201);
    const r2 = await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/bot-installations`, { bot_id: botIdB }, "key-nc-2");
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: { code: string } };
    expect(body.error.code).toBe("COMMAND_NAME_CONFLICT");
  });

  it("returns 403 when a non-admin member tries to install", async () => {
    const ownerId = `owner-nadmin-${crypto.randomUUID()}`;
    const memberId = `member-nadmin-${crypto.randomUUID()}`;
    const botId = `bot-nadmin-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Member Channel");
    await seedBotWithCatalog({ botId });
    // add member via owner
    await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/members`, { user_id: memberId, role: "member" }, `key-addmem-${memberId}`);
    const res = await browserReq(memberId, "POST", `/api/chat/channels/${channelId}/bot-installations`, { bot_id: botId }, "key-member-install");
    expect(res.status).toBe(403);
  });

  it("uninstall (status=removed) deletes command names + bindings + subscriptions", async () => {
    const ownerId = `owner-uninstall-${crypto.randomUUID()}`;
    const botId = `bot-uninstall-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Uninstall Channel");
    await seedBotWithCatalog({ botId });
    await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/bot-installations`, { bot_id: botId }, "key-install-uninstall");
    const res = await browserReq(ownerId, "PATCH", `/api/chat/channels/${channelId}/bot-installations/${botId}`, { status: "removed" }, "key-uninstall");
    expect(res.status).toBe(200);
    await withChannel(channelId, (ctx) => {
      const names = ctx.storage.sql
        .exec("SELECT COUNT(*) AS c FROM channel_command_names WHERE channel_id=? AND bot_id=?", channelId, botId)
        .toArray()[0] as { c: number | bigint };
      expect(Number(names.c)).toBe(0);
      const subs = ctx.storage.sql
        .exec("SELECT COUNT(*) AS c FROM channel_bot_event_subscriptions WHERE channel_id=? AND bot_id=?", channelId, botId)
        .toArray()[0] as { c: number | bigint };
      expect(Number(subs.c)).toBe(0);
    });
  });

  it("emits a system.notice(notice_kind=bot.installed) with bot_id, no token", async () => {
    const ownerId = `owner-notice-${crypto.randomUUID()}`;
    const botId = `bot-notice-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Notice Channel");
    await seedBotWithCatalog({ botId });
    await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/bot-installations`, { bot_id: botId }, "key-notice-install");
    await withChannel(channelId, (ctx) => {
      const notice = ctx.storage.sql
        .exec("SELECT payload_json FROM events WHERE channel_id=? AND event_type='system.notice' AND payload_json LIKE '%bot.installed%'", channelId)
        .toArray()[0] as { payload_json: string } | undefined;
      expect(notice).toBeDefined();
      const payload = JSON.parse(notice!.payload_json) as Record<string, unknown>;
      expect(payload.notice_kind).toBe("bot.installed");
      expect(payload.bot_id).toBe(botId);
      // no secret/token leak
      expect(JSON.stringify(payload)).not.toContain("token");
      expect(JSON.stringify(payload)).not.toContain("callback_secret");
    });
  });
});