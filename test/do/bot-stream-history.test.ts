import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { computeFinalizeRequestHash } from "../../src/chat/stream-registry";
import { createTestChannel, getNamedDo } from "../helpers";

const BOT_ID = "bot-stream-history-1";

async function registerAndFinalize(
  stub: DurableObjectStub,
  channelId: string,
  resolvedText: string,
  components: unknown[] = [],
) {
  const clientEffectId = `eff-${crypto.randomUUID()}`;
  const registerRes = await stub.fetch(
    new Request("https://x/internal/stream-registry-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: channelId,
        bot_id: BOT_ID,
        client_effect_id: clientEffectId,
        request_hash: JSON.stringify({ format: "plain" }),
        sender_bot_display_name: "Stream Bot",
        sender_bot_avatar_url: null,
        message: { type: "text", format: "plain" },
      }),
    }),
  );
  expect(registerRes.status).toBe(200);
  const registerBody = (await registerRes.json()) as { message_id: string };
  const messageId = registerBody.message_id;
  const finalSeq = 1;
  const finalizeRequestHash = await computeFinalizeRequestHash({
    final_seq: finalSeq,
    resolved_text: resolvedText,
    components,
    attachment_ids: [],
  });

  const finalizeRes = await stub.fetch(
    new Request("https://x/internal/stream-finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: channelId,
        message_id: messageId,
        bot_id: BOT_ID,
        resolved_text: resolvedText,
        finalize_request_hash: finalizeRequestHash,
        final_seq: finalSeq,
        components,
        attachment_ids: [],
      }),
    }),
  );
  expect(finalizeRes.status).toBe(200);
  const finalizeBody = (await finalizeRes.json()) as { message_id: string; event_id: string };
  return { messageId, eventId: finalizeBody.event_id };
}

describe("stream finalize history and replay projection", () => {
  it("timeline history includes finalized message with full text", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = `owner-${crypto.randomUUID()}`;
    const stub = await createTestChannel(env, { channelId, ownerId });
    const resolvedText = "canonical final body";
    const { messageId, eventId } = await registerAndFinalize(stub, channelId, resolvedText);

    const historyRes = await stub.fetch(
      new Request("https://x/internal/messages", {
        headers: { "X-Verified-User-Id": ownerId },
      }),
    );
    expect(historyRes.status).toBe(200);
    const history = (await historyRes.json()) as {
      items: Array<{ type: string; event_id: string; payload: { message?: { text?: string | null; message_id?: string } } }>;
    };
    const finalized = history.items.find((item) => item.event_id === eventId);
    expect(finalized?.type).toBe("message.stream_finalized");
    expect(finalized?.payload.message?.message_id).toBe(messageId);
    expect(finalized?.payload.message?.text).toBe(resolvedText);
  });

  it("replay projection matches live event payload shape", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = `owner-${crypto.randomUUID()}`;
    const stub = await createTestChannel(env, { channelId, ownerId });
    const components = [
      {
        component_id: "btn-1",
        kind: "button",
        style: "primary",
        custom_id: "act-1",
        label: "Go",
      },
    ];
    const resolvedText = "with components";
    const { eventId } = await registerAndFinalize(stub, channelId, resolvedText, components);

    const { runInDurableObject } = await import("cloudflare:test");
    let liveEventJson = "";
    await runInDurableObject(stub, async (instance: unknown) => {
      const ctx = (instance as { ctx: DurableObjectState }).ctx;
      const outbox = ctx.storage.sql
        .exec(
          "SELECT payload_json FROM projection_outbox WHERE target_kind='channel_fanout' AND event_id=?",
          eventId,
        )
        .toArray()[0] as { payload_json: string } | undefined;
      const payload = outbox?.payload_json ? (JSON.parse(outbox.payload_json) as { event_json?: string }) : null;
      liveEventJson = payload?.event_json ?? "";
    });
    expect(liveEventJson).toBeTruthy();
    const liveFrame = JSON.parse(liveEventJson) as {
      type: string;
      event_id: string;
      payload: { message?: { text?: string | null; components?: unknown[] } };
    };
    expect(liveFrame.type).toBe("message.stream_finalized");
    expect(liveFrame.event_id).toBe(eventId);

    const replayRes = await stub.fetch(
      new Request("https://x/internal/replay?after=", {
        headers: { "X-Verified-User-Id": ownerId },
      }),
    );
    expect(replayRes.status).toBe(200);
    const replay = (await replayRes.json()) as { events: Array<{ event_id: string; event_json: string }> };
    const replayRow = replay.events.find((row) => row.event_id === eventId);
    expect(replayRow).toBeTruthy();
    const replayFrame = JSON.parse(replayRow!.event_json) as {
      type: string;
      payload: { message?: { text?: string | null; components?: unknown[] } };
    };
    expect(replayFrame.type).toBe("message.stream_finalized");
    expect(replayFrame.payload.message?.text).toBe(resolvedText);
    expect(replayFrame.payload.message?.components).toEqual(components);
    expect(replayFrame.payload.message?.text).toBe(liveFrame.payload.message?.text);
    expect(replayFrame.payload.message?.components).toEqual(liveFrame.payload.message?.components);
  });

  it("does not include stream message in history before finalize", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = `owner-${crypto.randomUUID()}`;
    const stub = await createTestChannel(env, { channelId, ownerId });
    const clientEffectId = `eff-${crypto.randomUUID()}`;
    const registerRes = await stub.fetch(
      new Request("https://x/internal/stream-registry-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId,
          bot_id: BOT_ID,
          client_effect_id: clientEffectId,
          request_hash: JSON.stringify({ format: "plain" }),
          sender_bot_display_name: "Stream Bot",
          sender_bot_avatar_url: null,
          message: { type: "text", format: "plain" },
        }),
      }),
    );
    const registerBody = (await registerRes.json()) as { message_id: string };
    const messageId = registerBody.message_id;

    const historyRes = await stub.fetch(
      new Request("https://x/internal/messages", {
        headers: { "X-Verified-User-Id": ownerId },
      }),
    );
    const history = (await historyRes.json()) as {
      items: Array<{ payload: { message?: { message_id?: string } } }>;
    };
    const hasMessage = history.items.some((item) => item.payload.message?.message_id === messageId);
    expect(hasMessage).toBe(false);

    const messageCount = await runInDoCount(stub, "SELECT COUNT(*) AS c FROM messages WHERE message_id=?", messageId);
    expect(messageCount).toBe(0);
  });
});

async function runInDoCount(stub: DurableObjectStub, query: string, ...params: unknown[]): Promise<number> {
  const { runInDurableObject } = await import("cloudflare:test");
  let count = 0;
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    const row = ctx.storage.sql.exec(query, ...params).toArray()[0] as { c: number };
    count = Number(row.c);
  });
  return count;
}
