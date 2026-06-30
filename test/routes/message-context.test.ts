import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  createTestChannel,
  makeJwt,
  mutateTestMessage,
  sendTestMessage,
  TEST_SECRET,
} from "../helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (
    request: Request,
    envOverride?: unknown,
    ctx?: { waitUntil: () => void; passThroughOnException: () => void },
  ) => Promise<Response> | Response;
};

async function authedMessageContextReq(
  userId: string,
  channelId: string,
  messageId: string,
  qs = "",
): Promise<Response> {
  const token = await makeJwt({ sub: userId }, TEST_SECRET);
  const req = new Request(
    `https://chat.kuma.homes/api/chat/channels/${channelId}/messages/${messageId}/context?${qs}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return SELF.fetch(req, { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

describe("GET /api/chat/channels/{channel_id}/messages/{message_id}/context", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch(
      new Request("https://chat.kuma.homes/api/chat/channels/some-id/messages/some-msg/context"),
    );
    expect(res.status).toBe(401);
  });

  it("returns anchor_message_id and ascending timeline items for a member", async () => {
    const userId = "u-msg-ctx-route-1";
    const channelId = "0198dddd-0000-7000-8000-000000000201";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId: userId,
      title: "Context Route",
      visibility: "public_listed",
    });

    await sendTestMessage(stub, { userId, channelId, commandId: "cm-ctx-r-1", text: "before" });
    const anchorSend = (await (
      await sendTestMessage(stub, { userId, channelId, commandId: "cm-ctx-r-2", text: "anchor" })
    ).json()) as { message: { message_id: string } };
    await sendTestMessage(stub, { userId, channelId, commandId: "cm-ctx-r-3", text: "after" });

    const res = await authedMessageContextReq(userId, channelId, anchorSend.message.message_id, "before=2&after=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      anchor_message_id: string;
      items: Array<{ event_id: string; type: string; payload: { message?: { message_id?: string; text?: string | null } } }>;
    };

    expect(body.anchor_message_id).toBe(anchorSend.message.message_id);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    const ids = body.items.map((item) => item.event_id);
    expect(ids).toEqual([...ids].sort());
    expect(body.items.some((item) => item.type === "message.created" && item.payload.message?.text === "anchor")).toBe(true);
  });

  it("defaults before/after to 30 and clamps max to 50", async () => {
    const userId = "u-msg-ctx-route-2";
    const channelId = "0198dddd-0000-7000-8000-000000000202";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId: userId,
      title: "Context Defaults",
      visibility: "public_listed",
    });

    const send = (await (
      await sendTestMessage(stub, { userId, channelId, commandId: "cm-ctx-r-def", text: "only" })
    ).json()) as { message: { message_id: string } };

    const res = await authedMessageContextReq(userId, channelId, send.message.message_id);
    expect(res.status).toBe(200);

    const overMax = await authedMessageContextReq(
      userId,
      channelId,
      send.message.message_id,
      "before=999&after=999",
    );
    expect(overMax.status).toBe(200);
  });

  it("returns 404 CHANNEL_NOT_FOUND for a random channel_id", async () => {
    const userId = "u-msg-ctx-route-missing";
    const res = await authedMessageContextReq(
      userId,
      "0199eeee-0000-7000-8000-000000000001",
      "0199eeee-0000-7000-8000-000000000002",
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CHANNEL_NOT_FOUND");
  });

  it("returns 403 for non-member on a private channel", async () => {
    const ownerId = "u-msg-ctx-route-owner";
    const strangerId = "u-msg-ctx-route-stranger";
    const channelId = "0198dddd-0000-7000-8000-000000000203";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId,
      title: "Private Context Route",
      visibility: "private",
    });

    const send = (await (
      await sendTestMessage(stub, { userId: ownerId, channelId, commandId: "cm-ctx-r-priv", text: "hidden" })
    ).json()) as { message: { message_id: string } };

    const res = await authedMessageContextReq(strangerId, channelId, send.message.message_id);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 404 MESSAGE_NOT_FOUND when anchor is deleted", async () => {
    const userId = "u-msg-ctx-route-del";
    const channelId = "0198dddd-0000-7000-8000-000000000204";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId: userId,
      title: "Deleted Context Route",
      visibility: "public_listed",
    });

    const send = (await (
      await sendTestMessage(stub, { userId, channelId, commandId: "cm-ctx-r-del", text: "delete me" })
    ).json()) as { message: { message_id: string } };

    const deleteRes = await mutateTestMessage(stub, {
      userId,
      channelId,
      messageId: send.message.message_id,
      operation: "message.delete",
      operationId: "op-ctx-r-del",
    });
    expect(deleteRes.status).toBe(200);

    const res = await authedMessageContextReq(userId, channelId, send.message.message_id);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MESSAGE_NOT_FOUND");
  });
});
