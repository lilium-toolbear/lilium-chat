import { describe, expect, it } from "vitest";
import type { CommandManifestItem, CommandManifestResponse } from "../../src/contract/bot-api";
import {
  applyCommandManifestDelta,
  appendPlatformHelpItem,
  appendPlatformPermissionItem,
  appendPlatformCommandItems,
  buildManifestRemoveDelta,
  buildManifestUpsertDelta,
  projectCommandManifest,
} from "../../src/chat/command-manifest";
import { PLATFORM_HELP_BOT_COMMAND_ID, PLATFORM_PERMISSION_BOT_COMMAND_ID } from "../../src/chat/platform-commands";

function makeItem(overrides: Partial<CommandManifestItem> = {}): CommandManifestItem {
  return {
    bot_command_id: "cmd-1",
    name: "zebra",
    aliases: [],
    description: "Z",
    help_text: "",
    bot: { bot_id: "b1", display_name: "Bot", avatar_url: null },
    options: [],
    effective_member_permission: "member",
    execution: { mode: "stateless" },
    ...overrides,
  };
}

function makeManifest(overrides: Partial<CommandManifestResponse> = {}): CommandManifestResponse {
  return {
    version: 1,
    items: [makeItem()],
    ...overrides,
  };
}

describe("projectCommandManifest", () => {
  it("returns only allowed bindings sorted by name", () => {
    const manifest = projectCommandManifest(3, [
      {
        status: "allowed",
        command_snapshot_json: JSON.stringify({
          bot_command_id: "cmd-1",
          name: "zebra",
          aliases: [],
          description: "Z",
          bot: { bot_id: "b1", display_name: "Bot", avatar_url: null },
          options: [],
          default_member_permission: "member",
          execution: { mode: "stateless" },
        }),
        permission_override: null,
      },
      {
        status: "blocked",
        command_snapshot_json: "{}",
        permission_override: null,
      },
      {
        status: "allowed",
        command_snapshot_json: JSON.stringify({
          bot_command_id: "cmd-2",
          name: "alpha",
          aliases: ["a"],
          description: "A",
          bot: { bot_id: "b2", display_name: "Alpha Bot", avatar_url: null },
          options: [],
          default_member_permission: "admin",
          execution: { mode: "stateless" },
        }),
        permission_override: "owner",
      },
    ]);

    expect(manifest.version).toBe(3);
    expect(manifest.items).toHaveLength(2);
    expect(manifest.items[0]?.name).toBe("alpha");
    expect(manifest.items[0]?.effective_member_permission).toBe("owner");
    expect(manifest.items[1]?.name).toBe("zebra");
    expect(manifest.items[1]?.effective_member_permission).toBe("member");
  });

  it("drops invalid snapshot payload rows", () => {
    const manifest = projectCommandManifest(4, [
      { status: "allowed", command_snapshot_json: "{not-json}", permission_override: null },
      { status: "allowed", command_snapshot_json: "{}", permission_override: null },
    ]);
    expect(manifest.items).toHaveLength(0);
  });
});

describe("manifest delta helpers", () => {
  it("builds upsert and remove delta shapes", () => {
    const item = makeItem();
    const upsert = buildManifestUpsertDelta(2, item);
    const remove = buildManifestRemoveDelta(3);

    expect(upsert).toEqual({ op: "upsert", manifest_version: 2, item });
    expect(remove).toEqual({ op: "remove", manifest_version: 3 });
  });
});

describe("applyCommandManifestDelta", () => {
  it("applies upsert when version increments by one", () => {
    const current = makeManifest({
      version: 1,
      items: [makeItem({ bot_command_id: "cmd-1", name: "zebra" })],
    });
    const delta = buildManifestUpsertDelta(
      2,
      makeItem({ bot_command_id: "cmd-2", name: "alpha", effective_member_permission: "admin" }),
    );

    const result = applyCommandManifestDelta(current, delta);

    expect(result.applied).toBe(true);
    expect(result.requiresRefresh).toBe(false);
    expect(result.manifest.version).toBe(2);
    expect(result.manifest.items.map((item) => item.bot_command_id)).toEqual(["cmd-2", "cmd-1"]);
  });

  it("applies remove by bot_command_id", () => {
    const current = makeManifest({
      version: 2,
      items: [
        makeItem({ bot_command_id: "cmd-1", name: "zebra" }),
        makeItem({ bot_command_id: "cmd-2", name: "alpha" }),
      ],
    });
    const delta = buildManifestRemoveDelta(3);

    const result = applyCommandManifestDelta(current, delta, "cmd-1");

    expect(result.applied).toBe(true);
    expect(result.requiresRefresh).toBe(false);
    expect(result.manifest.version).toBe(3);
    expect(result.manifest.items.map((item) => item.bot_command_id)).toEqual(["cmd-2"]);
  });

  it("ignores stale deltas", () => {
    const current = makeManifest({ version: 4 });
    const stale = buildManifestRemoveDelta(4);

    const result = applyCommandManifestDelta(current, stale, "cmd-1");

    expect(result.applied).toBe(false);
    expect(result.requiresRefresh).toBe(false);
    expect(result.manifest).toBe(current);
  });

  it("flags refresh on version gap", () => {
    const current = makeManifest({ version: 1 });
    const gap = buildManifestRemoveDelta(4);

    const result = applyCommandManifestDelta(current, gap, "cmd-1");

    expect(result.applied).toBe(false);
    expect(result.requiresRefresh).toBe(true);
    expect(result.manifest).toBe(current);
  });
});

describe("appendPlatformHelpItem", () => {
  it("appends platform /help command to manifest", () => {
    const manifest = appendPlatformHelpItem(projectCommandManifest(1, []));
    expect(manifest.items.some((item) => item.bot_command_id === PLATFORM_HELP_BOT_COMMAND_ID)).toBe(true);
  });
});

describe("appendPlatformCommandItems", () => {
  it("appends /permission for owner/admin only", () => {
    const base = projectCommandManifest(1, []);
    expect(
      appendPlatformCommandItems(base, "owner").items.some(
        (item) => item.bot_command_id === PLATFORM_PERMISSION_BOT_COMMAND_ID,
      ),
    ).toBe(true);
    expect(
      appendPlatformCommandItems(base, "member").items.some(
        (item) => item.bot_command_id === PLATFORM_PERMISSION_BOT_COMMAND_ID,
      ),
    ).toBe(false);
  });

  it("does not duplicate platform permission item", () => {
    const once = appendPlatformPermissionItem(projectCommandManifest(1, []));
    const twice = appendPlatformPermissionItem(once);
    expect(
      twice.items.filter((item) => item.bot_command_id === PLATFORM_PERMISSION_BOT_COMMAND_ID),
    ).toHaveLength(1);
  });
});
