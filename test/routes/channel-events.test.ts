import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createTestChannel, makeJwt, replayTestEvents, sendTestMessage, TEST_SECRET } from "../helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

async function authedChannelEventsReq(
  userId: string,
  channelId: string,
  qs = "",
): Promise<Response> {
  const token = await makeJwt({ sub: userId }, TEST_SECRET);
  const req = new Request(`https://chat.kuma.homes/api/chat/channels/${channelId}/events?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return SELF.fetch(req, { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

describe("GET /api/chat/channels/{channel_id}/events", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/channels/some-id/events"));
    expect(res.status).toBe(401);
  });

  it("returns parsed events, latest_event_id, and next_cursor for a member", async () => {
    const userId = "u-ch-ev-member-1";
    const channelId = "0198dddd-0000-7000-8000-000000000001";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId: userId,
      title: "Events Route",
      visibility: "public_listed",
    });

    const allReplay = await replayTestEvents(stub, userId, "");
    const allFrames = allReplay.events.map((e) => JSON.parse(e.event_json) as { event_id: string; type: string });
    const channelCreated = allFrames.find((f) => f.type === "channel.created");
    expect(channelCreated).toBeDefined();

    const send = (await (
      await sendTestMessage(stub, { userId, channelId, commandId: "cm-ch-ev-1", text: "gap fill" })
    ).json()) as { event_id: string };

    const res = await authedChannelEventsReq(userId, channelId, `after_event_id=${encodeURIComponent(channelCreated!.event_id)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ event_id: string; type: string; payload: Record<string, unknown> }>;
      latest_event_id: string | null;
      next_cursor: string | null;
    };

    expect(body).toHaveProperty("events");
    expect(body).toHaveProperty("latest_event_id");
    expect(body).toHaveProperty("next_cursor");
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.every((e) => typeof e.event_id === "string" && typeof e.type === "string")).toBe(true);
    expect(body.events.every((e) => !("event_json" in e))).toBe(true);

    expect(body.events.some((e) => e.type === "member.joined")).toBe(true);
    expect(body.events.some((e) => e.type === "message.created" && e.event_id === send.event_id)).toBe(true);
    expect(body.latest_event_id).toBe(send.event_id);
  });

  it("returns 403 for non-member on a private channel", async () => {
    const ownerId = "u-ch-ev-owner-2";
    const strangerId = "u-ch-ev-stranger-2";
    const channelId = "0198dddd-0000-7000-8000-000000000002";
    await createTestChannel(env, {
      channelId,
      ownerId,
      title: "Private Events",
      visibility: "private",
    });

    const res = await authedChannelEventsReq(strangerId, channelId);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("paginates with limit and next_cursor", async () => {
    const userId = "u-ch-ev-page-3";
    const channelId = "0198dddd-0000-7000-8000-000000000003";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId: userId,
      title: "Paged Events",
      visibility: "public_listed",
    });
    await sendTestMessage(stub, { userId, channelId, commandId: "cm-ch-ev-page-1", text: "one" });
    await sendTestMessage(stub, { userId, channelId, commandId: "cm-ch-ev-page-2", text: "two" });

    const page1 = await authedChannelEventsReq(userId, channelId, "limit=2");
    expect(page1.status).toBe(200);
    const body1 = (await page1.json()) as {
      events: Array<{ event_id: string }>;
      latest_event_id: string | null;
      next_cursor: string | null;
    };
    expect(body1.events.length).toBe(2);
    expect(body1.next_cursor).toBeTruthy();

    const page2 = await authedChannelEventsReq(
      userId,
      channelId,
      `after_event_id=${encodeURIComponent(body1.next_cursor ?? "")}&limit=100`,
    );
    expect(page2.status).toBe(200);
    const body2 = (await page2.json()) as {
      events: Array<{ event_id: string }>;
      next_cursor: string | null;
    };
    expect(body2.events.length).toBeGreaterThan(0);
    expect(body2.events[0]!.event_id > body1.events[body1.events.length - 1]!.event_id).toBe(true);
  });

  it("returns channel latest_event_id when page is empty", async () => {
    const userId = "u-ch-ev-empty-4";
    const channelId = "0198dddd-0000-7000-8000-000000000004";
    const stub = await createTestChannel(env, {
      channelId,
      ownerId: userId,
      title: "Empty Page",
      visibility: "public_listed",
    });
    const allReplay = await replayTestEvents(stub, userId, "");
    const lastRaw = allReplay.events[allReplay.events.length - 1]!;
    const lastFrame = JSON.parse(lastRaw.event_json) as { event_id: string };

    const res = await authedChannelEventsReq(userId, channelId, `after_event_id=${encodeURIComponent(lastFrame.event_id)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      latest_event_id: string | null;
      next_cursor: string | null;
    };
    expect(body.events).toEqual([]);
    expect(body.latest_event_id).toBe(lastFrame.event_id);
    expect(body.next_cursor).toBeNull();
  });
});
