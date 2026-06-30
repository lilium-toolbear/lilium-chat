import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, sendTestMessage, TEST_SECRET, setupOwnedChannelForUser } from "../helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

async function authedEventsReq(userId: string, token: string, qs: string): Promise<Response> {
  const req = new Request(`https://chat.kuma.homes/api/chat/events?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return SELF.fetch(req, { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

describe("GET /api/chat/events", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/events"));
    expect(res.status).toBe(401);
  });

  it("replays a single channel by channel_id + after_event_id", async () => {
    const userId = "u-ev-1";
    const token = await makeJwt({ sub: userId }, TEST_SECRET);

    const { stub: channelStub, channelId } = await setupOwnedChannelForUser(env, userId, { title: "Lilium", visibility: "public_listed" });
    const send = (await (await sendTestMessage(channelStub, { userId, channelId, commandId: "cm-ev-1", text: "hi" })).json()) as {
      event_id: string;
    };

    const res = await authedEventsReq(userId, token, `channel_id=${channelId}&after_event_id=`);
    expect(res.status).toBe(200);
    interface RoutedMessage {
      message_id: string;
      sender: {
        kind: string;
        user: {
          user_id: string;
        };
      };
    }
    const body = (await res.json()) as {
      items: Array<{ event_id: string; type: string; payload: { message: RoutedMessage } }>;
      last_event_id_per_channel: Record<string, string>;
    };
    const found = body.items.find((e) => e.event_id === send.event_id);
    expect(found).toBeDefined();
    expect(found?.type).toBe("message.created");
    expect(found?.payload.message).toBeDefined();
    expect(found?.payload.message).toHaveProperty("message_id");
    expect(found?.payload.message).toHaveProperty("sender");
    expect(found?.payload.message.sender).toHaveProperty("user");
    expect(found?.payload.message.sender.user.user_id).toBe("u-ev-1");
    expect(body.last_event_id_per_channel[channelId]).toBeTruthy();
  });

  it("replays all my channels via cursors (multi-channel merge)", async () => {
    const userId = "u-ev-2";
    const token = await makeJwt({ sub: userId }, TEST_SECRET);

    const { stub: channelStub, channelId } = await setupOwnedChannelForUser(env, userId, { title: "Lilium", visibility: "public_listed" });
    await sendTestMessage(channelStub, { userId, channelId, commandId: "cm-ev-2", text: "yo" });

    const cursors = btoa("{}").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await authedEventsReq(userId, token, `cursors=${cursors}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<unknown>;
      last_event_id_per_channel: Record<string, string>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.last_event_id_per_channel[channelId]).toBeTruthy();
  });
});
