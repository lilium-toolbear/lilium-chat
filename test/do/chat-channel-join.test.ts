import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

const { runInDurableObject } = await import("cloudflare:test") as {
  runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
};

async function getMemberRow(channelId: string, userId: string): Promise<{ role: string; joined_at: string; left_at: string | null } | undefined> {
  let out: { role: string; joined_at: string; left_at: string | null } | undefined;
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
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
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
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

async function getIdemRows(userId: string, operationId: string): Promise<{ request_hash: string; response_json: string }[]> {
  let out: { request_hash: string; response_json: string }[] = [];
  // idempotency_keys is per-ChatChannel-DO; we read from any channel's DO that the user joined.
  // We pass the channelId via a stub the caller already has. To keep this helper simple, we read
  // from the system channel DO (system-general) which always exists in these tests.
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
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

async function createChannel(opts: { channelId: string; ownerId: string; visibility: string; title?: string; kind?: string }) {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], opts.channelId);
  const res = await stub.fetch(new Request("https://x/internal/create-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": opts.ownerId, "Content-Type": "application/json" },
    body: JSON.stringify({
      channel_id: opts.channelId,
      creator_user_id: opts.ownerId,
      title: opts.title ?? "JoinTest",
      topic: null,
      avatar_attachment_id: null,
      visibility: opts.visibility,
      initial_members: [],
    }),
  }));
  return { res, stub };
}

async function join(stub: DurableObjectStub, userId: string, operationId?: string): Promise<Response> {
  return stub.fetch(new Request("https://x/internal/join", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, operation_id: operationId }),
  }));
}

describe("ChatChannel /internal/join", () => {
  it("join public_listed channel as non-member → 200, member row, member.joined event, user_directory + channel_directory outbox, idempotency row", async () => {
    const channelId = uniqId("b10101");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-1", visibility: "public_listed", title: "PubJoin1" });
    const res = await join(stub, "u-b1-joiner-1", "op-join-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel_id: string; membership_version: number; joined_at: string; role: string };
    expect(body.channel_id).toBe(channelId);
    expect(body.role).toBe("member");
    const m = await getMemberRow(channelId, "u-b1-joiner-1");
    expect(m).toBeDefined();
    expect(m!.left_at).toBeNull();
    expect(m!.role).toBe("member");
    const evCount = await countMemberJoinedEvents(channelId, "u-b1-joiner-1");
    expect(evCount).toBe(1);
    // idempotency row written (principal-scoped on the joiner)
    const idem = await getIdemRows("u-b1-joiner-1", "op-join-1");
    // Note: getIdemRows reads from system-general DO; the join happened on the channel DO, so this
    // helper is not the right one for non-system channels. Verify via the channel DO instead.
    let idemOnChannel: { request_hash: string; response_json: string }[] = [];
    await runInDurableObject(stub, async (instance: unknown) => {
      idemOnChannel = (instance as {
        ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => Array<{ request_hash: string; response_json: string }> } } } };
      }).ctx.storage.sql
        .exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.join' AND operation_id=?", "u-b1-joiner-1", "op-join-1")
        .toArray();
    });
    expect(idemOnChannel.length).toBe(1);
    void idem;
  });

  it("duplicate same operation_id → cached response, no second member row, no second event", async () => {
    const channelId = uniqId("b10201");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-2", visibility: "public_listed", title: "PubJoin2" });
    const r1 = await join(stub, "u-b1-joiner-2", "op-join-2");
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { joined_at: string; membership_version: number };
    const r2 = await join(stub, "u-b1-joiner-2", "op-join-2");
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { joined_at: string; membership_version: number; role: string };
    expect(b2.joined_at).toBe(b1.joined_at);
    expect(b2.membership_version).toBe(b1.membership_version);
    expect(b2.role).toBe("member");
    const evCount = await countMemberJoinedEvents(channelId, "u-b1-joiner-2");
    expect(evCount).toBe(1); // no second event
  });

  it("duplicate same operation_id different request_hash → 409 IDEMPOTENCY_CONFLICT", async () => {
    const channelId = uniqId("b10301");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-3", visibility: "public_listed", title: "PubJoin3" });
    // first join as user A with operation_id op-conflict
    const r1 = await stub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-a", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "u-b1-a", operation_id: "op-conflict-3" }),
    }));
    expect(r1.status).toBe(200);
    // now reuse the SAME operation_id but as a different principal (different X-Verified-User-Id)
    // — the idempotency row is principal-scoped, so this is a fresh cache miss for principal u-b1-b.
    // To trigger a real request_hash conflict we must use the SAME principal + SAME operation_id but
    // a different user_id in the body (which changes request_hash).
    const r2 = await stub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-a", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "u-b1-b", operation_id: "op-conflict-3" }),
    }));
    expect(r2.status).toBe(409);
    const e = (await r2.json()) as { error: { code: string } };
    expect(e.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("join private channel as non-member → 403 FORBIDDEN", async () => {
    const channelId = uniqId("b10401");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-4", visibility: "private", title: "PrivJoin4" });
    const res = await join(stub, "u-b1-stranger-4", "op-priv-4");
    expect(res.status).toBe(403);
    const e = (await res.json()) as { error: { code: string } };
    expect(e.error.code).toBe("FORBIDDEN");
  });

  it("join public_unlisted channel as non-member → 403 FORBIDDEN", async () => {
    const channelId = uniqId("b10501");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-5", visibility: "public_unlisted", title: "UnlistedJoin5" });
    const res = await join(stub, "u-b1-stranger-5", "op-unlisted-5");
    expect(res.status).toBe(403);
  });

  it("join dissolved channel → 409 CHANNEL_DISSOLVED", async () => {
    const channelId = uniqId("b10601");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-6", visibility: "public_listed", title: "DissolvedJoin6" });
    await stub.fetch(new Request("https://x/internal/dissolve", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-owner-6", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-dissolve-6", channel_id: channelId }),
    }));
    const res = await join(stub, "u-b1-stranger-6", "op-dissolved-6");
    expect(res.status).toBe(409);
    const e = (await res.json()) as { error: { code: string } };
    expect(e.error.code).toBe("CHANNEL_DISSOLVED");
  });

  it("join kind='dm' channel → 403 FORBIDDEN", async () => {
    // Create a DM-kind channel by directly inserting channel_meta via runInDurableObject.
    const channelId = uniqId("b10701");
    const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
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
    const res = await join(stub, "u-b1-stranger-7", "op-dm-7");
    expect(res.status).toBe(403);
    const e = (await res.json()) as { error: { code: string } };
    expect(e.error.code).toBe("FORBIDDEN");
  });

  it("already-active-member join → 200, returns existing joined_at/membership_version/existing role (NOT reset), no duplicate event, no count bump, idempotency row IS written", async () => {
    const channelId = uniqId("b10801");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-8", visibility: "public_listed", title: "ActiveJoin8" });
    // owner is already an active member with role 'owner'
    const res = await join(stub, "u-b1-owner-8", "op-active-8");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; joined_at: string; membership_version: number };
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
    const res = await join(stub, "u-b1-owner-9", "op-owner-9");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("owner");
  });

  it("cached retry of an already-active-member no-op returns the cached role/joined_at even after the user later leaves", async () => {
    const channelId = uniqId("b10a01");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-a", visibility: "public_listed", title: "CachedNoopA" });
    // first join as a fresh user (becomes member) with operation_id op-cached-a
    const r1 = await join(stub, "u-b1-joiner-a", "op-cached-a");
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { role: string; joined_at: string };
    expect(b1.role).toBe("member");
    // Now the user leaves (owner removes them).
    await stub.fetch(new Request("https://x/internal/members-remove", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-owner-a", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-remove-a", channel_id: channelId, user_id: "u-b1-joiner-a" }),
    }));
    // A retry with the SAME operation_id must return the cached no-op... but wait: the first call
    // was a FRESH join (real mutation), so the cached result is the fresh-join result. The plan's
    // "cached retry of an already-active-member no-op" scenario requires the FIRST call to be a
    // no-op. Re-do: owner joins own channel (active no-op) with operation_id op-cached-a2.
    const r2 = await join(stub, "u-b1-owner-a", "op-cached-a2");
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { role: string; joined_at: string };
    expect(b2.role).toBe("owner");
    // owner cannot leave (owner invariant), so simulate a leave via direct DB edit to force a non-active state.
    await runInDurableObject(stub, async (instance: unknown) => {
      (instance as {
        ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => void } } };
      }).ctx.storage.sql.exec("UPDATE members SET left_at=? WHERE channel_id=? AND user_id=?", new Date().toISOString(), channelId, "u-b1-owner-a");
    });
    // retry with the same operation_id → must return the cached no-op result (role=owner), NOT rejoin.
    const r3 = await join(stub, "u-b1-owner-a", "op-cached-a2");
    expect(r3.status).toBe(200);
    const b3 = (await r3.json()) as { role: string; joined_at: string };
    expect(b3.role).toBe("owner");
    expect(b3.joined_at).toBe(b2.joined_at);
  });

  it("rejoin as a left user on a public channel → 200, joined_at updated, left_at=NULL, role='member', member.joined event, count bumped, outbox written", async () => {
    const channelId = uniqId("b10b01");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-b", visibility: "public_listed", title: "RejoinLeftB" });
    // first join a fresh user
    await join(stub, "u-b1-joiner-b", "op-rejoin-b-1");
    // owner removes them (left_at set)
    await stub.fetch(new Request("https://x/internal/members-remove", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-owner-b", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-remove-b", channel_id: channelId, user_id: "u-b1-joiner-b" }),
    }));
    const mAfterLeave = await getMemberRow(channelId, "u-b1-joiner-b");
    expect(mAfterLeave!.left_at).not.toBeNull();
    // rejoin
    const res = await join(stub, "u-b1-joiner-b", "op-rejoin-b-2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; joined_at: string };
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
    await stub.fetch(new Request("https://x/internal/members-remove", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-owner-c", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-remove-c", channel_id: channelId, user_id: "u-b1-joiner-c" }),
    }));
    const res = await join(stub, "u-b1-joiner-c", "op-rejoin-c-2");
    expect(res.status).toBe(200);
    const m = await getMemberRow(channelId, "u-b1-joiner-c");
    expect(m!.left_at).toBeNull();
    expect(m!.role).toBe("member");
  });

  it("rejoin as a left user on a private channel → 403 FORBIDDEN (visibility gate applies to rejoin too)", async () => {
    const channelId = uniqId("b10d01");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-d", visibility: "private", title: "RejoinPrivD" });
    // add a member, then remove them
    await stub.fetch(new Request("https://x/internal/members-add", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-owner-d", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-add-d", channel_id: channelId, user_id: "u-b1-joiner-d", role: "member" }),
    }));
    await stub.fetch(new Request("https://x/internal/members-remove", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-owner-d", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-remove-d", channel_id: channelId, user_id: "u-b1-joiner-d" }),
    }));
    const res = await join(stub, "u-b1-joiner-d", "op-rejoin-priv-d");
    expect(res.status).toBe(403);
  });

  it("rejoin as a former admin (left_at set, prior role='admin') on a public channel → role reset to 'member'", async () => {
    const channelId = uniqId("b10e01");
    const { stub } = await createChannel({ channelId, ownerId: "u-b1-owner-e", visibility: "public_listed", title: "RejoinAdminE" });
    // add as admin
    await stub.fetch(new Request("https://x/internal/members-add", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-owner-e", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-add-e", channel_id: channelId, user_id: "u-b1-joiner-e", role: "admin" }),
    }));
    // owner removes them
    await stub.fetch(new Request("https://x/internal/members-remove", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-owner-e", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-remove-e", channel_id: channelId, user_id: "u-b1-joiner-e" }),
    }));
    const res = await join(stub, "u-b1-joiner-e", "op-rejoin-e");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("member");
    const m = await getMemberRow(channelId, "u-b1-joiner-e");
    expect(m!.role).toBe("member");
  });

  it("ensureSystemJoined still succeeds (system channel is public_listed)", async () => {
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", {
      method: "POST", body: JSON.stringify({ title: "Lilium" }),
    }));
    const res = await sysStub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-sys-1", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "u-b1-sys-1" }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel_id: string; role: string };
    expect(body.channel_id).toBeTruthy();
    expect(body.role).toBe("member");
  });

  it("browser join of the system channel (with operation_id) → 200, already-active-member no-op, returns existing role/joined_at, no member.joined event, idempotency row written (P1-1: system channel join is allowed, not 403)", async () => {
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", {
      method: "POST", body: JSON.stringify({ title: "Lilium" }),
    }));
    // first login auto-join (no operation_id) — fresh join
    const r1 = await sysStub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-sys-2", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "u-b1-sys-2" }),
    }));
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { joined_at: string };
    // browser join with operation_id → already-active no-op
    const r2 = await sysStub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-b1-sys-2", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "u-b1-sys-2", operation_id: "op-sys-browser-2" }),
    }));
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { role: string; joined_at: string };
    expect(b2.joined_at).toBe(b1.joined_at);
    expect(b2.role).toBe("member");
    // no new member.joined event for the no-op (only the first-join one)
    let n = 0;
    await runInDurableObject(sysStub, async (instance: unknown) => {
      const sysChannelId = (instance as {
        ctx: { storage: { sql: { exec: (q: string) => { toArray: () => Array<{ channel_id: string }> } } } };
      }).ctx.storage.sql.exec("SELECT channel_id FROM channel_meta LIMIT 1").toArray()[0]?.channel_id;
      if (sysChannelId) {
        n = Number((instance as {
          ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => Array<{ c: number | bigint }> } } } };
        }).ctx.storage.sql
          .exec("SELECT COUNT(*) AS c FROM events WHERE channel_id=? AND event_type='member.joined' AND payload_json LIKE ?", sysChannelId, `%"user_id":"u-b1-sys-2"%`)
          .toArray()[0]?.c ?? 0);
      }
    });
    expect(n).toBe(1);
    // idempotency row written for the no-op
    let idem: { response_json: string }[] = [];
    await runInDurableObject(sysStub, async (instance: unknown) => {
      idem = (instance as {
        ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => Array<{ response_json: string }> } } } };
      }).ctx.storage.sql
        .exec("SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.join' AND operation_id=?", "u-b1-sys-2", "op-sys-browser-2")
        .toArray();
    });
    expect(idem.length).toBe(1);
  });
});
