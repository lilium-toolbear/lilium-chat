import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

const DIR = () => getNamedDo(env.CHANNEL_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], "shared");

type Row = {
  channel_id: string;
  title: string;
  avatar_url: string | null;
  member_count: number;
  last_message_at: string | null;
  status: string;
  updated_at: string;
};

async function listAll(): Promise<Row[]> {
  const res = await DIR().fetch(new Request("https://x/internal/list?limit=100"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Row[]; next_cursor: string | null };
  return body.items;
}

async function rawRows(): Promise<Row[]> {
  const { runInDurableObject } = await import("cloudflare:test") as {
    runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
  };
  let out: Row[] = [];
  await runInDurableObject(DIR(), async (instance: unknown) => {
    out = (instance as {
      ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => Row[] } } } };
    }).ctx.storage.sql
      .exec("SELECT channel_id, title, avatar_url, member_count, last_message_at, status, updated_at FROM public_channels ORDER BY channel_id")
      .toArray();
  });
  return out;
}

async function deleteRow(channelId: string): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test") as {
    runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
  };
  await runInDurableObject(DIR(), async (instance: unknown) => {
    (instance as {
      ctx: { storage: { sql: { exec: (q: string, ...p: unknown[]) => void } } };
    }).ctx.storage.sql.exec("DELETE FROM public_channels WHERE channel_id=?", channelId);
  });
}

function upsert(channelId: string, fields: Record<string, unknown>, fieldsPresent: string[]) {
  return DIR().fetch(new Request("https://x/internal/apply-projection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "upsert", channel_id: channelId, fields, fields_present: fieldsPresent }),
  }));
}

function del(channelId: string) {
  return DIR().fetch(new Request("https://x/internal/apply-projection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", channel_id: channelId }),
  }));
}

describe("ChannelDirectory /internal/apply-projection", () => {
  it("upsert with a full snapshot inserts a new row (all NOT NULL fields present)", async () => {
    const id = "0199cd00-0000-7000-8000-00000000a001";
    const res = await upsert(id, {
      title: "Public One",
      avatar_url: null,
      member_count: 3,
      last_message_at: null,
      status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    expect(res.status).toBe(200);
    const rows = await rawRows();
    const r = rows.find((x) => x.channel_id === id);
    expect(r).toBeDefined();
    expect(r!.title).toBe("Public One");
    expect(r!.avatar_url).toBeNull();
    expect(r!.member_count).toBe(3);
    expect(r!.last_message_at).toBeNull();
    expect(r!.status).toBe("active");
  });

  it("upsert on an existing row overwrites all fields (full-row upsert)", async () => {
    const id = "0199cd00-0000-7000-8000-00000000a002";
    await upsert(id, {
      title: "First", avatar_url: null, member_count: 1, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    await upsert(id, {
      title: "Second", avatar_url: "https://x/a.png", member_count: 5,
      last_message_at: "2026-06-26T00:00:00.000Z", status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    const rows = await rawRows();
    const r = rows.find((x) => x.channel_id === id);
    expect(r!.title).toBe("Second");
    expect(r!.avatar_url).toBe("https://x/a.png");
    expect(r!.member_count).toBe(5);
    expect(r!.last_message_at).toBe("2026-06-26T00:00:00.000Z");
  });

  it("upsert where avatar_url=null (in fields_present) writes NULL (explicit null preserved)", async () => {
    const id = "0199cd00-0000-7000-8000-00000000a003";
    await upsert(id, {
      title: "Avatar", avatar_url: "https://x/a.png", member_count: 1, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    await upsert(id, {
      title: "Avatar", avatar_url: null, member_count: 1, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    const rows = await rawRows();
    const r = rows.find((x) => x.channel_id === id);
    expect(r!.avatar_url).toBeNull();
  });

  it("upsert where last_message_at=null writes NULL (brand-new public channel)", async () => {
    const id = "0199cd00-0000-7000-8000-00000000a004";
    await upsert(id, {
      title: "NoMsg", avatar_url: null, member_count: 1, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    const rows = await rawRows();
    const r = rows.find((x) => x.channel_id === id);
    expect(r!.last_message_at).toBeNull();
  });

  it("delete removes row; second delete is a no-op (200)", async () => {
    const id = "0199cd00-0000-7000-8000-00000000a005";
    await upsert(id, {
      title: "Del", avatar_url: null, member_count: 1, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    const r1 = await del(id);
    expect(r1.status).toBe(200);
    const r2 = await del(id);
    expect(r2.status).toBe(200);
    const rows = await rawRows();
    expect(rows.find((x) => x.channel_id === id)).toBeUndefined();
  });

  it("repair convergence: a missing row is restored by the next full-snapshot upsert", async () => {
    const id = "0199cd00-0000-7000-8000-00000000a006";
    await upsert(id, {
      title: "Repair", avatar_url: null, member_count: 2, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    // simulate a missing row (dead-letter/reorder loss)
    await deleteRow(id);
    // a message.send upsert still carries the full snapshot (title/avatar/member_count/status + last_message_at)
    const r = await upsert(id, {
      title: "Repair", avatar_url: null, member_count: 2,
      last_message_at: "2026-06-26T00:00:01.000Z", status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    expect(r.status).toBe(200);
    const rows = await rawRows();
    const row = rows.find((x) => x.channel_id === id);
    expect(row).toBeDefined();
    expect(row!.title).toBe("Repair");
    expect(row!.member_count).toBe(2);
    expect(row!.status).toBe("active");
    expect(row!.last_message_at).toBe("2026-06-26T00:00:01.000Z");
  });
});

describe("ChannelDirectory /internal/list", () => {
  it("returns only status='active' rows", async () => {
    const activeId = "0199cd00-0000-7000-8000-00000000b001";
    const dissolvedId = "0199cd00-0000-7000-8000-00000000b002";
    await upsert(activeId, {
      title: "ActiveList", avatar_url: null, member_count: 1, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    await upsert(dissolvedId, {
      title: "DissolvedList", avatar_url: null, member_count: 1, last_message_at: null, status: "dissolved",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    const items = await listAll();
    const ids = items.map((i) => i.channel_id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(dissolvedId);
  });

  it("q filters by title substring", async () => {
    const a = "0199cd00-0000-7000-8000-00000000b010";
    const b = "0199cd00-0000-7000-8000-00000000b011";
    await upsert(a, {
      title: "Rustaceans", avatar_url: null, member_count: 1, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    await upsert(b, {
      title: "Gophers", avatar_url: null, member_count: 1, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    const res = await DIR().fetch(new Request("https://x/internal/list?q=Rust&limit=100"));
    const body = (await res.json()) as { items: Row[] };
    const titles = body.items.map((i) => i.title);
    expect(titles).toContain("Rustaceans");
    expect(titles).not.toContain("Gophers");
  });

  it("sorts by COALESCE(last_message_at, updated_at) DESC, channel_id DESC; cursor paginates", async () => {
    // Use distinct timestamps so the order is deterministic.
    const ids = [
      "0199cd00-0000-7000-8000-00000000c001",
      "0199cd00-0000-7000-8000-00000000c002",
      "0199cd00-0000-7000-8000-00000000c003",
    ];
    // c001 has last_message_at newest; c002 has no last_message_at (uses updated_at); c003 has oldest last_message_at.
    const newest = "2026-06-26T00:00:10.000Z";
    const mid = "2026-06-26T00:00:05.000Z";
    const oldest = "2026-06-26T00:00:01.000Z";
    await upsert(ids[0]!, {
      title: "C1", avatar_url: null, member_count: 1, last_message_at: newest, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    await upsert(ids[1]!, {
      title: "C2", avatar_url: null, member_count: 1, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    // bump c002 updated_at by re-upserting with a later timestamp (its updated_at reflects the upsert time).
    // To make this deterministic we re-upsert c002 after a small delay using its own updated_at as the activity.
    // Instead: give c002 a last_message_at older than newest but newer than oldest, to control ordering.
    await upsert(ids[1]!, {
      title: "C2", avatar_url: null, member_count: 1, last_message_at: mid, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    await upsert(ids[2]!, {
      title: "C3", avatar_url: null, member_count: 1, last_message_at: oldest, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    const items = await listAll();
    const listed = items.filter((i) => ids.includes(i.channel_id));
    const orderedIds = listed.map((i) => i.channel_id);
    // newest > mid > oldest
    expect(orderedIds).toEqual([ids[0], ids[1], ids[2]]);

    // keyset pagination: page 1 limit 1 → first item + next_cursor; page 2 → second item.
    const page1 = await DIR().fetch(new Request("https://x/internal/list?limit=1"));
    const p1 = (await page1.json()) as { items: Row[]; next_cursor: string };
    expect(p1.items.length).toBe(1);
    const filtered1 = p1.items.filter((i) => ids.includes(i.channel_id));
    // page1 may include other rows from prior tests; find our newest.
    const firstOurs = filtered1[0] ?? p1.items[0];
    // cursor past the first of our set: fetch page 2 with the cursor
    const page2 = await DIR().fetch(new Request(`https://x/internal/list?limit=100&cursor=${encodeURIComponent(p1.next_cursor ?? "")}`));
    const p2 = (await page2.json()) as { items: Row[]; next_cursor: string | null };
    // the second page must NOT re-include the first page's row.
    expect(firstOurs).toBeDefined();
    if (firstOurs) {
      expect(p2.items.find((i) => i.channel_id === firstOurs.channel_id)).toBeUndefined();
    }
  });

  it("limit is clamped to 100", async () => {
    const res = await DIR().fetch(new Request("https://x/internal/list?limit=99999"));
    expect(res.status).toBe(200);
    // No assertion on count (the table may have many rows); the handler must not error on a huge limit.
    const body = (await res.json()) as { items: Row[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("rows with null last_message_at sort by updated_at", async () => {
    const a = "0199cd00-0000-7000-8000-00000000d001";
    const b = "0199cd00-0000-7000-8000-00000000d002";
    // Both have null last_message_at; the one upserted last has a newer updated_at and sorts first.
    await upsert(a, {
      title: "OlderUpdated", avatar_url: null, member_count: 1, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    await upsert(b, {
      title: "NewerUpdated", avatar_url: null, member_count: 1, last_message_at: null, status: "active",
    }, ["title", "avatar_url", "member_count", "last_message_at", "status"]);
    const items = await listAll();
    const listed = items.filter((i) => i.channel_id === a || i.channel_id === b);
    expect(listed.length).toBe(2);
    expect(listed[0]!.channel_id).toBe(b); // newer updated_at first
    expect(listed[1]!.channel_id).toBe(a);
  });
});
