import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import type { UserDirectory } from "../../src/do/user-directory";

const USER = "u-rs-1";
const CHANNEL = "0197aaaa-0000-7000-8000-000000000001";
const USER_ADV = "u-rs-adv";
const CHANNEL_ADV = "0197aaaa-0000-7000-8000-000000000010";

async function seedMembership() {
  // Simulate a my_channels active row (normally written via the user_directory join outbox).
  const stub = getNamedDo<UserDirectory>(env.USER_DIRECTORY as unknown as DurableObjectNamespace<UserDirectory>, USER);
  await stub.upsertChannelProjection(USER, { action: "join", channel_id: CHANNEL, kind: "channel", membership_version: 1 });
  return stub;
}

describe("UserDirectory updateReadState", () => {
  it("sets last_read_event_id on first mark (advanced: true)", async () => {
    const stub = await seedMembership();
    const body = await stub.updateReadState(USER, { channel_id: CHANNEL, last_read_event_id: "01J00000000000000000000000" });
    expect(body.channel_id).toBe(CHANNEL);
    expect(body.last_read_event_id).toBe("01J00000000000000000000000");
    expect(body.advanced).toBe(true);
  });

  it("same cursor re-mark → advanced:false (no emit field)", async () => {
    const stub = await seedMembership();
    const cursor = "01J00000000000000000000010";
    const b1 = await stub.updateReadState(USER, { channel_id: CHANNEL, last_read_event_id: cursor });
    const b2 = await stub.updateReadState(USER, { channel_id: CHANNEL, last_read_event_id: cursor });
    expect(b1.advanced).toBe(true);
    expect(b2.advanced).toBe(false);
  });

  it("only advances monotonically: earlier cursor returns the STORED floor (not the request cursor)", async () => {
    const stub = await seedMembership();
    await stub.updateReadState(USER, { channel_id: CHANNEL, last_read_event_id: "01Jzzzzzzzzzzzzzzzzzzzzzz" });
    const body = await stub.updateReadState(USER, { channel_id: CHANNEL, last_read_event_id: "01Jaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(body.last_read_event_id).toBe("01Jzzzzzzzzzzzzzzzzzzzzzz"); // stored floor, NOT the earlier request cursor
    expect(body.advanced).toBe(false);
  });

  it("403 if not an active member of the channel", async () => {
    const stub = getNamedDo<UserDirectory>(env.USER_DIRECTORY as unknown as DurableObjectNamespace<UserDirectory>, "u-rs-nobody");
    try {
      await stub.updateReadState("u-rs-nobody", { channel_id: "0197bbbb-0000-7000-8000-000000000002", last_read_event_id: "01Jx" });
      throw new Error("updateReadState should have failed");
    } catch (err) {
      expect(err).toMatchObject({ code: "FORBIDDEN", remote: true });
    }
  });

  it("returns advanced:false on same-cursor re-mark while preserving stored floor", async () => {
    const stub = getNamedDo<UserDirectory>(env.USER_DIRECTORY as unknown as DurableObjectNamespace<UserDirectory>, USER_ADV);
    await stub.upsertChannelProjection(USER_ADV, { action: "join", channel_id: CHANNEL_ADV, kind: "channel", membership_version: 1 });
    const cursor = "01J00000000000000000000020";
    const firstBody = await stub.updateReadState(USER_ADV, { channel_id: CHANNEL_ADV, last_read_event_id: cursor });
    const secondBody = await stub.updateReadState(USER_ADV, { channel_id: CHANNEL_ADV, last_read_event_id: cursor });
    expect(firstBody.advanced).toBe(true);
    expect(firstBody.last_read_event_id).toBe(cursor);
    expect(secondBody.advanced).toBe(false);
  });
});
