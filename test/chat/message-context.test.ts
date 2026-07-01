import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { buildMessageContextPage, type MessageContextPage } from "../../src/chat/message-context";
import type { Env } from "../../src/env";
import { ApiError } from "../../src/errors";
import {
  createTestChannel,
  mutateTestMessage,
  sendTestMessage,
} from "../helpers";

const { runInDurableObject } = await import("cloudflare:test") as {
  runInDurableObject: (
    stub: unknown,
    cb: (instance: unknown) => Promise<void>,
  ) => Promise<void>;
};

async function callBuildMessageContextPage(
  stub: DurableObjectStub,
  userId: string,
  messageId: string,
  beforeCount = 30,
  afterCount = 30,
): Promise<MessageContextPage> {
  let result: MessageContextPage | null = null;
  let thrown: unknown = null;
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState; env: Env }).ctx;
    const doEnv = (instance as { ctx: DurableObjectState; env: Env }).env;
    try {
      result = await buildMessageContextPage({
        sql: ctx.storage.sql,
        env: doEnv,
        userId,
        messageId,
        beforeCount,
        afterCount,
      });
    } catch (err) {
      thrown = err;
    }
  });
  if (thrown) throw thrown;
  if (result === null) throw new Error("buildMessageContextPage did not run");
  return result;
}

describe("buildMessageContextPage", () => {
  it("returns ascending timeline window centered on anchor message.created", async () => {
    const userId = "u-msg-ctx-unit-1";
    const channelId = "0198dddd-0000-7000-8000-000000000101";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId: userId,
      title: "Context Unit",
      visibility: "public_listed",
    });

    const send1 = (await (
      await sendTestMessage(stub, { userId, channelId, commandId: "cm-ctx-u-1", text: "one" })
    ).json()) as { message: { message_id: string } };
    const send2 = (await (
      await sendTestMessage(stub, { userId, channelId, commandId: "cm-ctx-u-2", text: "two" })
    ).json()) as { message: { message_id: string } };
    const send3 = (await (
      await sendTestMessage(stub, { userId, channelId, commandId: "cm-ctx-u-3", text: "three" })
    ).json()) as { message: { message_id: string } };

    const page = await callBuildMessageContextPage(stub, userId, send2.message.message_id, 1, 1);

    expect(page.anchor_message_id).toBe(send2.message.message_id);
    expect(page.items.length).toBeGreaterThanOrEqual(3);
    const ids = page.items.map((item) => item.event_id);
    expect(ids).toEqual([...ids].sort());
    expect(page.items.some((item) => item.type === "message.created" && item.payload.message?.message_id === send1.message.message_id)).toBe(true);
    expect(page.items.some((item) => item.type === "message.created" && item.payload.message?.message_id === send2.message.message_id)).toBe(true);
    expect(page.items.some((item) => item.type === "message.created" && item.payload.message?.message_id === send3.message.message_id)).toBe(true);
  });

  it("respects before/after event counts", async () => {
    const userId = "u-msg-ctx-unit-2";
    const channelId = "0198dddd-0000-7000-8000-000000000102";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId: userId,
      title: "Context Counts",
      visibility: "public_listed",
    });

    const sends: string[] = [];
    for (let i = 0; i < 5; i++) {
      const send = (await (
        await sendTestMessage(stub, { userId, channelId, commandId: `cm-ctx-u-c-${i}`, text: `msg-${i}` })
      ).json()) as { message: { message_id: string } };
      sends.push(send.message.message_id);
    }

    const page = await callBuildMessageContextPage(stub, userId, sends[2]!, 0, 0);
    expect(page.anchor_message_id).toBe(sends[2]);
    expect(page.items.filter((item) => item.type === "message.created").length).toBe(1);
    expect((page.items[0]!.payload as { message?: { message_id?: string } }).message?.message_id).toBe(sends[2]);
  });

  it("throws MESSAGE_NOT_FOUND when anchor is deleted", async () => {
    const userId = "u-msg-ctx-unit-3";
    const channelId = "0198dddd-0000-7000-8000-000000000103";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId: userId,
      title: "Context Deleted",
      visibility: "public_listed",
    });

    const send = (await (
      await sendTestMessage(stub, { userId, channelId, commandId: "cm-ctx-u-del", text: "gone" })
    ).json()) as { message: { message_id: string } };

    const deleteRes = await mutateTestMessage(stub, {
      userId,
      channelId,
      messageId: send.message.message_id,
      operation: "message.delete",
      operationId: "op-ctx-u-del",
    });
    expect(deleteRes.status).toBe(200);

    await expect(callBuildMessageContextPage(stub, userId, send.message.message_id)).rejects.toMatchObject({
      code: "MESSAGE_NOT_FOUND",
    });
  });

  it("throws FORBIDDEN for non-member on private channel", async () => {
    const ownerId = "u-msg-ctx-unit-owner";
    const strangerId = "u-msg-ctx-unit-stranger";
    const channelId = "0198dddd-0000-7000-8000-000000000104";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId,
      title: "Private Context",
      visibility: "private",
    });

    const send = (await (
      await sendTestMessage(stub, { userId: ownerId, channelId, commandId: "cm-ctx-u-priv", text: "secret" })
    ).json()) as { message: { message_id: string } };

    await expect(callBuildMessageContextPage(stub, strangerId, send.message.message_id)).rejects.toBeInstanceOf(ApiError);
    await expect(callBuildMessageContextPage(stub, strangerId, send.message.message_id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
