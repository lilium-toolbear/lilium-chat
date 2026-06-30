import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import type { UserDirectory } from "../../src/do/user-directory";

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

type OpenDmResult =
  | { kind: "cached"; response: unknown }
  | { kind: "needs_inflate"; channel_id: string; joined_at: string; role: string };

async function openDm(openerId: string, recipientId: string, key: string): Promise<{ body: OpenDmResult; stub: DurableObjectStub<UserDirectory> }> {
  const stub = getNamedDo<UserDirectory>(env.USER_DIRECTORY as unknown as DurableObjectNamespace<UserDirectory>, openerId);
  const body = await stub.openDm(openerId, { idempotency_key: key, recipient_user_id: recipientId }) as OpenDmResult;
  return { body, stub };
}

function needsInflate(body: OpenDmResult): Extract<OpenDmResult, { kind: "needs_inflate" }> {
  if (body.kind !== "needs_inflate") throw new Error("expected needs_inflate openDm result");
  return body;
}

describe("UserDirectory openDm", () => {
  it("first open returns needs_inflate with channel_id and joined_at", async () => {
    const { body } = await openDm(USER_A, USER_B, "dm-key-1");
    const needs = needsInflate(body);
    expect(body.kind).toBe("needs_inflate");
    expect(needs.channel_id).toBeTruthy();
    expect(needs.joined_at).toBeTruthy();
    expect(needs.role).toBe("member");
  });

  it("B opens A after A created pair returns same channel_id", async () => {
    const a = await openDm(USER_A, USER_B, "dm-key-ab-a");
    const b = await openDm(USER_B, USER_A, "dm-key-ab-b");
    expect(needsInflate(b.body).channel_id).toBe(needsInflate(a.body).channel_id);
    expect(needsInflate(b.body).joined_at).toBeTruthy();
  });

  it("same key + different recipient returns 409 IDEMPOTENCY_CONFLICT", async () => {
    const USER_C = "00000000-0000-7000-8000-000000000403";
    await openDm(USER_A, USER_B, "dm-key-conflict");
    try {
      await openDm(USER_A, USER_C, "dm-key-conflict");
      throw new Error("openDm should have failed");
    } catch (err) {
      expect(err).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", remote: true });
    }
  });

  it("self-DM returns 422 INVALID_DM_TARGET", async () => {
    try {
      await openDm(USER_A, USER_A, "dm-key-self");
      throw new Error("openDm should have failed");
    } catch (err) {
      expect(err).toMatchObject({ code: "INVALID_DM_TARGET", remote: true });
    }
  });

  it("cached response after open-dm-complete", async () => {
    const { body, stub } = await openDm(USER_A, USER_B, "dm-key-cached");
    const needs = needsInflate(body);
    expect(needs.kind).toBe("needs_inflate");

    const cachedResponse = {
      channel: { channel_id: needs.channel_id, kind: "dm" },
      membership: { role: "member", joined_at: needs.joined_at },
    };
    await stub.completeOpenDm(USER_A, { idempotency_key: "dm-key-cached", response_json: JSON.stringify(cachedResponse) });

    const replay = await openDm(USER_A, USER_B, "dm-key-cached");
    if (replay.body.kind !== "cached") throw new Error("expected cached openDm replay");
    expect((replay.body.response as typeof cachedResponse).channel.channel_id).toBe(needs.channel_id);
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

    const { body, stub } = await openDm(USER_A, USER_B, "dm-key-cached-no-resolve");
    const needs = needsInflate(body);
    const cachedResponse = {
      channel: { channel_id: needs.channel_id, kind: "dm" },
      membership: { role: "member", joined_at: needs.joined_at },
    };
    await stub.completeOpenDm(USER_A, { idempotency_key: "dm-key-cached-no-resolve", response_json: JSON.stringify(cachedResponse) });

    const callsBeforeReplay = resolveCalls;
    const replay = await openDm(USER_A, USER_B, "dm-key-cached-no-resolve");
    expect(replay.body.kind).toBe("cached");
    expect(resolveCalls).toBe(callsBeforeReplay);
  });

  it("unknown recipient returns 404 DM_TARGET_NOT_FOUND", async () => {
    const { resolveUserSummaries } = await import("../../src/profile/resolve");
    const unknown = "00000000-0000-7000-8000-000000009999";
    vi.mocked(resolveUserSummaries).mockImplementationOnce(async () => new Map());

    try {
      await openDm(USER_A, unknown, "dm-key-unknown");
      throw new Error("openDm should have failed");
    } catch (err) {
      expect(err).toMatchObject({ code: "DM_TARGET_NOT_FOUND", remote: true });
    }
  });

  it("same key + self recipient after prior different recipient returns 409 IDEMPOTENCY_CONFLICT", async () => {
    await openDm(USER_A, USER_B, "dm-key-self-after-b");
    try {
      await openDm(USER_A, USER_A, "dm-key-self-after-b");
      throw new Error("openDm should have failed");
    } catch (err) {
      expect(err).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", remote: true });
    }
  });

  it("resume creating row without response_json re-enters orchestration", async () => {
    const first = await openDm(USER_A, USER_B, "dm-key-resume");
    expect(first.body.kind).toBe("needs_inflate");

    const second = await openDm(USER_A, USER_B, "dm-key-resume");
    expect(second.body.kind).toBe("needs_inflate");
    expect(needsInflate(second.body).channel_id).toBe(needsInflate(first.body).channel_id);
  });

  it("resume creating row then complete then cached replay", async () => {
    const { body, stub } = await openDm(USER_A, USER_B, "dm-key-resume-complete");
    const needs = needsInflate(body);
    expect(needs.kind).toBe("needs_inflate");

    const resume = await openDm(USER_A, USER_B, "dm-key-resume-complete");
    expect(resume.body.kind).toBe("needs_inflate");
    expect(needsInflate(resume.body).channel_id).toBe(needs.channel_id);

    const cachedResponse = {
      channel: { channel_id: needs.channel_id, kind: "dm" },
      membership: { role: "member", joined_at: needs.joined_at },
    };
    await stub.completeOpenDm(USER_A, { idempotency_key: "dm-key-resume-complete", response_json: JSON.stringify(cachedResponse) });

    const replay = await openDm(USER_A, USER_B, "dm-key-resume-complete");
    if (replay.body.kind !== "cached") throw new Error("expected cached openDm replay");
    expect((replay.body.response as typeof cachedResponse).channel.channel_id).toBe(needs.channel_id);
  });
});
