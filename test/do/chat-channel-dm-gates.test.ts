import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createTestDmChannel, expectDoRpcError } from "../helpers";

const USER_A = "00000000-0000-7000-8000-000000000701";
const USER_B = "00000000-0000-7000-8000-000000000702";

async function seedDm() {
  return createTestDmChannel(env, USER_A, USER_B, USER_A);
}

describe("ChatChannel DM management gates", () => {
  it("rejects update-channel on dm with UNSUPPORTED_CHANNEL_KIND", async () => {
    const { stub, channelId } = await seedDm();
    await expectDoRpcError(
      () => stub.updateChannel({ user_id: USER_A, idempotency_key: "k1", channel_id: channelId, title: "nope" }),
      "UNSUPPORTED_CHANNEL_KIND",
    );
  });

  it("rejects dissolve on dm", async () => {
    const { stub, channelId } = await seedDm();
    await expectDoRpcError(
      () => stub.dissolveChannel({ user_id: USER_A, idempotency_key: "k2", channel_id: channelId }),
      "UNSUPPORTED_CHANNEL_KIND",
    );
  });

  it("rejects join on dm", async () => {
    const { stub } = await seedDm();
    await expectDoRpcError(
      () => stub.joinChannel({ user_id: "00000000-0000-7000-8000-000000000799", operation_id: crypto.randomUUID() }),
      "UNSUPPORTED_CHANNEL_KIND",
    );
  });

  it("rejects members-add on dm", async () => {
    const { stub, channelId } = await seedDm();
    await expectDoRpcError(
      () => stub.addMember({
        user_id: USER_A,
        idempotency_key: "k3",
        channel_id: channelId,
        target_user_id: "00000000-0000-7000-8000-000000000799",
        role: "member",
      }),
      "UNSUPPORTED_CHANNEL_KIND",
    );
  });
});
