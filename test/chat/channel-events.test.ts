import { describe, it, expect } from "vitest";
import {
  buildChannelCreatedPayload,
  buildChannelUpdatedPayload,
  buildChannelDissolvedPayload,
  buildMemberJoinedPayload,
  buildMemberRoleUpdatedPayload,
  buildMemberLeftPayload,
  buildReadStateUpdatedPayload,
  buildSystemNoticePayload,
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

  it("member.left mirrors member.joined shape", () => {
    const p = buildMemberLeftPayload({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 4, actor_kind: "user", actor_id: "u1" });
    expect(p).toMatchObject({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 4, actor_kind: "user", actor_id: "u1" });
  });

  it("read_state.updated", () => {
    const p = buildReadStateUpdatedPayload({ channel_id: "c1", user_id: "u1", last_read_event_id: "01J" });
    expect(p).toEqual({ channel_id: "c1", user_id: "u1", last_read_event_id: "01J" });
  });

  it("system.notice persisted ref shape", () => {
    const p = buildSystemNoticePayload({ notice_kind: "channel.dissolved", actor_kind: "user", actor_id: "u1", target_user_id: null, message_id: null, channel_changes: null });
    expect(p).toMatchObject({ notice_kind: "channel.dissolved", actor_kind: "user", actor_id: "u1", target_user_id: null, message_id: null, channel_changes: null });
    expect(JSON.stringify(p)).not.toContain("display_name");
  });
});

describe("resolveActorForLiveBroadcast", () => {
  it("replaces actor_id with a resolved actor UserSummary", async () => {
    const persisted = buildSystemNoticePayload({ notice_kind: "member.joined", actor_kind: "user", actor_id: "u1", target_user_id: "u2", message_id: null, channel_changes: null });
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
    expect((live as any).target_user).toEqual({ user_id: "u2", display_name: "Bob", avatar_url: "https://x/b.png" });
    expect(live).not.toHaveProperty("actor_id");
    expect(live).not.toHaveProperty("target_user_id");
  });

  it("system actor has actor=null and no resolution", async () => {
    const persisted = buildSystemNoticePayload({ notice_kind: "member.joined", actor_kind: "system", actor_id: "system", target_user_id: null, message_id: null, channel_changes: null });
    const called: string[] = [];
    const live = await resolveActorForLiveBroadcast(persisted, async (ids) => { called.push(...ids); return new Map(); });
    expect((live as any).actor).toBe(null);
    expect(called).toEqual([]); // system actor does not trigger resolution
  });

  it("falls back to user-<shortid> when actor not in pg", async () => {
    const persisted = buildChannelCreatedPayload({ channel_id: "c1", kind: "channel", visibility: "private", title: "T", actor_kind: "user", actor_id: "u-ghost" });
    const live = await resolveActorForLiveBroadcast(persisted, async () => new Map());
    expect((live as any).actor.display_name).toBe("user-u-ghost");
  });
});

describe("resolveActorWithMap (sync, prod path)", () => {
  it("resolves actor + target_user from a pre-resolved map", () => {
    const persisted = buildSystemNoticePayload({ notice_kind: "member.role_updated", actor_kind: "user", actor_id: "u1", target_user_id: "u2", message_id: null, channel_changes: null });
    const map = new Map([["u1", { user_id: "u1", display_name: "Alice", avatar_url: null }], ["u2", { user_id: "u2", display_name: "Bob", avatar_url: null }]]);
    const live = resolveActorWithMap(persisted, map);
    expect((live as any).actor).toEqual({ user_id: "u1", display_name: "Alice", avatar_url: null });
    expect((live as any).target_user).toEqual({ user_id: "u2", display_name: "Bob", avatar_url: null });
    expect(live).not.toHaveProperty("actor_id");
  });

  it("system actor → actor:null, no map lookup needed", () => {
    const persisted = buildMemberJoinedPayload({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 1, actor_kind: "system", actor_id: "system" });
    const live = resolveActorWithMap(persisted, new Map());
    expect((live as any).actor).toBe(null);
    expect((live as any).target_user).toBe(null);
  });
});
