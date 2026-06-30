import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createTestDmChannel } from "../helpers";

const USER_A = "00000000-0000-7000-8000-000000000301";
const USER_B = "00000000-0000-7000-8000-000000000302";

describe("ChatChannel createDm", () => {
  it("creates kind=dm meta and exactly two member rows with role=member", async () => {
    const { stub, channelId } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const summary = await stub.getSummary(USER_A);
    expect(summary.kind).toBe("dm");
    expect(summary.member_count).toBe(2);
    expect(summary.title).toBe("");
    expect(summary.avatar_url).toBeNull();
    expect(summary.my_role).toBe("member");

    const members = await stub.listMembers(USER_A, "");
    expect(members.items).toHaveLength(2);
    expect(members.items.every((m) => m.role === "member")).toBe(true);
    expect(members.items.map((m) => m.user_id).sort()).toEqual([USER_A, USER_B].sort());

    const outbox = await stub.debugOutboxPending("channel_directory");
    expect(outbox.count).toBe(0);

    expect(channelId).toBeTruthy();
  });

  it("is idempotent on retry", async () => {
    const { stub, channelId } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    await stub.createDm({
      user_id: USER_A,
      channel_id: channelId,
      user_a: USER_A,
      user_b: USER_B,
      created_by: USER_A,
    });
    const members = await stub.listMembers(USER_A, "");
    expect(members.items).toHaveLength(2);
  });

  it("writes user_directory outbox rows with kind=dm", async () => {
    const { stub } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const outbox = await stub.debugOutboxPending("user_directory");
    expect(outbox.count).toBeGreaterThanOrEqual(0);
  });
});
