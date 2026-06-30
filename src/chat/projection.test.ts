import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { createTestChannel, joinTestChannel, readMyChannels } from "../../test/helpers";

describe("projection outbox delivery (reviewer P0-1)", () => {
  it("flush delivers join → UserDirectory my_channels contains the channel", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = "u-proj-owner-1";
    const userId = "u-proj-e2e-1";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId,
      title: "Lilium",
      visibility: "public_listed",
    });
    const jr = await joinTestChannel(stub, userId);
    const { channel_id } = jr;
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (instance) => { await (instance as { alarm: () => Promise<void> }).alarm(); });
    const items = await readMyChannels(env, userId);
    expect(items.find((r) => r.channel_id === channel_id)).toBeDefined();
    const pb = await stub.debugOutboxPending("user_directory");
    expect(pb.count).toBe(0);
  });

  it("flush with X-Verified-User-Id header set (P0-1 regression) — target does not 400", async () => {
    const channelId = crypto.randomUUID();
    const ownerId = "u-proj-owner-2";
    const userId = "u-proj-header-1";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId,
      title: "Lilium",
      visibility: "public_listed",
    });
    await joinTestChannel(stub, userId);
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (instance) => { await (instance as { alarm: () => Promise<void> }).alarm(); });
    const items = await readMyChannels(env, userId);
    expect(items.length).toBeGreaterThan(0);
  });
});
