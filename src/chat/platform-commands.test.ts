import { describe, expect, it } from "vitest";

import { buildPlatformHelpText, platformHelpManifestItem } from "./platform-commands";
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
