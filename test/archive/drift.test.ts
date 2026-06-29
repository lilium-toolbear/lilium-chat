import { describe, expect, it } from "vitest";
import { ARCHIVE_TABLE_WHITELIST, RUNTIME_TABLE_BLACKLIST } from "../../src/archive/payload";
import { appendChatChannelArchive } from "../../src/archive/chat-channel-record";
import { applyArchiveOutboxMigration } from "../../src/archive/apply-archive-migration";

describe("archive drift/static", () => {
  it("whitelist and blacklist are disjoint", () => {
    for (const table of ARCHIVE_TABLE_WHITELIST) {
      expect(RUNTIME_TABLE_BLACKLIST.has(table)).toBe(false);
    }
  });

  it("archive append helpers are exported", () => {
    expect(typeof appendChatChannelArchive).toBe("function");
    expect(typeof applyArchiveOutboxMigration).toBe("function");
  });

  it("normalized chat tables cover ChatChannel scope", () => {
    const required = [
      "chat_channels",
      "chat_channel_members",
      "chat_messages",
      "chat_events",
      "chat_invites",
      "chat_channel_command_bindings",
    ];
    for (const table of required) {
      expect(ARCHIVE_TABLE_WHITELIST.has(table)).toBe(true);
    }
  });
});
