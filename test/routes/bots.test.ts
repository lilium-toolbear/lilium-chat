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

  it("PATCH /api/chat/bots/:id updates avatar_url for owner", async () => {
    const userId = `bot-patch-owner-${crypto.randomUUID()}`;
    const createRes = await browserReq(
      userId,
      "POST",
      "/api/chat/bots",
      { display_name: "Patch Bot", issue_initial_token: false },
      `key-patch-create-${crypto.randomUUID()}`,
    );
    const created = (await createRes.json()) as { bot: { bot_id: string } };

    const patchRes = await browserReq(
      userId,
      "PATCH",
      `/api/chat/bots/${created.bot.bot_id}`,
      { avatar_url: "https://s3.kuma.homes/avatars/bot.png" },
      `key-patch-avatar-${crypto.randomUUID()}`,
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { bot: { avatar_url: string | null } };
    expect(patched.bot.avatar_url).toBe("https://s3.kuma.homes/avatars/bot.png");

    const getRes = await browserReq(userId, "GET", `/api/chat/bots/${created.bot.bot_id}`);
    const got = (await getRes.json()) as { bot: { avatar_url: string | null } };
    expect(got.bot.avatar_url).toBe("https://s3.kuma.homes/avatars/bot.png");
  });

  it("PATCH /api/chat/bots/:id returns 403 for non-owner", async () => {
    const ownerId = `bot-patch-owner-${crypto.randomUUID()}`;
    const otherId = `bot-patch-other-${crypto.randomUUID()}`;
    const createRes = await browserReq(
      ownerId,
      "POST",
      "/api/chat/bots",
      { display_name: "Owner Patch Bot", issue_initial_token: false },
      `key-patch-forbidden-create-${crypto.randomUUID()}`,
    );
    const created = (await createRes.json()) as { bot: { bot_id: string } };

    const forbiddenRes = await browserReq(
      otherId,
      "PATCH",
      `/api/chat/bots/${created.bot.bot_id}`,
      { avatar_url: "https://example.com/evil.png" },
      `key-patch-forbidden-${crypto.randomUUID()}`,
    );
    expect(forbiddenRes.status).toBe(403);
  });

  it("PATCH /api/chat/bots/:id updates description and visibility", async () => {
    const userId = `bot-patch-profile-${crypto.randomUUID()}`;
    const createRes = await browserReq(
      userId,
      "POST",
      "/api/chat/bots",
      { display_name: "Profile Bot", issue_initial_token: false },
      `key-profile-create-${crypto.randomUUID()}`,
    );
    const created = (await createRes.json()) as { bot: { bot_id: string } };

    const patchRes = await browserReq(
      userId,
      "PATCH",
      `/api/chat/bots/${created.bot.bot_id}`,
      { description: "Updated description", visibility: "public" },
      `key-profile-patch-${crypto.randomUUID()}`,
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      bot: { description: string | null; visibility: string };
    };
    expect(patched.bot.description).toBe("Updated description");
    expect(patched.bot.visibility).toBe("public");
  });

  it("PATCH /api/chat/bots/:id with status deleted removes bot from list", async () => {
    const userId = `bot-delete-owner-${crypto.randomUUID()}`;
    const createRes = await browserReq(
      userId,
      "POST",
      "/api/chat/bots",
      { display_name: "Delete Me", issue_initial_token: false },
      `key-delete-create-${crypto.randomUUID()}`,
    );
    const created = (await createRes.json()) as { bot: { bot_id: string } };

    const deleteRes = await browserReq(
      userId,
      "PATCH",
      `/api/chat/bots/${created.bot.bot_id}`,
      { status: "deleted" },
      `key-delete-bot-${crypto.randomUUID()}`,
    );
    expect(deleteRes.status).toBe(200);

    const listRes = await browserReq(userId, "GET", "/api/chat/bots");
    const listBody = (await listRes.json()) as { items: Array<{ bot_id: string }> };
    expect(listBody.items.some((item) => item.bot_id === created.bot.bot_id)).toBe(false);

    const getRes = await browserReq(userId, "GET", `/api/chat/bots/${created.bot.bot_id}`);
    expect(getRes.status).toBe(404);
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

  it("bot create, token create, and revoke append archive_outbox (hash only, no plaintext)", async () => {
    const userId = `bot-archive-owner-${crypto.randomUUID()}`;
    const createRes = await browserReq(
      userId,
      "POST",
      "/api/chat/bots",
      {
        display_name: "Archive Bot",
        issue_initial_token: true,
        initial_token_name: "initial",
      },
      `key-archive-create-${crypto.randomUUID()}`,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      bot: { bot_id: string };
      initial_token?: { token_id: string; plaintext: string };
    };
    expect(created.initial_token?.plaintext.startsWith("lcbot_")).toBe(true);

    const tokenRes = await browserReq(
      userId,
      "POST",
      `/api/chat/bots/${created.bot.bot_id}/tokens`,
      { name: "rotated" },
      `key-archive-token-${crypto.randomUUID()}`,
    );
    expect(tokenRes.status).toBe(201);
    const rotated = (await tokenRes.json()) as { token: { token_id: string; plaintext: string } };

    const revokeRes = await browserReq(
      userId,
      "DELETE",
      `/api/chat/bots/${created.bot.bot_id}/tokens/${rotated.token.token_id}`,
      undefined,
      `key-archive-revoke-${crypto.randomUUID()}`,
    );
    expect(revokeRes.status).toBe(200);

    await withRegistry((ctx) => {
      const rows = ctx.storage.sql
        .exec("SELECT payload_json FROM archive_outbox ORDER BY source_seq")
        .toArray() as Array<{ payload_json: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(3);

      const changes = rows.flatMap((row) => {
        const payload = JSON.parse(row.payload_json) as { changes: Array<{ table: string; op: string; after?: Record<string, unknown> }> };
        return payload.changes;
      });

      const appUpserts = changes.filter((c) => c.table === "chat_bot_apps" && c.op === "upsert");
      expect(appUpserts.some((c) => c.after?.bot_id === created.bot.bot_id)).toBe(true);

      const tokenUpserts = changes.filter((c) => c.table === "chat_bot_tokens" && c.op === "upsert");
      expect(
        tokenUpserts.some(
          (c) => c.after?.token_id === created.initial_token?.token_id && c.after?.revoked_at == null,
        ),
      ).toBe(true);
      expect(
        tokenUpserts.some(
          (c) => c.after?.token_id === rotated.token.token_id && c.after?.revoked_at != null,
        ),
      ).toBe(true);

      for (const change of tokenUpserts) {
        expect(change.after?.token_hash).toBeTruthy();
        expect(change.after).not.toHaveProperty("plaintext");
        expect(change.after).not.toHaveProperty("scopes_json");
      }

      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(created.initial_token!.plaintext);
      expect(serialized).not.toContain(rotated.token.plaintext);
    });
  });
});
