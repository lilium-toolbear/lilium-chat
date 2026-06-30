import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  computeAbandonedTextHash,
  computeFinalizeRequestHash,
  buildBotStreamWsUrl,
} from "../../src/chat/stream-registry";
import { createTestChannel, getNamedDo } from "../helpers";
import { tableExists, indexExists } from "../../src/do/sql-migrations";
import { CHAT_CHANNEL_CURRENT_SCHEMA_VERSION } from "../../src/do/migrations/chat-channel";

const BOT_ID = "bot-stream-test-1";

async function createChannelStub() {
  const channelId = crypto.randomUUID();
  const ownerId = `owner-${crypto.randomUUID()}`;
  const stub = await createTestChannel(env, { channelId, ownerId });
  return { stub, channelId, ownerId };
}

async function registerStream(
  stub: DurableObjectStub,
  input: {
    channelId: string;
    clientEffectId: string;
    requestHash?: string;
  },
) {
  const requestHash = input.requestHash ?? JSON.stringify({ format: "plain" });
  const res = await stub.fetch(
    new Request("https://x/internal/stream-registry-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: input.channelId,
        bot_id: BOT_ID,
        client_effect_id: input.clientEffectId,
        request_hash: requestHash,
        sender_bot_display_name: "Stream Bot",
        sender_bot_avatar_url: null,
        message: { type: "text", format: "plain" },
      }),
    }),
  );
  return { res, requestHash, body: res.ok ? ((await res.json()) as Record<string, unknown>) : null };
}

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

describe("stream-registry helpers", () => {
  it("builds stable ws_url and finalize hash", async () => {
    expect(buildBotStreamWsUrl("ch-1", "msg-1")).toBe(
      "/api/chat/bot/channels/ch-1/streams/msg-1/ws",
    );
    const hash = await computeFinalizeRequestHash({
      final_seq: 2,
      resolved_text: "hello",
      components: [],
      attachment_ids: [],
    });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await computeAbandonedTextHash("partial")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("ChatChannel stream registry internal routes", () => {
  it("migration creates message_stream_registry table and indexes", async () => {
    const channelId = `stream-mig-${crypto.randomUUID()}`;
    const stub = getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace, channelId);
    await stub.fetch(new Request("https://x/ping"));

    await withDoState(stub, (ctx) => {
      expect(tableExists(ctx, "message_stream_registry")).toBe(true);
      expect(indexExists(ctx, "idx_message_stream_registry_bot")).toBe(true);
      expect(indexExists(ctx, "idx_message_stream_registry_expiry")).toBe(true);
    });

    const versionRes = await stub.fetch(
      new Request("https://x/internal/schema-version", { headers: { "X-Test-Only": "1" } }),
    );
    const versionBody = (await versionRes.json()) as { current_version: number };
    expect(versionBody.current_version).toBe(CHAT_CHANNEL_CURRENT_SCHEMA_VERSION);
  });

  it("register + check happy path", async () => {
    const { stub, channelId } = await createChannelStub();
    const clientEffectId = `eff-${crypto.randomUUID()}`;
    const { res, body } = await registerStream(stub, { channelId, clientEffectId });
    expect(res.status).toBe(200);
    expect(body?.message_id).toBeTruthy();
    const messageId = body!.message_id as string;
    const stream = body!.stream as { ws_url: string; expires_at: string; channel_id: string; message_id: string };
    expect(stream.ws_url).toBe(buildBotStreamWsUrl(channelId, messageId));
    expect(stream.channel_id).toBe(channelId);
    expect(stream.message_id).toBe(messageId);
    expect(stream.expires_at).toBeTruthy();

    const checkRes = await stub.fetch(
      new Request("https://x/internal/stream-registry-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: channelId, message_id: messageId, bot_id: BOT_ID }),
      }),
    );
    expect(checkRes.status).toBe(200);
    const checkBody = (await checkRes.json()) as { ok: boolean; status: string };
    expect(checkBody.ok).toBe(true);
    expect(checkBody.status).toBe("streaming");
  });

  it("idempotent start_stream register returns same message_id and ws_url", async () => {
    const { stub, channelId } = await createChannelStub();
    const clientEffectId = `eff-idem-${crypto.randomUUID()}`;
    const requestHash = JSON.stringify({ format: "plain", type: "text" });

    const first = await registerStream(stub, { channelId, clientEffectId, requestHash });
    const second = await registerStream(stub, { channelId, clientEffectId, requestHash });

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(second.body?.message_id).toBe(first.body?.message_id);
    expect((second.body?.stream as { ws_url: string }).ws_url).toBe(
      (first.body?.stream as { ws_url: string }).ws_url,
    );

    await withDoState(stub, (ctx) => {
      const count = ctx.storage.sql
        .exec("SELECT COUNT(*) AS c FROM message_stream_registry WHERE channel_id=?", channelId)
        .toArray()[0] as { c: number };
      expect(Number(count.c)).toBe(1);
    });
  });

  it("register conflict on different request_hash", async () => {
    const { stub, channelId } = await createChannelStub();
    const clientEffectId = `eff-conflict-${crypto.randomUUID()}`;
    const first = await registerStream(stub, { channelId, clientEffectId, requestHash: "hash-a" });
    expect(first.res.status).toBe(200);

    const second = await registerStream(stub, { channelId, clientEffectId, requestHash: "hash-b" });
    expect(second.res.status).toBe(409);
    const err = (await second.res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("BOT_EFFECT_CONFLICT");
  });

  it("check rejects wrong bot, missing registry, expired, and non-streaming status", async () => {
    const { stub, channelId } = await createChannelStub();
    const clientEffectId = `eff-check-${crypto.randomUUID()}`;
    const { body } = await registerStream(stub, { channelId, clientEffectId });
    const messageId = body!.message_id as string;

    const wrongBot = await stub.fetch(
      new Request("https://x/internal/stream-registry-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: channelId, message_id: messageId, bot_id: "other-bot" }),
      }),
    );
    expect(wrongBot.status).toBe(404);

    const missing = await stub.fetch(
      new Request("https://x/internal/stream-registry-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: channelId, message_id: crypto.randomUUID(), bot_id: BOT_ID }),
      }),
    );
    expect(missing.status).toBe(404);

    await withDoState(stub, (ctx) => {
      ctx.storage.sql.exec(
        "UPDATE message_stream_registry SET expires_at=? WHERE channel_id=? AND message_id=?",
        new Date(Date.now() - 60_000).toISOString(),
        channelId,
        messageId,
      );
    });
    const expired = await stub.fetch(
      new Request("https://x/internal/stream-registry-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: channelId, message_id: messageId, bot_id: BOT_ID }),
      }),
    );
    expect(expired.status).toBe(410);
  });

  it("finalize writes message + stream_finalized event and is idempotent", async () => {
    const { stub, channelId } = await createChannelStub();
    const clientEffectId = `eff-fin-${crypto.randomUUID()}`;
    const { body } = await registerStream(stub, { channelId, clientEffectId });
    const messageId = body!.message_id as string;
    const resolvedText = "final stream text";
    const finalizeRequestHash = await computeFinalizeRequestHash({
      final_seq: 1,
      resolved_text: resolvedText,
      components: [],
      attachment_ids: [],
    });

    const finalizeBody = {
      channel_id: channelId,
      message_id: messageId,
      bot_id: BOT_ID,
      resolved_text: resolvedText,
      finalize_request_hash: finalizeRequestHash,
      final_seq: 1,
      components: [],
      attachment_ids: [],
    };

    const first = await stub.fetch(
      new Request("https://x/internal/stream-finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalizeBody),
      }),
    );
    expect(first.status).toBe(200);
    const firstPayload = (await first.json()) as { message_id: string; event_id: string };
    expect(firstPayload.message_id).toBe(messageId);
    expect(firstPayload.event_id).toBeTruthy();

    const second = await stub.fetch(
      new Request("https://x/internal/stream-finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalizeBody),
      }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstPayload);

    await withDoState(stub, (ctx) => {
      const registry = ctx.storage.sql
        .exec("SELECT status, finalize_request_hash, final_event_id FROM message_stream_registry WHERE channel_id=? AND message_id=?", channelId, messageId)
        .toArray()[0] as { status: string; finalize_request_hash: string; final_event_id: string };
      expect(registry.status).toBe("finalized");
      expect(registry.finalize_request_hash).toBe(finalizeRequestHash);
      expect(registry.final_event_id).toBe(firstPayload.event_id);

      const message = ctx.storage.sql
        .exec("SELECT text, stream_state, status, created_at FROM messages WHERE message_id=?", messageId)
        .toArray()[0] as { text: string; stream_state: string; status: string; created_at: string };
      expect(message.text).toBe(resolvedText);
      expect(message.stream_state).toBe("final");
      expect(message.status).toBe("normal");

      const events = ctx.storage.sql
        .exec("SELECT event_type FROM events WHERE event_id=?", firstPayload.event_id)
        .toArray()[0] as { event_type: string };
      expect(events.event_type).toBe("message.stream_finalized");

      const createdCount = ctx.storage.sql
        .exec("SELECT COUNT(*) AS c FROM events WHERE event_type='message.created' AND payload_json LIKE ?", `%${messageId}%`)
        .toArray()[0] as { c: number };
      expect(Number(createdCount.c)).toBe(0);
    });

    const conflictHash = await computeFinalizeRequestHash({
      final_seq: 2,
      resolved_text: "different",
      components: [],
      attachment_ids: [],
    });
    const conflict = await stub.fetch(
      new Request("https://x/internal/stream-finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...finalizeBody, finalize_request_hash: conflictHash, final_seq: 2, resolved_text: "different" }),
      }),
    );
    expect(conflict.status).toBe(409);
  });

  it("abandon with partial writes failed message and is idempotent", async () => {
    const { stub, channelId } = await createChannelStub();
    const clientEffectId = `eff-abn-${crypto.randomUUID()}`;
    const { body } = await registerStream(stub, { channelId, clientEffectId });
    const messageId = body!.message_id as string;
    const partial = "partial text";
    const abandonedTextHash = await computeAbandonedTextHash(partial);

    const abandonBody = {
      channel_id: channelId,
      message_id: messageId,
      bot_id: BOT_ID,
      resolved_partial: partial,
      abandoned_text_hash: abandonedTextHash,
    };

    const first = await stub.fetch(
      new Request("https://x/internal/stream-abandon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(abandonBody),
      }),
    );
    expect(first.status).toBe(200);
    const firstPayload = (await first.json()) as { message_id: string; event_id: string };

    const second = await stub.fetch(
      new Request("https://x/internal/stream-abandon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(abandonBody),
      }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstPayload);

    await withDoState(stub, (ctx) => {
      const registry = ctx.storage.sql
        .exec("SELECT status, abandoned_text_hash FROM message_stream_registry WHERE channel_id=? AND message_id=?", channelId, messageId)
        .toArray()[0] as { status: string; abandoned_text_hash: string };
      expect(registry.status).toBe("abandoned");
      expect(registry.abandoned_text_hash).toBe(abandonedTextHash);

      const message = ctx.storage.sql
        .exec("SELECT text, stream_state, status FROM messages WHERE message_id=?", messageId)
        .toArray()[0] as { text: string; stream_state: string; status: string };
      expect(message.text).toBe(partial);
      expect(message.stream_state).toBe("abandoned");
      expect(message.status).toBe("failed");

      const events = ctx.storage.sql
        .exec("SELECT event_type FROM events WHERE event_id=?", firstPayload.event_id)
        .toArray()[0] as { event_type: string };
      expect(events.event_type).toBe("message.stream_abandoned");
    });
  });

  it("abandon with empty partial marks registry abandoned without canonical rows", async () => {
    const { stub, channelId } = await createChannelStub();
    const clientEffectId = `eff-empty-${crypto.randomUUID()}`;
    const { body } = await registerStream(stub, { channelId, clientEffectId });
    const messageId = body!.message_id as string;
    const emptyHash = await computeAbandonedTextHash("");

    const res = await stub.fetch(
      new Request("https://x/internal/stream-abandon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId,
          message_id: messageId,
          bot_id: BOT_ID,
          resolved_partial: "",
          abandoned_text_hash: emptyHash,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; canonical: boolean };
    expect(payload.ok).toBe(true);
    expect(payload.canonical).toBe(false);

    await withDoState(stub, (ctx) => {
      const registry = ctx.storage.sql
        .exec("SELECT status FROM message_stream_registry WHERE channel_id=? AND message_id=?", channelId, messageId)
        .toArray()[0] as { status: string };
      expect(registry.status).toBe("abandoned");

      const messageCount = ctx.storage.sql
        .exec("SELECT COUNT(*) AS c FROM messages WHERE message_id=?", messageId)
        .toArray()[0] as { c: number };
      expect(Number(messageCount.c)).toBe(0);
    });
  });
});
