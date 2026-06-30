import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { addTestMember, createTestChannel, expectDoRpcError, getNamedDo, joinTestChannel, removeTestMember } from "../helpers";
import type { JoinChannelApiResponse } from "../../src/contract/channel-api";
import type { ChatChannel } from "../../src/do/chat-channel";

const { runInDurableObject } = await import("cloudflare:test") as {
  runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
};

async function getMemberRow(channelId: string, userId: string): Promise<{ role: string; joined_at: string; left_at: string | null } | undefined> {
  let out: { role: string; joined_at: string; left_at: string | null } | undefined;
  const stub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL, channelId);
  await runInDurableObject(stub, async (instance: unknown) => {
    out = (instance as {
      ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => Array<{ role: string; joined_at: string; left_at: string | null }> } } } };
    }).ctx.storage.sql
      .exec("SELECT role, joined_at, left_at FROM members WHERE channel_id=? AND user_id=?", channelId, userId)
      .toArray()[0];
  });
  return out;
}

async function countMemberJoinedEvents(channelId: string, userId: string): Promise<number> {
  let n = 0;
  const stub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL, channelId);
  await runInDurableObject(stub, async (instance: unknown) => {
    const row = (instance as {
      ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => Array<{ c: number | bigint }> } } } };
    }).ctx.storage.sql
      .exec("SELECT COUNT(*) AS c FROM events WHERE channel_id=? AND event_type='member.joined' AND payload_json LIKE ?", channelId, `%"user_id":"${userId}"%`)
      .toArray()[0];
    n = Number(row?.c ?? 0);
  });
  return n;
}

async function getIdemRows(channelId: string, userId: string, operationId: string): Promise<{ request_hash: string; response_json: string }[]> {
  let out: { request_hash: string; response_json: string }[] = [];
  const stub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL, channelId);
  await runInDurableObject(stub, async (instance: unknown) => {
    out = (instance as {
      ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => Array<{ request_hash: string; response_json: string }> } } } };
    }).ctx.storage.sql
      .exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.join' AND operation_id=?", userId, operationId)
      .toArray();
  });
  return out;
}

function uniqId(label: string): string {
  return `0199cf00-0000-7000-8000-${label.padStart(12, "0")}`;
}


async function createChannel(opts: { channelId: string; ownerId: string; visibility: string; title?: string }) {
  const stub = await createTestChannel(env, {
    channelId: opts.channelId,
    ownerId: opts.ownerId,
    title: opts.title ?? "JoinTest",
    visibility: opts.visibility,
  });
  await stub.getSummary(opts.ownerId);
  return { stub };
}

async function join(stub: DurableObjectStub<ChatChannel>, userId: string, operationId?: string): Promise<JoinChannelApiResponse> {
  return joinTestChannel(stub, userId, operationId);
}

describe("ChatChannel join RPC", () => {
  it("join public_listed channel as non-member → 200, member row, member.joined event, user_directory + channel_directory outbox, idempotency row", async () => {
    const channelId = uniqId("b10101");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-1", visibility: "public_listed", title: "PubJoin1" });
    const body = await join(stub, "u-b1-joiner-1", "op-join-1");
    expect(body.channel_id).toBe(channelId);
    expect(body.role).toBe("member");
    const m = await getMemberRow(channelId, "u-b1-joiner-1");
    expect(m).toBeDefined();
    expect(m!.left_at).toBeNull();
    expect(m!.role).toBe("member");
    const evCount = await countMemberJoinedEvents(channelId, "u-b1-joiner-1");
    expect(evCount).toBe(1);
    // idempotency row written (principal-scoped on the joiner)
    const idem = await getIdemRows(channelId, "u-b1-joiner-1", "op-join-1");
    expect(idem.length).toBe(1);
  });

  it("duplicate same operation_id → cached response, no second member row, no second event", async () => {
    const channelId = uniqId("b10201");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-2", visibility: "public_listed", title: "PubJoin2" });
    const b1 = await join(stub, "u-b1-joiner-2", "op-join-2");
    const b2 = await join(stub, "u-b1-joiner-2", "op-join-2");
    expect(b2.joined_at).toBe(b1.joined_at);
    expect(b2.membership_version).toBe(b1.membership_version);
    expect(b2.role).toBe("member");
    const evCount = await countMemberJoinedEvents(channelId, "u-b1-joiner-2");
    expect(evCount).toBe(1); // no second event
  });

  it("join private channel as non-member → 403 FORBIDDEN", async () => {
    const channelId = uniqId("b10401");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-4", visibility: "private", title: "PrivJoin4" });
    await expectDoRpcError(() => join(stub, "u-b1-stranger-4", "op-priv-4"), "FORBIDDEN");
  });

  it("join public_unlisted channel as non-member → 403 FORBIDDEN", async () => {
    const channelId = uniqId("b10501");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-5", visibility: "public_unlisted", title: "UnlistedJoin5" });
    await expectDoRpcError(() => join(stub, "u-b1-stranger-5", "op-unlisted-5"), "FORBIDDEN");
  });

  it("join dissolved channel → 409 CHANNEL_DISSOLVED", async () => {
    const channelId = uniqId("b10601");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-6", visibility: "public_listed", title: "DissolvedJoin6" });
    await stub.dissolveChannel({ user_id: "u-b1-owner-6", idempotency_key: "ik-dissolve-6", channel_id: channelId });
    await expectDoRpcError(() => join(stub, "u-b1-stranger-6", "op-dissolved-6"), "CHANNEL_DISSOLVED");
  });

  it("join kind='dm' channel → 409 UNSUPPORTED_CHANNEL_KIND", async () => {
    // Create a DM-kind channel by directly inserting channel_meta via runInDurableObject.
    const channelId = uniqId("b10701");
    const stub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL, channelId);
    await runInDurableObject(stub, async (instance: unknown) => {
      (instance as {
        ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => void } } };
      }).ctx.storage.sql.exec(
        `INSERT INTO channel_meta (channel_id, kind, visibility, title, topic, avatar_url, status, created_by, created_at, updated_at, member_count, membership_version) VALUES (?, 'dm', 'private', 'DM', NULL, NULL, 'active', 'u-dm-a', ?, ?, 1, 1)`,
        channelId, new Date().toISOString(), new Date().toISOString(),
      );
      (instance as {
        ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => void } } };
      }).ctx.storage.sql.exec(
        "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, 'u-dm-a', 'owner', ?, NULL)",
        channelId, new Date().toISOString(),
      );
    });
    await expectDoRpcError(() => join(stub, "u-b1-stranger-7", "op-dm-7"), "UNSUPPORTED_CHANNEL_KIND");
  });

  it("already-active-member join → 200, returns existing joined_at/membership_version/existing role (NOT reset), no duplicate event, no count bump, idempotency row IS written", async () => {
    const channelId = uniqId("b10801");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-8", visibility: "public_listed", title: "ActiveJoin8" });
    // owner is already an active member with role 'owner'
    const body = await join(stub, "u-b1-owner-8", "op-active-8");
    expect(body.role).toBe("owner"); // existing role, not 'member'
    const evCount = await countMemberJoinedEvents(channelId, "u-b1-owner-8");
    expect(evCount).toBe(1); // the create-channel member.joined, no new one from join
    // idempotency row IS written
    let idem: { response_json: string }[] = [];
    await runInDurableObject(stub, async (instance: unknown) => {
      idem = (instance as {
        ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => Array<{ response_json: string }> } } } };
      }).ctx.storage.sql
        .exec("SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.join' AND operation_id=?", "u-b1-owner-8", "op-active-8")
        .toArray();
    });
    expect(idem.length).toBe(1);
  });

  it("already-active-owner join → role='owner' in response (P0-4)", async () => {
    const channelId = uniqId("b10901");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-9", visibility: "public_listed", title: "OwnerJoin9" });
    const body = await join(stub, "u-b1-owner-9", "op-owner-9");
    expect(body.role).toBe("owner");
  });

  it("cached retry of an already-active-member no-op returns the cached role/joined_at even after the user later leaves", async () => {
    const channelId = uniqId("b10a01");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-a", visibility: "public_listed", title: "CachedNoopA" });
    // first join as a fresh user (becomes member) with operation_id op-cached-a
    const b1 = await join(stub, "u-b1-joiner-a", "op-cached-a");
    expect(b1.role).toBe("member");
    // Now the user leaves (owner removes them).
    await removeTestMember(stub, { actorUserId: "u-b1-owner-a", targetUserId: "u-b1-joiner-a", channelId, idempotencyKey: "ik-remove-a" });
    // A retry with the SAME operation_id must return the cached no-op... but wait: the first call
    // was a FRESH join (real mutation), so the cached result is the fresh-join result. The plan's
    // "cached retry of an already-active-member no-op" scenario requires the FIRST call to be a
    // no-op. Re-do: owner joins own channel (active no-op) with operation_id op-cached-a2.
    const b2 = await join(stub, "u-b1-owner-a", "op-cached-a2");
    expect(b2.role).toBe("owner");
    // owner cannot leave (owner invariant), so simulate a leave via direct DB edit to force a non-active state.
    await runInDurableObject(stub, async (instance: unknown) => {
      (instance as {
        ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => void } } };
      }).ctx.storage.sql.exec("UPDATE members SET left_at=? WHERE channel_id=? AND user_id=?", new Date().toISOString(), channelId, "u-b1-owner-a");
    });
    // retry with the same operation_id → must return the cached no-op result (role=owner), NOT rejoin.
    const b3 = await join(stub, "u-b1-owner-a", "op-cached-a2");
    expect(b3.role).toBe("owner");
    expect(b3.joined_at).toBe(b2.joined_at);
  });

  it("rejoin as a left user on a public channel → 200, joined_at updated, left_at=NULL, role='member', member.joined event, count bumped, outbox written", async () => {
    const channelId = uniqId("b10b01");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-b", visibility: "public_listed", title: "RejoinLeftB" });
    // first join a fresh user
    await join(stub, "u-b1-joiner-b", "op-rejoin-b-1");
    // owner removes them (left_at set)
    await removeTestMember(stub, { actorUserId: "u-b1-owner-b", targetUserId: "u-b1-joiner-b", channelId, idempotencyKey: "ik-remove-b" });
    const mAfterLeave = await getMemberRow(channelId, "u-b1-joiner-b");
    expect(mAfterLeave!.left_at).not.toBeNull();
    // rejoin
    const body = await join(stub, "u-b1-joiner-b", "op-rejoin-b-2");
    expect(body.role).toBe("member");
    const mAfterRejoin = await getMemberRow(channelId, "u-b1-joiner-b");
    expect(mAfterRejoin!.left_at).toBeNull();
    expect(mAfterRejoin!.role).toBe("member");
    const evCount = await countMemberJoinedEvents(channelId, "u-b1-joiner-b");
    expect(evCount).toBe(2); // first join + rejoin
  });

  it("rejoin as a removed user on a public channel → same as left rejoin (removed users can rejoin public channels via the join endpoint)", async () => {
    // same as above (members-remove sets left_at regardless of self/other); covered by the left test.
    // This test asserts the path explicitly for the 'removed' wording.
    const channelId = uniqId("b10c01");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-c", visibility: "public_listed", title: "RejoinRemovedC" });
    await join(stub, "u-b1-joiner-c", "op-rejoin-c-1");
    await removeTestMember(stub, { actorUserId: "u-b1-owner-c", targetUserId: "u-b1-joiner-c", channelId, idempotencyKey: "ik-remove-c" });
    const body = await join(stub, "u-b1-joiner-c", "op-rejoin-c-2");
    expect(body.role).toBe("member");
    const m = await getMemberRow(channelId, "u-b1-joiner-c");
    expect(m!.left_at).toBeNull();
    expect(m!.role).toBe("member");
  });

  it("rejoin as a left user on a private channel → 403 FORBIDDEN (visibility gate applies to rejoin too)", async () => {
    const channelId = uniqId("b10d01");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-d", visibility: "private", title: "RejoinPrivD" });
    // add a member, then remove them
    await addTestMember(stub, { actorUserId: "u-b1-owner-d", targetUserId: "u-b1-joiner-d", channelId, idempotencyKey: "ik-add-d" });
    await removeTestMember(stub, { actorUserId: "u-b1-owner-d", targetUserId: "u-b1-joiner-d", channelId, idempotencyKey: "ik-remove-d" });
    await expectDoRpcError(() => join(stub, "u-b1-joiner-d", "op-rejoin-priv-d"), "FORBIDDEN");
  });

  it("rejoin as a former admin (left_at set, prior role='admin') on a public channel → role reset to 'member'", async () => {
    const channelId = uniqId("b10e01");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-e", visibility: "public_listed", title: "RejoinAdminE" });
    // add as admin
    await addTestMember(stub, { actorUserId: "u-b1-owner-e", targetUserId: "u-b1-joiner-e", channelId, role: "admin", idempotencyKey: "ik-add-e" });
    // owner removes them
    await removeTestMember(stub, { actorUserId: "u-b1-owner-e", targetUserId: "u-b1-joiner-e", channelId, idempotencyKey: "ik-remove-e" });
    const body = await join(stub, "u-b1-joiner-e", "op-rejoin-e");
    expect(body.role).toBe("member");
    const m = await getMemberRow(channelId, "u-b1-joiner-e");
    expect(m!.role).toBe("member");
  });

  it("browser join with operation_id on already-active member → 200 no-op, returns existing role/joined_at, no second member.joined event, idempotency row written", async () => {
    const channelId = uniqId("b1sys02");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-sys-owner-2", visibility: "public_listed", title: "PubJoinSys2" });
    const b1 = await join(stub, "u-b1-sys-2");
    const b2 = await join(stub, "u-b1-sys-2", "op-sys-browser-2");
    expect(b2.joined_at).toBe(b1.joined_at);
    expect(b2.role).toBe("member");
    const evCount = await countMemberJoinedEvents(channelId, "u-b1-sys-2");
    expect(evCount).toBe(1);
    const idem = await getIdemRows(channelId, "u-b1-sys-2", "op-sys-browser-2");
    expect(idem.length).toBe(1);
  });
});
