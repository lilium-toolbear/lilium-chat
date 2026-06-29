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
  opts?: { admin?: boolean; idemKey?: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await makeJwt({ sub: userId, ...(opts?.admin ? { admin: true } : {}) }, TEST_SECRET)}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (opts?.idemKey) headers["Idempotency-Key"] = opts.idemKey;
  return SELF.fetch(
    new Request(`https://chat.kuma.homes${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    { ...env, JWT_SECRET: TEST_SECRET } as typeof env,
  );
}

describe("Admin Bot API", () => {
  it("GET /api/chat/admin/bots requires admin", async () => {
    const userId = `non-admin-${crypto.randomUUID()}`;
    const res = await browserReq(userId, "GET", "/api/chat/admin/bots");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_ACCESS_REQUIRED");
  });

  it("GET /api/chat/admin/bots lists bots across owners for admin", async () => {
    const ownerA = `owner-a-${crypto.randomUUID()}`;
    const ownerB = `owner-b-${crypto.randomUUID()}`;
    const adminId = `admin-${crypto.randomUUID()}`;
    const botA = `bot-a-${crypto.randomUUID()}`;
    const botB = `bot-b-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    await withRegistry((ctx) => {
      ctx.storage.sql.exec(
        `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, 'private', 'active', ?, ?)`,
        botA,
        ownerA,
        "Alpha Bot",
        now,
        now,
      );
      ctx.storage.sql.exec(
        `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, 'official', 'active', ?, ?)`,
        botB,
        ownerB,
        "Official Bot",
        now,
        now,
      );
    });

    const res = await browserReq(adminId, "GET", "/api/chat/admin/bots", undefined, { admin: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ bot_id: string; owner_user_id: string }> };
    expect(body.items.some((item) => item.bot_id === botA && item.owner_user_id === ownerA)).toBe(true);
    expect(body.items.some((item) => item.bot_id === botB && item.owner_user_id === ownerB)).toBe(true);
  });
});
