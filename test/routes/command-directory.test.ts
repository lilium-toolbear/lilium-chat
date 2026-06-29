import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, makeJwt, TEST_SECRET } from "../helpers";

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

async function browserReq(userId: string, path: string): Promise<Response> {
  return SELF.fetch(
    new Request(`https://chat.kuma.homes${path}`, {
      headers: {
        Authorization: `Bearer ${await makeJwt({ sub: userId }, TEST_SECRET)}`,
      },
    }),
    { ...env, JWT_SECRET: TEST_SECRET } as typeof env,
  );
}

describe("GET /api/chat/commands/directory", () => {
  it("returns command items by name and alias search", async () => {
    const userId = `directory-user-${crypto.randomUUID()}`;
    const botId = `bot-${crypto.randomUUID()}`;
    const cmdWerewolf = `cmd-${crypto.randomUUID()}`;
    const cmdAsk = `cmd-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    await withRegistry((ctx) => {
      ctx.storage.sql.exec(
        `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        botId,
        "owner",
        "Game Bot",
        null,
        "Party games",
        "public",
        now,
        now,
      );
      ctx.storage.sql.exec(
        `INSERT INTO bot_commands (
           bot_command_id, bot_id, name, description, options_json, default_member_permission,
           execution_mode, stateful_config_json, status, schema_version, definition_hash, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, '[]', 'member', 'stateful', ?, 'active', 1, ?, ?, ?, NULL)`,
        cmdWerewolf,
        botId,
        "werewolf",
        "Start a werewolf game",
        JSON.stringify({
          mutex_scope: "channel",
          default_ttl_seconds: 3600,
          max_ttl_seconds: 7200,
          listen_capability: {
            message_types: ["text"],
            include_bot_messages: false,
            include_own_messages: false,
          },
        }),
        `hash-${cmdWerewolf}`,
        now,
        now,
      );
      ctx.storage.sql.exec(
        `INSERT INTO bot_commands (
           bot_command_id, bot_id, name, description, options_json, default_member_permission,
           execution_mode, stateful_config_json, status, schema_version, definition_hash, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, '[]', 'member', 'stateless', NULL, 'active', 1, ?, ?, ?, NULL)`,
        cmdAsk,
        botId,
        "ask",
        "Ask assistant",
        `hash-${cmdAsk}`,
        now,
        now,
      );
      ctx.storage.sql.exec(
        "INSERT INTO bot_command_aliases (bot_command_id, bot_id, alias, created_at) VALUES (?, ?, ?, ?)",
        cmdWerewolf,
        botId,
        "ww",
        now,
      );
      ctx.storage.sql.exec(
        "INSERT INTO bot_command_aliases (bot_command_id, bot_id, alias, created_at) VALUES (?, ?, ?, ?)",
        cmdWerewolf,
        botId,
        "狼人杀",
        now,
      );
    });

    const byNameRes = await browserReq(userId, "/api/chat/commands/directory?query=were");
    expect(byNameRes.status).toBe(200);
    const byNameBody = (await byNameRes.json()) as {
      items: Array<{
        bot_command_id: string;
        name: string;
        aliases: string[];
        bot: { bot_id: string; display_name: string };
        execution: { mode: string };
      }>;
      next_cursor: string | null;
    };
    expect(byNameBody.items).toHaveLength(1);
    expect(byNameBody.items[0]?.bot_command_id).toBe(cmdWerewolf);
    expect(byNameBody.items[0]?.aliases).toEqual(["ww", "狼人杀"]);
    expect(byNameBody.items[0]?.bot.bot_id).toBe(botId);
    expect(byNameBody.items[0]?.bot.display_name).toBe("Game Bot");
    expect(byNameBody.items[0]?.execution.mode).toBe("stateful");
    expect(byNameBody.next_cursor).toBeNull();

    const byAliasRes = await browserReq(userId, "/api/chat/commands/directory?query=狼人");
    expect(byAliasRes.status).toBe(200);
    const byAliasBody = (await byAliasRes.json()) as {
      items: Array<{ bot_command_id: string; name: string }>;
    };
    expect(byAliasBody.items).toHaveLength(1);
    expect(byAliasBody.items[0]?.name).toBe("werewolf");
  });

  it("supports pagination cursor", async () => {
    const userId = `directory-page-user-${crypto.randomUUID()}`;
    const botId = `bot-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const commands = ["alpha", "beta", "gamma"];

    await withRegistry((ctx) => {
      ctx.storage.sql.exec(
        `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        botId,
        "owner",
        "Paging Bot",
        null,
        null,
        "private",
        now,
        now,
      );
      for (const name of commands) {
        const commandId = `cmd-${name}-${crypto.randomUUID()}`;
        ctx.storage.sql.exec(
          `INSERT INTO bot_commands (
             bot_command_id, bot_id, name, description, options_json, default_member_permission,
             execution_mode, stateful_config_json, status, schema_version, definition_hash, created_at, updated_at, deleted_at
           ) VALUES (?, ?, ?, ?, '[]', 'member', 'stateless', NULL, 'active', 1, ?, ?, ?, NULL)`,
          commandId,
          botId,
          name,
          `${name} command`,
          `hash-${commandId}`,
          now,
          now,
        );
      }
    });

    const firstRes = await browserReq(userId, "/api/chat/commands/directory?limit=1");
    expect(firstRes.status).toBe(200);
    const firstBody = (await firstRes.json()) as {
      items: Array<{ bot_command_id: string }>;
      next_cursor: string | null;
    };
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.next_cursor).not.toBeNull();

    const secondRes = await browserReq(
      userId,
      `/api/chat/commands/directory?limit=1&cursor=${encodeURIComponent(firstBody.next_cursor ?? "")}`,
    );
    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as {
      items: Array<{ bot_command_id: string }>;
    };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0]?.bot_command_id).not.toBe(firstBody.items[0]?.bot_command_id);
  });
});
