import { describe, it, expect } from "vitest";
import { parseMessageSendCommand, dedupePrincipalKeyForUser } from "../../src/chat/command";

describe("parseMessageSendCommand", () => {
  it("parses a valid text message.send", () => {
    const r = parseMessageSendCommand(
      {
        frame_type: "command",
        command: "message.send",
        command_id: "cmd-1",
        channel_id: "ch-1",
        payload: {
          client_message_id: "cm-1",
          type: "text",
          text: "hello",
          reply_to_message_id: null,
          attachment_ids: [],
          mentions: [],
        },
      },
      "u-1",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.client_message_id).toBe("cm-1");
      expect(r.command.type).toBe("text");
      expect(r.command.text).toBe("hello");
      expect(r.command.reply_to).toBe(null);
      expect(r.command.attachment_ids).toEqual([]);
      expect(r.command.mentions).toEqual([]);
    }
  });

  it("rejects wrong command name", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "channel.update", command_id: "cmd-1", channel_id: "ch-1", payload: {} },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_COMMAND");
  });

  it("rejects missing client_message_id", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { type: "text", text: "hi" } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects empty text for type=text", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { client_message_id: "cm-1", type: "text", text: "  " } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects missing channel_id", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", payload: { client_message_id: "cm-1", type: "text", text: "hi" } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CHANNEL_NOT_FOUND");
  });

  it("rejects image type (Phase 2 is text-only; images are Phase 5)", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { client_message_id: "cm-1", type: "image", text: "", attachment_ids: ["a-1"] } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects reply_to_message_id (Phase 2 has no reply snapshot; replies are Phase 4)", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { client_message_id: "cm-1", type: "text", text: "hi", reply_to_message_id: "m-1" } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects non-empty attachment_ids (Phase 2 is text-only)", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { client_message_id: "cm-1", type: "text", text: "hi", attachment_ids: ["a-1"] } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
});

describe("dedupePrincipalKeyForUser", () => {
  it("namespaces by user id", () => {
    expect(dedupePrincipalKeyForUser("u-1")).toBe("user:u-1");
  });
});

