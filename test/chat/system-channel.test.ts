import { describe, it, expect } from "vitest";
import { env as cfEnv } from "cloudflare:workers";
import { channelRouteNameFor, SYSTEM_CHANNEL_NAME } from "../../src/chat/system-channel";

// `cloudflare:workers`'s `env` is typed as Cloudflare.Env (without the secret augmentation from
// src/env.ts). Cast to the augmented Env the route helpers expect — same convention as the
// getNamedDo binding cast used across the suite.
const env = cfEnv as unknown as Parameters<typeof channelRouteNameFor>[0];

describe("channelRouteNameFor", () => {
  it("returns system-general for the system channel id", async () => {
    // Bootstrap the system channel so ensureSystemChannel resolves a real id.
    const sys = await channelRouteNameFor(env, "u-route-1", "will-be-replaced");
    void sys;
    // Resolve the real system channel id, then assert routing.
    const { ensureSystemChannel } = await import("../../src/chat/system-channel");
    const { channelId } = await ensureSystemChannel(env);
    expect(await channelRouteNameFor(env, "u-route-1", channelId)).toBe(SYSTEM_CHANNEL_NAME);
  });

  it("returns the channel_id itself for a non-system channel (optimistic DO routing)", async () => {
    const userChannelId = "0192aaaa-0000-7000-8000-000000000001";
    expect(await channelRouteNameFor(env, "u-route-2", userChannelId)).toBe(userChannelId);
  });

  it("returns null for the literal string 'system-general' (not a user channel id)", async () => {
    expect(await channelRouteNameFor(env, "u-route-3", "system-general")).toBe(null);
  });
});
