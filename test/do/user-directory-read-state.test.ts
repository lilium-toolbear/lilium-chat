import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

const USER = "u-rs-1";
const CHANNEL = "0197aaaa-0000-7000-8000-000000000001";
const USER_ADV = "u-rs-adv";
const CHANNEL_ADV = "0197aaaa-0000-7000-8000-000000000010";

async function seedMembership() {
  // Simulate a my_channels active row (normally written via the user_directory join outbox).
  const stub = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], USER);
  await stub.fetch(new Request("https://x/internal/upsert-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "join", channel_id: CHANNEL, kind: "channel", membership_version: 1 }),
  }));
  return stub;
}

describe("UserDirectory /internal/read-state", () => {
  it("sets last_read_event_id on first mark (advanced: true)", async () => {
    const stub = await seedMembership();
    const res = await stub.fetch(new Request("https://x/internal/read-state", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: CHANNEL, last_read_event_id: "01J00000000000000000000000" }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel_id: string; last_read_event_id: string; advanced: boolean };
    expect(body.channel_id).toBe(CHANNEL);
    expect(body.last_read_event_id).toBe("01J00000000000000000000000");
    expect(body.advanced).toBe(true);
  });

  it("same cursor re-mark → advanced:false (no emit field)", async () => {
    const stub = await seedMembership();
    const cursor = "01J00000000000000000000010";
    const r1 = await stub.fetch(new Request("https://x/internal/read-state", { method: "POST", headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: CHANNEL, last_read_event_id: cursor }) }));
    const r2 = await stub.fetch(new Request("https://x/internal/read-state", { method: "POST", headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: CHANNEL, last_read_event_id: cursor }) }));
    const b1 = (await r1.json()) as { channel_id: string; advanced: boolean; last_read_event_id: string };
    const b2 = (await r2.json()) as { channel_id: string; advanced: boolean; last_read_event_id: string };
    expect(b1.advanced).toBe(true);
    expect(b2.advanced).toBe(false);
  });

  it("only advances monotonically: earlier cursor returns the STORED floor (not the request cursor)", async () => {
    const stub = await seedMembership();
    await stub.fetch(new Request("https://x/internal/read-state", { method: "POST", headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: CHANNEL, last_read_event_id: "01Jzzzzzzzzzzzzzzzzzzzzzz" }) }));
    const res = await stub.fetch(new Request("https://x/internal/read-state", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: CHANNEL, last_read_event_id: "01Jaaaaaaaaaaaaaaaaaaaaaaa" }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel_id: string; last_read_event_id: string; advanced: boolean };
    expect(body.last_read_event_id).toBe("01Jzzzzzzzzzzzzzzzzzzzzzz"); // stored floor, NOT the earlier request cursor
    expect(body.advanced).toBe(false);
  });

  it("403 if not an active member of the channel", async () => {
    const stub = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], "u-rs-nobody");
    const res = await stub.fetch(new Request("https://x/internal/read-state", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-rs-nobody", "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: "0197bbbb-0000-7000-8000-000000000002", last_read_event_id: "01Jx" }),
    }));
    expect(res.status).toBe(403);
  });

  it("returns advanced:false on same-cursor re-mark while preserving stored floor", async () => {
    const stub = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], USER_ADV);
    await stub.fetch(new Request("https://x/internal/upsert-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_ADV, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "join", channel_id: CHANNEL_ADV, kind: "channel", membership_version: 1 }),
    }));
    const cursor = "01J00000000000000000000020";
    const first = await stub.fetch(new Request("https://x/internal/read-state", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_ADV, "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: CHANNEL_ADV, last_read_event_id: cursor }),
    }));
    const second = await stub.fetch(new Request("https://x/internal/read-state", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_ADV, "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: CHANNEL_ADV, last_read_event_id: cursor }),
    }));
    const firstBody = (await first.json()) as { last_read_event_id: string; advanced: boolean };
    const secondBody = (await second.json()) as { last_read_event_id: string; advanced: boolean };
    expect(firstBody.advanced).toBe(true);
    expect(firstBody.last_read_event_id).toBe(cursor);
    expect(secondBody.advanced).toBe(false);
  });
});
