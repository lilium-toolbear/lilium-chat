import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createTestChannel, getNamedDo } from "../helpers";

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

const seededBots = new Set<string>();

async function seedBot(botId: string, displayName = "Session Effect Bot"): Promise<void> {
  await withRegistry((ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      botId,
      "owner-1",
      displayName,
      null,
      null,
      "private",
      "active",
      "2026-06-30T00:00:00.000Z",
      "2026-06-30T00:00:00.000Z",
    );
  });
  seededBots.add(botId);
}

afterEach(async () => {
  for (const botId of seededBots) {
    await withRegistry((ctx) => {
      ctx.storage.sql.exec("DELETE FROM bot_apps WHERE bot_id=?", botId);
    });
  }
  seededBots.clear();
});

async function withDoState(
  stub: DurableObjectStub,
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

function sendMessageEffect(clientEffectId: string, text: string) {
  return {
    type: "send_message",
    client_effect_id: clientEffectId,
    message: {
      type: "text",
      format: "plain",
      text,
      reply_to_message_id: null,
      attachment_ids: [],
      components: [],
    },
  };
}

async function seedActiveSession(input: {
  stub: DurableObjectStub;
  channelId: string;
  botId: string;
  sessionId: string;
  effectLastAckedSeq?: number;
  status?: string;
}): Promise<void> {
  await withDoState(input.stub, (ctx) => {
    ctx.storage.sql.exec(
      `INSERT INTO stateful_command_sessions (
         session_id, channel_id, bot_id, bot_command_id, invocation_id, started_by_user_id,
         status, listen_rules_json, input_next_seq, input_last_acked_seq, effect_last_acked_seq,
         started_at, expires_at, closed_at, close_reason, summary_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, NULL, NULL, ?)`,
      input.sessionId,
      input.channelId,
      input.botId,
      "cmd-1",
      "inv-1",
      "user-1",
      input.status ?? "active",
      JSON.stringify({ message_types: ["text"], include_bot_messages: false, include_own_messages: true }),
      input.effectLastAckedSeq ?? 0,
      "2026-06-30T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
      JSON.stringify({ command_name: "game" }),
    );
  });
}

describe("ChatChannel botSessionEffects RPC", () => {
  it("applies send_message and bumps effect_last_acked_seq", async () => {
    const botId = `bot-session-eff-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const stub = await createTestChannel(env, { channelId, ownerId: "owner-1" });
    await seedActiveSession({ stub, channelId, botId, sessionId });

    const body = await stub.botSessionEffects({
      session_id: sessionId,
      bot_id: botId,
      effect_seq: 1,
      effects: [sendMessageEffect("eff-s1", "stateful reply")],
    });
    expect(body.status).toBe("applied");
    if (body.status !== "applied") return;
    expect(body.effect_results[0]?.type).toBe("send_message");

    await withDoState(stub, (ctx) => {
      const session = ctx.storage.sql
        .exec("SELECT effect_last_acked_seq FROM stateful_command_sessions WHERE session_id=?", sessionId)
        .toArray()[0] as { effect_last_acked_seq: number };
      expect(session.effect_last_acked_seq).toBe(1);
    });
  });

  it("replays ack without re-applying when effect_seq <= effect_last_acked_seq", async () => {
    const botId = `bot-session-idem-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const stub = await createTestChannel(env, { channelId, ownerId: "owner-1" });
    await seedActiveSession({ stub, channelId, botId, sessionId, effectLastAckedSeq: 0 });

    const effect = sendMessageEffect("eff-idem-s", "once");
    const first = await stub.botSessionEffects({
      session_id: sessionId,
      bot_id: botId,
      effect_seq: 1,
      effects: [effect],
    });
    expect(first.status).toBe("applied");

    const second = await stub.botSessionEffects({
      session_id: sessionId,
      bot_id: botId,
      effect_seq: 1,
      effects: [effect],
    });
    expect(second.status).toBe("applied");
    if (first.status !== "applied" || second.status !== "applied") return;
    const firstSend = first.effect_results.find((r) => r.type === "send_message");
    const secondSend = second.effect_results.find((r) => r.type === "send_message");
    expect(firstSend?.type).toBe("send_message");
    expect(secondSend?.type).toBe("send_message");
    if (firstSend?.type !== "send_message" || secondSend?.type !== "send_message") return;
    expect(secondSend.message_id).toBe(firstSend.message_id);

    await withDoState(stub, (ctx) => {
      const count = ctx.storage.sql
        .exec("SELECT COUNT(*) AS c FROM messages WHERE channel_id=? AND text=?", channelId, "once")
        .toArray()[0] as { c: number };
      expect(Number(count.c)).toBe(1);
    });
  });

  it("rejects effect sequence gap with BOT_EFFECT_INVALID", async () => {
    const botId = `bot-session-gap-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const stub = await createTestChannel(env, { channelId, ownerId: "owner-1" });
    await seedActiveSession({ stub, channelId, botId, sessionId, effectLastAckedSeq: 1 });

    const body = await stub.botSessionEffects({
      session_id: sessionId,
      bot_id: botId,
      effect_seq: 3,
      effects: [sendMessageEffect("eff-gap", "skipped")],
    });
    expect(body.status).toBe("rejected");
    if (body.status !== "rejected") return;
    expect(body.error.code).toBe("BOT_EFFECT_INVALID");
    expect(body.error.message).toContain("gap");
  });

  it("rejects when session is not active", async () => {
    const botId = `bot-session-inactive-${crypto.randomUUID()}`;
    await seedBot(botId);
    const channelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const stub = await createTestChannel(env, { channelId, ownerId: "owner-1" });
    await seedActiveSession({ stub, channelId, botId, sessionId, status: "starting" });

    const body = await stub.botSessionEffects({
      session_id: sessionId,
      bot_id: botId,
      effect_seq: 1,
      effects: [sendMessageEffect("eff-inactive", "nope")],
    });
    expect(body.status).toBe("rejected");
    if (body.status !== "rejected") return;
    expect(body.error.code).toBe("STATEFUL_SESSION_NOT_ACTIVE");
  });
});
