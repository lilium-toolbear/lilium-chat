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

const USER_A = "00000000-0000-7000-8000-000000000801";
const USER_B = "00000000-0000-7000-8000-000000000802";

async function api(token: string, method: string, path: string, body?: unknown, key?: string): Promise<Response> {
  const SELF = (await import("../../src/index")).default;
  const testEnv = { ...env, JWT_SECRET: TEST_SECRET };
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (key) headers["Idempotency-Key"] = key;
  return SELF.fetch(new Request(`https://chat.kuma.homes${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }), testEnv as typeof env, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
}

describe("DM forbidden HTTP mutations", () => {
  let channelId = "";

  it("seeds a dm channel", async () => {
    const { channelId: id } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    channelId = id;
    expect(channelId).toBeTruthy();
  });

  it("PATCH channel returns 409 UNSUPPORTED_CHANNEL_KIND", async () => {
    const token = await makeJwt({ sub: USER_A });
    const res = await api(token, "PATCH", `/api/chat/channels/${channelId}`, { title: "x" }, "mut-1");
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_CHANNEL_KIND");
  });

  it("POST dissolve returns 409", async () => {
    const token = await makeJwt({ sub: USER_A });
    const res = await api(token, "POST", `/api/chat/channels/${channelId}/dissolve`, {}, "mut-2");
    expect(res.status).toBe(409);
  });

  it("GET commands returns empty list for dm", async () => {
    const token = await makeJwt({ sub: USER_A });
    const res = await api(token, "GET", `/api/chat/channels/${channelId}/commands`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
