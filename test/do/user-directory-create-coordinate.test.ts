import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import type { UserDirectory } from "../../src/do/user-directory";

const CREATOR = "u-coord-creator";

async function coordinate(overrides: Record<string, unknown> = {}) {
  const stub = getNamedDo<UserDirectory>(env.USER_DIRECTORY, CREATOR);
  const body = {
    idempotency_key: "key-1",
    title: "Coord Channel",
    topic: null,
    avatar_attachment_id: null,
    visibility: "private",
    initial_members: [{ user_id: "u-coord-init", role: "member" }],
    ...overrides,
  };
  const res = await stub.channelCreateCoordinate(CREATOR, body);
  return { res, stub, body };
}

describe("UserDirectory channelCreateCoordinate", () => {
  it("first call creates the channel and returns channel + owner membership", async () => {
    const { res } = await coordinate();
    expect(res.channel.kind).toBe("channel");
    expect(res.joined_at).toBeTruthy();
    expect(res.channel.channel_id).toBeTruthy();
  });

  it("same key + same body returns the SAME channel_id (cached)", async () => {
    const r1 = await coordinate({ idempotency_key: "key-dup" });
    const r2 = await coordinate({ idempotency_key: "key-dup" });
    expect(r2.res.channel.channel_id).toBe(r1.res.channel.channel_id);
  });

  it("same key + different body returns 409 IDEMPOTENCY_CONFLICT", async () => {
    await coordinate({ idempotency_key: "key-conflict", title: "First" });
    try {
      await coordinate({ idempotency_key: "key-conflict", title: "Different" });
      throw new Error("expected conflict");
    } catch (err) {
      expect((err as { remote?: unknown; code?: unknown }).remote).toBe(true);
      expect((err as { code?: unknown }).code).toBe("IDEMPOTENCY_CONFLICT");
    }
  });
});
