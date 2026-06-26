import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, makeJwt, TEST_SECRET } from "../helpers";

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

type SeedPermission = "member" | "admin" | "owner";

type SeedCommand = {
  name: string;
  aliases: string[];
  description: string;
  options?: unknown[];
  defaultMemberPermission: SeedPermission;
  defaultEnabledOnInstall: boolean;
};

const seededBotIds = new Set<string>();

async function seedBotWithCatalog(opts: {
  botId: string;
  displayName: string;
  avatarUrl?: string | null;
  commands: SeedCommand[];
}): Promise<void> {
  const now = "2026-06-26T00:00:00.000Z";
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, callback_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      opts.botId,
      "owner-1",
      opts.displayName,
      opts.avatarUrl ?? null,
      "https://example.test/callback",
      now,
      now,
    );

    for (const c of opts.commands) {
      const commandId = `cmd-${opts.botId}-${c.name}`;
      ctx.storage.sql.exec(
        `INSERT INTO bot_commands (
           bot_command_id, bot_id, name, description, options_json,
           default_member_permission, default_enabled_on_install, schema_version,
           definition_hash, enabled, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, NULL)`,
        commandId,
        opts.botId,
        c.name,
        c.description,
        JSON.stringify(c.options ?? []),
        c.defaultMemberPermission,
        c.defaultEnabledOnInstall ? 1 : 0,
        `hash-${c.name}-1`,
        now,
        now,
      );
      for (const alias of c.aliases) {
        ctx.storage.sql.exec(
          "INSERT INTO bot_command_aliases (bot_command_id, bot_id, alias, created_at) VALUES (?, ?, ?, ?)",
          commandId,
          opts.botId,
          alias,
          now,
        );
      }
    }
  });

  seededBotIds.add(opts.botId);
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

describe("GET /api/chat/channels/:channel_id/commands (7a-commands-query)", () => {
  it("returns matched_kind=canonical when prefix hits command name", async () => {
    const ownerId = `owner-canon-${crypto.randomUUID()}`;
    const botId = `bot-canon-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Canonical Command Match");
    await seedBotWithCatalog({
      botId,
      displayName: "Snapshot Bot",
      commands: [
        {
          name: "summarize",
          aliases: ["sum"],
          description: "Summarize text",
          defaultMemberPermission: "member",
          defaultEnabledOnInstall: true,
        },
      ],
    });

    const installRes = await browserReq(
      ownerId,
      "POST",
      `/api/chat/channels/${channelId}/bot-installations`,
      { bot_id: botId },
      `key-canon-${crypto.randomUUID()}`,
    );
    expect(installRes.status).toBe(201);

    const res = await browserReq(ownerId, "GET", `/api/chat/channels/${channelId}/commands?prefix=su`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string; matched_name: string; matched_kind: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.name).toBe("summarize");
    expect(body.items[0]!.matched_name).toBe("summarize");
    expect(body.items[0]!.matched_kind).toBe("canonical");
  });

  it("returns matched_kind=alias when prefix hits an alias", async () => {
    const ownerId = `owner-alias-${crypto.randomUUID()}`;
    const botId = `bot-alias-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Alias Command Match");
    await seedBotWithCatalog({
      botId,
      displayName: "Alias Bot",
      commands: [
        {
          name: "greet",
          aliases: ["asstart", "start"],
          description: "Send greeting",
          defaultMemberPermission: "member",
          defaultEnabledOnInstall: true,
        },
      ],
    });

    const installRes = await browserReq(
      ownerId,
      "POST",
      `/api/chat/channels/${channelId}/bot-installations`,
      { bot_id: botId },
      `key-alias-${crypto.randomUUID()}`,
    );
    expect(installRes.status).toBe(201);

    const res = await browserReq(ownerId, "GET", `/api/chat/channels/${channelId}/commands?prefix=as`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ matched_name: string; matched_kind: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.matched_name).toBe("asstart");
    expect(body.items[0]!.matched_kind).toBe("alias");
  });

  it("returns 403 when the caller is not a channel member", async () => {
    const ownerId = `owner-nm-${crypto.randomUUID()}`;
    const outsiderId = `outside-nm-${crypto.randomUUID()}`;
    const botId = `bot-nm-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Non-member Command Query");
    await seedBotWithCatalog({
      botId,
      displayName: "Private Bot",
      commands: [
        {
          name: "help",
          aliases: ["h"],
          description: "Help text",
          defaultMemberPermission: "member",
          defaultEnabledOnInstall: true,
        },
      ],
    });

    const installRes = await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/bot-installations`, { bot_id: botId }, `key-nm-${crypto.randomUUID()}`);
    expect(installRes.status).toBe(201);

    const res = await browserReq(outsiderId, "GET", `/api/chat/channels/${channelId}/commands?prefix=he`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("filters out commands requiring higher permission than caller", async () => {
    const ownerId = `owner-admin-${crypto.randomUUID()}`;
    const memberId = `member-admin-${crypto.randomUUID()}`;
    const botId = `bot-admin-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Permission Filter");
    await seedBotWithCatalog({
      botId,
      displayName: "Permission Bot",
      commands: [
        {
          name: "membercmd",
          aliases: ["mcmd"],
          description: "Member command",
          defaultMemberPermission: "member",
          defaultEnabledOnInstall: true,
        },
        {
          name: "admincmd",
          aliases: ["acmd"],
          description: "Admin command",
          defaultMemberPermission: "admin",
          defaultEnabledOnInstall: true,
        },
      ],
    });

    const installRes = await browserReq(
      ownerId,
      "POST",
      `/api/chat/channels/${channelId}/bot-installations`,
      { bot_id: botId },
      `key-filter-${crypto.randomUUID()}`,
    );
    expect(installRes.status).toBe(201);
    const addMemberRes = await browserReq(ownerId, "POST", `/api/chat/channels/${channelId}/members`, { user_id: memberId, role: "member" }, `key-add-${memberId}`);
    expect(addMemberRes.status).toBe(200);

    const res = await browserReq(memberId, "GET", `/api/chat/channels/${channelId}/commands?prefix=ad`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items).toHaveLength(0);
  });

  it("returns empty list when no enabled commands match the channel state", async () => {
    const ownerId = `owner-empty-${crypto.randomUUID()}`;
    const botId = `bot-empty-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "No Enabled Commands");
    await seedBotWithCatalog({
      botId,
      displayName: "Off Bot",
      commands: [
        {
          name: "disabledcmd",
          aliases: ["dcmd"],
          description: "Disabled command",
          defaultMemberPermission: "member",
          defaultEnabledOnInstall: false,
        },
      ],
    });

    const installRes = await browserReq(
      ownerId,
      "POST",
      `/api/chat/channels/${channelId}/bot-installations`,
      { bot_id: botId },
      `key-empty-${crypto.randomUUID()}`,
    );
    expect(installRes.status).toBe(201);

    const res = await browserReq(ownerId, "GET", `/api/chat/channels/${channelId}/commands?prefix=dis`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<unknown> };
    expect(body.items).toHaveLength(0);
  });

  it("uses bot summary from installation snapshot (no BotRegistry read during query)", async () => {
    const ownerId = `owner-snapshot-${crypto.randomUUID()}`;
    const botId = `bot-snapshot-${crypto.randomUUID()}`;
    const channelId = await createChannel(ownerId, "Snapshot Source Bot");
    await seedBotWithCatalog({
      botId,
      displayName: "Install Snapshot Bot",
      commands: [
        {
          name: "snapshot",
          aliases: ["sn"],
          description: "Snapshot test",
          defaultMemberPermission: "member",
          defaultEnabledOnInstall: true,
        },
      ],
    });

    const installRes = await browserReq(
      ownerId,
      "POST",
      `/api/chat/channels/${channelId}/bot-installations`,
      { bot_id: botId },
      `key-snapshot-${crypto.randomUUID()}`,
    );
    expect(installRes.status).toBe(201);

    await withRegistry((ctx) => {
      ctx.storage.sql.exec("UPDATE bot_apps SET display_name=? WHERE bot_id=?", "Registry Mutated Bot", botId);
    });

    const res = await browserReq(ownerId, "GET", `/api/chat/channels/${channelId}/commands?prefix=sn`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ bot: { display_name: string } }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.bot.display_name).toBe("Install Snapshot Bot");
  });
});
