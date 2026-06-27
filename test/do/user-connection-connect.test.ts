import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { upgradeUserConnection } from "../ws-helpers";

describe("UserConnection thin WS connect", () => {
  it("returns 101 with v2 subprotocol without cross-DO side effects", async () => {
    const userId = "u-connect-thin";
    const channelId = "ch-connect-thin";
    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], channelId);

    const { stub } = await upgradeUserConnection(userId);

    const dump = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Test-Only": "1", "X-Channel-Id": channelId },
    }))).json()) as { leases: unknown[] };
    expect(dump.leases.length).toBe(0);

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance: unknown, state: any) => {
      const rows = state.storage.sql
        .exec("SELECT status FROM live_sessions")
        .toArray() as Array<{ status: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.status).toBe("open");
    });
  });
});
