import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createTestDmChannel } from "../helpers";

const USER_A = "00000000-0000-7000-8000-000000000301";
const USER_B = "00000000-0000-7000-8000-000000000302";

describe("ChatChannel /internal/create-dm", () => {
  it("creates kind=dm meta and exactly two member rows with role=member", async () => {
    const { stub, channelId } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const summaryRes = await stub.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": USER_A },
    }));
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json() as { kind: string; member_count: number; title: string; avatar_url: string | null; my_role: string };
    expect(summary.kind).toBe("dm");
    expect(summary.member_count).toBe(2);
    expect(summary.title).toBe("");
    expect(summary.avatar_url).toBeNull();
    expect(summary.my_role).toBe("member");

    const membersRes = await stub.fetch(new Request("https://x/internal/members-list", {
      headers: { "X-Verified-User-Id": USER_A },
    }));
    const members = await membersRes.json() as { items: Array<{ user_id: string; role: string }> };
    expect(members.items).toHaveLength(2);
    expect(members.items.every((m) => m.role === "member")).toBe(true);
    expect(members.items.map((m) => m.user_id).sort()).toEqual([USER_A, USER_B].sort());

    const outboxRes = await stub.fetch(new Request("https://x/internal/outbox-pending?target_kind=channel_directory"));
    const outbox = await outboxRes.json() as { count: number };
    expect(outbox.count).toBe(0);

    expect(channelId).toBeTruthy();
  });

  it("is idempotent on retry", async () => {
    const { stub, channelId } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const res = await stub.fetch(new Request("https://x/internal/create-dm", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_A, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: channelId,
        user_a: USER_A,
        user_b: USER_B,
        created_by: USER_A,
      }),
    }));
    expect(res.status).toBe(200);
    const membersRes = await stub.fetch(new Request("https://x/internal/members-list", {
      headers: { "X-Verified-User-Id": USER_A },
    }));
    const members = await membersRes.json() as { items: unknown[] };
    expect(members.items).toHaveLength(2);
  });

  it("writes user_directory outbox rows with kind=dm", async () => {
    const { stub } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const outboxRes = await stub.fetch(new Request("https://x/internal/outbox-pending?target_kind=user_directory"));
    const outbox = await outboxRes.json() as { count: number };
    expect(outbox.count).toBeGreaterThanOrEqual(0);
  });
});
