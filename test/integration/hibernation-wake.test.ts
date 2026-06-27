import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { makeJwt, setupOwnedChannelForUser, TEST_SECRET } from "../helpers";
import { liveStartAndAck, upgradeUserConnection } from "../ws-helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

describe("hibernation wake: attachment restore + HTTP catch-up", () => {
  it("missed events before live_start are available via GET /events, not auto-replayed on connect", async () => {
    const userId = "u-hib-1";
    const token = await makeJwt({ sub: userId }, TEST_SECRET);
    const { stub: channelStub, channelId } = await setupOwnedChannelForUser(env, userId, {
      title: "Lilium",
      visibility: "public_listed",
    });

    const beforeSend = (await (
      await channelStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))
    ).json()) as { last_event_id: string | null };
    const staleCursor = beforeSend.last_event_id ?? "";

    const send = (await (
      await channelStub.fetch(
        new Request("https://x/internal/message-send", {
          method: "POST",
          headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
          body: JSON.stringify({
            command_id: "cm-hib-1",
            dedupe_principal_key: `user:${userId}`,
            type: "text",
            text: "before reconnect",
            reply_to: null,
            mentions: [],
            channel_id: channelId,
          }),
        }),
      )
    ).json()) as { event_id: string };

    const { ws } = await upgradeUserConnection(userId);
    await liveStartAndAck(ws, "cmd-hib-live");

    const catchUpRes = await SELF.fetch(
      new Request(
        `https://chat.kuma.homes/api/chat/events?channel_id=${encodeURIComponent(channelId)}&after_event_id=${encodeURIComponent(staleCursor)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      { ...env, JWT_SECRET: TEST_SECRET } as typeof env,
    );
    expect(catchUpRes.status).toBe(200);
    const body = (await catchUpRes.json()) as { items: Array<{ event_id: string }> };
    expect(body.items.some((item) => item.event_id === send.event_id)).toBe(true);
    ws.close();
  });

  it("serializeAttachment round-trips user_id and session_id (the eviction safety property)", async () => {
    const userId = "u-hib-2";
    const { stub } = await upgradeUserConnection(userId);

    const { runInDurableObject } = (await import("cloudflare:test")) as {
      runInDurableObject: (
        stub: DurableObjectStub,
        cb: (instance: unknown, state: { getWebSockets: () => WebSocket[] }) => Promise<void>,
      ) => Promise<void>;
    };
    await runInDurableObject(
      stub,
      async (_instance: unknown, state: { getWebSockets: () => WebSocket[] }) => {
        const socket = state.getWebSockets()[0];
        expect(socket).toBeDefined();
        if (!socket) return;
        const att = socket.deserializeAttachment() as { user_id: string; session_id: string } | null;
        expect(att?.user_id).toBe(userId);
        expect(att?.session_id).toBeTruthy();
      },
    );
  });
});
