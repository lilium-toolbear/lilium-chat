import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";

import { createOwnedTestChannel } from "../../../test/helpers";
import type { ChatChannel } from "./object";

async function setupChannel(userId: string): Promise<{ channelId: string; stub: DurableObjectStub<ChatChannel> }> {
  return createOwnedTestChannel(env, userId, { title: "Lilium", visibility: "public_listed" });
}

describe("ChatChannel read endpoints", () => {
  it("summary returns channel meta + last_event_id + my role", async () => {
    const userId = "u-read-1";
    const { channelId, stub } = await setupChannel(userId);
    const body = await stub.getSummary(userId);
    expect(body.channel_id).toBe(channelId);
    expect(body.title).toBe("Lilium");
    expect(body.member_count).toBeGreaterThanOrEqual(1);
    expect(body.my_role).toBe("owner");
    expect(body.last_event_id).not.toBeNull();
  });

  it("messages pagination returns domain setup events but no messages for fresh channel", async () => {
    const userId = "u-read-2";
    const { stub } = await setupChannel(userId);
    const body = await stub.getMessages(userId, { before: null, after: null, limit: 50 });
    expect(body.items.some((item) => item.type === "channel.created")).toBe(true);
    expect(body.items.some((item) => item.type === "member.joined")).toBe(true);
    expect(body.items.some((item) => item.type === "message.created")).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  it("summary allows non-member read for public channels", async () => {
    const userId = "u-read-owner";
    const { channelId, stub } = await setupChannel(userId);
    const body = await stub.getSummary("non-member-x");

    expect(body.channel_id).toBe(channelId);
    expect(body.my_role).toBeNull();
  });

  it("summary rejects non-member read for private channels", async () => {
    const userId = "u-read-private-owner";
    const { stub } = await createOwnedTestChannel(env, userId, { title: "Private", visibility: "private" });
    try {
      await stub.getSummary("non-member-private");
      throw new Error("getSummary should have failed");
    } catch (err) {
      expect(err).toMatchObject({ code: "FORBIDDEN", remote: true });
    }
  });
});
