import { describe, expect, it } from "vitest";
import { parseCommandInvokeCommand } from "../../src/chat/command-invoke";

describe("parseCommandInvokeCommand", () => {
  const baseFrame = {
    frame_type: "command" as const,
    command: "command.invoke",
    command_id: "cmd-1",
    channel_id: "ch-1",
    payload: {
      bot_command_id: "bot-cmd-1",
      invoked_name: "ask",
      command_manifest_version: 1,
      options: {},
    },
  };

  it("parses optional reply_to_message_id", () => {
    const result = parseCommandInvokeCommand({
      ...baseFrame,
      payload: {
        ...baseFrame.payload,
        reply_to_message_id: "msg-1",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.reply_to_message_id).toBe("msg-1");
  });

  it("normalizes empty reply_to_message_id to null", () => {
    const result = parseCommandInvokeCommand({
      ...baseFrame,
      payload: {
        ...baseFrame.payload,
        reply_to_message_id: "",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.reply_to_message_id).toBeNull();
  });

  it("defaults reply_to_message_id to null when omitted", () => {
    const result = parseCommandInvokeCommand(baseFrame);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.reply_to_message_id).toBeNull();
  });
});
