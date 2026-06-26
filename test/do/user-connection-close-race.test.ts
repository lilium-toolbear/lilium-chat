import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { liveStartAndAck, upgradeUserConnection } from "../ws-helpers";

describe("UserConnection close race cleanup", () => {
  it("revokes fanout leases from SQL on close", async () => {
    const userId = "u-close-race";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", {
      method: "POST", body: JSON.stringify({ title: "Lilium" }),
    }));
    await sysStub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const { runDurableObjectAlarm } = await import("cloudflare:test") as { runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void> };
    await runDurableObjectAlarm(sysStub);
    const sysId = ((await (await sysStub.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": userId },
    }))).json()) as { channel_id: string }).channel_id;

    const fanout = getNamedDo(env.CHANNEL_FANOUT as unknown as Parameters<typeof getNamedDo>[0], sysId);
    const { ws, sessionId } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws);

    const dumpBefore = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Channel-Id": sysId },
    }))).json()) as { leases: Array<{ session_id: string }> };
    expect(dumpBefore.leases.some((l) => l.session_id === sessionId)).toBe(true);

    ws.close();
    await new Promise((r) => setTimeout(r, 150));

    const dumpAfter = (await (await fanout.fetch(new Request("https://x/dump", {
      headers: { "X-Channel-Id": sysId },
    }))).json()) as { leases: Array<{ session_id: string }> };
    expect(dumpAfter.leases.some((l) => l.session_id === sessionId)).toBe(false);
  });
});
