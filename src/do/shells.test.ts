import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";

const DO_BINDINGS = [
  ["CHAT_CHANNEL", "ChatChannel"],
  ["USER_DIRECTORY", "UserDirectory"],
  ["USER_CONNECTION", "UserConnection"],
  ["CHANNEL_DIRECTORY", "ChannelDirectory"],
  ["INVITE_DIRECTORY", "InviteDirectory"],
  ["BOT_REGISTRY", "BotRegistry"],
  ["CHANNEL_FANOUT", "ChannelFanout"],
  ["DM_DIRECTORY", "DMDirectory"],
] as const;

describe("DO shells", () => {
  for (const [binding, className] of DO_BINDINGS) {
    it(`${className} initializes schema and responds ok`, async () => {
      const ns = env[binding] as unknown as DurableObjectNamespace;
      const id = ns.idFromName(`shell-test-${className}`);
      const stub = ns.get(id);
      const res = await stub.fetch(new Request("https://x/ping"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  }

  it("ChatChannel.nextEventId is monotonic within a ms (via SQL inspection)", async () => {
    const id = env.CHAT_CHANNEL.idFromName("seq-test");
    const stub = env.CHAT_CHANNEL.get(id);
    const res = await stub.fetch(new Request("https://x/next-event-id?count=3&ms=1700000000000"));
    const body = (await res.json()) as { ids: string[] };
    expect(body.ids).toHaveLength(3);
    const first = body.ids[0] ?? "";
    const second = body.ids[1] ?? "";
    const third = body.ids[2] ?? "";
    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });
});
