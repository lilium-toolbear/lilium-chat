import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createTestDmChannel, mutateTestMessage, sendTestMessage } from "../helpers";

const USER_A = "00000000-0000-7000-8000-000000000a01";
const USER_B = "00000000-0000-7000-8000-000000000a02";

describe("ChatChannel DM message lifecycle", () => {
  it("message.send works on dm channel", async () => {
    const { stub, channelId } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const res = await sendTestMessage(stub, { userId: USER_A, channelId, commandId: "dm-msg-1", text: "hello dm" });
    expect(res.status).toBe(200);
    const out = await res.json() as { channel_id: string; event_id: string };
    expect(out.channel_id).toBe(channelId);
    expect(out.event_id).toBeTruthy();
  });

  it("non-sender cannot delete message on dm", async () => {
    const { stub, channelId } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const sendRes = await sendTestMessage(stub, { userId: USER_A, channelId, commandId: "dm-msg-del", text: "delete me" });
    const sent = await sendRes.json() as { message: { message_id: string } };
    const delRes = await mutateTestMessage(stub, {
      userId: USER_B,
      channelId,
      messageId: sent.message.message_id,
      operation: "message.delete",
      operationId: "dm-del-1",
    });
    expect(delRes.status).toBe(403);
  });
});
