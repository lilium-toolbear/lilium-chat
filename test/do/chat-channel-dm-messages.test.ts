import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createTestDmChannel } from "../helpers";

const USER_A = "00000000-0000-7000-8000-000000000a01";
const USER_B = "00000000-0000-7000-8000-000000000a02";

describe("ChatChannel DM message lifecycle", () => {
  it("message.send works on dm channel", async () => {
    const { stub, channelId } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const res = await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_A, "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: "dm-msg-1",
        dedupe_principal_key: `user:${USER_A}`,
        type: "text",
        text: "hello dm",
        reply_to: null,
        mentions: [],
        channel_id: channelId,
      }),
    }));
    expect(res.status).toBe(200);
    const out = await res.json() as { channel_id: string; event_id: string };
    expect(out.channel_id).toBe(channelId);
    expect(out.event_id).toBeTruthy();
  });

  it("non-sender cannot delete message on dm", async () => {
    const { stub, channelId } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const sendRes = await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_A, "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: "dm-msg-del",
        dedupe_principal_key: `user:${USER_A}`,
        type: "text",
        text: "delete me",
        reply_to: null,
        mentions: [],
        channel_id: channelId,
      }),
    }));
    const sent = await sendRes.json() as { message: { message_id: string } };
    const delRes = await stub.fetch(new Request("https://x/internal/message-delete", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_B, "Content-Type": "application/json" },
      body: JSON.stringify({
        operation_id: "dm-del-1",
        message_id: sent.message.message_id,
        channel_id: channelId,
        reason: null,
      }),
    }));
    expect(delRes.status).toBe(403);
  });
});
