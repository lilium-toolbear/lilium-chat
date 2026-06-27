import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createTestDmChannel, makeJwt, TEST_SECRET } from "../helpers";

vi.mock("../../src/profile/resolve", () => ({
  resolveUserSummaries: vi.fn(async (userIds: string[]) => {
    const map = new Map<string, { user_id: string; display_name: string; avatar_url: null }>();
    for (const id of userIds) {
      map.set(id, { user_id: id, display_name: `User ${id.slice(-4)}`, avatar_url: null });
    }
    return map;
  }),
}));

const USER_A = "00000000-0000-7000-8000-000000000b01";
const USER_B = "00000000-0000-7000-8000-000000000b02";

describe("public channel directory excludes dm", () => {
  it("does not list dm channels after dm creation", async () => {
    const { channelId } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const SELF = (await import("../../src/index")).default;
    const testEnv = { ...env, JWT_SECRET: TEST_SECRET };
    const token = await makeJwt({ sub: USER_A });
    const res = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/channels/directory", {
      headers: { Authorization: `Bearer ${token}` },
    }), testEnv as typeof env, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ channel_id: string }> };
    expect(body.items.some((it) => it.channel_id === channelId)).toBe(false);
  });
});
