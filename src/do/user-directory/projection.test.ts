import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";

import { getNamedDo } from "../../../test/helpers";
import type { UserDirectory } from "./object";

const userId = "u-proj-1";

const userDirectory = env.USER_DIRECTORY as unknown as DurableObjectNamespace<UserDirectory>;

function stub() {
  return getNamedDo<UserDirectory>(userDirectory, userId);
}

async function upsert(body: { action: "join" | "leave" | "dissolve"; channel_id: string; kind: string; membership_version: number }) {
  return stub().upsertChannelProjection(userId, body);
}

describe("UserDirectory projection", () => {
  it("join inserts an active my_channels row with membership_version", async () => {
    await upsert({ action: "join", channel_id: "ch-p-1", kind: "channel", membership_version: 1 });
    const body = await stub().listMyChannels(userId);
    const row = body.items.find((r) => r.channel_id === "ch-p-1");
    expect(row).toBeDefined();
    expect(row!.membership_version).toBe(1);
  });

  it("leave marks status=left + left_at, not in active my_channels", async () => {
    await upsert({ action: "join", channel_id: "ch-p-2", kind: "channel", membership_version: 1 });
    await upsert({ action: "leave", channel_id: "ch-p-2", kind: "channel", membership_version: 2 });
    const body = await stub().listMyChannels(userId);
    expect(body.items.find((r) => r.channel_id === "ch-p-2")).toBeUndefined();
  });

  it("dissolve marks status=dissolved and keeps channel in my_channels", async () => {
    await upsert({ action: "join", channel_id: "ch-p-dissolve", kind: "channel", membership_version: 1 });
    await upsert({ action: "dissolve", channel_id: "ch-p-dissolve", kind: "channel", membership_version: 2 });
    const body = await stub().listMyChannels(userId);
    expect(body.items.find((r) => r.channel_id === "ch-p-dissolve")).toBeDefined();
  });

  it("re-applying same membership_version is idempotent (no duplicate, no error)", async () => {
    await upsert({ action: "join", channel_id: "ch-p-3", kind: "channel", membership_version: 5 });
    await upsert({ action: "join", channel_id: "ch-p-3", kind: "channel", membership_version: 5 });
    const body = await stub().listMyChannels(userId);
    expect(body.items.filter((r) => r.channel_id === "ch-p-3").length).toBe(1);
  });
});
