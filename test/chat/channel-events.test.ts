import { describe, it, expect } from "vitest";
import {
  buildChannelCreatedPayload,
  buildChannelUpdatedPayload,
  buildChannelDissolvedPayload,
  buildMemberJoinedPayload,
  buildMemberRoleUpdatedPayload,
  buildMemberLeftPayload,
  buildReadStateUpdatedPayload,
  buildBotInstalledPayload,
  buildBotUpdatedPayload,
  buildCommandBindingUpdatedPayload,
  resolveActorForLiveBroadcast,
  resolveActorWithMap,
} from "../../src/chat/channel-events";

describe("persisted payloads store actor refs, not UserSummary", () => {
  it("channel.created", () => {
    const p = buildChannelCreatedPayload({ channel_id: "c1", kind: "channel", visibility: "private", title: "T", actor_kind: "user", actor_id: "u1" });
    expect(p).toMatchObject({ actor_kind: "user", actor_id: "u1" });
    expect((p as any).channel).toEqual({ channel_id: "c1", kind: "channel", visibility: "private", title: "T" });
    expect(JSON.stringify(p)).not.toContain("display_name");
  });

  it("channel.updated carries channel_changes", () => {
    const p = buildChannelUpdatedPayload({ channel_id: "c1", channel_changes: { title: { before: "a", after: "b" } }, actor_kind: "user", actor_id: "u1" });
    expect((p as any).channel_changes).toEqual({ title: { before: "a", after: "b" } });
  });

  it("channel.dissolved", () => {
    const p = buildChannelDissolvedPayload({ channel_id: "c1", dissolved_at: "2026-06-24T00:00:00Z", actor_kind: "user", actor_id: "u1" });
    expect(p).toMatchObject({ channel_id: "c1", status: "dissolved", dissolved_at: "2026-06-24T00:00:00Z", actor_kind: "user", actor_id: "u1" });
  });

  it("member.joined", () => {
    const p = buildMemberJoinedPayload({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 3, actor_kind: "system", actor_id: "system" });
    expect(p).toMatchObject({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 3, actor_kind: "system", actor_id: "system" });
  });

  it("member.role_updated", () => {
    const p = buildMemberRoleUpdatedPayload({ channel_id: "c1", user_id: "u2", before_role: "member", after_role: "admin", membership_version: 4, actor_kind: "user", actor_id: "u1" });
    expect(p).toMatchObject({ before_role: "member", after_role: "admin", membership_version: 4 });
  });

  it("member.left carries leave_source", () => {
    const p = buildMemberLeftPayload({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 4, actor_kind: "user", actor_id: "u1", leave_source: "removed" });
    expect(p).toMatchObject({ leave_source: "removed" });
  });

  it("read_state.updated", () => {
    const p = buildReadStateUpdatedPayload({ channel_id: "c1", user_id: "u1", last_read_event_id: "01J" });
    expect(p).toEqual({ channel_id: "c1", user_id: "u1", last_read_event_id: "01J" });
  });

  it("bot.installed persisted ref shape", () => {
    const p = buildBotInstalledPayload({ channel_id: "c1", bot_id: "b1", actor_kind: "user", actor_id: "u1" });
    expect(p).toMatchObject({ channel_id: "c1", bot_id: "b1", actor_kind: "user", actor_id: "u1" });
    expect(JSON.stringify(p)).not.toContain("display_name");
  });

  it("bot.updated carries status changes", () => {
    const p = buildBotUpdatedPayload({
      channel_id: "c1", bot_id: "b1", status: "removed",
      changes: { status: { before: "active", after: "removed" } },
      actor_kind: "user", actor_id: "u1",
    });
    expect((p as any).changes).toEqual({ status: { before: "active", after: "removed" } });
  });

  it("command.binding_updated carries binding_changes", () => {
    const p = buildCommandBindingUpdatedPayload({
      channel_id: "c1", bot_id: "b1", bot_command_id: "cmd1",
      binding_changes: { enabled: { before: "disabled", after: "enabled" } },
      actor_kind: "user", actor_id: "u1",
    });
    expect((p as any).binding_changes).toEqual({ enabled: { before: "disabled", after: "enabled" } });
  });
});

describe("resolveActorForLiveBroadcast", () => {
  it("replaces actor_id and user_id with resolved UserSummary fields", async () => {
    const persisted = buildMemberJoinedPayload({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 1, actor_kind: "user", actor_id: "u1" });
    const live = await resolveActorForLiveBroadcast(
      persisted,
      async () => new Map([[
        "u1",
        { user_id: "u1", display_name: "Alice", avatar_url: null },
      ], [
        "u2",
        { user_id: "u2", display_name: "Bob", avatar_url: "https://x/b.png" },
      ]]),
    );
    expect((live as any).actor).toEqual({ user_id: "u1", display_name: "Alice", avatar_url: null });
    expect((live as any).user).toEqual({ user_id: "u2", display_name: "Bob", avatar_url: "https://x/b.png" });
    expect(live).not.toHaveProperty("actor_id");
    expect(live).not.toHaveProperty("user_id");
  });

  it("system actor has actor=null and no resolution", async () => {
    const persisted = buildMemberJoinedPayload({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 1, actor_kind: "system", actor_id: "system" });
    const called: string[] = [];
    const live = await resolveActorForLiveBroadcast(persisted, async (ids) => { called.push(...ids); return new Map(); });
    expect((live as any).actor).toBe(null);
    expect(called).toEqual(["u2"]);
  });

  it("falls back to user-<shortid> when actor not in pg", async () => {
    const persisted = buildChannelCreatedPayload({ channel_id: "c1", kind: "channel", visibility: "private", title: "T", actor_kind: "user", actor_id: "u-ghost" });
    const live = await resolveActorForLiveBroadcast(persisted, async () => new Map());
    expect((live as any).actor.display_name).toBe("user-u-ghost");
  });
});

describe("resolveActorWithMap (sync, prod path)", () => {
  it("resolves actor + user from a pre-resolved map", () => {
    const persisted = buildMemberRoleUpdatedPayload({ channel_id: "c1", user_id: "u2", before_role: "member", after_role: "admin", membership_version: 1, actor_kind: "user", actor_id: "u1" });
    const map = new Map([["u1", { user_id: "u1", display_name: "Alice", avatar_url: null }], ["u2", { user_id: "u2", display_name: "Bob", avatar_url: null }]]);
    const live = resolveActorWithMap(persisted, map);
    expect((live as any).actor).toEqual({ user_id: "u1", display_name: "Alice", avatar_url: null });
    expect((live as any).user).toEqual({ user_id: "u2", display_name: "Bob", avatar_url: null });
    expect(live).not.toHaveProperty("actor_id");
    expect(live).not.toHaveProperty("user_id");
  });

  it("system actor → actor:null, subject user still resolved", () => {
    const persisted = buildMemberJoinedPayload({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 1, actor_kind: "system", actor_id: "system" });
    const map = new Map([["u2", { user_id: "u2", display_name: "Bob", avatar_url: null }]]);
    const live = resolveActorWithMap(persisted, map);
    expect((live as any).actor).toBe(null);
    expect((live as any).user).toEqual({ user_id: "u2", display_name: "Bob", avatar_url: null });
  });
});
