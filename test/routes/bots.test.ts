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

describe("Browser Bot Developer API", () => {
  it("POST /api/chat/bots creates bot and initial token", async () => {
    const userId = `bot-owner-${crypto.randomUUID()}`;
    const res = await browserReq(
      userId,
      "POST",
      "/api/chat/bots",
      {
        display_name: "Test Bot",
        description: "Owner bot",
        visibility: "private",
        issue_initial_token: true,
        initial_token_name: "local-dev",
      },
      `key-create-${crypto.randomUUID()}`,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      bot: { bot_id: string; owner_user_id: string; display_name: string; status: string };
      initial_token?: { token_id: string; name: string; plaintext: string };
    };
    expect(body.bot.owner_user_id).toBe(userId);
    expect(body.bot.display_name).toBe("Test Bot");
    expect(body.bot.status).toBe("active");
    expect(body.initial_token?.name).toBe("local-dev");
    expect(body.initial_token?.plaintext.startsWith("lcbot_")).toBe(true);
    expect(body.initial_token?.plaintext).toMatch(/^lcbot_[A-Za-z0-9_-]+$/);
  });

  it("GET /api/chat/bots lists owner bots with command_count", async () => {
    const userId = `bot-list-owner-${crypto.randomUUID()}`;
    const createRes = await browserReq(
      userId,
      "POST",
      "/api/chat/bots",
      { display_name: "List Bot", issue_initial_token: false },
      `key-list-create-${crypto.randomUUID()}`,
    );
    const created = (await createRes.json()) as { bot: { bot_id: string } };
    const commandId = `cmd-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await withRegistry((ctx) => {
      ctx.storage.sql.exec(
        `INSERT INTO bot_commands (
           bot_command_id, bot_id, name, description, options_json, default_member_permission,
           execution_mode, stateful_config_json, status, schema_version, definition_hash, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, '[]', 'member', 'stateless', NULL, 'active', 1, ?, ?, ?, NULL)`,
        commandId,
        created.bot.bot_id,
        "ask",
        "Ask",
        `hash-${commandId}`,
        now,
        now,
      );
    });

    const res = await browserReq(userId, "GET", "/api/chat/bots");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ bot_id: string; command_count: number; owner_user_id: string }>;
      next_cursor: string | null;
    };
    const item = body.items.find((entry) => entry.bot_id === created.bot.bot_id);
    expect(item).toBeDefined();
    expect(item?.owner_user_id).toBe(userId);
    expect(item?.command_count).toBe(1);
    expect(body.next_cursor).toBeNull();
  });

  it("GET /api/chat/bots/:id returns 403 for non-owner", async () => {
    const ownerId = `bot-owner-${crypto.randomUUID()}`;
    const anotherUser = `bot-non-owner-${crypto.randomUUID()}`;
    const createRes = await browserReq(
      ownerId,
      "POST",
      "/api/chat/bots",
      { display_name: "Owner Bot", issue_initial_token: false },
      `key-owner-create-${crypto.randomUUID()}`,
    );
    const created = (await createRes.json()) as { bot: { bot_id: string } };

    const ownRes = await browserReq(ownerId, "GET", `/api/chat/bots/${created.bot.bot_id}`);
    expect(ownRes.status).toBe(200);

    const forbiddenRes = await browserReq(anotherUser, "GET", `/api/chat/bots/${created.bot.bot_id}`);
    expect(forbiddenRes.status).toBe(403);
  });

  it("GET /api/chat/bots/:id/tokens lists metadata only", async () => {
    const userId = `bot-token-list-owner-${crypto.randomUUID()}`;
    const createRes = await browserReq(
      userId,
      "POST",
      "/api/chat/bots",
      { display_name: "Token Bot", issue_initial_token: true, initial_token_name: "seed" },
      `key-token-list-create-${crypto.randomUUID()}`,
    );
    const created = (await createRes.json()) as { bot: { bot_id: string } };

    const res = await browserReq(userId, "GET", `/api/chat/bots/${created.bot.bot_id}/tokens`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ token_id: string; name: string; scopes: string[]; plaintext?: string }>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]?.name).toBe("seed");
    expect("plaintext" in (body.items[0] ?? {})).toBe(false);
  });

  it("POST/DELETE token creates and revokes bot token", async () => {
    const userId = `bot-token-owner-${crypto.randomUUID()}`;
    const createRes = await browserReq(
      userId,
      "POST",
      "/api/chat/bots",
      { display_name: "Rotate Bot", issue_initial_token: false },
      `key-token-create-owner-${crypto.randomUUID()}`,
    );
    const created = (await createRes.json()) as { bot: { bot_id: string } };

    const tokenRes = await browserReq(
      userId,
      "POST",
      `/api/chat/bots/${created.bot.bot_id}/tokens`,
      {
        name: "production",
        scopes: ["chat:runtime:connect", "chat:commands:manage"],
      },
      `key-token-create-${crypto.randomUUID()}`,
    );
    expect(tokenRes.status).toBe(201);
    const tokenBody = (await tokenRes.json()) as {
      token: { token_id: string; plaintext: string; scopes: string[] };
    };
    expect(tokenBody.token.plaintext.startsWith("lcbot_")).toBe(true);
    expect(tokenBody.token.scopes).toEqual(["chat:runtime:connect", "chat:commands:manage"]);

    const revokeRes = await browserReq(
      userId,
      "DELETE",
      `/api/chat/bots/${created.bot.bot_id}/tokens/${tokenBody.token.token_id}`,
      undefined,
      `key-token-revoke-${crypto.randomUUID()}`,
    );
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as { token_id: string; revoked_at: string };
    expect(revokeBody.token_id).toBe(tokenBody.token.token_id);
    expect(revokeBody.revoked_at.length).toBeGreaterThan(0);
  });
});
