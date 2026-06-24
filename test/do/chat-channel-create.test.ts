import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

async function createChannel(overrides: Record<string, unknown> = {}) {
  const channelId = (overrides.channel_id ?? "0192" + Math.random().toString(36).slice(2).padEnd(8, "0") + "-0000-7000-8000-000000000001") as string;
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
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
  const res = await stub.fetch(new Request("https://x/internal/create-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": body.creator_user_id, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { res, channelId, stub };
}

describe("ChatChannel /internal/create-channel", () => {
  it("creates the channel + owner + initial members and returns channel + membership", async () => {
    const { res, channelId } = await createChannel();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { channel_id: string; kind: string; status: string }; membership: { role: string }; event_ids: string[] };
    expect(body.channel.channel_id).toBe(channelId);
    expect(body.channel.kind).toBe("channel");
    expect(body.channel.status).toBe("active");
    expect(body.membership.role).toBe("owner");
    expect(body.event_ids.length).toBeGreaterThanOrEqual(3); // channel.created + member.joined(creator) + member.joined(init) + system.notice
  });

  it("is idempotent on re-call (same channel_id returns existing, no duplicate events)", async () => {
    const { channelId, stub } = await createChannel();
    const res2 = await stub.fetch(new Request("https://x/internal/create-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-creator-1", "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: channelId, creator_user_id: "u-creator-1", title: "My Channel", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [{ user_id: "u-init-1", role: "member" }] }),
    }));
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { membership: { role: string }; event_ids: string[] };
    expect(body2.membership.role).toBe("owner");
    expect(body2.event_ids).toEqual([]); // no new events on idempotent re-call
  });

  it("rejects non-null avatar_attachment_id (Phase 3, attachments are Phase 5)", async () => {
    const { res } = await createChannel({ avatar_attachment_id: "att-1" });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects owner role in initial_members", async () => {
    const { res } = await createChannel({ initial_members: [{ user_id: "u-x", role: "owner" }] });
    expect(res.status).toBe(422);
  });
});
