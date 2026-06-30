import { describe, expect, it } from "vitest";
import {
  isOfficialCommandBlocked,
  mergeOfficialIntoBindingRows,
  officialCommandToSnapshot,
  type OfficialCommandCatalogItem,
} from "../../src/chat/official-command-manifest";
import { projectCommandManifest } from "../../src/chat/command-manifest";

function officialItem(overrides: Partial<OfficialCommandCatalogItem> = {}): OfficialCommandCatalogItem {
  return {
    bot_command_id: "official-cmd-1",
    name: "ask",
    aliases: ["ai"],
    description: "Ask",
    help_text: "Detailed help",
    bot: { bot_id: "official-bot", display_name: "Official Bot", avatar_url: null },
    options: [{ name: "prompt", type: "string", required: true }],
    default_member_permission: "member",
    execution: { mode: "stateless", schema_version: 1, definition_hash: "hash-1" },
    ...overrides,
  };
}

describe("mergeOfficialIntoBindingRows", () => {
  it("includes official commands when channel has no binding rows", () => {
    const merged = mergeOfficialIntoBindingRows([], [officialItem()]);
    const manifest = projectCommandManifest(1, merged);
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]?.name).toBe("ask");
    expect(manifest.items[0]?.help_text).toBe("Detailed help");
  });

  it("excludes blocked official commands", () => {
    const merged = mergeOfficialIntoBindingRows(
      [
        {
          bot_command_id: "official-cmd-1",
          bot_id: "official-bot",
          status: "blocked",
          command_snapshot_json: "{}",
          permission_override: null,
        },
      ],
      [officialItem()],
    );
    const manifest = projectCommandManifest(1, merged);
    expect(manifest.items).toHaveLength(0);
  });

  it("applies permission_override from allowed official binding rows", () => {
    const merged = mergeOfficialIntoBindingRows(
      [
        {
          bot_command_id: "official-cmd-1",
          bot_id: "official-bot",
          status: "allowed",
          command_snapshot_json: JSON.stringify(officialCommandToSnapshot(officialItem())),
          permission_override: "owner",
        },
      ],
      [officialItem()],
    );
    const manifest = projectCommandManifest(1, merged);
    expect(manifest.items[0]?.effective_member_permission).toBe("owner");
  });

  it("detects blocked official commands", () => {
    expect(
      isOfficialCommandBlocked(
        [
          {
            bot_command_id: "official-cmd-1",
            bot_id: "official-bot",
            status: "blocked",
            command_snapshot_json: "{}",
            permission_override: null,
          },
        ],
        "official-cmd-1",
      ),
    ).toBe(true);
    expect(isOfficialCommandBlocked([], "official-cmd-1")).toBe(false);
  });
});
