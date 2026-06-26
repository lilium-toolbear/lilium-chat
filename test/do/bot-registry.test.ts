import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { getNamedDo } from "../helpers";
import { ApiError, errorResponse } from "../../src/errors";
import type { Env as AppEnv } from "../../src/env";
import {
  botRegistryStub,
  getBotIdentity,
  hashBotToken,
  verifyBotToken,
  type BotIdentity,
} from "../../src/auth/bot";

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
  displayName?: string;
  avatarUrl?: string | null;
}): Promise<void> {
  const tokenHash = await hashBotToken(opts.token);
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, callback_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      opts.botId,
      "owner-1",
      opts.displayName ?? "Test Bot",
      opts.avatarUrl ?? null,
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
      JSON.stringify(opts.scopes ?? ["chat:commands:manage", "chat:runtime:connect"]),
      "2026-06-26T00:00:00.000Z",
      opts.revoked ? "2026-06-26T00:00:00.000Z" : null,
    );
  });
  seededBotIds.add(opts.botId);
}

async function cleanupBot(botId: string): Promise<void> {
  await withRegistry((ctx) => {
    ctx.storage.sql.exec("DELETE FROM bot_tokens WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_apps WHERE bot_id=?", botId);
  });
  seededBotIds.delete(botId);
}

afterEach(async () => {
  for (const botId of [...seededBotIds]) await cleanupBot(botId);
});

// Minimal Hono app to exercise getBotIdentity (auth + scope) end-to-end.
function botIdentityApp(requiredScope: string) {
  const app = new Hono<{ Bindings: AppEnv; Variables: { requestId: string } }>();
  app.post("/probe", async (c) => {
    try {
      const { botId } = await getBotIdentity(c, requiredScope);
      return c.json({ bot_id: botId });
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err, "req-test");
      throw err;
    }
  });
  return app;
}

describe("BotRegistry token-verify + bot-get (7a-bot-identity)", () => {
  it("verifyBotToken resolves a valid active bot token to {bot_id, scopes}", async () => {
    const botId = `bot-ok-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-ok", scopes: ["chat:commands:manage", "chat:runtime:connect"] });
    const id = await verifyBotToken(env as unknown as AppEnv, "secret-ok");
    expect(id.bot_id).toBe(botId);
    expect(id.scopes).toEqual(["chat:commands:manage", "chat:runtime:connect"]);
  });

  it("rejects an unknown token with UNAUTHORIZED", async () => {
    await expect(verifyBotToken(env as unknown as AppEnv, "never-issued")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects a revoked token with UNAUTHORIZED", async () => {
    const botId = `bot-revoked-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-revoked", revoked: true });
    await expect(verifyBotToken(env as unknown as AppEnv, "secret-revoked")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects a non-active bot with UNAUTHORIZED", async () => {
    const botId = `bot-disabled-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-disabled", status: "disabled" });
    await expect(verifyBotToken(env as unknown as AppEnv, "secret-disabled")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("/internal/bot-get returns the bot profile (no callback_secret/callback_url)", async () => {
    const botId = `bot-get-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-get", displayName: "Profile Bot", avatarUrl: "https://example.test/a.png" });
    const res = await REGISTRY().fetch(
      new Request(`https://x/internal/bot-get?bot_id=${botId}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.bot_id).toBe(botId);
    expect(body.display_name).toBe("Profile Bot");
    expect(body.avatar_url).toBe("https://example.test/a.png");
    expect(body.status).toBe("active");
    // never leak callback config (HTTP callback is future transport)
    expect(body.callback_secret).toBeUndefined();
    expect(body.callback_url).toBeUndefined();
  });

  it("/internal/bot-get returns 404 BOT_NOT_FOUND for unknown bot_id", async () => {
    const res = await REGISTRY().fetch(
      new Request("https://x/internal/bot-get?bot_id=nope"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BOT_NOT_FOUND");
  });

  it("getBotIdentity returns bot_id when scope is present", async () => {
    const botId = `bot-scope-ok-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-scope-ok", scopes: ["chat:commands:manage"] });
    const app = botIdentityApp("chat:commands:manage");
    const res = await app.fetch(
      new Request("https://x/probe", {
        method: "POST",
        headers: { Authorization: "Bearer secret-scope-ok", "Content-Type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { bot_id: string }).bot_id).toBe(botId);
  });

  it("getBotIdentity returns 403 FORBIDDEN when scope is missing", async () => {
    const botId = `bot-scope-missing-${crypto.randomUUID()}`;
    await seedBot({ botId, token: "secret-scope-missing", scopes: ["chat:messages:read"] });
    const app = botIdentityApp("chat:commands:manage");
    const res = await app.fetch(
      new Request("https://x/probe", {
        method: "POST",
        headers: { Authorization: "Bearer secret-scope-missing", "Content-Type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("getBotIdentity returns 401 without a bearer token", async () => {
    const app = botIdentityApp("chat:commands:manage");
    const res = await app.fetch(
      new Request("https://x/probe", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
