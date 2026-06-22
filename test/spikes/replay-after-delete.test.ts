import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

describe("spike: replay filters message.created when message is deleted", () => {
  it("created event absent from replay after status=deleted", async () => {
    const chId = env.CHAT_CHANNEL.idFromName("replay-1");
    const ch = env.CHAT_CHANNEL.get(chId);

    await ch.fetch(
      new Request("https://x/spike-create", {
        method: "POST",
        body: JSON.stringify({
          message_id: "m-r-1",
          event_id: "e-r-1",
          text: "hi",
        }),
      }),
    );

    await ch.fetch(
      new Request("https://x/spike-delete", {
        method: "POST",
        body: JSON.stringify({ message_id: "m-r-1" }),
      }),
    );

    const res = await ch.fetch(new Request("https://x/spike-replay?after=e-r-0"));
    const body = (await res.json()) as { events: Array<{ event_id: string; event_type: string }> };
    const created = body.events.find((e) => e.event_type === "message.created");
    expect(created).toBeUndefined();
  });
});
