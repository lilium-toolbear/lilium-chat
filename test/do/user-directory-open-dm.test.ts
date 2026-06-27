import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

vi.mock("../../src/profile/resolve", () => ({
  resolveUserSummaries: vi.fn(async (userIds: string[]) => {
    const map = new Map<string, { user_id: string; display_name: string; avatar_url: null }>();
    for (const id of userIds) {
      map.set(id, { user_id: id, display_name: `User ${id.slice(-4)}`, avatar_url: null });
    }
    return map;
  }),
}));

const USER_A = "00000000-0000-7000-8000-000000000401";
const USER_B = "00000000-0000-7000-8000-000000000402";

async function openDm(openerId: string, recipientId: string, key: string) {
  const stub = getNamedDo(env.USER_DIRECTORY as unknown as DurableObjectNamespace, openerId);
  const res = await stub.fetch(new Request("https://x/internal/open-dm", {
    method: "POST",
    headers: { "X-Verified-User-Id": openerId, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: key, recipient_user_id: recipientId }),
  }));
  return { res, stub };
}

describe("UserDirectory /internal/open-dm", () => {
  it("first open returns needs_inflate with channel_id and joined_at", async () => {
    const { res } = await openDm(USER_A, USER_B, "dm-key-1");
    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string; channel_id: string; joined_at: string; role: string };
    expect(body.kind).toBe("needs_inflate");
    expect(body.channel_id).toBeTruthy();
    expect(body.joined_at).toBeTruthy();
    expect(body.role).toBe("member");
  });

  it("B opens A after A created pair returns same channel_id", async () => {
    const a = await openDm(USER_A, USER_B, "dm-key-ab-a");
    const aBody = await a.res.json() as { channel_id: string };
    const b = await openDm(USER_B, USER_A, "dm-key-ab-b");
    const bBody = await b.res.json() as { channel_id: string; joined_at: string };
    expect(bBody.channel_id).toBe(aBody.channel_id);
    expect(bBody.joined_at).toBeTruthy();
  });

  it("same key + different recipient returns 409 IDEMPOTENCY_CONFLICT", async () => {
    const USER_C = "00000000-0000-7000-8000-000000000403";
    await openDm(USER_A, USER_B, "dm-key-conflict");
    const r2 = await openDm(USER_A, USER_C, "dm-key-conflict");
    expect(r2.res.status).toBe(409);
    const body = await r2.res.json() as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("self-DM returns 422 INVALID_DM_TARGET", async () => {
    const { res } = await openDm(USER_A, USER_A, "dm-key-self");
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_DM_TARGET");
  });

  it("cached response after open-dm-complete", async () => {
    const { res, stub } = await openDm(USER_A, USER_B, "dm-key-cached");
    const needs = await res.json() as { kind: string; channel_id: string; joined_at: string; role: string };
    expect(needs.kind).toBe("needs_inflate");

    const cachedResponse = {
      channel: { channel_id: needs.channel_id, kind: "dm" },
      membership: { role: "member", joined_at: needs.joined_at },
    };
    await stub.fetch(new Request("https://x/internal/open-dm-complete", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_A, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "dm-key-cached", response_json: JSON.stringify(cachedResponse) }),
    }));

    const replay = await openDm(USER_A, USER_B, "dm-key-cached");
    const replayBody = await replay.res.json() as { kind: string; response: typeof cachedResponse };
    expect(replayBody.kind).toBe("cached");
    expect(replayBody.response.channel.channel_id).toBe(needs.channel_id);
  });

  it("completed replay skips profile resolve", async () => {
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

    const { res, stub } = await openDm(USER_A, USER_B, "dm-key-cached-no-resolve");
    const needs = await res.json() as { kind: string; channel_id: string; joined_at: string; role: string };
    const cachedResponse = {
      channel: { channel_id: needs.channel_id, kind: "dm" },
      membership: { role: "member", joined_at: needs.joined_at },
    };
    await stub.fetch(new Request("https://x/internal/open-dm-complete", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER_A, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "dm-key-cached-no-resolve", response_json: JSON.stringify(cachedResponse) }),
    }));

    const callsBeforeReplay = resolveCalls;
    const replay = await openDm(USER_A, USER_B, "dm-key-cached-no-resolve");
    expect(replay.res.status).toBe(200);
    const replayBody = await replay.res.json() as { kind: string };
    expect(replayBody.kind).toBe("cached");
    expect(resolveCalls).toBe(callsBeforeReplay);
  });

  it("unknown recipient returns 404 DM_TARGET_NOT_FOUND", async () => {
    const { resolveUserSummaries } = await import("../../src/profile/resolve");
    const unknown = "00000000-0000-7000-8000-000000009999";
    vi.mocked(resolveUserSummaries).mockImplementationOnce(async () => new Map());

    const { res } = await openDm(USER_A, unknown, "dm-key-unknown");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("DM_TARGET_NOT_FOUND");
  });

  it("same key + self recipient after prior different recipient returns 409 IDEMPOTENCY_CONFLICT", async () => {
    await openDm(USER_A, USER_B, "dm-key-self-after-b");
    const { res } = await openDm(USER_A, USER_A, "dm-key-self-after-b");
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
