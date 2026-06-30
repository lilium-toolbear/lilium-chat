import { describe, expect, it } from "vitest";

import {
  buildPlatformHelpText,
  buildPlatformPermissionListText,
  computeManageableCommands,
  platformHelpManifestItem,
  resolveManageableCommandName,
} from "./platform-commands";
import type { ChannelBindingRow } from "./official-command-manifest";
import type { CommandManifestItem } from "../contract/bot-api";

function makeItem(name: string, botName: string): CommandManifestItem {
  return {
    bot_command_id: `cmd-${name}`,
    name,
    aliases: [],
    description: `${name} description`,
    help_text: "",
    bot: {
      bot_id: `bot-${botName}`,
      display_name: botName,
      avatar_url: null,
    },
    options: [],
    execution: { mode: "stateless" },
    effective_member_permission: "member",
  };
}

describe("buildPlatformHelpText", () => {
  it("returns a fallback when no commands are visible", () => {
    expect(buildPlatformHelpText([platformHelpManifestItem()])).toBe("当前频道没有可用命令。");
  });

  it("groups visible commands by bot display name", () => {
    const text = buildPlatformHelpText([
      platformHelpManifestItem(),
      makeItem("pay", "工具熊"),
      makeItem("balance", "工具熊"),
    ]);

    expect(text).toContain("**工具熊**");
    expect(text).toContain("/pay — pay description");
    expect(text).toContain("/balance — balance description");
  });
});

describe("platform permission helpers", () => {
  it("lists enabled and disabled manageable commands", () => {
    const bindingRows: ChannelBindingRow[] = [
      {
        bot_command_id: "cmd-1",
        bot_id: "bot-1",
        status: "allowed",
        command_snapshot_json: JSON.stringify({
          bot_command_id: "cmd-1",
          name: "ask",
          aliases: [],
          description: "Ask",
          bot: { bot_id: "bot-1", display_name: "Bot", avatar_url: null },
          options: [],
          default_member_permission: "member",
          execution: { mode: "stateless" },
        }),
        permission_override: null,
      },
      {
        bot_command_id: "cmd-2",
        bot_id: "bot-1",
        status: "blocked",
        command_snapshot_json: JSON.stringify({
          bot_command_id: "cmd-2",
          name: "talk",
          aliases: [],
          description: "Talk",
          bot: { bot_id: "bot-1", display_name: "Bot", avatar_url: null },
          options: [],
          default_member_permission: "member",
          execution: { mode: "stateless" },
        }),
        permission_override: null,
      },
    ];
    const manageable = computeManageableCommands(bindingRows, []);
    const text = buildPlatformPermissionListText(manageable);
    expect(text).toContain("/ask");
    expect(text).toContain("/talk");
    expect(resolveManageableCommandName(manageable, "talk")?.bot_command_id).toBe("cmd-2");
  });
});
