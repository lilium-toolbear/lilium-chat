import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createTestChannel, replayTestEvents, sendTestMessage } from "../helpers";

describe("ChatChannel replay RPC actor projection", () => {
  it("replays member.joined with resolved actor + user (not bare ids)", async () => {
    const cid = "0198aaaa-0000-7000-8000-000000000001";
    // Create the channel (owner=u-replay-owner), which writes channel.created + member.joined events.
    const stub = await createTestChannel(env, {
      channelId: cid,
      ownerId: "u-replay-owner",
      title: "R",
      visibility: "private",
      initial_members: [{ user_id: "u-replay-target", role: "member" }],
    });
    const res = await replayTestEvents(stub, "u-replay-owner");
    const body = res;
    const frames = body.events.map((e) => JSON.parse(e.event_json) as { type: string; payload: Record<string, unknown> });
    // member.joined(initial member, actor=system) — assert subject user is resolved on the wire.
    const joined = frames.find((f) => {
      if (f.type !== "member.joined") return false;
      const payload = f.payload as { user?: { user_id?: string }; user_id?: string };
      const subjectId = payload.user?.user_id ?? payload.user_id;
      return subjectId === "u-replay-target";
    });
    expect(joined).toBeTruthy();
    const p = joined!.payload as { actor?: unknown; user?: unknown; actor_id?: unknown; user_id?: unknown };
    expect(p).toHaveProperty("user");
    expect(p.actor_id).toBeUndefined();
    expect(p.user_id).toBeUndefined();
    expect((p.user as { user_id?: string })?.user_id).toBe("u-replay-target");
  });

  it("replays channel.created with resolved actor, not bare actor_id", async () => {
    const cid = "0198bbbb-0000-7000-8000-000000000001";
    const stub = await createTestChannel(env, { channelId: cid, ownerId: "u-replay-owner2", title: "R2", visibility: "private" });
    const res = await replayTestEvents(stub, "u-replay-owner2");
    const frames = res.events.map((e) => JSON.parse(e.event_json) as { type: string; payload: Record<string, unknown> });
    const created = frames.find((f) => f.type === "channel.created")!;
    expect(created.payload).toHaveProperty("actor");
    expect(created.payload).not.toHaveProperty("actor_id");
  });

  it("replays message.created with full message projection", async () => {
    const cid = "0198cccc-0000-7000-8000-000000000001";
    const stub = await createTestChannel(env, { channelId: cid, ownerId: "u-replay-sender", title: "R3", visibility: "private" });
    const send = (await (
      await sendTestMessage(stub, { userId: "u-replay-sender", channelId: cid, commandId: "cm-replay-projection", text: "projection check" })
    ).json()) as { event_id: string };
    const replay = await replayTestEvents(stub, "u-replay-sender");

    const frames = replay.events.map((e) => JSON.parse(e.event_json) as { type: string; payload: Record<string, unknown> });
    const created = frames.find((f) => f.type === "message.created");
    expect(created).toBeTruthy();
    const message = (created!.payload as { message?: { sender?: { kind?: string; user?: { user_id: string } }; text?: string; attachments?: unknown[]; components?: unknown[]; mentions?: unknown[] } }).message;
    expect(message?.text).toBe("projection check");
    expect(message?.sender).toHaveProperty("user");
    expect(message?.sender).toHaveProperty("kind", "user");
    expect(message?.sender?.user).toHaveProperty("user_id", "u-replay-sender");
    expect(Array.isArray(message?.attachments)).toBe(true);
    expect(Array.isArray(message?.components)).toBe(true);
    expect(Array.isArray(message?.mentions)).toBe(true);

    const out = replay.events.find((e) => {
      const frame = JSON.parse(e.event_json) as { event_id: string };
      return frame.event_id === send.event_id;
    });
    expect(out).toBeDefined();
  });
});
