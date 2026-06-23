import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../../test/helpers";

async function app() {
  return (await import("../index")).default;
}

async function call(path: string, userId = "00000000-0000-7000-8000-000000000201"): Promise<Response> {
  const a = await app();
  const token = await makeJwt({ sub: userId });
  const testEnv = { ...env, JWT_SECRET: TEST_SECRET };
  return a.fetch(
    new Request(`https://chat.kuma.homes${path}`, { headers: { Authorization: `Bearer ${token}` } }),
    testEnv as typeof env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as any,
  );
}

describe("channels routes", () => {
  it("GET /api/chat/channels returns system channel after bootstrap", async () => {
    const a = await app();
    const t = await makeJwt({ sub: "00000000-0000-7000-8000-000000000201" });
    await a.fetch(
      new Request("https://chat.kuma.homes/api/chat/bootstrap", { headers: { Authorization: `Bearer ${t}` } }),
      { ...env, JWT_SECRET: TEST_SECRET } as typeof env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as any,
    );
    const res = await call("/api/chat/channels");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ channel_id: string; kind: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]!.kind).toBe("channel");
  });

  it("GET /api/chat/channels/:id returns detail for the system channel", async () => {
    const listRes = await call("/api/chat/channels");
    const list = await listRes.json() as { items: Array<{ channel_id: string }> };
    const cid = list.items[0]!.channel_id;
    const res = await call(`/api/chat/channels/${cid}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { channel: { channel_id: string; kind: string; status: string } };
    expect(body.channel.channel_id).toBe(cid);
    expect(body.channel.status).toBe("active");
  });
});
