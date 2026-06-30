import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { dumpChannelFanout, getNamedDo, setupOwnedChannelForUser } from "../helpers";
import { liveStartAndAck, upgradeUserConnection } from "../ws-helpers";
import type { ChannelFanout } from "../../src/do/channel-fanout";

describe("UserConnection close race cleanup", () => {
  it("revokes fanout leases from SQL on close", async () => {
    const userId = "u-close-race";
    const { stub, channelId } = await setupOwnedChannelForUser(env, userId, { title: "Lilium", visibility: "public_listed" });

    const fanout = getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, channelId);
    const { ws, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws);

    const dumpBefore = await dumpChannelFanout(fanout, channelId);
    expect(dumpBefore.leases.some((l) => l.session_id === sessionId)).toBe(true);

    ws.close();
    await new Promise((r) => setTimeout(r, 150));

    const dumpAfter = await dumpChannelFanout(fanout, channelId);
    expect(dumpAfter.leases.some((l) => l.session_id === sessionId)).toBe(false);
    void stub;
  });
});
