import { describe, expect, it } from "vitest";
import { ARCHIVE_TABLE_WHITELIST, RUNTIME_TABLE_BLACKLIST } from "../../src/archive/payload";
import { appendChatChannelArchive } from "../../src/archive/chat-channel-record";
import { applyArchiveOutboxMigration } from "../../src/archive/apply-archive-migration";
import { REPLAY_TABLES } from "../../src/archive-consumer/replay-tables";

describe("archive drift/static", () => {
  it("whitelist and blacklist are disjoint", () => {
    for (const table of ARCHIVE_TABLE_WHITELIST) {
      expect(RUNTIME_TABLE_BLACKLIST.has(table)).toBe(false);
    }
  });

  it("REPLAY_TABLES keys match ARCHIVE_TABLE_WHITELIST exactly", () => {
    expect(new Set(Object.keys(REPLAY_TABLES))).toEqual(ARCHIVE_TABLE_WHITELIST);
  });

  it("deprecated Phase-7 archive tables are not replayable", () => {
    const deprecated = [
      "chat_bot_event_capabilities",
      "chat_bot_installations",
      "chat_channel_command_names",
      "chat_channel_bot_event_subscriptions",
    ];
    for (const table of deprecated) {
      expect(REPLAY_TABLES[table]).toBeUndefined();
      expect(ARCHIVE_TABLE_WHITELIST.has(table)).toBe(false);
    }
  });

  it("slash-catalog bindings use composite primary key in replay config", () => {
    expect(REPLAY_TABLES.chat_channel_command_bindings?.pk).toEqual(["channel_id", "bot_command_id"]);
    expect(REPLAY_TABLES.chat_bot_command_names?.pk).toEqual(["slash_token"]);
    expect(REPLAY_TABLES.chat_stateful_command_sessions?.pk).toEqual(["session_id"]);
    expect(REPLAY_TABLES.chat_stateful_session_inputs?.pk).toEqual(["session_id", "seq"]);
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
      "chat_stateful_command_sessions",
      "chat_command_invocations",
    ];
    for (const table of required) {
      expect(ARCHIVE_TABLE_WHITELIST.has(table)).toBe(true);
    }
  });
});
