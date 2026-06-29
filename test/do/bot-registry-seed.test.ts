import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, TEST_SECRET } from "../helpers";
import { hashBotToken } from "../../src/auth/bot";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown) => Promise<Response> | Response;
};

const OFFICIAL_BOT_ID = "00000000-0000-7000-8000-000000000601";

function registryStub() {
  return getNamedDo(env.BOT_REGISTRY as unknown as DurableObjectNamespace, "registry");
}

async function withRegistry(
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(registryStub(), async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function cleanupOfficialBot(): Promise<void> {
  await withRegistry((ctx) => {
    ctx.storage.sql.exec("DELETE FROM bot_command_names WHERE bot_id=?", OFFICIAL_BOT_ID);
    ctx.storage.sql.exec("DELETE FROM bot_command_aliases WHERE bot_id=?", OFFICIAL_BOT_ID);
    ctx.storage.sql.exec("DELETE FROM bot_commands WHERE bot_id=?", OFFICIAL_BOT_ID);
    ctx.storage.sql.exec("DELETE FROM bot_idempotency_keys WHERE principal_id=?", OFFICIAL_BOT_ID);
    ctx.storage.sql.exec("DELETE FROM bot_tokens WHERE bot_id=?", OFFICIAL_BOT_ID);
    ctx.storage.sql.exec("DELETE FROM bot_apps WHERE bot_id=?", OFFICIAL_BOT_ID);
  });
}

afterEach(async () => {
  await cleanupOfficialBot();
});

async function seedOfficial(): Promise<{
  token: string | null;
  commands: Array<{ bot_command_id: string; name: string; aliases: string[]; schema_version: number }>;
}> {
  const res = await registryStub().fetch(new Request("https://x/internal/seed-official-bot", { method: "POST" }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    token: string | null;
    bot: { bot_id: string };
    commands: Array<{ bot_command_id: string; name: string; aliases: string[]; schema_version: number }>;
  };
  expect(body.bot.bot_id).toBe(OFFICIAL_BOT_ID);
  return { token: body.token, commands: body.commands };
}

async function putBotCommands(token: string, body: unknown, idemKey: string): Promise<Response> {
  return SELF.fetch(
    new Request("https://chat.kuma.homes/api/chat/bot/commands", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idemKey,
      },
      body: JSON.stringify(body),
    }),
    { ...env, JWT_SECRET: TEST_SECRET } as typeof env,
  );
}

describe("BotRegistry /internal/seed-official-bot (7a-seed)", () => {
  it("seeds official bot catalog + token, token plaintext returned once", async () => {
    const first = await seedOfficial();
    expect(first.token).toMatch(/^lcbot_[0-9a-f-]+_[0-9a-f-]+$/);
    expect(first.commands).toHaveLength(2);

    await withRegistry((ctx) => {
      const bot = ctx.storage.sql
        .exec("SELECT bot_id, display_name, avatar_url, status FROM bot_apps WHERE bot_id=?", OFFICIAL_BOT_ID)
        .toArray()[0] as { bot_id: string; display_name: string; avatar_url: string | null; status: string } | undefined;
      expect(bot).toBeDefined();
      expect(bot?.display_name).toBe("Lilium Bot");
      expect(bot?.status).toBe("active");

      const commands = ctx.storage.sql
        .exec("SELECT bot_command_id, name FROM bot_commands WHERE bot_id=? ORDER BY name", OFFICIAL_BOT_ID)
        .toArray() as Array<{ bot_command_id: string; name: string }>;
      expect(commands).toHaveLength(2);
      expect(commands.map((c) => c.name)).toEqual(["ask", "summarize"]);

      const globalNames = ctx.storage.sql
        .exec("SELECT slash_token FROM bot_command_names WHERE bot_id=? ORDER BY slash_token", OFFICIAL_BOT_ID)
        .toArray() as Array<{ slash_token: string }>;
      expect(globalNames.length).toBeGreaterThan(0);

      const tokens = ctx.storage.sql
        .exec("SELECT token_hash FROM bot_tokens WHERE bot_id=?", OFFICIAL_BOT_ID)
        .toArray() as Array<{ token_hash: string }>;
      expect(tokens).toHaveLength(1);
    });

    const second = await seedOfficial();
    expect(second.token).toBeNull();

    if (first.token === null) throw new Error("official seed did not return token");
    const tokenHash = await hashBotToken(first.token);
    await withRegistry((ctx) => {
      const tokenRows = ctx.storage.sql
        .exec("SELECT token_hash, revoked_at FROM bot_tokens WHERE bot_id=?", OFFICIAL_BOT_ID)
        .toArray() as Array<{ token_hash: string; revoked_at: string | null }>;
      expect(tokenRows).toHaveLength(1);
      expect(tokenRows[0]!.token_hash).toBe(tokenHash);
      expect(tokenRows[0]!.revoked_at).toBeNull();
    });
  });

  it("is idempotent and does not rotate command ids", async () => {
    const first = await seedOfficial();
    expect(first.token).toMatch(/^lcbot_/);
    const firstIds = new Map(first.commands.map((c) => [c.name, c.bot_command_id]));

    const second = await seedOfficial();
    expect(second.token).toBeNull();

    await withRegistry((ctx) => {
      const rows = ctx.storage.sql
        .exec("SELECT name, bot_command_id FROM bot_commands WHERE bot_id=? ORDER BY name", OFFICIAL_BOT_ID)
        .toArray() as Array<{ name: string; bot_command_id: string }>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(firstIds.get(row.name)).toBe(row.bot_command_id);
      }
    });
  });

  it("catalog sync overrides seed definitions", async () => {
    const seed = await seedOfficial();
    expect(seed.token).toMatch(/^lcbot_/);
    if (seed.token === null) throw new Error("official seed did not return token");

    const syncRes = await putBotCommands(seed.token, {
      commands: [
        {
          name: "ask",
          aliases: ["a", "askit"],
          description: "ask updated",
          options: [{ name: "prompt", type: "string", required: true, description: "Prompt" }],
          default_member_permission: "member",
          execution: { mode: "stateless" },
        },
      ],
    }, "seed-sync");
    expect(syncRes.status).toBe(200);

    const body = (await syncRes.json()) as {
      commands: Array<{ bot_command_id: string; name: string; aliases: string[]; schema_version: number }>;
    };
    expect(body.commands).toHaveLength(1);

    await withRegistry((ctx) => {
      const ask = ctx.storage.sql
        .exec(
          "SELECT bot_command_id, description, options_json, execution_mode, schema_version FROM bot_commands WHERE bot_id=? AND name=?",
          OFFICIAL_BOT_ID,
          "ask",
        )
        .toArray()[0] as
          | {
              bot_command_id: string;
              description: string;
              options_json: string;
              execution_mode: string;
              schema_version: number;
            }
          | undefined;
      expect(ask).toBeDefined();
      expect(ask!.description).toBe("ask updated");
      expect(JSON.parse(ask!.options_json)).toEqual([
        { name: "prompt", type: "string", required: true, description: "Prompt" },
      ]);
      expect(ask!.execution_mode).toBe("stateless");
      const expectedId = seed.commands.find((c) => c.name === "ask")!.bot_command_id;
      expect(ask!.bot_command_id).toBe(expectedId);

      const aliases = ctx.storage.sql
        .exec("SELECT alias FROM bot_command_aliases WHERE bot_command_id=? ORDER BY alias", ask!.bot_command_id)
        .toArray() as Array<{ alias: string }>;
      expect(aliases.map((r) => r.alias)).toEqual(["a", "askit"]);
    });

    let askSchemaVersion = 0;
    await withRegistry(async (ctx) => {
      const seedAsk = ctx.storage.sql
        .exec("SELECT schema_version FROM bot_commands WHERE bot_id=? AND name=?", OFFICIAL_BOT_ID, "ask")
        .toArray()[0] as { schema_version: number } | undefined;
      askSchemaVersion = seedAsk?.schema_version ?? 0;
    });
    expect(askSchemaVersion).toBeGreaterThanOrEqual(1);
  });
});
