import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

describe("spike: MessageIndex lookup → ROUTE_INDEX_PENDING before flush, resolves after", () => {
  it("lookup miss then hit after outbox flush", async () => {
    const mid = "msg-routing-1";
    const idx = env.MESSAGE_INDEX.getByName(mid);

    const before = await idx.fetch(new Request(`https://x/get?message_id=${mid}`));
    const beforeBody = (await before.json()) as { channel_id?: string };
    expect(beforeBody.channel_id).toBeUndefined();

    await idx.fetch(
      new Request("https://x/upsert", {
        method: "POST",
        body: JSON.stringify({ message_id: mid, channel_id: "ch-routing-1" }),
      }),
    );

    const after = await idx.fetch(new Request(`https://x/get?message_id=${mid}`));
    const afterBody = (await after.json()) as { channel_id?: string };
    expect(afterBody.channel_id).toBe("ch-routing-1");
  });
});
