import { describe, expect, it } from "vitest";
import {
  buildInvocationDisplayText,
  parseInvocationJson,
  serializeInvocationJson,
} from "./command-invocation";

describe("buildInvocationDisplayText", () => {
  it("returns slash name only when options are empty", () => {
    expect(buildInvocationDisplayText("help", {})).toBe("/help");
  });

  it("appends non-empty option values in stable key order", () => {
    expect(
      buildInvocationDisplayText("pay", {
        amount: { type: "integer", value: 100 },
        note: { type: "string", value: "lunch" },
      }),
    ).toBe("/pay 100 lunch");
  });

  it("skips empty string option values", () => {
    expect(
      buildInvocationDisplayText("ask", {
        prompt: { type: "string", value: "hello" },
        empty: { type: "string", value: "   " },
      }),
    ).toBe("/ask hello");
  });
});

describe("invocation json helpers", () => {
  it("round-trips invocation metadata", () => {
    const invocation = {
      bot_command_id: "cmd-1",
      invoked_name: "pay",
      options: {
        amount: { type: "integer", value: 50 },
      },
    };
    const json = serializeInvocationJson(invocation);
    expect(parseInvocationJson(json)).toEqual(invocation);
  });

  it("returns null for invalid json", () => {
    expect(parseInvocationJson("not-json")).toBeNull();
    expect(parseInvocationJson(null)).toBeNull();
  });
});
