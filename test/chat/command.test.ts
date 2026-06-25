import { describe, it, expect } from "vitest";
import {
  parseMessageSendCommand,
  dedupePrincipalKeyForUser,
  parseMessageEditCommand,
  parseMessageRecallCommand,
  parseMessageDeleteCommand,
} from "../../src/chat/command";

describe("parseMessageSendCommand", () => {
  it("parses a valid text message.send (command_id is top-level, NOT in payload)", () => {
    const r = parseMessageSendCommand(
      {
        frame_type: "command",
        command: "message.send",
        command_id: "cmd-1",
        channel_id: "ch-1",
        payload: {
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
      expect(r.command.command_id).toBe("cmd-1"); // v4.0: the frame-level command_id
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

  it("rejects missing top-level command_id", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "", channel_id: "ch-1", payload: { type: "text", text: "hi" } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("ignores a payload command_id (v4.0: only the top-level command_id is the operation id)", () => {
    // A v2.6-compliant client does NOT send payload.command_id; if one does, it is ignored, not rejected.
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { command_id: "stray-payload-id", type: "text", text: "hi" } },
      "u-1",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.command.command_id).toBe("cmd-1");
  });

  it("rejects empty text for type=text", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { type: "text", text: "  " } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects missing channel_id", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", payload: { type: "text", text: "hi" } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CHANNEL_NOT_FOUND");
  });

  it("rejects image type (text-only; images are Phase 5)", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { type: "image", text: "", attachment_ids: ["a-1"] } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects reply_to_message_id (reply snapshot is Phase 4)", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { type: "text", text: "hi", reply_to_message_id: "m-1" } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects non-empty attachment_ids (text-only)", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { type: "text", text: "hi", attachment_ids: ["a-1"] } },
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

describe("parseMessageEditCommand", () => {
  const ok = { frame_type: "command" as const, command: "message.edit", command_id: "op-e1", channel_id: "ch1", payload: { message_id: "m1", text: "new" } };
  it("parses edit (command_id top-level, message_id + text in payload)", () => {
    const r = parseMessageEditCommand(ok as any);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.message_id).toBe("m1");
      expect(r.command.text).toBe("new");
    }
  });
  it("rejects missing message_id", () => {
    const r = parseMessageEditCommand({ ...ok, payload: { text: "x" } } as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
  it("rejects empty text", () => {
    const r = parseMessageEditCommand({ ...ok, payload: { message_id: "m1", text: "  " } } as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
  it("rejects missing top-level command_id", () => {
    const r = parseMessageEditCommand({ ...ok, command_id: "" } as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
});

describe("parseMessageRecallCommand", () => {
  it("parses recall", () => {
    const r = parseMessageRecallCommand({ frame_type: "command", command: "message.recall", command_id: "op-r1", channel_id: "ch1", payload: { message_id: "m1" } } as any);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.command.message_id).toBe("m1");
  });
  it("rejects missing message_id", () => {
    const r = parseMessageRecallCommand({ frame_type: "command", command: "message.recall", command_id: "op-r1", channel_id: "ch1", payload: {} } as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
});

describe("parseMessageDeleteCommand", () => {
  it("parses delete with optional reason", () => {
    const r = parseMessageDeleteCommand({ frame_type: "command", command: "message.delete", command_id: "op-d1", channel_id: "ch1", payload: { message_id: "m1", reason: "spam" } } as any);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.message_id).toBe("m1");
      expect(r.command.reason).toBe("spam");
    }
  });
  it("parses delete without reason (null ok)", () => {
    const r = parseMessageDeleteCommand({ frame_type: "command", command: "message.delete", command_id: "op-d2", channel_id: "ch1", payload: { message_id: "m1" } } as any);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.command.reason).toBeNull();
  });
  it("rejects missing message_id", () => {
    const r = parseMessageDeleteCommand({ frame_type: "command", command: "message.delete", command_id: "op-d3", channel_id: "ch1", payload: { reason: "x" } } as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
});
