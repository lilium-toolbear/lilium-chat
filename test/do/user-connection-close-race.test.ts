import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, setupOwnedChannelForUser } from "../helpers";
import { liveStartAndAck, upgradeUserConnection } from "../ws-helpers";

describe("UserConnection close race cleanup", () => {
  it("revokes fanout leases from SQL on close", async () => {
    const userId = "u-close-race";
    const { stub, channelId } = await setupOwnedChannelForUser(env, userId, { title: "Lilium", visibility: "public_listed" });

    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);
    const { ws, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws);

    const dumpBefore = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Channel-Id": channelId },
    }))).json()) as { leases: Array<{ session_id: string }> };
    expect(dumpBefore.leases.some((l) => l.session_id === sessionId)).toBe(true);

    ws.close();
    await new Promise((r) => setTimeout(r, 150));

    const dumpAfter = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Channel-Id": channelId },
    }))).json()) as { leases: Array<{ session_id: string }> };
    expect(dumpAfter.leases.some((l) => l.session_id === sessionId)).toBe(false);
    void stub;
  });
});
