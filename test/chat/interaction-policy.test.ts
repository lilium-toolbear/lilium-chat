import { describe, expect, it } from "vitest";
import {
  checkTargetedPolicy,
  policyBlocksExclusive,
  policyBlocksPerUserOnce,
  resolveInteractionPolicy,
  validateInteractionValue,
} from "../../src/chat/interaction-policy";

describe("interaction-policy", () => {
  const baseButton = {
    component_id: "cmp-1",
    kind: "button" as const,
    style: "primary" as const,
    label: "Go",
    custom_id: "go",
    disabled: false,
  };

  it("defaults missing policy to multi", () => {
    expect(resolveInteractionPolicy(baseButton)).toBe("multi");
  });

  it("validates button value must be true", () => {
    expect(validateInteractionValue(baseButton, true).ok).toBe(true);
    expect(validateInteractionValue(baseButton, false).ok).toBe(false);
  });

  it("blocks per_user_once when an active interaction exists", () => {
    expect(policyBlocksPerUserOnce(1).ok).toBe(false);
    expect(policyBlocksPerUserOnce(1)).toMatchObject({ code: "INTERACTION_ALREADY_SUBMITTED" });
  });

  it("blocks exclusive when component already used", () => {
    expect(policyBlocksExclusive(1).ok).toBe(false);
    expect(policyBlocksExclusive(1)).toMatchObject({ code: "COMPONENT_ALREADY_USED" });
  });

  it("enforces targeted policy by actor", () => {
    const targeted = {
      ...baseButton,
      interaction_policy: "targeted" as const,
      target_user_id: "user-a",
    };
    expect(checkTargetedPolicy(targeted, "user-a").ok).toBe(true);
    expect(checkTargetedPolicy(targeted, "user-b")).toMatchObject({
      ok: false,
      code: "INTERACTION_FORBIDDEN_TARGET",
    });
  });
});
