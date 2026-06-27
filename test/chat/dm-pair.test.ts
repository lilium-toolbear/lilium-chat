import { describe, expect, it } from "vitest";
import { canonicalDmPairKey } from "../../src/chat/dm-pair";

const USER_A = "00000000-0000-7000-8000-000000000101";
const USER_B = "00000000-0000-7000-8000-000000000102";

describe("canonicalDmPairKey", () => {
  it("produces the same pair_key regardless of argument order", () => {
    const ab = canonicalDmPairKey(USER_A, USER_B);
    const ba = canonicalDmPairKey(USER_B, USER_A);
    expect(ab.pair_key).toBe(ba.pair_key);
    expect(ab.user_low).toBe(USER_A);
    expect(ab.user_high).toBe(USER_B);
  });

  it("orders user_low and user_high lexicographically", () => {
    const { user_low, user_high, pair_key } = canonicalDmPairKey(USER_B, USER_A);
    expect(user_low < user_high).toBe(true);
    expect(pair_key).toBe(`${user_low}:${user_high}`);
  });

  it("rejects equal user ids", () => {
    expect(() => canonicalDmPairKey(USER_A, USER_A)).toThrow();
  });
});
