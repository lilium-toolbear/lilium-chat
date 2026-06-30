import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import type { ChatChannel } from "../../src/do/chat-channel";

async function createChannel(overrides: Record<string, unknown> = {}) {
  const channelId = (overrides.channel_id ?? "0192" + Math.random().toString(36).slice(2).padEnd(8, "0") + "-0000-7000-8000-000000000001") as string;
  const stub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL, channelId);
  const body = {
    channel_id: channelId,
    creator_user_id: "u-creator-1",
    title: "My Channel",
    topic: null,
    avatar_attachment_id: null,
    visibility: "private",
    initial_members: [{ user_id: "u-init-1", role: "member" }],
    ...overrides,
  };
  const out = await stub.createChannel({ user_id: body.creator_user_id as string, ...body } as Parameters<ChatChannel["createChannel"]>[0]);
  return { out, channelId, stub };
}

describe("ChatChannel createChannel", () => {
  it("creates the channel + owner + initial members and returns channel + membership", async () => {
    const { out, channelId } = await createChannel();
    expect(out.channel.channel_id).toBe(channelId);
    expect(out.channel.kind).toBe("channel");
    expect(out.channel.status).toBe("active");
    expect(out.membership.role).toBe("owner");
    expect(out.event_ids.length).toBeGreaterThanOrEqual(3); // channel.created + member.joined(creator) + member.joined(init)
  });

  it("is idempotent on re-call (same channel_id returns existing, no duplicate events)", async () => {
    const { channelId, stub } = await createChannel();
    const out2 = await stub.createChannel({
      user_id: "u-creator-1",
      channel_id: channelId,
      creator_user_id: "u-creator-1",
      title: "My Channel",
      topic: null,
      avatar_attachment_id: null,
      visibility: "private",
      initial_members: [{ user_id: "u-init-1", role: "member" }],
    });
    expect(out2.membership.role).toBe("owner");
    expect(out2.event_ids).toEqual([]); // no new events on idempotent re-call
  });

  it("rejects non-null avatar_attachment_id (Phase 3, attachments are Phase 5)", async () => {
    await expect(createChannel({ avatar_attachment_id: "att-1" })).rejects.toMatchObject({
      code: "INVALID_MESSAGE",
      remote: true,
    });
  });

  it("rejects owner role in initial_members", async () => {
    await expect(createChannel({ initial_members: [{ user_id: "u-x", role: "owner" }] })).rejects.toMatchObject({
      code: "INVALID_MESSAGE",
      remote: true,
    });
  });
});
