import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo } from "../helpers";

async function setupSystemAndJoin(userId: string): Promise<{ stub: DurableObjectStub; channelId: string }> {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
  await stub.fetch(new Request("https://x/internal/maybe-create-system", {
    method: "POST",
    body: JSON.stringify({ title: "Lilium" }),
  }));
  await stub.fetch(
    new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }),
  );
  const channelId = (await (await stub.fetch(new Request("https://x/internal/summary", {
    headers: { "X-Verified-User-Id": userId },
  }))).json() as { channel_id: string }).channel_id;
  return { stub, channelId };
}

describe("ChatChannel /internal/message-send", () => {
  it("writes a message + event + outbox rows and returns full projection", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-1");
    const res = await stub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": "u-ms-1", "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: "cm-1",
          dedupe_principal_key: "user:u-ms-1",
          type: "text",
          text: "hello",
          reply_to: null,
          mentions: [],
          channel_id: channelId,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { channel_id: string; event_id: string; message: { message_id: string; command_id: string; sender: { user: { display_name: string } } } };
    expect(out.channel_id).toBe(channelId);
    expect(out.event_id).toBeTruthy();
    expect(out.message.message_id).toBeTruthy();
    expect(out.message.command_id).toBe("cm-1");
    expect(out.message.sender).toBeDefined();
    expect(out.message.sender).toHaveProperty("user");
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-2");
    const res = await stub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": "u-stranger", "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: "cm-x",
          dedupe_principal_key: "user:u-stranger",
          type: "text",
          text: "hi",
          reply_to: null,
          mentions: [],
          channel_id: channelId,
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("is idempotent on (dedupe_principal_key, command_id): same message_id + event_id", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-3");
    const body = {
      dedupe_principal_key: "user:u-ms-3",
      type: "text",
      text: "dup",
      reply_to: null,
      mentions: [],
      channel_id: channelId,
    };
    const a = (await (
      await stub.fetch(
        new Request("https://x/internal/message-send", {
          method: "POST",
          headers: { "X-Verified-User-Id": "u-ms-3", "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, command_id: "cm-dup" }),
        }),
      )
    ).json()) as { channel_id: string; event_id: string; message: { message_id: string } };
    const b = (await (
      await stub.fetch(
        new Request("https://x/internal/message-send", {
          method: "POST",
          headers: { "X-Verified-User-Id": "u-ms-3", "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, command_id: "cm-dup" }),
        }),
      )
    ).json()) as { channel_id: string; event_id: string; message: { message_id: string } };

    expect(a.message.message_id).toBe(b.message.message_id);
    expect(a.event_id).toBe(b.event_id);
  });

  it("returns IDEMPOTENCY_CONFLICT (409) when same command_id but different body", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-7");
    const base = {
      dedupe_principal_key: "user:u-ms-7",
      type: "text",
      reply_to: null,
      mentions: [],
      channel_id: channelId,
    };

    const a = await stub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": "u-ms-7", "Content-Type": "application/json" },
        body: JSON.stringify({ ...base, command_id: "cm-conflict", text: "first" }),
      }),
    );
    expect(a.status).toBe(200);

    const b = await stub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": "u-ms-7", "Content-Type": "application/json" },
        body: JSON.stringify({ ...base, command_id: "cm-conflict", text: "different" }),
      }),
    );
    expect(b.status).toBe(409);
    const bb = (await b.json()) as { error: { code: string } };
    expect(bb.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("different users, same command_id → different messages (namespacing)", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-4");
    await stub.fetch(
      new Request("https://x/internal/join", {
        method: "POST",
        headers: { "X-Verified-User-Id": "u-ms-5", "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: "u-ms-5" }),
      }),
    );

    const a = (await (
      await stub.fetch(
        new Request("https://x/internal/message-send", {
          method: "POST",
          headers: { "X-Verified-User-Id": "u-ms-4", "Content-Type": "application/json" },
          body: JSON.stringify({
            command_id: "shared",
            dedupe_principal_key: "user:u-ms-4",
            type: "text",
            text: "a",
            reply_to: null,
            mentions: [],
            channel_id: channelId,
          }),
        }),
      )
    ).json()) as { channel_id: string; event_id: string; message: { message_id: string } };
    const b = (await (
      await stub.fetch(
        new Request("https://x/internal/message-send", {
          method: "POST",
          headers: { "X-Verified-User-Id": "u-ms-5", "Content-Type": "application/json" },
          body: JSON.stringify({
            command_id: "shared",
            dedupe_principal_key: "user:u-ms-5",
            type: "text",
            text: "b",
            reply_to: null,
            mentions: [],
            channel_id: channelId,
          }),
        }),
      )
    ).json()) as { channel_id: string; event_id: string; message: { message_id: string } };

    expect(a.message.message_id).not.toBe(b.message.message_id);
  });

  it("/internal/replay returns the message.created event_json after creation, filtered by status", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-6");
    const send = (await (
      await stub.fetch(
        new Request("https://x/internal/message-send", {
          method: "POST",
          headers: { "X-Verified-User-Id": "u-ms-6", "Content-Type": "application/json" },
          body: JSON.stringify({
            command_id: "cm-r",
            dedupe_principal_key: "user:u-ms-6",
            type: "text",
            text: "replay me",
            reply_to: null,
            mentions: [],
            channel_id: channelId,
          }),
        }),
      )
    ).json()) as { channel_id: string; event_id: string; message: { message_id: string } };

    const replay = (await (
      await stub.fetch(new Request(`https://x/internal/replay?after=`, { headers: { "X-Verified-User-Id": "u-ms-6" } }))
    ).json()) as { events: Array<{ event_id: string; event_json: string }> };

    const found = replay.events.find((e) => e.event_id === send.event_id);
    expect(found).toBeDefined();
    expect(found?.event_json).toContain('"message.created"');
  });

  // P0-2 regression: idempotency_keys.response_json must store the FULL committed ack payload,
  // written co-atomically with the business rows — no crash window where response_json is "{}" and a
  // duplicate retry returns event_id:"" / message:null. We can't crash the DO mid-txn, but we assert
  // a duplicate retry returns the SAME complete ack (event_id + message present, not degraded).
  it("P0-2: duplicate retry returns the same complete ack (response_json is full, not {})", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-7");
    const body = {
      command_id: "cm-p02",
      dedupe_principal_key: "user:u-ms-7",
      type: "text",
      text: "p0-2 ack integrity",
      reply_to: null,
      mentions: [],
      channel_id: channelId,
    };
    const r1 = await (await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST", headers: { "X-Verified-User-Id": "u-ms-7", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }))).json() as { event_id: string; message: { message_id: string } };
    expect(r1.event_id).toBeTruthy();
    expect(r1.message.message_id).toBeTruthy();

    // Duplicate retry (same operation_id + same body) must return the SAME committed ack —
    // event_id present, message present (NOT the degraded {event_id:"",message:null} fallback
    // that an empty response_json would produce).
    const r2 = await (await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST", headers: { "X-Verified-User-Id": "u-ms-7", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }))).json() as { event_id: string; message: { message_id: string } | null };
    expect(r2.event_id).toBe(r1.event_id);
    expect(r2.message).not.toBeNull();
    expect(r2.message!.message_id).toBe(r1.message.message_id);
  });
});
