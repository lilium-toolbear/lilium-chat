import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo } from "../../test/helpers";

const SYSTEM = "system-general";
type GetNamedDoArg = Parameters<typeof getNamedDo>[0];
const chatChannel = env.CHAT_CHANNEL as unknown as GetNamedDoArg;
const userDirectory = env.USER_DIRECTORY as unknown as GetNamedDoArg;

async function ensureSystem(): Promise<string> {
  const stub = getNamedDo(chatChannel, SYSTEM);
  const res = await stub.fetch(new Request("https://x/internal/maybe-create-system", {
    method: "POST",
    body: JSON.stringify({ title: "Lilium" }),
  }));
  const body = await res.json() as { channel_id: string };
  return body.channel_id;
}

describe("ChatChannel system channel", () => {
  it("maybe-create-system is idempotent (same channel_id across calls)", async () => {
    const id1 = await ensureSystem();
    const id2 = await ensureSystem();
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("join is idempotent and bumps membership_version only once for a new user", async () => {
    const channelId = await ensureSystem();
    const stub = getNamedDo(chatChannel, SYSTEM);
    const userId = "u-join-1";
    const r1 = await stub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const b1 = await r1.json() as { channel_id: string; membership_version: number };
    expect(b1.channel_id).toBe(channelId);
    expect(b1.membership_version).toBe(1);

    const r2 = await stub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const b2 = await r2.json() as { membership_version: number };
    expect(b2.membership_version).toBe(1);
  });

  it("join writes a projection_outbox row for user_directory", async () => {
    await ensureSystem();
    const stub = getNamedDo(chatChannel, SYSTEM);
    const userId = "u-join-2";
    await stub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));

    const probe = await stub.fetch(new Request("https://x/internal/outbox-pending?target_kind=user_directory"));
    const pb = await probe.json() as { count: number };
    expect(pb.count).toBeGreaterThanOrEqual(1);
  });

  it("end-to-end: join → alarm flush → UserDirectory my_channels contains the channel", async () => {
    const channelId = await ensureSystem();
    const stub = getNamedDo(chatChannel, SYSTEM);
    const userId = "u-e2e-1";
    await stub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (instance: unknown) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });

    const dirStub = getNamedDo(userDirectory, userId);
    const res = await dirStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: Array<{ channel_id: string }> };
    expect(body.items.find((r) => r.channel_id === channelId)).toBeDefined();
  });

  it("rejoin after leave reactivates and bumps membership_version (reviewer P1-4)", async () => {
    const channelId = await ensureSystem();
    const stub = getNamedDo(chatChannel, SYSTEM);
    const userId = "u-rejoin-1";

    const r1 = await stub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const b1 = await r1.json() as { membership_version: number };

    await stub.fetch(new Request("https://x/internal/test-leave", {
      method: "POST",
      headers: {
        "X-Verified-User-Id": userId,
        "X-Test-Only": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: userId }),
    }));

    const r2 = await stub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const b2 = await r2.json() as { membership_version: number };

    expect(channelId).toBe(channelId);
    expect(b2.membership_version).toBeGreaterThan(b1.membership_version);
  });
});
