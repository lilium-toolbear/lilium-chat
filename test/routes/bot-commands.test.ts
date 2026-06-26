import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { hashBotToken } from "../../src/auth/bot";

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

const seededBotIds = new Set<string>();
async function seedBot(opts: {
  botId: string;
  token: string;
  status?: string;
  revoked?: boolean;
  scopes?: string[];
}): Promise<void> {
  const tokenHash = await hashBotToken(opts.token);
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, callback_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      opts.botId,
      "owner-1",
      "Catalog Bot",
      null,
      "https://example.test/callback",
      opts.status ?? "active",
      "2026-06-26T00:00:00.000Z",
      "2026-06-26T00:00:00.000Z",
    );
    ctx.storage.sql.exec(
      `INSERT INTO bot_tokens (token_id, bot_id, token_hash, scopes, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      `tok-${opts.botId}`,
      opts.botId,
      tokenHash,
      JSON.stringify(opts.scopes ?? ["chat:commands:manage"]),
      "2026-06-26T00:00:00.000Z",
      opts.revoked ? "2026-06-26T00:00:00.000Z" : null,
    );
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

async function botPut(
  token: string,
  body: unknown,
  idemKey: string,
): Promise<Response> {
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
    env,
  );
}

const ASK_COMMAND = {
  name: "ask",
  aliases: ["ai", "chat"],
  description: "Ask the assistant",
  options: [
    { name: "prompt", type: "string", required: true, description: "Question" },
    { name: "count", type: "integer", required: false, min: 1, max: 10 },
  ],
  default_member_permission: "member",
  default_enabled_on_install: true,
};

describe("PUT /api/chat/bot/commands (7a-catalog-sync)", () => {
  it("registers a command catalog + aliases + event_capabilities", async () => {
    const botId = `cat-ok-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-cat-ok" });
    const res = await botPut(
      "secret-cat-ok",
      {
        commands: [ASK_COMMAND],
        event_capabilities: [
          {
            event_type: "message.created",
            default_enabled_on_install: false,
            default_filters: { message_types: ["text"] },
          },
        ],
      },
      "key-1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      commands: Array<{ bot_command_id: string; name: string; aliases: string[]; enabled: boolean; default_enabled_on_install: boolean }>;
      event_capabilities: Array<{ event_type: string; default_enabled_on_install: boolean }>;
    };
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]!.name).toBe("ask");
    expect(body.commands[0]!.aliases).toEqual(["ai", "chat"]);
    expect(body.commands[0]!.enabled).toBe(true);
    expect(body.commands[0]!.default_enabled_on_install).toBe(true);
    expect(body.event_capabilities[0]!.event_type).toBe("message.created");
  });

  it("is idempotent: same Idempotency-Key + same body returns the same response", async () => {
    const botId = `cat-idem-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-cat-idem" });
    const r1 = await botPut("secret-cat-idem", { commands: [ASK_COMMAND] }, "key-idem");
    const b1 = (await r1.json()) as { commands: Array<{ bot_command_id: string }> };
    const r2 = await botPut("secret-cat-idem", { commands: [ASK_COMMAND] }, "key-idem");
    const b2 = (await r2.json()) as { commands: Array<{ bot_command_id: string }> };
    expect(r2.status).toBe(200);
    expect(b2.commands[0]!.bot_command_id).toBe(b1.commands[0]!.bot_command_id);
  });

  it("reuses bot_command_id when re-registering the same name", async () => {
    const botId = `cat-reuse-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-cat-reuse" });
    const r1 = await botPut("secret-cat-reuse", { commands: [ASK_COMMAND] }, "key-reuse-1");
    const b1 = (await r1.json()) as { commands: Array<{ bot_command_id: string }> };
    // different description -> different definition_hash, but same (bot_id, name) -> same id
    const r2 = await botPut(
      "secret-cat-reuse",
      { commands: [{ ...ASK_COMMAND, description: "Ask the assistant v2" }] },
      "key-reuse-2",
    );
    const b2 = (await r2.json()) as { commands: Array<{ bot_command_id: string }> };
    expect(b2.commands[0]!.bot_command_id).toBe(b1.commands[0]!.bot_command_id);
  });

  it("returns 409 IDEMPOTENCY_CONFLICT when same key + different body", async () => {
    const botId = `cat-conflict-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-cat-conflict" });
    await botPut("secret-cat-conflict", { commands: [ASK_COMMAND] }, "key-conflict");
    const r2 = await botPut(
      "secret-cat-conflict",
      { commands: [{ ...ASK_COMMAND, name: "ask2" }] },
      "key-conflict",
    );
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("returns 422 for invalid option type", async () => {
    const botId = `cat-invalid-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-cat-invalid" });
    const res = await botPut(
      "secret-cat-invalid",
      { commands: [{ ...ASK_COMMAND, options: [{ name: "x", type: "bogus" }] }] },
      "key-invalid",
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_COMMAND_OPTIONS");
  });

  it("returns 422 for non-message.created event_type", async () => {
    const botId = `cat-badcap-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-cat-badcap" });
    const res = await botPut(
      "secret-cat-badcap",
      {
        commands: [ASK_COMMAND],
        event_capabilities: [{ event_type: "message.updated" }],
      },
      "key-badcap",
    );
    expect(res.status).toBe(422);
  });

  it("returns 401 for a revoked token", async () => {
    const botId = `cat-revoked-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-cat-revoked", revoked: true });
    const res = await botPut("secret-cat-revoked", { commands: [ASK_COMMAND] }, "key-revoked");
    expect(res.status).toBe(401);
  });

  it("returns 403 when scope chat:commands:manage is missing", async () => {
    const botId = `cat-noscope-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-cat-noscope", scopes: ["chat:messages:read"] });
    const res = await botPut("secret-cat-noscope", { commands: [ASK_COMMAND] }, "key-noscope");
    expect(res.status).toBe(403);
  });

  it("returns 422 when Idempotency-Key is missing", async () => {
    const botId = `cat-nokey-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-cat-nokey" });
    const res = await SELF.fetch(
      new Request("https://chat.kuma.homes/api/chat/bot/commands", {
        method: "PUT",
        headers: { Authorization: "Bearer secret-cat-nokey", "Content-Type": "application/json" },
        body: JSON.stringify({ commands: [ASK_COMMAND] }),
      }),
      env,
    );
    expect(res.status).toBe(422);
  });
});