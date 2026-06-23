import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../../test/helpers";
import type { Env } from "../env";
import { ensureSystemChannel, ensureSystemJoined, channelRouteNameFor, SYSTEM_CHANNEL_NAME } from "./system-channel";

const testEnv = env as unknown as Env;

describe("system-channel helpers", () => {
  it("ensureSystemChannel returns a stable UUIDv7 channel_id", async () => {
    const a = await ensureSystemChannel(testEnv);
    const b = await ensureSystemChannel(testEnv);
    expect(a.channelId).toBe(b.channelId);
    expect(a.channelId).toMatch(/^01[0-9a-f]{6}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("channelRouteNameFor returns system name for system channelId, null for others", async () => {
    const userId = "u-route-1";
    const { channelId } = await ensureSystemJoined(testEnv, userId);
    expect(await channelRouteNameFor(testEnv, userId, channelId)).toBe(SYSTEM_CHANNEL_NAME);
    expect(await channelRouteNameFor(testEnv, userId, "unknown-uuid")).toBeNull();
  });
});
