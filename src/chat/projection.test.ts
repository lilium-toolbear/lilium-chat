import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../../test/helpers";

const SYSTEM = "system-general";
type GetNamedDoArg = Parameters<typeof getNamedDo>[0];
const chatChannel = env.CHAT_CHANNEL as unknown as GetNamedDoArg;
const userDirectory = env.USER_DIRECTORY as unknown as GetNamedDoArg;

describe("projection outbox delivery (reviewer P0-1)", () => {
  it("flush delivers join → UserDirectory my_channels contains the channel", async () => {
    const sys = getNamedDo(chatChannel, SYSTEM);
    await sys.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    const userId = "u-proj-e2e-1";
    const jr = await sys.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const { channel_id } = await jr.json() as { channel_id: string };
    // drive the alarm flush
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(sys, async (instance) => { await (instance as { alarm: () => Promise<void> }).alarm(); });
    const dir = getNamedDo(userDirectory, userId);
    const res = await dir.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: Array<{ channel_id: string }> };
    expect(body.items.find((r) => r.channel_id === channel_id)).toBeDefined();
    // outbox row now delivered
    const probe = await sys.fetch(new Request("https://x/internal/outbox-pending?target_kind=user_directory"));
    const pb = await probe.json() as { count: number };
    expect(pb.count).toBe(0);
  });

  it("flush with X-Verified-User-Id header set (P0-1 regression) — target does not 400", async () => {
    // This guards against the original bug where the flush fetch omitted the header.
    const sys = getNamedDo(chatChannel, SYSTEM);
    await sys.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    const userId = "u-proj-header-1";
    await sys.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(sys, async (instance) => { await (instance as { alarm: () => Promise<void> }).alarm(); });
    // no dead_letter rows for this user
    const dir = getNamedDo(userDirectory, userId);
    const res = await dir.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: Array<{ channel_id: string }> };
    expect(body.items.length).toBeGreaterThan(0);
  });
});
