import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { mutateTestMessage, replayTestEvents, sendTestMessage, setupOwnedChannelForUser } from "../helpers";

describe("replay filters message.created when message is deleted", () => {
  it("created event absent from replay after delete", async () => {
    const userId = "u-replay-del-1";
    const { stub, channelId } = await setupOwnedChannelForUser(env, userId, {
      title: "ReplayDelete",
      visibility: "public_listed",
    });

    const send = (await (
      await sendTestMessage(stub, { userId, channelId, commandId: "cm-replay-del", text: "hi" })
    ).json()) as { event_id: string; message: { message_id: string } };

    const deleteRes = await mutateTestMessage(stub, {
      userId,
      channelId,
      messageId: send.message.message_id,
      operation: "message.delete",
      operationId: "op-replay-del",
    });
    expect(deleteRes.status).toBe(200);

    const replay = await replayTestEvents(stub, userId);

    const created = replay.events.find((e) => e.event_id === send.event_id);
    expect(created).toBeUndefined();
  });
});
