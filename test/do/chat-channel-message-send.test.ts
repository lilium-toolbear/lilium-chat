import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { MessageMutationAckPayload } from "../../src/contract/idempotency";

import {
  expectDoRpcError,
  joinTestChannel,
  replayTestEvents,
  rpcSendMessage,
  sendTestMessage,
  setupOwnedChannelForUser,
} from "../helpers";
import type { ChatChannel } from "../../src/do/chat-channel";

const { runInDurableObject } = await import("cloudflare:test") as {
  runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
};

type OutboxRow = {
  target_kind: string;
  status: string;
};

async function listProjectionOutbox(stub: DurableObjectStub): Promise<OutboxRow[]> {
  let out: OutboxRow[] = [];
  await runInDurableObject(stub, async (instance: unknown) => {
    out = (instance as {
      ctx: { storage: { sql: { exec: (q: string) => { toArray: () => OutboxRow[] } } } };
    }).ctx.storage.sql
      .exec("SELECT target_kind, status FROM projection_outbox ORDER BY created_at ASC")
      .toArray();
  });
  return out;
}

async function setupChannelAndJoin(userId: string): Promise<{ stub: DurableObjectStub<ChatChannel>; channelId: string }> {
  return setupOwnedChannelForUser(env, userId, { title: "Lilium", visibility: "public_listed" });
}

async function parseSend(res: Response): Promise<MessageMutationAckPayload> {
  return (await res.json()) as MessageMutationAckPayload;
}

describe("ChatChannel message send RPC", () => {
  it("writes a message + event + outbox rows and returns full projection", async () => {
    const { stub, channelId } = await setupChannelAndJoin("u-ms-1");
    const out = await parseSend(await sendTestMessage(stub, { userId: "u-ms-1", channelId, commandId: "cm-1", text: "hello" }));
    expect(out.channel_id).toBe(channelId);
    expect(out.event_id).toBeTruthy();
    expect(out.message.message_id).toBeTruthy();
    expect(out.message.command_id).toBe("cm-1");
    expect(out.message.sender).toBeDefined();
    expect(out.message.sender).toHaveProperty("user");

    const outbox = await listProjectionOutbox(stub);
    expect(outbox.some((r) => r.target_kind === "channel_fanout" && r.status === "pending")).toBe(true);
    expect(outbox.some((r) => r.target_kind === "channel_directory" && r.status === "pending")).toBe(true);
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const { stub, channelId } = await setupChannelAndJoin("u-ms-2");
    const res = await sendTestMessage(stub, { userId: "u-stranger", channelId, commandId: "cm-x", text: "hi" });
    expect(res.status).toBe(403);
  });

  it("is idempotent on (dedupe_principal_key, command_id): same message_id + event_id", async () => {
    const { stub, channelId } = await setupChannelAndJoin("u-ms-3");
    const body = {
      dedupe_principal_key: "user:u-ms-3",
      type: "text",
      text: "dup",
      reply_to: null,
      attachment_ids: [] as string[],
      mentions: [] as Array<{ user_id: string; start: number; end: number }>,
      channel_id: channelId,
    };
    const a = (await (await rpcSendMessage(stub, { user_id: "u-ms-3", command_id: "cm-dup", ...body })).json()) as {
      channel_id: string;
      event_id: string;
      message: { message_id: string };
    };
    const b = (await (await rpcSendMessage(stub, { user_id: "u-ms-3", command_id: "cm-dup", ...body })).json()) as {
      channel_id: string;
      event_id: string;
      message: { message_id: string };
    };

    expect(a.message.message_id).toBe(b.message.message_id);
    expect(a.event_id).toBe(b.event_id);
  });

  it("returns IDEMPOTENCY_CONFLICT (409) when same command_id but different body", async () => {
    const { stub, channelId } = await setupChannelAndJoin("u-ms-7");
    const base = {
      dedupe_principal_key: "user:u-ms-7",
      type: "text",
      reply_to: null,
      attachment_ids: [] as string[],
      mentions: [] as Array<{ user_id: string; start: number; end: number }>,
      channel_id: channelId,
    };

    const a = await rpcSendMessage(stub, { user_id: "u-ms-7", ...base, command_id: "cm-conflict", text: "first" });
    expect(a.status).toBe(200);

    const b = await rpcSendMessage(stub, { user_id: "u-ms-7", ...base, command_id: "cm-conflict", text: "different" });
    expect(b.status).toBe(409);
    const bb = (await b.json()) as { error: { code: string } };
    expect(bb.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("different users, same command_id → different messages (namespacing)", async () => {
    const { stub, channelId } = await setupChannelAndJoin("u-ms-4");
    await joinTestChannel(stub, "u-ms-5");

    const a = await parseSend(await sendTestMessage(stub, { userId: "u-ms-4", channelId, commandId: "shared", text: "a" }));
    const b = await parseSend(await sendTestMessage(stub, { userId: "u-ms-5", channelId, commandId: "shared", text: "b" }));

    expect(a.message.message_id).not.toBe(b.message.message_id);
  });

  it("replay RPC returns the message.created event_json after creation, filtered by status", async () => {
    const { stub, channelId } = await setupChannelAndJoin("u-ms-6");
    const send = await parseSend(await sendTestMessage(stub, { userId: "u-ms-6", channelId, commandId: "cm-r", text: "replay me" }));

    const replay = await replayTestEvents(stub, "u-ms-6");

    const found = replay.events.find((e) => e.event_id === send.event_id);
    expect(found).toBeDefined();
    expect(found?.event_json).toContain('"message.created"');
  });

  it("P0-2: duplicate retry returns the same complete ack (response_json is full, not {})", async () => {
    const { stub, channelId } = await setupChannelAndJoin("u-ms-7");
    const body = {
      command_id: "cm-p02",
      dedupe_principal_key: "user:u-ms-7",
      type: "text",
      text: "p0-2 ack integrity",
      reply_to: null,
      attachment_ids: [] as string[],
      mentions: [] as Array<{ user_id: string; start: number; end: number }>,
      channel_id: channelId,
    };
    const r1 = (await (await rpcSendMessage(stub, { user_id: "u-ms-7", ...body })).json()) as { event_id: string; message: { message_id: string } };
    expect(r1.event_id).toBeTruthy();
    expect(r1.message.message_id).toBeTruthy();

    const r2 = (await (await rpcSendMessage(stub, { user_id: "u-ms-7", ...body })).json()) as { event_id: string; message: { message_id: string } | null };
    expect(r2.event_id).toBe(r1.event_id);
    expect(r2.message).not.toBeNull();
    expect(r2.message!.message_id).toBe(r1.message.message_id);
  });

  it("persists reply_to and reply_snapshot when replying to a visible message", async () => {
    const { stub, channelId } = await setupChannelAndJoin("u-ms-reply");
    const original = await parseSend(await sendTestMessage(stub, { userId: "u-ms-reply", channelId, commandId: "cm-reply-target", text: "original message" }));

    const reply = await parseSend(await sendTestMessage(stub, {
      userId: "u-ms-reply",
      channelId,
      commandId: "cm-reply-send",
      text: "my reply",
      replyTo: original.message.message_id,
    }));

    expect(reply.message.reply_to).toBe(original.message.message_id);
    expect(reply.message.reply_snapshot).toMatchObject({
      message_id: original.message.message_id,
      text_preview: "original message",
      status: "normal",
    });
  });

  it("rejects reply_to when target message is missing", async () => {
    const { stub, channelId } = await setupChannelAndJoin("u-ms-reply-miss");
    const res = await sendTestMessage(stub, {
      userId: "u-ms-reply-miss",
      channelId,
      commandId: "cm-reply-miss",
      text: "orphan reply",
      replyTo: "00000000-0000-7000-8000-000000009999",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MESSAGE_NOT_FOUND");
  });
});
