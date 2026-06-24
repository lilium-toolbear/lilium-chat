import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET, getNamedDo } from "../helpers";

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

    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    await sysStub.fetch(
      new Request("https://x/internal/join", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }),
    );
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", {
      headers: { "X-Verified-User-Id": userId },
    }))).json() as { channel_id: string }).channel_id;
    const send = (await (
      await sysStub.fetch(
        new Request("https://x/internal/message-send", {
          method: "POST",
          headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
          body: JSON.stringify({
            command_id: "cm-ev-1",
            dedupe_principal_key: `user:${userId}`,
            type: "text",
            text: "hi",
            reply_to: null,
            mentions: [],
            channel_id: sysId,
          }),
        }),
      )
    ).json()) as { event_id: string };

    const res = await authedEventsReq(userId, token, `channel_id=${sysId}&after_event_id=`);
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
    expect(body.last_event_id_per_channel[sysId]).toBeTruthy();
  });

  it("replays all my channels via cursors (multi-channel merge)", async () => {
    const userId = "u-ev-2";
    const token = await makeJwt({ sub: userId }, TEST_SECRET);

    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(
      new Request("https://x/internal/join", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }),
    );
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as {
      channel_id: string;
    }).channel_id;
    await sysStub.fetch(
      new Request("https://x/internal/message-send", {
        method: "POST",
        headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: "cm-ev-2",
          dedupe_principal_key: `user:${userId}`,
          type: "text",
          text: "yo",
          reply_to: null,
          mentions: [],
          channel_id: sysId,
        }),
      }),
    );

    const cursors = btoa("{}").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await authedEventsReq(userId, token, `cursors=${cursors}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<unknown>;
      last_event_id_per_channel: Record<string, string>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.last_event_id_per_channel[sysId]).toBeTruthy();
  });
});
