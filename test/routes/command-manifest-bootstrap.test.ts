import { describe, expect, it } from "vitest";
import { PLATFORM_HELP_BOT_COMMAND_ID } from "../../src/chat/platform-commands";
import { env } from "cloudflare:workers";
import { setupOwnedChannelForUser, makeJwt, TEST_SECRET } from "../helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown) => Promise<Response> | Response;
};

async function browserReq(userId: string, path: string): Promise<Response> {
  const token = await makeJwt({ sub: userId }, TEST_SECRET);
  return SELF.fetch(
    new Request(`https://chat.kuma.homes${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }),
    { ...env, JWT_SECRET: "test-jwt-secret-do-not-use-in-prod" } as typeof env,
  );
}

async function withChannel(
  channelStub: DurableObjectStub,
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(channelStub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

describe("bootstrap command manifest", () => {
  it("attaches command_manifest for requested non-dm channel", async () => {
    const userId = `bootstrap-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botCommandId = `cmd-${crypto.randomUUID()}`;
    const botId = `bot-${crypto.randomUUID()}`;
    const { stub } = await setupOwnedChannelForUser(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL" | "USER_DIRECTORY">,
      userId,
      { channelId, title: "Bootstrap Manifest Channel" },
    );

    await withChannel(stub, (ctx) => {
      const now = new Date().toISOString();
      ctx.storage.sql.exec(
        `INSERT INTO channel_command_bindings (
           channel_id, bot_command_id, bot_id, status, permission_override,
           command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
         ) VALUES (?, ?, ?, 'allowed', NULL, ?, NULL, ?, ?)`,
        channelId,
        botCommandId,
        botId,
        JSON.stringify({
          bot_command_id: botCommandId,
          name: "ask",
          aliases: ["ai"],
          description: "Ask bot",
          bot: { bot_id: botId, display_name: "Bootstrap Bot", avatar_url: null },
          options: [],
          default_member_permission: "member",
          execution: { mode: "stateless" },
        }),
        userId,
        now,
      );
      ctx.storage.sql.exec(
        "UPDATE channel_meta SET command_manifest_version=1, updated_at=? WHERE channel_id=?",
        now,
        channelId,
      );
    });

    const res = await browserReq(userId, `/api/chat/bootstrap?channel_id=${encodeURIComponent(channelId)}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      active_channel: { channel_id: string; kind: string } | null;
      command_manifest?: {
        version: number;
        items: Array<{ bot_command_id: string; name: string }>;
      };
    };
    expect(body.active_channel?.channel_id).toBe(channelId);
    expect(body.active_channel?.kind).toBe("channel");
    expect(body.command_manifest?.version).toBe(1);
    expect(body.command_manifest?.items).toHaveLength(2);
    expect(body.command_manifest?.items.some((item) => item.bot_command_id === botCommandId)).toBe(true);
    expect(body.command_manifest?.items.some((item) => item.bot_command_id === PLATFORM_HELP_BOT_COMMAND_ID)).toBe(true);
  });
});
