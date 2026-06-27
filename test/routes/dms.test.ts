import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../helpers";

vi.mock("../../src/profile/resolve", () => ({
  resolveUserSummaries: vi.fn(async (userIds: string[]) => {
    const map = new Map<string, { user_id: string; display_name: string; avatar_url: null }>();
    for (const id of userIds) {
      map.set(id, { user_id: id, display_name: `User ${id.slice(-4)}`, avatar_url: null });
    }
    return map;
  }),
}));

const USER_A = "00000000-0000-7000-8000-000000000601";
const USER_B = "00000000-0000-7000-8000-000000000602";

async function postDms(token: string, recipientId: string, key: string): Promise<Response> {
  const SELF = (await import("../../src/index")).default;
  const testEnv = { ...env, JWT_SECRET: TEST_SECRET };
  return SELF.fetch(new Request("https://chat.kuma.homes/api/chat/dms", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_user_id: recipientId }),
  }), testEnv as typeof env, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
}

describe("POST /api/chat/dms", () => {
  it("happy path returns full ChannelSummary with dm_peer", async () => {
    const token = await makeJwt({ sub: USER_A });
    const res = await postDms(token, USER_B, "http-dm-1");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      channel: {
        channel_id: string;
        kind: string;
        dm_peer: { user_id: string };
        unread_count: number;
        last_read_event_id: null;
        last_message_preview: null;
        last_message_at: null;
        last_event_id: string | null;
      };
      membership: { role: string; joined_at: string };
    };
    expect(body.channel.kind).toBe("dm");
    expect(body.channel.dm_peer.user_id).toBe(USER_B);
    expect(body.channel.unread_count).toBe(0);
    expect(body.channel.last_read_event_id).toBeNull();
    expect(body.membership.role).toBe("member");
    expect(body.membership.joined_at).toBeTruthy();
  });

  it("B opens A after A opened B returns same channel_id", async () => {
    const tokenA = await makeJwt({ sub: USER_A });
    const tokenB = await makeJwt({ sub: USER_B });
    const r1 = await postDms(tokenA, USER_B, "http-dm-ab-a");
    const b1 = await r1.json() as { channel: { channel_id: string } };
    const r2 = await postDms(tokenB, USER_A, "http-dm-ab-b");
    const b2 = await r2.json() as { channel: { channel_id: string } };
    expect(b2.channel.channel_id).toBe(b1.channel.channel_id);
  });

  it("missing Idempotency-Key returns 422 INVALID_MESSAGE (codebase convention)", async () => {
    const SELF = (await import("../../src/index")).default;
    const testEnv = { ...env, JWT_SECRET: TEST_SECRET };
    const token = await makeJwt({ sub: USER_A });
    const res = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/dms", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient_user_id: USER_B }),
    }), testEnv as typeof env, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_MESSAGE");
  });

  it("unknown recipient returns 404 DM_TARGET_NOT_FOUND", async () => {
    const { resolveUserSummaries } = await import("../../src/profile/resolve");
    const unknown = "00000000-0000-7000-8000-000000009999";
    vi.mocked(resolveUserSummaries).mockImplementationOnce(async () => new Map());

    const token = await makeJwt({ sub: USER_A });
    const res = await postDms(token, unknown, "http-dm-unknown");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("DM_TARGET_NOT_FOUND");
  });

  it("self-DM returns 422 INVALID_DM_TARGET", async () => {
    const token = await makeJwt({ sub: USER_A });
    const res = await postDms(token, USER_A, "http-dm-self");
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_DM_TARGET");
  });

  it("idempotent retry returns same channel", async () => {
    const token = await makeJwt({ sub: USER_A });
    const r1 = await postDms(token, USER_B, "http-dm-idem");
    const b1 = await r1.json() as { channel: { channel_id: string } };
    const r2 = await postDms(token, USER_B, "http-dm-idem");
    const b2 = await r2.json() as { channel: { channel_id: string } };
    expect(b2.channel.channel_id).toBe(b1.channel.channel_id);
  });

  it("completed idempotent replay returns byte-identical body without profile resolve", async () => {
    const { resolveUserSummaries } = await import("../../src/profile/resolve");
    let resolveCalls = 0;
    vi.mocked(resolveUserSummaries).mockImplementation(async (userIds) => {
      resolveCalls++;
      const map = new Map<string, { user_id: string; display_name: string; avatar_url: null }>();
      for (const id of userIds) {
        map.set(id, { user_id: id, display_name: `User ${id.slice(-4)}`, avatar_url: null });
      }
      return map;
    });

    const token = await makeJwt({ sub: USER_A });
    const r1 = await postDms(token, USER_B, "http-dm-idem-bytes");
    expect(r1.status).toBe(200);
    const bodyText1 = await r1.text();

    const callsBeforeReplay = resolveCalls;
    const r2 = await postDms(token, USER_B, "http-dm-idem-bytes");
    expect(r2.status).toBe(200);
    expect(await r2.text()).toBe(bodyText1);
    expect(resolveCalls).toBe(callsBeforeReplay);
  });

  it("projects dm to recipient my_channels after outbox flush", async () => {
    const token = await makeJwt({ sub: USER_A });
    const res = await postDms(token, USER_B, "http-dm-proj");
    const body = await res.json() as { channel: { channel_id: string } };
    const chStub = env.CHAT_CHANNEL.getByName(body.channel.channel_id);
    const { runDurableObjectAlarm } = await import("cloudflare:test") as { runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void> };
    const dirStub = env.USER_DIRECTORY.getByName(USER_B);
    for (let i = 0; i < 40; i++) {
      await runDurableObjectAlarm(chStub);
      const listRes = await dirStub.fetch(new Request("https://x/my-channels", {
        headers: { "X-Verified-User-Id": USER_B },
      }));
      if (listRes.ok) {
        const items = ((await listRes.json()) as { items: Array<{ channel_id: string; kind: string }> }).items;
        const row = items.find((it) => it.channel_id === body.channel.channel_id);
        if (row) {
          expect(row.kind).toBe("dm");
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("dm not projected to recipient my_channels");
  });
});
