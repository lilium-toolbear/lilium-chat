import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  PLATFORM_HELP_BOT_COMMAND_ID,
  PLATFORM_PERMISSION_BOT_COMMAND_ID,
} from "../../src/chat/platform-commands";
import { createOwnedTestChannel, addTestMember, getNamedDo } from "../helpers";
import type { CommandManifestResponse } from "../../src/contract/bot-api";
import type { ChatChannel } from "../../src/do/chat-channel";
import { nextAck, upgradeUserConnection } from "../ws-helpers";

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

const seededOfficialBotIds = new Set<string>();

async function seedOfficialCommand(opts: {
  botId: string;
  botCommandId: string;
  commandName: string;
  aliases?: string[];
}): Promise<void> {
  const now = new Date().toISOString();
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (
         bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, NULL, 'official', 'active', ?, ?)`,
      opts.botId,
      "owner-1",
      "Official Bot",
      now,
      now,
    );
    ctx.storage.sql.exec(
      `INSERT INTO bot_commands (
         bot_command_id, bot_id, name, description, help_text, options_json, default_member_permission,
         execution_mode, stateful_config_json, status, schema_version, definition_hash, created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, '', '[]', 'member', 'stateless', NULL, 'active', 1, ?, ?, ?, NULL)`,
      opts.botCommandId,
      opts.botId,
      opts.commandName,
      `Run ${opts.commandName}`,
      `hash-${opts.botCommandId}`,
      now,
      now,
    );
    for (const alias of opts.aliases ?? []) {
      ctx.storage.sql.exec(
        "INSERT INTO bot_command_aliases (bot_command_id, bot_id, alias, created_at) VALUES (?, ?, ?, ?)",
        opts.botCommandId,
        opts.botId,
        alias,
        now,
      );
    }
  });
  seededOfficialBotIds.add(opts.botId);
}

async function cleanupOfficialBot(botId: string): Promise<void> {
  await withRegistry((ctx) => {
    ctx.storage.sql.exec("DELETE FROM bot_command_aliases WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_commands WHERE bot_id=?", botId);
    ctx.storage.sql.exec("DELETE FROM bot_apps WHERE bot_id=?", botId);
  });
  seededOfficialBotIds.delete(botId);
}

afterEach(async () => {
  for (const botId of [...seededOfficialBotIds]) await cleanupOfficialBot(botId);
});

async function withChannel(
  channelId: string,
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace, channelId);
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function seedAllowedCommandBinding(input: {
  channelId: string;
  userId: string;
  botId: string;
  botCommandId: string;
  commandName: string;
  manifestVersion: number;
}): Promise<void> {
  await withChannel(input.channelId, (ctx) => {
    const now = new Date().toISOString();
    ctx.storage.sql.exec(
      `INSERT INTO channel_command_bindings (
         channel_id, bot_command_id, bot_id, status, permission_override,
         command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
       ) VALUES (?, ?, ?, 'allowed', NULL, ?, NULL, ?, ?)`,
      input.channelId,
      input.botCommandId,
      input.botId,
      JSON.stringify({
        bot_command_id: input.botCommandId,
        name: input.commandName,
        aliases: [],
        description: `Run ${input.commandName}`,
        bot: { bot_id: input.botId, display_name: "Permission Bot", avatar_url: null },
        options: [],
        default_member_permission: "member",
        execution: { mode: "stateless" },
      }),
      input.userId,
      now,
    );
    ctx.storage.sql.exec(
      "UPDATE channel_meta SET command_manifest_version=?, updated_at=? WHERE channel_id=?",
      input.manifestVersion,
      now,
      input.channelId,
    );
  });
}

async function addChannelMember(
  channelId: string,
  actorUserId: string,
  memberUserId: string,
  role: "member" | "admin",
): Promise<void> {
  const stub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL as unknown as DurableObjectNamespace<ChatChannel>, channelId);
  await addTestMember(stub, {
    actorUserId,
    targetUserId: memberUserId,
    channelId,
    role,
  });
}

async function invokePermission(
  ws: WebSocket,
  channelId: string,
  manifestVersion: number,
  options: Record<string, { type: string; value: unknown }> = {},
): Promise<Record<string, unknown>> {
  const commandId = `perm-${crypto.randomUUID()}`;
  ws.send(JSON.stringify({
    frame_type: "command",
    command: "command.invoke",
    command_id: commandId,
    channel_id: channelId,
    payload: {
      bot_command_id: PLATFORM_PERMISSION_BOT_COMMAND_ID,
      invoked_name: "permission",
      command_manifest_version: manifestVersion,
      options,
    },
  }));
  return JSON.parse(await nextAck(ws)) as Record<string, unknown>;
}

describe("platform /permission", () => {
  it("owner list mode returns permission summary text message", async () => {
    const userId = `perm-owner-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `perm-bot-${crypto.randomUUID()}`;
    const botCommandId = `perm-cmd-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Permission Channel" },
    );
    await seedAllowedCommandBinding({
      channelId,
      userId,
      botId,
      botCommandId,
      commandName: "ask",
      manifestVersion: 1,
    });

    const { ws } = await upgradeUserConnection(userId);
    const ack = await invokePermission(ws, channelId, 1);
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.status).toBe("committed");
    const payload = ack.payload as { message?: { text?: string } };
    expect(payload.message?.text).toContain("当前频道命令权限");
    expect(payload.message?.text).toContain("/ask");
    ws.close();
  });

  it("member invoke returns COMMAND_PERMISSION_DENIED", async () => {
    const ownerId = `perm-owner-deny-${crypto.randomUUID()}`;
    const memberId = `perm-member-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      ownerId,
      { channelId, title: "Permission Deny Channel" },
    );
    await addChannelMember(channelId, ownerId, memberId, "member");

    const { ws } = await upgradeUserConnection(memberId);
    ws.send(JSON.stringify({
      frame_type: "command",
      command: "command.invoke",
      command_id: `perm-deny-${crypto.randomUUID()}`,
      channel_id: channelId,
      payload: {
        bot_command_id: PLATFORM_PERMISSION_BOT_COMMAND_ID,
        invoked_name: "permission",
        command_manifest_version: 0,
        options: {},
      },
    }));
    const frame = JSON.parse(await nextAck(ws)) as {
      frame_type: string;
      error?: { code?: string };
    };
    expect(frame.frame_type).toBe("command_error");
    expect(frame.error?.code).toBe("COMMAND_PERMISSION_DENIED");
    ws.close();
  });

  it("owner blocking a command emits command.binding_updated with manifest delta", async () => {
    const userId = `perm-block-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `perm-block-bot-${crypto.randomUUID()}`;
    const botCommandId = `perm-block-cmd-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Permission Block Channel" },
    );
    await seedAllowedCommandBinding({
      channelId,
      userId,
      botId,
      botCommandId,
      commandName: "talk",
      manifestVersion: 1,
    });

    const { ws } = await upgradeUserConnection(userId);
    const ack = await invokePermission(ws, channelId, 1, {
      command: { type: "string", value: "talk" },
      action: { type: "string", value: "off" },
    });
    expect(ack.status).toBe("committed");
    const payload = ack.payload as { message?: { text?: string } };
    expect(payload.message?.text).toContain("关闭");

    await withChannel(channelId, (ctx) => {
      const binding = ctx.storage.sql
        .exec(
          "SELECT status FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
          channelId,
          botCommandId,
        )
        .toArray()[0] as { status: string } | undefined;
      expect(binding?.status).toBe("blocked");

      const meta = ctx.storage.sql
        .exec("SELECT command_manifest_version FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { command_manifest_version: number } | undefined;
      expect(meta?.command_manifest_version).toBe(2);

      const event = ctx.storage.sql
        .exec(
          "SELECT payload_json FROM events WHERE channel_id=? AND event_type='command.binding_updated' ORDER BY event_id DESC LIMIT 1",
          channelId,
        )
        .toArray()[0] as { payload_json: string } | undefined;
      expect(event).toBeTruthy();
      const eventPayload = JSON.parse(event?.payload_json ?? "{}") as {
        command_manifest_delta?: { op?: string; manifest_version?: number };
      };
      expect(eventPayload.command_manifest_delta?.op).toBe("remove");
      expect(eventPayload.command_manifest_delta?.manifest_version).toBe(2);
    });

    ws.close();
  });

  it("owner manifest includes /permission but member manifest does not", async () => {
    const ownerId = `perm-manifest-owner-${crypto.randomUUID()}`;
    const memberId = `perm-manifest-member-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      ownerId,
      { channelId, title: "Permission Manifest Channel" },
    );
    await addChannelMember(channelId, ownerId, memberId, "member");

    const channelStub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL as unknown as DurableObjectNamespace<ChatChannel>, channelId);
    const ownerManifest = await channelStub.getChannelCommands(ownerId, channelId) as CommandManifestResponse;
    expect(ownerManifest.items.some((item) => item.bot_command_id === PLATFORM_PERMISSION_BOT_COMMAND_ID)).toBe(true);
    expect(ownerManifest.items.some((item) => item.bot_command_id === PLATFORM_HELP_BOT_COMMAND_ID)).toBe(true);

    const memberManifest = await channelStub.getChannelCommands(memberId, channelId) as CommandManifestResponse;
    expect(memberManifest.items.some((item) => item.bot_command_id === PLATFORM_PERMISSION_BOT_COMMAND_ID)).toBe(false);
    expect(memberManifest.items.some((item) => item.bot_command_id === PLATFORM_HELP_BOT_COMMAND_ID)).toBe(true);
  });

  it("owner can re-enable a blocked official command", async () => {
    const userId = `perm-official-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `official-bot-${crypto.randomUUID()}`;
    const botCommandId = `official-roll-${crypto.randomUUID()}`;

    await seedOfficialCommand({
      botId,
      botCommandId,
      commandName: "roll",
      aliases: ["r"],
    });
    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Official Permission Channel" },
    );

    const { ws } = await upgradeUserConnection(userId);
    const blockAck = await invokePermission(ws, channelId, 0, {
      command: { type: "string", value: "roll" },
      action: { type: "string", value: "off" },
    });
    expect(blockAck.status).toBe("committed");

    const enableAck = await invokePermission(ws, channelId, 1, {
      command: { type: "string", value: "roll" },
      action: { type: "string", value: "on" },
    });
    expect(enableAck.status).toBe("committed");
    const enablePayload = enableAck.payload as { message?: { text?: string } };
    expect(enablePayload.message?.text).toContain("开启");

    await withChannel(channelId, (ctx) => {
      const binding = ctx.storage.sql
        .exec(
          "SELECT status FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
          channelId,
          botCommandId,
        )
        .toArray()[0] as { status: string } | undefined;
      expect(binding).toBeUndefined();

      const meta = ctx.storage.sql
        .exec("SELECT command_manifest_version FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { command_manifest_version: number } | undefined;
      expect(meta?.command_manifest_version).toBe(2);
    });

    ws.close();
  });

  it("owner enabling an already-allowed official command returns OFFICIAL_COMMAND_AUTO_ALLOWED", async () => {
    const userId = `perm-official-dup-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `official-bot-dup-${crypto.randomUUID()}`;
    const botCommandId = `official-roll-dup-${crypto.randomUUID()}`;

    await seedOfficialCommand({
      botId,
      botCommandId,
      commandName: "roll",
    });
    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Official Permission Dup Channel" },
    );

    const { ws } = await upgradeUserConnection(userId);
    ws.send(JSON.stringify({
      frame_type: "command",
      command: "command.invoke",
      command_id: `perm-official-dup-${crypto.randomUUID()}`,
      channel_id: channelId,
      payload: {
        bot_command_id: PLATFORM_PERMISSION_BOT_COMMAND_ID,
        invoked_name: "permission",
        command_manifest_version: 0,
        options: {
          command: { type: "string", value: "roll" },
          action: { type: "string", value: "on" },
        },
      },
    }));
    const frame = JSON.parse(await nextAck(ws)) as {
      frame_type: string;
      error?: { code?: string };
    };
    expect(frame.frame_type).toBe("command_error");
    expect(frame.error?.code).toBe("OFFICIAL_COMMAND_AUTO_ALLOWED");
    ws.close();
  });
});
