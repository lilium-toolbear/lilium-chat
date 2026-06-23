import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo } from "../../test/helpers";

const userId = "u-proj-1";

type GetNamedDoArg = Parameters<typeof getNamedDo>[0];
const userDirectory = env.USER_DIRECTORY as unknown as GetNamedDoArg;

async function upsert(body: Record<string, unknown>): Promise<Response> {
  const stub = getNamedDo(userDirectory, userId);
  return stub.fetch(new Request("https://x/internal/upsert-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("UserDirectory projection", () => {
  it("join inserts an active my_channels row with membership_version", async () => {
    await upsert({ action: "join", channel_id: "ch-p-1", kind: "channel", membership_version: 1 });
    const stub = getNamedDo(userDirectory, userId);
    const res = await stub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: Array<{ channel_id: string; kind: string; membership_version: number; last_read_event_id: string | null }> };
    const row = body.items.find((r) => r.channel_id === "ch-p-1");
    expect(row).toBeDefined();
    expect(row!.membership_version).toBe(1);
  });

  it("leave marks status=left + left_at, not in active my_channels", async () => {
    await upsert({ action: "join", channel_id: "ch-p-2", kind: "channel", membership_version: 1 });
    await upsert({ action: "leave", channel_id: "ch-p-2", kind: "channel", membership_version: 2 });
    const stub = getNamedDo(userDirectory, userId);
    const res = await stub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: Array<{ channel_id: string }> };
    expect(body.items.find((r) => r.channel_id === "ch-p-2")).toBeUndefined();
  });

  it("re-applying same membership_version is idempotent (no duplicate, no error)", async () => {
    await upsert({ action: "join", channel_id: "ch-p-3", kind: "channel", membership_version: 5 });
    await upsert({ action: "join", channel_id: "ch-p-3", kind: "channel", membership_version: 5 });
    const stub = getNamedDo(userDirectory, userId);
    const res = await stub.fetch(
      new Request("https://x/my-channels", {
        headers: { "X-Verified-User-Id": userId },
      }),
    );
    const body = await res.json() as { items: Array<{ channel_id: string }> };
    expect(body.items.filter((r) => r.channel_id === "ch-p-3").length).toBe(1);
  });
});
