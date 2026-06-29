import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import { createOwnedTestChannel, getNamedDo } from "../helpers";
import { nextAck, upgradeUserConnection } from "../ws-helpers";

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

const STATEFUL_EXECUTION = {
  mode: "stateful" as const,
  schema_version: 1,
  definition_hash: "sha256:stateful",
  stateful: {
    mutex_scope: "channel" as const,
    default_ttl_seconds: 3600,
    max_ttl_seconds: 7200,
    listen_capability: {
      message_types: ["text"],
      include_bot_messages: false,
      include_own_messages: true,
    },
  },
};

async function seedStatefulBinding(input: {
  channelId: string;
  userId: string;
  botId: string;
  botCommandId: string;
  manifestVersion: number;
  commandName?: string;
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
        name: input.commandName ?? "werewolf",
        aliases: [],
        description: "Stateful game",
        bot: { bot_id: input.botId, display_name: "Game Bot", avatar_url: null },
        options: [],
        default_member_permission: "member",
        execution: STATEFUL_EXECUTION,
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

async function openBotGateway(botId: string): Promise<{ ws: WebSocket; stub: DurableObjectStub; waitForType: (type: string) => Promise<Record<string, unknown>> }> {
  const stub = getNamedDo(env.BOT_CONNECTION as unknown as DurableObjectNamespace, botId);
  const res = await stub.fetch(new Request("https://x/bot", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": BOT_GATEWAY_API_VERSION,
      "X-Verified-Bot-Id": botId,
    },
  }));
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const frames: Record<string, unknown>[] = [];
  ws.addEventListener("message", (ev) => {
    try {
      frames.push(JSON.parse(typeof ev.data === "string" ? ev.data : "") as Record<string, unknown>);
    } catch {
      // ignore
    }
  });
  const waitForType = async (type: string, timeoutMs = 10000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idx = frames.findIndex((frame) => frame.type === type);
      if (idx >= 0) return frames.splice(idx, 1)[0] ?? {};
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for bot frame type ${type}`);
  };
  ws.send(JSON.stringify({
    type: "hello",
    api_version: BOT_GATEWAY_API_VERSION,
    last_received_delivery_id: null,
  }));
  await waitForType("ready");
  return { ws, stub, waitForType };
}

async function stopStatefulSession(input: {
  userId: string;
  channelId: string;
  sessionId: string;
  operationId: string;
  reason?: string;
}): Promise<{ ok?: boolean; session_id?: string; error?: { code?: string } }> {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace, input.channelId);
  const res = await stub.fetch(
    new Request("https://x/internal/stateful-session-stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Verified-User-Id": input.userId,
      },
      body: JSON.stringify({
        channel_id: input.channelId,
        session_id: input.sessionId,
        reason: input.reason ?? "admin_stop",
        operation_id: input.operationId,
      }),
    }),
  );
  return (await res.json()) as { ok?: boolean; session_id?: string; error?: { code?: string } };
}

async function invokeStatefulCommand(input: {
  userId: string;
  channelId: string;
  botCommandId: string;
  commandId?: string;
  invokedName?: string;
  options?: Record<string, { type: string; value: unknown }>;
}): Promise<{ ws: WebSocket; ack: { payload?: { session_id?: string }; error?: { code?: string; active_session?: Record<string, unknown> } } }> {
  const { ws } = await upgradeUserConnection(input.userId);
  ws.send(JSON.stringify({
    frame_type: "command",
    command: "command.invoke",
    command_id: input.commandId ?? `invoke-${crypto.randomUUID()}`,
    channel_id: input.channelId,
    payload: {
      bot_command_id: input.botCommandId,
      invoked_name: input.invokedName ?? "werewolf",
      command_manifest_version: 1,
      options: input.options ?? {},
    },
  }));
  const ack = JSON.parse(await nextAck(ws)) as {
    frame_type: string;
    status: string;
    payload?: { session_id?: string };
    error?: { code?: string; active_session?: Record<string, unknown> };
  };
  return { ws, ack };
}

const openedBotSockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of openedBotSockets.splice(0)) {
    ws.close();
  }
});

describe("stateful command sessions", () => {
  it("returns BOT_OFFLINE and creates no session row when bot disconnected", async () => {
    const userId = `stateful-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `stateful-bot-${crypto.randomUUID()}`;
    const botCommandId = `stateful-cmd-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Stateful Offline" },
    );
    await seedStatefulBinding({ channelId, userId, botId, botCommandId, manifestVersion: 1 });

    const { ws, ack } = await invokeStatefulCommand({ userId, channelId, botCommandId });
    expect(ack).toMatchObject({ frame_type: "command_error", error: { code: "BOT_OFFLINE" } });

    await withChannel(channelId, (ctx) => {
      const count = ctx.storage.sql
        .exec("SELECT COUNT(*) AS c FROM stateful_command_sessions WHERE channel_id=?", channelId)
        .toArray()[0] as { c: number };
      expect(Number(count.c)).toBe(0);
    });
    ws.close();
  });

  it("returns STATEFUL_SESSION_BUSY when second stateful invoke races same channel", async () => {
    const userId = `stateful-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `stateful-bot-${crypto.randomUUID()}`;
    const botCommandId = `stateful-cmd-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Stateful Busy" },
    );
    await seedStatefulBinding({ channelId, userId, botId, botCommandId, manifestVersion: 1 });
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);

    const first = await invokeStatefulCommand({ userId, channelId, botCommandId });
    expect(first.ack).toMatchObject({ frame_type: "command_ack", status: "committed" });
    expect(first.ack.payload?.session_id).toBeTruthy();

    const second = await invokeStatefulCommand({ userId, channelId, botCommandId });
    expect(second.ack).toMatchObject({
      frame_type: "command_error",
      error: { code: "STATEFUL_SESSION_BUSY" },
    });
    expect(second.ack.error?.active_session).toMatchObject({
      session_id: expect.any(String),
      command_name: "werewolf",
      started_by: expect.objectContaining({ user_id: userId }),
      started_at: expect.any(String),
      expires_at: expect.any(String),
    });

    first.ws.close();
    second.ws.close();
  });

  it("returns IDEMPOTENCY_CONFLICT before busy when same command_id has different body", async () => {
    const userId = `stateful-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `stateful-bot-${crypto.randomUUID()}`;
    const botCommandId = `stateful-cmd-${crypto.randomUUID()}`;
    const commandId = `idem-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Stateful Idempotency" },
    );
    await seedStatefulBinding({ channelId, userId, botId, botCommandId, manifestVersion: 1 });
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);

    const first = await invokeStatefulCommand({ userId, channelId, botCommandId, commandId });
    expect(first.ack).toMatchObject({ frame_type: "command_ack", status: "committed" });

    const { ws } = await upgradeUserConnection(userId);
    ws.send(JSON.stringify({
      frame_type: "command",
      command: "command.invoke",
      command_id: commandId,
      channel_id: channelId,
      payload: {
        bot_command_id: botCommandId,
        invoked_name: "",
        command_manifest_version: 1,
        options: {},
      },
    }));
    const conflictAck = JSON.parse(await nextAck(ws)) as {
      frame_type: string;
      error?: { code?: string };
    };
    expect(conflictAck).toMatchObject({
      frame_type: "command_error",
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
    ws.close();
    first.ws.close();
  });

  it("enqueues stateful session start in bot_delivery_outbox on invoke", async () => {
    const userId = `stateful-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `stateful-bot-${crypto.randomUUID()}`;
    const botCommandId = `stateful-cmd-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Stateful Outbox" },
    );
    await seedStatefulBinding({ channelId, userId, botId, botCommandId, manifestVersion: 1 });
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);

    const { ws, ack } = await invokeStatefulCommand({ userId, channelId, botCommandId });
    const sessionId = ack.payload?.session_id as string;
    expect(sessionId).toBeTruthy();

    await withChannel(channelId, (ctx) => {
      const row = ctx.storage.sql
        .exec(
          "SELECT kind, status, event_id FROM bot_delivery_outbox WHERE kind='stateful_session_start' AND event_id=?",
          sessionId,
        )
        .toArray()[0] as { kind: string; status: string; event_id: string } | undefined;
      expect(row?.kind).toBe("stateful_session_start");
      expect(row?.event_id).toBe(sessionId);
      expect(["pending", "delivered"]).toContain(row?.status);
    });
    ws.close();
  });

  it("does not emit stateful_session.started until bot sends session.start_ack", async () => {
    const userId = `stateful-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `stateful-bot-${crypto.randomUUID()}`;
    const botCommandId = `stateful-cmd-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Stateful Started Event" },
    );
    await seedStatefulBinding({ channelId, userId, botId, botCommandId, manifestVersion: 1 });
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);

    const sessionStartPromise = botGateway.waitForType("session.start");
    const { ws, ack } = await invokeStatefulCommand({ userId, channelId, botCommandId });
    const sessionId = ack.payload?.session_id as string;
    expect(sessionId).toBeTruthy();

    const sessionStart = await sessionStartPromise;
    expect(sessionStart.type).toBe("session.start");
    expect(sessionStart.session_id).toBe(sessionId);

    await withChannel(channelId, (ctx) => {
      const before = ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS c FROM events WHERE channel_id=? AND event_type='stateful_session.started'",
          channelId,
        )
        .toArray()[0] as { c: number };
      expect(Number(before.c)).toBe(0);
    });

    botGateway.ws.send(JSON.stringify({
      type: "session.start_ack",
      api_version: BOT_GATEWAY_API_VERSION,
      session_id: sessionId,
    }));

    for (let i = 0; i < 40; i++) {
      let found: { payload_json: string } | undefined;
      await withChannel(channelId, (ctx) => {
        found = ctx.storage.sql
          .exec(
            "SELECT payload_json FROM events WHERE channel_id=? AND event_type='stateful_session.started' LIMIT 1",
            channelId,
          )
          .toArray()[0] as { payload_json: string } | undefined;
      });
      if (found) {
        const payload = JSON.parse(found.payload_json) as {
          session?: { session_id?: string; status?: string; started_by_user_id?: string };
        };
        expect(payload.session?.session_id).toBe(sessionId);
        expect(payload.session?.status).toBe("active");
        expect(payload.session?.started_by_user_id).toBe(userId);
        ws.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("stateful_session.started not emitted");
  });

  it("rejects invoked_name that does not match command snapshot", async () => {
    const userId = `stateful-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `stateful-bot-${crypto.randomUUID()}`;
    const botCommandId = `stateful-cmd-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Invoked Name" },
    );
    await seedStatefulBinding({ channelId, userId, botId, botCommandId, manifestVersion: 1 });
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);

    const { ws, ack } = await invokeStatefulCommand({
      userId,
      channelId,
      botCommandId,
      invokedName: "poker",
    });
    expect(ack).toMatchObject({
      frame_type: "command_error",
      error: { code: "COMMAND_OPTIONS_INVALID" },
    });
    ws.close();
  });

  it("stop is idempotent for the same operation_id after session closes", async () => {
    const userId = `stateful-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `stateful-bot-${crypto.randomUUID()}`;
    const botCommandId = `stateful-cmd-${crypto.randomUUID()}`;
    const operationId = `stop-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Stateful Stop Idempotency" },
    );
    await seedStatefulBinding({ channelId, userId, botId, botCommandId, manifestVersion: 1 });
    const botGateway = await openBotGateway(botId);
    openedBotSockets.push(botGateway.ws);

    const { ws, ack } = await invokeStatefulCommand({ userId, channelId, botCommandId });
    const sessionId = ack.payload?.session_id as string;
    expect(sessionId).toBeTruthy();

    const firstStop = await stopStatefulSession({
      userId,
      channelId,
      sessionId,
      operationId,
    });
    expect(firstStop).toMatchObject({ ok: true, session_id: sessionId });

    const retryStop = await stopStatefulSession({
      userId,
      channelId,
      sessionId,
      operationId,
    });
    expect(retryStop).toMatchObject({ ok: true, session_id: sessionId });
    expect(retryStop.error?.code).toBeUndefined();

    ws.close();
  });

  it("reconnect uses BotConnection session refs to resume inputs from ChatChannel", async () => {
    const userId = `stateful-user-${crypto.randomUUID()}`;
    const channelId = crypto.randomUUID();
    const botId = `stateful-bot-${crypto.randomUUID()}`;
    const botCommandId = `stateful-cmd-${crypto.randomUUID()}`;

    await createOwnedTestChannel(
      env as unknown as Pick<import("../../src/env").Env, "CHAT_CHANNEL">,
      userId,
      { channelId, title: "Stateful Resume" },
    );
    await seedStatefulBinding({ channelId, userId, botId, botCommandId, manifestVersion: 1 });
    const firstGateway = await openBotGateway(botId);
    openedBotSockets.push(firstGateway.ws);

    const sessionStartPromise = firstGateway.waitForType("session.start");
    const { ack } = await invokeStatefulCommand({ userId, channelId, botCommandId });
    const sessionId = ack.payload?.session_id as string;
    await sessionStartPromise;

    firstGateway.ws.send(JSON.stringify({
      type: "session.start_ack",
      api_version: BOT_GATEWAY_API_VERSION,
      session_id: sessionId,
    }));

    for (let i = 0; i < 40; i++) {
      let active: { status: string } | undefined;
      await withChannel(channelId, (ctx) => {
        active = ctx.storage.sql
          .exec("SELECT status FROM stateful_command_sessions WHERE session_id=?", sessionId)
          .toArray()[0] as { status: string } | undefined;
      });
      if (active?.status === "active") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    firstGateway.ws.close();
    await new Promise((r) => setTimeout(r, 100));

    await withChannel(channelId, (ctx) => {
      ctx.storage.sql.exec(
        `INSERT INTO stateful_session_inputs (
           session_id, seq, channel_id, event_id, message_id, message_projection_json, status, created_at
         ) VALUES (?, 1, ?, ?, ?, ?, 'pending', ?)`,
        sessionId,
        channelId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        JSON.stringify({
          event: { event_id: crypto.randomUUID(), type: "message.created", occurred_at: new Date().toISOString() },
          message: { message_id: crypto.randomUUID(), type: "text", text: "resume me" },
        }),
        new Date().toISOString(),
      );
    });

    const secondGateway = await openBotGateway(botId);
    openedBotSockets.push(secondGateway.ws);

    const resumed = await secondGateway.waitForType("session.input");
    expect(resumed.type).toBe("session.input");
    expect(resumed.seq).toBe(1);
  });
});
