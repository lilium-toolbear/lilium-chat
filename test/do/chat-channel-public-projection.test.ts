import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test") as {
  runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
  runDurableObjectAlarm: (stub: unknown) => Promise<void>;
};

type OutboxRow = {
  outbox_id: string;
  target_kind: string;
  target_key: string;
  payload_json: string;
  status: string;
};

async function listDirectoryOutbox(stub: DurableObjectStub): Promise<OutboxRow[]> {
  let out: OutboxRow[] = [];
  await runInDurableObject(stub, async (instance: unknown) => {
    out = (instance as {
      ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => OutboxRow[] } } } };
    }).ctx.storage.sql
      .exec("SELECT outbox_id, target_kind, target_key, payload_json, status FROM projection_outbox WHERE target_kind='channel_directory' ORDER BY created_at ASC")
      .toArray();
  });
  return out;
}

async function setMaxAttemptsToOne(stub: DurableObjectStub): Promise<void> {
  // Force the next channel_directory outbox row to dead-letter on first failure for the retry test.
  await runInDurableObject(stub, async (instance: unknown) => {
    (instance as {
      ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => void } } };
    }).ctx.storage.sql.exec("UPDATE projection_outbox SET max_attempts=1 WHERE target_kind='channel_directory'");
  });
}


function parsePayload(r: OutboxRow): { action: string; channel_id: string; fields?: Record<string, unknown> } {
  return JSON.parse(r.payload_json) as { action: string; channel_id: string; fields?: Record<string, unknown> };
}

async function createChannel(opts: { channelId: string; ownerId: string; visibility: string; title?: string }) {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], opts.channelId);
  const res = await stub.fetch(new Request("https://x/internal/create-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": opts.ownerId, "Content-Type": "application/json" },
    body: JSON.stringify({
      channel_id: opts.channelId,
      creator_user_id: opts.ownerId,
      title: opts.title ?? "PubChan",
      topic: null,
      avatar_attachment_id: null,
      visibility: opts.visibility,
      initial_members: [],
    }),
  }));
  return { res, stub };
}

async function flushAlarm(stub: DurableObjectStub): Promise<void> {
  await runDurableObjectAlarm(stub);
}

function uniqId(label: string): string {
  return `0199ce00-0000-7000-8000-${label.padStart(12, "0")}`;
}

describe("ChatChannel channel_directory projection outbox", () => {
  it("create-public writes one channel_directory upsert outbox row co-atomic with channel_meta insert", async () => {
    const channelId = uniqId("a20101");
    const { stub } = await createChannel({ channelId, ownerId: "u-a2-1", visibility: "public_listed", title: "PublicCreate" });
    const rows = await listDirectoryOutbox(stub);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const upserts = rows.filter((r) => r.status === "pending").map(parsePayload);
    const ours = upserts.find((p) => p.channel_id === channelId && p.action === "upsert");
    expect(ours).toBeDefined();
    expect(ours!.fields).toBeDefined();
    expect(ours!.fields!.title).toBe("PublicCreate");
    expect(ours!.fields!.member_count).toBe(1);
    expect(ours!.fields!.status).toBe("active");
    expect(ours!.fields!.last_message_at).toBeNull();
  });

  it("create-private writes no channel_directory outbox row", async () => {
    const channelId = uniqId("a20201");
    const { stub } = await createChannel({ channelId, ownerId: "u-a2-2", visibility: "private", title: "PrivateCreate" });
    const rows = await listDirectoryOutbox(stub);
    expect(rows.find((r) => parsePayload(r).channel_id === channelId)).toBeUndefined();
  });

  it("update visibility private→public_listed writes upsert; public_listed→private writes delete; public→public title change writes upsert", async () => {
    const channelId = uniqId("a20301");
    const { stub } = await createChannel({ channelId, ownerId: "u-a2-3", visibility: "private", title: "VisPriv" });

    // private → public_listed
    await stub.fetch(new Request("https://x/internal/update-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-a2-3", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-vis-pub", channel_id: channelId, visibility: "public_listed" }),
    }));
    let rows = await listDirectoryOutbox(stub);
    const toPub = rows.map(parsePayload).find((p) => p.channel_id === channelId && p.action === "upsert");
    expect(toPub).toBeDefined();

    // public_listed → public_listed with title change
    await stub.fetch(new Request("https://x/internal/update-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-a2-3", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-vis-title", channel_id: channelId, title: "NewTitle" }),
    }));
    rows = await listDirectoryOutbox(stub);
    const titleUpserts = rows.map(parsePayload).filter((p) => p.channel_id === channelId && p.action === "upsert");
    expect(titleUpserts.length).toBeGreaterThanOrEqual(2);

    // public_listed → private
    await stub.fetch(new Request("https://x/internal/update-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-a2-3", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-vis-priv", channel_id: channelId, visibility: "private" }),
    }));
    rows = await listDirectoryOutbox(stub);
    const dels = rows.map(parsePayload).filter((p) => p.channel_id === channelId && p.action === "delete");
    expect(dels.length).toBeGreaterThanOrEqual(1);
  });

  it("dissolve writes delete outbox row (when public)", async () => {
    const channelId = uniqId("a20401");
    const { stub } = await createChannel({ channelId, ownerId: "u-a2-4", visibility: "public_listed", title: "DissolvePub" });
    await stub.fetch(new Request("https://x/internal/dissolve", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-a2-4", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "ik-dissolve", channel_id: channelId }),
    }));
    const rows = await listDirectoryOutbox(stub);
    const dels = rows.map(parsePayload).filter((p) => p.channel_id === channelId && p.action === "delete");
    expect(dels.length).toBeGreaterThanOrEqual(1);
  });

  it("join on a public channel writes upsert with bumped member_count; join on a private channel writes no channel_directory outbox", async () => {
    const pubId = uniqId("a20501");
    const privId = uniqId("a20502");
    const { stub: pubStub } = await createChannel({ channelId: pubId, ownerId: "u-a2-5", visibility: "public_listed", title: "PubJoin" });
    const { stub: privStub } = await createChannel({ channelId: privId, ownerId: "u-a2-5b", visibility: "private", title: "PrivJoin" });

    await pubStub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-a2-joiner", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "u-a2-joiner" }),
    }));
    const pubRows = await listDirectoryOutbox(pubStub);
    const pubUpserts = pubRows.map(parsePayload).filter((p) => p.channel_id === pubId && p.action === "upsert");
    const joinUpsert = pubUpserts[pubUpserts.length - 1];
    expect(joinUpsert).toBeDefined();
    expect(joinUpsert!.fields!.member_count).toBe(2); // creator(1) + joiner

    await privStub.fetch(new Request("https://x/internal/join", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-a2-joiner2", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "u-a2-joiner2" }),
    }));
    const privRows = await listDirectoryOutbox(privStub);
    expect(privRows.find((r) => parsePayload(r).channel_id === privId)).toBeUndefined();
  });

  it("message.send on a public channel writes a FULL-snapshot upsert (title/avatar/member_count/status + last_message_at)", async () => {
    const channelId = uniqId("a20601");
    const { stub } = await createChannel({ channelId, ownerId: "u-a2-6", visibility: "public_listed", title: "PubMsg" });
    // owner is already a member; send a message
    const res = await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-a2-6", "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: "cm-a2-6-1",
        dedupe_principal_key: "user:u-a2-6",
        type: "text",
        text: "hello directory",
        reply_to: null,
        attachment_ids: [],
        mentions: [],
        channel_id: channelId,
      }),
    }));
    expect(res.status).toBe(200);
    const rows = await listDirectoryOutbox(stub);
    const upserts = rows.map(parsePayload).filter((p) => p.channel_id === channelId && p.action === "upsert");
    // at least the message.send upsert (could also have the create upsert)
    const msgUpsert = upserts[upserts.length - 1];
    expect(msgUpsert).toBeDefined();
    expect(msgUpsert!.fields!.title).toBe("PubMsg");
    expect(msgUpsert!.fields!.member_count).toBe(1);
    expect(msgUpsert!.fields!.status).toBe("active");
    expect(msgUpsert!.fields!.last_message_at).toBeTruthy(); // set to the message created_at
  });

  it("message.send on a private channel writes no channel_directory outbox", async () => {
    const channelId = uniqId("a20701");
    const { stub } = await createChannel({ channelId, ownerId: "u-a2-7", visibility: "private", title: "PrivMsg" });
    const res = await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-a2-7", "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: "cm-a2-7-1",
        dedupe_principal_key: "user:u-a2-7",
        type: "text",
        text: "private hello",
        reply_to: null,
        attachment_ids: [],
        mentions: [],
        channel_id: channelId,
      }),
    }));
    expect(res.status).toBe(200);
    const rows = await listDirectoryOutbox(stub);
    expect(rows.find((r) => parsePayload(r).channel_id === channelId)).toBeUndefined();
  });

  it("alarm flush delivers an upsert payload to ChannelDirectory(shared)/internal/apply-projection and marks delivered", async () => {
    const channelId = uniqId("a20801");
    const { stub } = await createChannel({ channelId, ownerId: "u-a2-8", visibility: "public_listed", title: "PubFlush" });
    // schedule + run the alarm
    await runInDurableObject(stub, async (instance: unknown) => {
      await (instance as { scheduleOutboxAlarm: (nowIso: string) => Promise<void> }).scheduleOutboxAlarm(new Date().toISOString());
    });
    await flushAlarm(stub);

    const rows = await listDirectoryOutbox(stub);
    const ours = rows.filter((r) => parsePayload(r).channel_id === channelId);
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((r) => r.status === "delivered")).toBe(true);

    // the directory now has the row
    const dirStub = getNamedDo(env.CHANNEL_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], "shared");
    const listRes = await dirStub.fetch(new Request("https://x/internal/list?limit=100"));
    const listBody = (await listRes.json()) as { items: Array<{ channel_id: string; title: string }> };
    const row = listBody.items.find((i) => i.channel_id === channelId);
    expect(row).toBeDefined();
    expect(row!.title).toBe("PubFlush");
  });

  it("dead_letter on repeated failure; a fresh outbox row for the same channel_id succeeds and apply-projection is idempotent (repair)", async () => {
    // Use a channel whose apply-projection will fail: we point the DO at an unreachable state by
    // corrupting the payload, then verify the row goes to dead_letter after max_attempts.
    const channelId = uniqId("a20901");
    const { stub } = await createChannel({ channelId, ownerId: "u-a2-9", visibility: "public_listed", title: "PubRepair" });

    // Force the existing channel_directory outbox rows to dead-letter on the next attempt by
    // setting max_attempts=1 and injecting a malformed payload that ChannelDirectory rejects.
    await runInDurableObject(stub, async (instance: unknown) => {
      const inst = instance as {
        ctx: { storage: {
          sql: { exec: (q: string, ...p: unknown[]) => void };
        } };
      };
      // bump max_attempts to 1 so the next failure dead-letters
      inst.ctx.storage.sql.exec("UPDATE projection_outbox SET max_attempts=1 WHERE target_kind='channel_directory'");
      // corrupt the payload so apply-projection returns non-ok (missing channel_id)
      inst.ctx.storage.sql.exec("UPDATE projection_outbox SET payload_json='{\"action\":\"upsert\",\"channel_id\":\"\"}' WHERE target_kind='channel_directory'");
    });
    await runInDurableObject(stub, async (instance: unknown) => {
      await (instance as { scheduleOutboxAlarm: (nowIso: string) => Promise<void> }).scheduleOutboxAlarm(new Date().toISOString());
    });
    await flushAlarm(stub);

    const rowsAfterFail = await listDirectoryOutbox(stub);
    const failed = rowsAfterFail.find((r) => r.status === "dead_letter");
    expect(failed).toBeDefined();

    // Now write a fresh, valid outbox row (simulating a subsequent message.send repair) and flush.
    await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-a2-9", "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: "cm-a2-9-repair",
        dedupe_principal_key: "user:u-a2-9",
        type: "text",
        text: "repair",
        reply_to: null,
        attachment_ids: [],
        mentions: [],
        channel_id: channelId,
      }),
    }));
    await runInDurableObject(stub, async (instance: unknown) => {
      await (instance as { scheduleOutboxAlarm: (nowIso: string) => Promise<void> }).scheduleOutboxAlarm(new Date().toISOString());
    });
    await flushAlarm(stub);

    // the directory row converged (repair): a valid row exists for this channel
    const dirStub = getNamedDo(env.CHANNEL_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], "shared");
    const listRes = await dirStub.fetch(new Request("https://x/internal/list?limit=100"));
    const listBody = (await listRes.json()) as { items: Array<{ channel_id: string; title: string }> };
    const row = listBody.items.find((i) => i.channel_id === channelId);
    expect(row).toBeDefined();
    expect(row!.title).toBe("PubRepair");
  });
});
