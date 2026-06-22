import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

describe("spike: projection_outbox flush is idempotent at target", () => {
  it("flush writes MessageIndex row once; second flush is a no-op", async () => {
    const srcId = env.CHAT_CHANNEL.idFromName("ob-src");
    const src = env.CHAT_CHANNEL.get(srcId);
    const targetId = env.MESSAGE_INDEX.idFromName("msg-1");
    const target = env.MESSAGE_INDEX.get(targetId);

    await src.fetch(
      new Request("https://x/outbox-insert", {
        method: "POST",
        body: JSON.stringify({
          outbox_id: "ob-1",
          target_key: "msg-1",
          payload: { message_id: "msg-1", channel_id: "ch-1" },
        }),
      }),
    );

    const flush1 = await src.fetch(new Request("https://x/outbox-flush", { method: "POST" }));
    expect(flush1.status).toBe(200);

    const got = await target.fetch(new Request("https://x/get?message_id=msg-1"));
    const gotBody = (await got.json()) as { channel_id?: string };
    expect(gotBody.channel_id).toBe("ch-1");

    const flush2 = await src.fetch(new Request("https://x/outbox-flush", { method: "POST" }));
    expect(flush2.status).toBe(200);

    const got2 = await target.fetch(new Request("https://x/get?message_id=msg-1"));
    const got2Body = (await got2.json()) as { channel_id?: string; count?: number };
    expect(got2Body.channel_id).toBe("ch-1");
  });
});
