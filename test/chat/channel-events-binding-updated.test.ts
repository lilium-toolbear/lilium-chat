import { describe, expect, it } from "vitest";
import { buildCommandBindingUpdatedPayload } from "../../src/chat/channel-events";

describe("buildCommandBindingUpdatedPayload", () => {
  it("persists command_manifest_delta for replay", () => {
    const payload = buildCommandBindingUpdatedPayload({
      channel_id: "ch-1",
      bot_id: "bot-1",
      bot_command_id: "cmd-1",
      binding_changes: { status: { before: "blocked", after: "allowed" } },
      actor_kind: "user",
      actor_id: "user-1",
      command_manifest_delta: {
        op: "upsert",
        manifest_version: 2,
        item: {
          bot_command_id: "cmd-1",
          name: "ask",
          aliases: [],
          description: "Ask",
          bot: { bot_id: "bot-1", display_name: "Bot", avatar_url: null },
          options: [],
          effective_member_permission: "member",
          execution: { mode: "stateless" },
        },
      },
    });
    expect(payload.command_manifest_delta.op).toBe("upsert");
    expect(payload.command_manifest_delta.manifest_version).toBe(2);
  });
});
