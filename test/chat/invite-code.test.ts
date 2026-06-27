import { describe, expect, it } from "vitest";
import { personalInviteCode } from "../../src/chat/invite-code";

describe("personalInviteCode", () => {
  it("is stable for the same channel and user", async () => {
    const a = await personalInviteCode("0193aaaa-0000-7000-8000-000000000001", "u-stable");
    const b = await personalInviteCode("0193aaaa-0000-7000-8000-000000000001", "u-stable");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("differs across users in the same channel", async () => {
    const a = await personalInviteCode("0193aaaa-0000-7000-8000-000000000001", "u-a");
    const b = await personalInviteCode("0193aaaa-0000-7000-8000-000000000001", "u-b");
    expect(a).not.toBe(b);
  });
});
