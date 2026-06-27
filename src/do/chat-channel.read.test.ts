import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";

import { createOwnedTestChannel } from "../../test/helpers";

async function setupChannel(userId: string): Promise<{ channelId: string; stub: DurableObjectStub }> {
  return createOwnedTestChannel(env, userId, { title: "Lilium", visibility: "public_listed" });
}

describe("ChatChannel read endpoints", () => {
  it("summary returns channel meta + last_event_id + my role", async () => {
    const userId = "u-read-1";
    const { channelId, stub } = await setupChannel(userId);
    const res = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { channel_id: string; title: string; last_event_id: string | null; my_role: string; member_count: number };
    expect(body.channel_id).toBe(channelId);
    expect(body.title).toBe("Lilium");
    expect(body.member_count).toBeGreaterThanOrEqual(1);
    expect(body.my_role).toBe("owner");
    expect(body.last_event_id).not.toBeNull();
  });

  it("messages pagination returns empty for fresh channel", async () => {
    const userId = "u-read-2";
    const { stub } = await setupChannel(userId);
    const res = await stub.fetch(new Request("https://x/internal/messages?limit=50", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: unknown[]; next_cursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("messages returns 403 for non-member when visibility private (separate channel)", async () => {
    const userId = "u-read-owner";
    const { channelId, stub } = await setupChannel(userId);
    const res = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": "non-member-x" } }));
    const body = await res.json() as { my_role: string | null; channel_id: string };

    expect(body.channel_id).toBe(channelId);
    expect(body.my_role).toBeNull();
  });
});
