import { afterEach, describe, expect, it } from "vitest";
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
      "Test Bot",
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
      JSON.stringify(opts.scopes ?? ["chat:runtime:connect"]),
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

const seededBotIds = new Set<string>();
afterEach(async () => {
  for (const botId of [...seededBotIds]) await cleanupBot(botId);
});

async function botWsUpgrade(token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": "lilium.chat.bot.v1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch(
    new Request("https://chat.kuma.homes/api/chat/bot/ws", {
      method: "GET",
      headers,
    }),
    env,
  );
}

describe("GET /api/chat/bot/ws (7b-ws-route)", () => {
  it("upgrades with valid bot token and returns lilium.chat.bot.v1 subprotocol", async () => {
    const botId = `bot-upgrade-ok-${crypto.randomUUID()}`;
    const token = "secret-upgrade-ok";
    await seedBot({ botId, token });

    const res = await botWsUpgrade(token);
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe("lilium.chat.bot.v1");

    // ensure DO got the upgrade request rather than a plain HTTP error wrapper
    expect(res.webSocket).toBeTruthy();
  });

  it("returns 401 for unknown bot token", async () => {
    const res = await botWsUpgrade("never-issued");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for revoked bot token", async () => {
    const botId = `bot-upgrade-revoked-${crypto.randomUUID()}`;
    const token = "secret-upgrade-revoked";
    await seedBot({ botId, token, revoked: true });

    const res = await botWsUpgrade(token);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when Authorization is missing", async () => {
    const res = await botWsUpgrade();
    expect(res.status).toBe(401);
  });
});
