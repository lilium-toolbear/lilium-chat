import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { InviteDirectory } from "../../src/do/invite-directory";

describe("spike: InviteDirectory lookup → ROUTE_INDEX_PENDING before flush, resolves after", () => {
  it("invite lookup miss then hit after upsert", async () => {
    const code = "invite-routing-1";
    const idx = env.INVITE_DIRECTORY.getByName(code) as DurableObjectStub<InviteDirectory>;

    const beforeBody = await idx.getInviteRoute(code);
    expect(beforeBody?.channel_id).toBeUndefined();

    await idx.upsertInvite({ invite_code: code, channel_id: "ch-invite-1" });

    const afterBody = await idx.getInviteRoute(code);
    expect(afterBody).not.toBeNull();
    if (afterBody === null) throw new Error("invite route missing");
    expect(afterBody.channel_id).toBe("ch-invite-1");
    expect(afterBody.status).toBe("active");
  });
});
