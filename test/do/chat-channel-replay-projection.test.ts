import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

describe("ChatChannel /internal/replay actor projection", () => {
  it("replays system.notice with resolved actor + target_user (not bare ids)", async () => {
    const cid = "0198aaaa-0000-7000-8000-000000000001";
    const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], cid);
    // Create the channel (owner=u-replay-owner), which writes channel.created + member.joined
    // + system.notice(notice_kind=channel.created, actor=owner). These payloads store actor_id=owner.
    await stub.fetch(new Request("https://x/internal/create-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-replay-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: cid, creator_user_id: "u-replay-owner", title: "R", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [{ user_id: "u-replay-target", role: "member" }] }),
    }));
    const res = await stub.fetch(new Request("https://x/internal/replay?after=", { headers: { "X-Verified-User-Id": "u-replay-owner" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ event_json: string }> };
    const frames = body.events.map((e) => JSON.parse(e.event_json) as { type: string; payload: Record<string, unknown> });
    // The create sequence writes: channel.created (actor=creator), member.joined(creator, actor=system),
    // member.joined(initial member, actor=system), system.notice(notice_kind=channel.created, actor=creator, target_user_id=null).
    // Assert the channel.created system.notice has its ACTOR resolved + ref stripped on the wire.
    const notice = frames.find((f) => f.type === "system.notice" && (f.payload as { notice_kind?: string }).notice_kind === "channel.created");
    expect(notice).toBeTruthy();
    const p = notice!.payload as { actor?: unknown; target_user?: unknown; actor_id?: unknown; target_user_id?: unknown };
    expect(p).toHaveProperty("actor");
    expect(p.actor_id).toBeUndefined();      // ref stripped on the wire
    expect(p.target_user_id).toBeUndefined(); // ref stripped on the wire
    // channel.created notice has target_user_id=null → wire target_user is null (not a UserSummary), but the field IS present.
    expect(p).toHaveProperty("target_user");
    expect(p.target_user).toBe(null);
  });

  it("replays channel.created with resolved actor, not bare actor_id", async () => {
    const cid = "0198bbbb-0000-7000-8000-000000000001";
    const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], cid);
    await stub.fetch(new Request("https://x/internal/create-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-replay-owner2", "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: cid, creator_user_id: "u-replay-owner2", title: "R2", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }),
    }));
    const res = await stub.fetch(new Request("https://x/internal/replay?after=", { headers: { "X-Verified-User-Id": "u-replay-owner2" } }));
    const frames = ((await res.json()) as { events: Array<{ event_json: string }> }).events.map((e) => JSON.parse(e.event_json) as { type: string; payload: Record<string, unknown> });
    const created = frames.find((f) => f.type === "channel.created")!;
    expect(created.payload).toHaveProperty("actor");
    expect(created.payload).not.toHaveProperty("actor_id");
  });
});
