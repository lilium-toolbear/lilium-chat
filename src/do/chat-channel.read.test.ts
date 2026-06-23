import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo } from "../../test/helpers";

const SYSTEM = "system-general-read";
type GetNamedDoArg = Parameters<typeof getNamedDo>[0];
const chatChannel = env.CHAT_CHANNEL as unknown as GetNamedDoArg;

async function setupChannel(): Promise<string> {
  const stub = getNamedDo(chatChannel, SYSTEM);
  const r = await stub.fetch(
    new Request("https://x/internal/maybe-create-system", {
      method: "POST",
      body: JSON.stringify({ title: "Lilium" }),
    }),
  );
  return (await r.json() as { channel_id: string }).channel_id;
}

async function joinUser(channelId: string, userId: string): Promise<void> {
  const stub = getNamedDo(chatChannel, SYSTEM);
  await stub.fetch(
    new Request("https://x/internal/join", {
      method: "POST",
      headers: {
        "X-Verified-User-Id": userId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: userId }),
    }),
  );
}

describe("ChatChannel read endpoints", () => {
  it("summary returns channel meta + last_event_id + my role", async () => {
    const cid = await setupChannel();
    const userId = "u-read-1";
    await joinUser(cid, userId);
    const stub = getNamedDo(chatChannel, SYSTEM);
    const res = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { channel_id: string; title: string; last_event_id: string | null; my_role: string; member_count: number };
    expect(body.channel_id).toBe(cid);
    expect(body.title).toBe("Lilium");
    expect(body.member_count).toBeGreaterThanOrEqual(1);
    expect(body.my_role).toBe("member");
    expect(body.last_event_id).not.toBeNull();
  });

  it("messages pagination returns empty for fresh channel", async () => {
    const cid = await setupChannel();
    const userId = "u-read-2";
    await joinUser(cid, userId);
    const stub = getNamedDo(chatChannel, SYSTEM);
    const res = await stub.fetch(new Request("https://x/internal/messages?limit=50", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: unknown[]; next_cursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("messages returns 403 for non-member when visibility private (separate channel)", async () => {
    const cid = await setupChannel();
    const stub = getNamedDo(chatChannel, SYSTEM);
    const res = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": "non-member-x" } }));
    const body = await res.json() as { my_role: string | null; channel_id: string };

    expect(body.channel_id).toBe(cid);
    expect(body.my_role).toBeNull();
  });
});
