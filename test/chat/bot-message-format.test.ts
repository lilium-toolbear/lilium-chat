import { describe, expect, it } from "vitest";
import { effectUsesUnsafeMarkdown } from "../../src/chat/bot-message-format";

describe("effectUsesUnsafeMarkdown", () => {
  it("detects unsafe-markdown on send_message", () => {
    expect(
      effectUsesUnsafeMarkdown({
        type: "send_message",
        client_effect_id: "eff-1",
        message: { type: "text", format: "unsafe-markdown", text: "hi" },
      }),
    ).toBe(true);
  });

  it("detects unsafe-markdown on start_stream", () => {
    expect(
      effectUsesUnsafeMarkdown({
        type: "start_stream",
        client_effect_id: "eff-1",
        message: { type: "text", format: "unsafe-markdown" },
      }),
    ).toBe(true);
  });

  it("returns false for plain markdown", () => {
    expect(
      effectUsesUnsafeMarkdown({
        type: "send_message",
        client_effect_id: "eff-1",
        message: { type: "text", format: "markdown", text: "hi" },
      }),
    ).toBe(false);
  });

  it("returns false for non-message effects", () => {
    expect(
      effectUsesUnsafeMarkdown({
        type: "disable_components",
        client_effect_id: "eff-1",
        message_id: "m1",
        component_ids: ["c1"],
      }),
    ).toBe(false);
  });
});
