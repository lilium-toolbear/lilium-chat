import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { setupOwnedChannelForUser } from "../helpers";

describe("replay filters message.created when message is deleted", () => {
  it("created event absent from replay after delete", async () => {
    const userId = "u-replay-del-1";
    const { stub, channelId } = await setupOwnedChannelForUser(env, userId, {
      title: "ReplayDelete",
      visibility: "public_listed",
    });

    const send = (await (
      await stub.fetch(
        new Request("https://x/internal/message-send", {
          method: "POST",
          headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
          body: JSON.stringify({
            command_id: "cm-replay-del",
            dedupe_principal_key: `user:${userId}`,
            type: "text",
            text: "hi",
            reply_to: null,
            mentions: [],
            channel_id: channelId,
          }),
        }),
      )
    ).json()) as { event_id: string; message: { message_id: string } };

    const deleteRes = await stub.fetch(
      new Request("https://x/internal/message-delete", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({
          operation_id: "op-replay-del",
          message_id: send.message.message_id,
          channel_id: channelId,
        }),
      }),
    );
    expect(deleteRes.status).toBe(200);

    const replay = (await (
      await stub.fetch(new Request(`https://x/internal/replay?after=`, { headers: { "X-Verified-User-Id": userId } }))
    ).json()) as { events: Array<{ event_id: string; event_json: string }> };

    const created = replay.events.find((e) => e.event_id === send.event_id);
    expect(created).toBeUndefined();
  });
});
