import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

describe("spike: InviteDirectory lookup → ROUTE_INDEX_PENDING before flush, resolves after", () => {
  it("invite lookup miss then hit after upsert", async () => {
    const code = "invite-routing-1";
    const idx = env.INVITE_DIRECTORY.getByName(code);

    const before = await idx.fetch(new Request(`https://x/get?code=${code}`));
    const beforeBody = (await before.json()) as { channel_id?: string };
    expect(beforeBody.channel_id).toBeUndefined();

    await idx.fetch(
      new Request("https://x/upsert", {
        method: "POST",
        body: JSON.stringify({ invite_code: code, channel_id: "ch-invite-1" }),
      }),
    );

    const after = await idx.fetch(new Request(`https://x/get?code=${code}`));
    const afterBody = (await after.json()) as { channel_id?: string; status?: string };
    expect(afterBody.channel_id).toBe("ch-invite-1");
    expect(afterBody.status).toBe("active");
  });
});
