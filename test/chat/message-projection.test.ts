import { describe, it, expect } from "vitest";
import { projectMessageForBrowser } from "../../src/chat/message-projection";
import type { MessageRow } from "../../src/do/chat-channel";

const baseRow = (over: Partial<MessageRow> = {}): MessageRow => ({
  message_id: "m1", command_id: "cmd1", channel_id: "c1",
  sender_kind: "user", sender_user_id: "u1", sender_bot_id: null,
  type: "text", format: "plain", status: "normal", text: "hi",
  reply_to: null, reply_snapshot_json: null, stream_state: "none",
  created_at: "2026-06-24T10:00:00Z", updated_at: "2026-06-24T10:00:00Z",
  edited_at: null, deleted_at: null, deleted_by: null, recalled_at: null,
  ...over,
});

describe("projectMessageForBrowser", () => {
  it("projects a normal user message with sender UserSummary", () => {
    const p = projectMessageForBrowser(baseRow(), { senderSummary: { user_id: "u1", display_name: "alice", avatar_url: null } });
    expect(p.message_id).toBe("m1");
    expect(p.command_id).toBe("cmd1");
    expect(p.channel_id).toBe("c1");
    expect(p.status).toBe("normal");
    expect(p.text).toBe("hi");
    expect((p as any).sender).toEqual({ kind: "user", user: { user_id: "u1", display_name: "alice", avatar_url: null } });
    expect(p).toHaveProperty("attachments");
    expect(p).toHaveProperty("components");
    expect(p).toHaveProperty("mentions");
  });

  it("recalled projection hides original text/attachments/mentions", () => {
    const p = projectMessageForBrowser(baseRow({ status: "recalled", recalled_at: "2026-06-24T10:02:00Z", text: "secret" }), { senderSummary: { user_id: "u1", display_name: "alice", avatar_url: null } });
    expect(p.status).toBe("recalled");
    expect(p.text).toBeNull();
    expect(p.attachments).toEqual([]);
    expect(p.mentions).toEqual([]);
    expect(p.recalled_at).toBe("2026-06-24T10:02:00Z");
  });

  it("deleted projection hides original text/attachments/mentions", () => {
    const p = projectMessageForBrowser(baseRow({ status: "deleted", deleted_at: "2026-06-24T10:03:00Z", deleted_by: "u-admin", text: "secret" }), { senderSummary: { user_id: "u1", display_name: "alice", avatar_url: null } });
    expect(p.status).toBe("deleted");
    expect(p.text).toBeNull();
    expect(p.attachments).toEqual([]);
    expect(p.mentions).toEqual([]);
  });

  it("edited projection keeps edited text + edited_at", () => {
    const p = projectMessageForBrowser(baseRow({ status: "edited", text: "new text", edited_at: "2026-06-24T10:01:00Z" }), { senderSummary: { user_id: "u1", display_name: "alice", avatar_url: null } });
    expect(p.status).toBe("edited");
    expect(p.text).toBe("new text");
    expect(p.edited_at).toBe("2026-06-24T10:01:00Z");
  });

  it("injects caller-provided mentions on a normal message", () => {
    const p = projectMessageForBrowser(baseRow(), { mentions: [{ user_id: "u2", start: 0, end: 4 }] });
    expect(p.mentions).toEqual([{ user_id: "u2", start: 0, end: 4 }]);
  });

  it("forces mentions/attachments/components empty on recalled even if provided", () => {
    const p = projectMessageForBrowser(baseRow({ status: "recalled", text: "secret" }), { mentions: [{ user_id: "u2", start: 0, end: 4 }], attachments: [] });
    expect(p.mentions).toEqual([]);
    expect(p.attachments).toEqual([]);
  });

  it("falls back to user-<shortid> when no summary provided", () => {
    const p = projectMessageForBrowser(baseRow());
    expect((p as any).sender.user.display_name).toBe("user-u1");
  });
});
