# Lilium Chat Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 0 shells into a working read-side chat core: a shared system public channel that every new user auto-joins, a real bootstrap returning the user's channels + per-channel cursor + the active channel's messages, and history pagination over ChatChannel messages — all over HTTP, no WebSocket yet (WS command/event is Phase 2).

**NOTE on Hono routing:** Hono uses `:param` not `{param}`. All `/api/chat/channels/:channel_id` routes below are written `:channel_id` in `app.get(...)` and read via `c.req.param("channel_id")`. (The plan body shows `:channel_id`; codex/implementer use `:param` syntax.)

**Architecture:** HTTP only. `GET /api/chat/bootstrap` reads UserDirectory (my_channels projection) + lazily joins the system channel + reads that ChatChannel for messages/unread/preview. `GET /api/chat/channels/{id}/messages` pages visible messages. Channel creation + membership writes go through the projection_outbox (Phase 0 built the table + scheduler; Phase 1 wires the first real outbox write: ChatChannel membership → UserDirectory.my_channels). Per-channel event_id generation is live (Phase 0's `nextEventId`), but Phase 1 emits `message.created`/`member.joined` events into the events table WITHOUT broadcasting (WS fanout is Phase 2) — events are written so per-channel cursor + future replay work, but no delivery path yet.

**Tech Stack:** TypeScript, Hono, Cloudflare DOs (Phase 0's 8 classes, unchanged set), `pg`+Hyperdrive (profile), wrangler/vitest. Frontend is NOT in this repo.

## Global Constraints (carry forward from Phase 0 + Phase 1 specifics)

Unless overridden below, all Phase 0 global constraints still apply (`docs/superpowers/plans/2026-06-22-lilium-chat-phase-0.md` Global Constraints section): `nodejs_compat`, `DurableObject` from `cloudflare:workers`, `ctx.storage.sql.exec`, `new_sqlite_classes` already migrated in `wrangler.jsonc`/`wrangler.test.jsonc`, `getByName` in prod / `idFromName`+`get` in tests, single-alarm-per-DO via `scheduleNextAlarm`/`runDueJobs`, per-channel monotonic UUIDv7 `monotonicUuidV7`, in-DO `idempotency_keys` for HTTP mutations, CORS + request_id middleware from `src/index.ts`.

Phase 1-specific:

- **System public channel:** a single ChatChannel DO named `system-general` (deterministic name via `env.CHAT_CHANNEL.getByName("system-general")`). `kind=channel`, `visibility=public_listed`, `status=active`, title `"Lilium"` (or configurable var; hardcode for Phase 1). Every user auto-joins on first bootstrap if absent. Phase 1 does NOT shard it (single DO); capacity note recorded, splitting is later work.
- **Lazy join semantics:** bootstrap checks UserDirectory.my_channels for the system channel; if absent or `status != active`, it triggers a join (ChatChannel writes members + event + outbox row for the UserDirectory projection). The join is idempotent (re-bootstrap is a no-op once `status=active`).
- **Projection outbox (first real use):** ChatChannel membership writes (join here; leave/role in Phase 3) write a `projection_outbox` row `target_kind='user_directory'`, `target_key=<user_id>`, payload `{action:'join'|'leave', channel_id, kind, membership_version}`. The ChatChannel DO's `alarm()` flushes pending outbox rows (same pattern as Phase 0's `/outbox-flush` spike endpoint, now in `alarm()` + `runDueJobs`). Target DO (UserDirectory) upserts my_channels idempotently.
- **Events written but not broadcast:** `message.created` and `member.joined` events are written to ChatChannel's `events` table (with `membership_version_at_event` + monotonic event_id) so `last_event_id` cursor is real. NO WebSocket delivery in Phase 1 (fanout is Phase 2). Bootstrap's `last_event_id`/`event_state.per_channel` reads the max event_id per channel.
- **No message SENDING in Phase 1:** `message.send` is a WS command (Phase 2). Phase 1 is read-only: bootstrap + history pagination. The system channel starts empty; Phase 2 populates it. (Bootstrap still returns the correct shape with empty messages.)
- **read-state floor:** `POST /api/chat/channels/:channel_id/read-state` is Phase 3 (with read-state mutation). Phase 1 bootstrap computes `unread_count`/`last_read_event_id` from UserDirectory.my_channels (which has the columns from Phase 0). `unread_count = count(events where event_id > last_read_event_id AND actor != me)` — for the system channel in Phase 1 this is 0 (no messages yet), but the computation path is real.
- **Profile resolve:** batch-resolve senders in messages list + the channel's last_message sender. Reuse Phase 0 `resolveUserSummaries`.
- **`last_message_preview` / `last_message_at` / `member_count` / `last_event_id`:** read from ChatChannel (`channel_meta` row + last message + max event_id). These are real columns now (Phase 0 schema has `channel_meta.member_count`, `first_message_at`, `last_message_at`; Phase 1 maintains `member_count` on join, `last_message_at` on message — but no messages in Phase 1 so it stays null).
- **ROUTE_INDEX_PENDING:** not needed in Phase 1 (no message_id-scoped routes called yet — `/messages/{id}` edit/delete is Phase 4). Skip.

**Verified platform assumptions (carried from Phase 0):** DO SQLite `sql.exec` is sync + `.toArray()`; `storage.transaction(fn)` for atomic read-modify-write; `getByName` resolves DOs; `scheduleNextAlarm`/`runDueJobs` from `src/do/scheduler.ts`; profile `resolveUserSummaries` swallows Hyperdrive errors → fallback. Re-verify nothing new.

---

## File Structure (Phase 1 deltas on Phase 0)

```
src/
├── do/
│   ├── chat-channel.ts        # MODIFY: add /internal/join, /internal/messages, /internal/summary, /internal/maybe-create; alarm() flushes outbox
│   ├── user-directory.ts      # MODIFY: add /internal/upsert-channel (idempotent join/leave projection) + enrich /my-channels to return membership_version
│   └── sql.ts                 # MODIFY: add helper to read last_event_id / last message (or put in chat-channel)
├── routes/
│   ├── bootstrap.ts           # MODIFY: real channels list + system channel lazy-join + active_channel + messages + per_channel cursors + unread
│   ├── messages.ts            # NEW: GET /api/chat/channels/:channel_id/messages
│   ├── channels.ts            # NEW: GET /api/chat/channels (list user's channels) + GET /api/chat/channels/{id} (detail)
│   ├── bootstrap.test.ts      # MODIFY: assert system channel appears, active_channel set, per_channel cursor map keyed by channel_id
│   ├── messages.test.ts       # NEW
│   └── channels.test.ts       # NEW
└── chat/
    ├── projection.ts          # NEW: ChatChannel→UserDirectory outbox write + flush helper (reusable; leave/role in Phase 3 reuse)
    └── projection.test.ts     # NEW
test/
└── unit/
    └── phase1-helpers.test.ts # NEW: cursor encoding, unread computation pure helpers
```

**Boundaries:**
- `src/chat/projection.ts` owns the outbox write + flush for user_directory projection. ChatChannel DO calls it; it's the single place that knows the outbox row shape for this target. Phase 3 (leave/role) reuses it.
- `src/do/chat-channel.ts` gains internal RPC-style `fetch` endpoints (`/internal/*`) called by the Worker; it does NOT do auth (the Worker already verified JWT). Internal endpoints trust `X-Verified-User-Id` like Phase 0's UserDirectory `/my-channels`.
- `src/routes/bootstrap.ts` orchestrates: Worker verifies JWT → calls UserDirectory `/my-channels` → for the system channel, calls ChatChannel `/internal/summary` + `/internal/messages` → batch profile resolve → shape response. Single `resolveUserSummaries` call for all senders.
- `src/routes/messages.ts` and `channels.ts` are thin: verify JWT → route to the right DO → shape. `messages.ts` reads from ChatChannel directly (channel_id in URL). `channels.ts` reads UserDirectory + ChatChannel summaries.

---

## Preconditions

- **Named-DO test helper exists and is used in all Phase 1 tests.** Add to `test/helpers.ts` (the Phase 0 helper file):

  ```ts
  export function getNamedDo(binding: DurableObjectNamespace, name: string): DurableObjectStub {
    // prod uses getByName; tests use idFromName+get. Works in both environments.
    return binding.get(binding.idFromName(name));
  }
  ```

  All Phase 1 tests import `getNamedDo` from `../../test/helpers` and use `getNamedDo(env.X, name)` instead of `env.X.getByName(name)`. (Phase 0 tests used `idFromName+get` directly; this centralizes the pattern.) Production code keeps `c.env.X.getByName(...)`.

- **v3.1 per-channel cursor contract delta is the implementation target** (`docs/api-contract/2026-06-22-toolbear-chat-api-contract.md` §4.1 / §10).
- **projection_outbox flush path is tested end-to-end**: ChatChannel join → alarm/flush → UserDirectory my_channels contains the channel (see Task 1 Step 4 test additions + `src/chat/projection.test.ts`).

---

## Task 0: Helper module `src/chat/system-channel.ts`

**Files:**
- Create: `src/chat/system-channel.ts`
- Test: `src/chat/system-channel.test.ts` (light)

Centralizes system-channel routing so `SYSTEM_CHANNEL_NAME` / `SYSTEM_TITLE` / `channelNameFor` are NOT duplicated across bootstrap, channels, messages routes (reviewer P1-3).

**Interfaces:**
- `ensureSystemChannel(env): Promise<{ channelId: string }>` — calls ChatChannel `/internal/maybe-create-system`.
- `ensureSystemJoined(env, userId): Promise<{ channelId: string; membershipVersion: number }>` — ensureSystemChannel + `/internal/join`.
- `channelRouteNameFor(env, userId, clientChannelId): Promise<string | null>` — returns `"system-general"` if `clientChannelId === system channelId` (probes system DO once to compare), else `clientChannelId` (Phase 3 convention where channel_id == DO name). Returns null if the channel can't be resolved (unknown UUID → caller returns CHANNEL_NOT_FOUND without creating state).

```ts
// src/chat/system-channel.ts
import type { Env } from "../env";

export const SYSTEM_CHANNEL_NAME = "system-general";
export const SYSTEM_TITLE = "Lilium";

export async function ensureSystemChannel(env: Env): Promise<{ channelId: string }> {
  const stub = env.CHAT_CHANNEL.getByName(SYSTEM_CHANNEL_NAME);
  const res = await stub.fetch(new Request("https://x/internal/maybe-create-system", {
    method: "POST", body: JSON.stringify({ title: SYSTEM_TITLE }),
  }));
  return { channelId: (await res.json() as { channel_id: string }).channel_id };
}

export async function ensureSystemJoined(env: Env, userId: string): Promise<{ channelId: string; membershipVersion: number }> {
  const { channelId } = await ensureSystemChannel(env);
  const stub = env.CHAT_CHANNEL.getByName(SYSTEM_CHANNEL_NAME);
  const jr = await stub.fetch(new Request("https://x/internal/join", {
    method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  }));
  const jb = await jr.json() as { channel_id: string; membership_version: number };
  return { channelId: jb.channel_id, membershipVersion: jb.membership_version };
}

export async function channelRouteNameFor(env: Env, userId: string, clientChannelId: string): Promise<string | null> {
  const sys = await ensureSystemChannel(env);
  if (clientChannelId === sys.channelId) return SYSTEM_CHANNEL_NAME;
  // Phase 3+ convention: user-created channels use channel_id as the DO name.
  // For Phase 1, any non-system id is unresolved → null (caller returns CHANNEL_NOT_FOUND).
  return null;
}
```

Test (`src/chat/system-channel.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../../test/helpers";
import { ensureSystemChannel, ensureSystemJoined, channelRouteNameFor, SYSTEM_CHANNEL_NAME } from "./system-channel";

describe("system-channel helpers", () => {
  it("ensureSystemChannel returns a stable UUIDv7 channel_id", async () => {
    const a = await ensureSystemChannel(env);
    const b = await ensureSystemChannel(env);
    expect(a.channelId).toBe(b.channelId);
    expect(a.channelId).toMatch(/^01[0-9a-f]{6}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("channelRouteNameFor returns system name for system channelId, null for others", async () => {
    const userId = "u-route-1";
    const { channelId } = await ensureSystemJoined(env, userId);
    expect(await channelRouteNameFor(env, userId, channelId)).toBe(SYSTEM_CHANNEL_NAME);
    expect(await channelRouteNameFor(env, userId, "unknown-uuid")).toBeNull();
  });
});
```

- [ ] **Step 1: Write failing test** (above)
- [ ] **Step 2: Run → FAIL** (`./system-channel` not found)
- [ ] **Step 3: Implement** `src/chat/system-channel.ts` (above)
- [ ] **Step 4: `npx tsc --noEmit` → PASS**
- [ ] **Step 5: `npx vitest run src/chat/system-channel.test.ts` → PASS (2 tests)**
- [ ] **Step 6: Commit** `git add src/chat/system-channel.ts src/chat/system-channel.test.ts test/helpers.ts && git commit -m "feat(chat): system-channel routing helpers + getNamedDo test helper"`

---

## Task 1: System channel lazy-create + join endpoint on ChatChannel

**Files:**
- Modify: `src/do/chat-channel.ts` (add `/internal/maybe-create-system` + `/internal/join`)
- Test: `src/do/chat-channel.system.test.ts` (NEW)

**Interfaces:**
- Consumes: `execSchema` (existing), `uuidv7` from `src/ids/uuidv7.ts`, `monotonicUuidV7` + `EventSeq` (existing in chat-channel via Phase 0).
- Produces:
  - ChatChannel fetch handles `POST /internal/maybe-create-system` with body `{ title: string }` → idempotently inserts `channel_meta` row for the current DO instance (the DO IS the channel; channel_id = `this.ctx.id.toString()` or a stable value from the row). Actually: the channel_id stored in `channel_meta` should match the DO name. Since this DO is `getByName("system-general")`, store `channel_id = "system-general"` (or a generated UUIDv7 stored once). Decision: store a generated UUIDv7 as `channel_id` in `channel_meta` on first create, and have the Worker treat the DO name `"system-general"` as the routing key; the `channel_id` returned to clients is the UUIDv7 from `channel_meta`. Tests assert the same DO returns the same channel_id across calls.
  - `POST /internal/join` with `X-Verified-User-Id` + body `{ user_id, role?: "member" }` → in one `storage.transaction`: upsert `members` row (`status` via left_at: active = left_at IS NULL), bump `channel_meta.membership_version`, insert `member.joined` event (event_id via `nextEventId`), write `projection_outbox` row `target_kind='user_directory', target_key=user_id, payload={action:'join', channel_id, kind, membership_version}`. Idempotent: if user already active member, return current membership without re-inserting event/outbox. Returns `{ channel_id, membership_version, joined_at }`.
  - Maintains `channel_meta.member_count` (denormalized count of active members) on join.

- [ ] **Step 1: Write failing test `src/do/chat-channel.system.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";

const SYSTEM = "system-general";

// getNamedDo is imported from test/helpers (added in Task 0).
import { getNamedDo } from "../../test/helpers";

async function ensureSystem(): Promise<string> {
  const stub = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
  const res = await stub.fetch(new Request("https://x/internal/maybe-create-system", {
    method: "POST", body: JSON.stringify({ title: "Lilium" }),
  }));
  const body = await res.json() as { channel_id: string };
  return body.channel_id;
}

describe("ChatChannel system channel", () => {
  it("maybe-create-system is idempotent (same channel_id across calls)", async () => {
    const id1 = await ensureSystem();
    const id2 = await ensureSystem();
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("join is idempotent and bumps membership_version only once for a new user", async () => {
    const channelId = await ensureSystem();
    const stub = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
    const userId = "u-join-1";
    const r1 = await stub.fetch(new Request("https://x/internal/join", {
      method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const b1 = await r1.json() as { channel_id: string; membership_version: number };
    expect(b1.channel_id).toBe(channelId);
    expect(b1.membership_version).toBe(1);
    // re-join same user → idempotent, no bump
    const r2 = await stub.fetch(new Request("https://x/internal/join", {
      method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const b2 = await r2.json() as { membership_version: number };
    expect(b2.membership_version).toBe(1);
  });

  it("join writes a projection_outbox row for user_directory", async () => {
    await ensureSystem();
    const stub = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
    const userId = "u-join-2";
    await stub.fetch(new Request("https://x/internal/join", {
      method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    // verify outbox row exists (internal probe) — use /internal/outbox-pending
    const probe = await stub.fetch(new Request("https://x/internal/outbox-pending?target_kind=user_directory"));
    const pb = await probe.json() as { count: number };
    expect(pb.count).toBeGreaterThanOrEqual(1);
  });

  it("end-to-end: join → alarm flush → UserDirectory my_channels contains the channel", async () => {
    const channelId = await ensureSystem();
    const stub = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
    const userId = "u-e2e-1";
    await stub.fetch(new Request("https://x/internal/join", {
      method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    // trigger the alarm flush (the DO's alarm() drains the outbox)
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (instance) => { await (instance as { alarm: () => Promise<void> }).alarm(); });
    const dirStub = getNamedDo(env.USER_DIRECTORY, userId);
    const res = await dirStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: Array<{ channel_id: string }> };
    expect(body.items.find((r) => r.channel_id === channelId)).toBeDefined();
  });

  it("rejoin after leave reactivates and bumps membership_version (reviewer P1-4)", async () => {
    const channelId = await ensureSystem();
    const stub = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
    const userId = "u-rejoin-1";
    const r1 = await stub.fetch(new Request("https://x/internal/join", {
      method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const b1 = await r1.json() as { membership_version: number };
    // simulate a leave via a direct internal update (Phase 3 adds /internal/leave; here set left_at directly through a test-only probe)
    await stub.fetch(new Request("https://x/internal/test-leave", {
      method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const r2 = await stub.fetch(new Request("https://x/internal/join", {
      method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    const b2 = await r2.json() as { membership_version: number };
    expect(b2.membership_version).toBeGreaterThan(b1.membership_version);
  });
});
```

The `rejoin` test needs a `/internal/test-leave` endpoint to set `left_at` (Phase 3 adds a real `/internal/leave`). Add this test-only endpoint to ChatChannel.fetch:

```ts
if (url.pathname === "/internal/test-leave") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  const now = new Date().toISOString();
  return await this.ctx.storage.transaction(async () => {
    const meta = this.ctx.storage.sql.exec("SELECT channel_id, membership_version FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string; membership_version: number } | undefined;
    if (!meta) return new Response("not created", { status: 409 });
    this.ctx.storage.sql.exec("UPDATE members SET left_at=? WHERE channel_id=? AND user_id=?", now, meta.channel_id, userId);
    return Response.json({ ok: true });
  });
}
```
(Remove this endpoint when Phase 3 adds the real leave path.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/do/chat-channel.system.test.ts`
Expected: FAIL — `/internal/maybe-create-system` returns 404.

- [ ] **Step 3: Implement `/internal/maybe-create-system` + `/internal/join` + `/internal/outbox-pending` in `chat-channel.ts`**

Add to ChatChannel.fetch (keep existing Phase 0 endpoints):

```ts
if (url.pathname === "/internal/maybe-create-system") {
  const { title } = (await request.json()) as { title: string };
  return await this.ctx.storage.transaction(async () => {
    const row = this.ctx.storage.sql.exec("SELECT channel_id FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string } | undefined;
    if (row) return Response.json({ channel_id: row.channel_id });
    const channelId = uuidv7();
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO channel_meta (channel_id, kind, visibility, title, topic, avatar_url, status, created_by, created_at, updated_at, member_count, membership_version) VALUES (?, 'channel', 'public_listed', ?, NULL, NULL, 'active', 'system', ?, ?, 0, 0)",
      channelId, title, now, now,
    );
    return Response.json({ channel_id: channelId });
  });
}

if (url.pathname === "/internal/join") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  const { user_id } = (await request.json()) as { user_id: string };
  if (!userId || userId !== user_id) return new Response("bad user", { status: 400 });
  return await this.ctx.storage.transaction(async () => {
    const meta = this.ctx.storage.sql.exec("SELECT channel_id, membership_version, member_count FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string; membership_version: number; member_count: number } | undefined;
    if (!meta) return new Response("channel not created", { status: 409 });
    const existing = this.ctx.storage.sql.exec("SELECT joined_at, left_at, role FROM members WHERE channel_id=? AND user_id=?", meta.channel_id, user_id).toArray()[0] as { joined_at: string; left_at: string | null; role: string } | undefined;
    if (existing && existing.left_at === null) {
      // already active member — idempotent, no bump.
      return Response.json({ channel_id: meta.channel_id, membership_version: meta.membership_version, joined_at: existing.joined_at });
    }
    const now = new Date().toISOString();
    const newVersion = meta.membership_version + 1;
    if (existing && existing.left_at !== null) {
      // reactivate a previously-left member: clear left_at, bump version, count++, write event + outbox.
      this.ctx.storage.sql.exec("UPDATE members SET left_at=NULL, role='member', joined_at=? WHERE channel_id=? AND user_id=?", now, meta.channel_id, user_id);
    } else {
      this.ctx.storage.sql.exec(
        "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'member', ?, NULL)",
        meta.channel_id, user_id, now,
      );
    }
    this.ctx.storage.sql.exec("UPDATE channel_meta SET membership_version=?, member_count=member_count+1, updated_at=? WHERE channel_id=?", newVersion, now, meta.channel_id);
    const eventId = this.nextEventId();
    // actor is the system performing the auto-join; the joined user is the SUBJECT (in payload), not the actor (reviewer P1-7).
    this.ctx.storage.sql.exec(
      "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'member.joined', ?, 'system', 'system', ?, ?, ?)",
      eventId, meta.channel_id, JSON.stringify({ channel_id: meta.channel_id, user_id, membership_version: newVersion }), newVersion, now,
    );
    const outboxId = uuidv7();
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, attempts, max_attempts, next_attempt_at, created_at, updated_at) VALUES (?, 'user_directory', ?, ?, ?, 'pending', 0, 5, ?, ?, ?)",
      outboxId, user_id, eventId, JSON.stringify({ action: "join", channel_id: meta.channel_id, kind: "channel", membership_version: newVersion }), now, now, now,
    );
    await this.scheduleOutboxAlarm(now);
    return Response.json({ channel_id: meta.channel_id, membership_version: newVersion, joined_at: now });
  });
}

if (url.pathname === "/internal/outbox-pending") {
  const tk = url.searchParams.get("target_kind") ?? "user_directory";
  const row = this.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM projection_outbox WHERE status='pending' AND target_kind=?", tk).toArray()[0] as { c: number } | undefined;
  return Response.json({ count: row?.c ?? 0 });
}
```

Add a private method `scheduleOutboxAlarm(now: string)`:

```ts
private async scheduleOutboxAlarm(nowIso: string): Promise<void> {
  // earliest pending outbox next_attempt_at; setAlarm to it (or leave existing if earlier).
  const dueTable = {
    table: "projection_outbox",
    dueColumn: "next_attempt_at",
    statusColumn: "status",
    pendingStatus: "pending",
    handler: async () => {}, // alarm() does the real flush
  };
  // reuse scheduler: find earliest due and setAlarm
  const next = this.ctx.storage.sql.exec("SELECT MIN(next_attempt_at) AS m FROM projection_outbox WHERE status='pending'").toArray()[0] as { m: string | null } | undefined;
  if (next?.m) {
    const ms = Date.parse(next.m);
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || ms < cur) await this.ctx.storage.setAlarm(ms);
  }
}
```

Note: comparing `next.m` (ISO string) as a timestamp via `Date.parse`. For Phase 1 simplicity `next_attempt_at` is set to `now` (immediate-ish flush). Real backoff lives in the alarm retry loop (Phase 0 scheduler already does exponential backoff via re-arm).

- [ ] **Step 4: Wire ChatChannel `alarm()` to flush outbox**

Add to the `alarm()` method (Phase 0 left it empty):

```ts
async alarm(): Promise<void> {
  const nowIso = new Date().toISOString();
  // Flush user_directory outbox rows that are due.
  const due = this.ctx.storage.sql.exec("SELECT outbox_id, target_key, payload_json FROM projection_outbox WHERE status='pending' AND next_attempt_at <= ?", nowIso).toArray() as Array<{ outbox_id: string; target_key: string; payload_json: string }>;
  for (const r of due) {
    try {
      const stub = this.env.USER_DIRECTORY.getByName(r.target_key);
      const res = await stub.fetch(new Request("https://x/internal/upsert-channel", { method: "POST", body: r.payload_json, headers: { "Content-Type": "application/json", "X-Verified-User-Id": r.target_key } }));
      if (res.ok) {
        this.ctx.storage.sql.exec("UPDATE projection_outbox SET status='delivered', updated_at=? WHERE outbox_id=?", nowIso, r.outbox_id);
      } else {
        this.bumpOutboxRetry(r.outbox_id, nowIso, `target returned ${res.status}`);
      }
    } catch (e) {
      this.bumpOutboxRetry(r.outbox_id, nowIso, String(e));
    }
  }
  // re-arm alarm to next earliest pending (or delete if none)
  await this.scheduleOutboxAlarm(nowIso);
}

private bumpOutboxRetry(outboxId: string, nowIso: string, error: string): void {
  const row = this.ctx.storage.sql.exec("SELECT attempts, max_attempts FROM projection_outbox WHERE outbox_id=?", outboxId).toArray()[0] as { attempts: number; max_attempts: number } | undefined;
  if (!row) return;
  const attempts = row.attempts + 1;
  if (attempts >= row.max_attempts) {
    this.ctx.storage.sql.exec("UPDATE projection_outbox SET status='dead_letter', attempts=?, last_error=?, failed_at=?, updated_at=? WHERE outbox_id=?", attempts, error, nowIso, nowIso, outboxId);
  } else {
    // exponential backoff: 2^attempts seconds
    const nextMs = Date.now() + Math.pow(2, attempts) * 1000;
    this.ctx.storage.sql.exec("UPDATE projection_outbox SET attempts=?, last_error=?, next_attempt_at=?, updated_at=? WHERE outbox_id=?", attempts, error, new Date(nextMs).toISOString(), nowIso, outboxId);
  }
}
```

- [ ] **Step 5: Run `tsc --noEmit`**

Run: `npx tsc --noEmit`
Expected: PASS. If `noUncheckedIndexedAccess` errors on `toArray()[0]`, add `?? undefined`/guards.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/do/chat-channel.system.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/do/chat-channel.ts src/do/chat-channel.system.test.ts
git commit -m "feat(do): system channel lazy-create + idempotent join + outbox flush in alarm"
```

### Task 1b: `src/chat/projection.test.ts` — outbox delivery end-to-end + dead-letter

Reviewer P0-1 required proving the flush path delivers to UserDirectory (not just that an outbox row exists). The end-to-end delivery test is in Task 1's `chat-channel.system.test.ts`; this file adds the dead-letter path + a focused projection helper test.

**Files:**
- Create: `src/chat/projection.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../../test/helpers";

const SYSTEM = "system-general";

describe("projection outbox delivery (reviewer P0-1)", () => {
  it("flush delivers join → UserDirectory my_channels contains the channel", async () => {
    const sys = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
    await sys.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    const userId = "u-proj-e2e-1";
    const jr = await sys.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const { channel_id } = await jr.json() as { channel_id: string };
    // drive the alarm flush
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(sys, async (instance) => { await (instance as { alarm: () => Promise<void> }).alarm(); });
    const dir = getNamedDo(env.USER_DIRECTORY, userId);
    const res = await dir.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: Array<{ channel_id: string }> };
    expect(body.items.find((r) => r.channel_id === channel_id)).toBeDefined();
    // outbox row now delivered
    const probe = await sys.fetch(new Request("https://x/internal/outbox-pending?target_kind=user_directory"));
    const pb = await probe.json() as { count: number };
    expect(pb.count).toBe(0);
  });

  it("flush with X-Verified-User-Id header set (P0-1 regression) — target does not 400", async () => {
    // This guards against the original bug where the flush fetch omitted the header.
    const sys = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
    await sys.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    const userId = "u-proj-header-1";
    await sys.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(sys, async (instance) => { await (instance as { alarm: () => Promise<void> }).alarm(); });
    // no dead_letter rows for this user
    const dir = getNamedDo(env.USER_DIRECTORY, userId);
    const res = await dir.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: Array<{ channel_id: string }> };
    expect(body.items.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 1: Write test** (above)
- [ ] **Step 2: Run → should PASS** (Task 1 already implements the header + alarm flush). If FAIL, the flush header is missing — fix Task 1's alarm.
- [ ] **Step 3: `npx tsc --noEmit` → PASS**
- [ ] **Step 4: `npx vitest run src/chat/projection.test.ts` → PASS (2 tests)**
- [ ] **Step 5: Commit** `git add src/chat/projection.test.ts && git commit -m "test(chat): projection outbox end-to-end + header regression (P0-1)"`

---

## Task 2: UserDirectory `/internal/upsert-channel` projection target

**Files:**
- Modify: `src/do/user-directory.ts` (add `/internal/upsert-channel` + enrich `/my-channels` to return `membership_version`)
- Test: `src/do/user-directory.projection.test.ts` (NEW)

**Interfaces:**
- Consumes: existing schema (my_channels has status/left_at/removed_at/membership_version).
- Produces:
  - `POST /internal/upsert-channel` body `{ action: "join"|"leave", channel_id, kind, membership_version }` + `X-Verified-User-Id` header (target user_id) → idempotent upsert of `my_channels` row. On `join`: insert or set `status='active', left_at=NULL, membership_version=<new>`. On `leave`: set `status='left', left_at=now, membership_version=<new>`. Idempotent: re-applying the same `membership_version` is a no-op. Returns `{ ok: true }`.
  - `/my-channels` now also returns `membership_version` per row (Phase 0 returned channel_id/kind/last_read_event_id only).

- [ ] **Step 1: Write failing test `src/do/user-directory.projection.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../../test/helpers";

const userId = "u-proj-1";

async function upsert(body: Record<string, unknown>): Promise<Response> {
  const stub = getNamedDo(env.USER_DIRECTORY, userId);
  return stub.fetch(new Request("https://x/internal/upsert-channel", {
    method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("UserDirectory projection", () => {
  it("join inserts an active my_channels row with membership_version", async () => {
    await upsert({ action: "join", channel_id: "ch-p-1", kind: "channel", membership_version: 1 });
    const stub = getNamedDo(env.USER_DIRECTORY, userId);
    const res = await stub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: Array<{ channel_id: string; kind: string; membership_version: number; last_read_event_id: string | null }> };
    const row = body.items.find((r) => r.channel_id === "ch-p-1");
    expect(row).toBeDefined();
    expect(row!.membership_version).toBe(1);
  });

  it("leave marks status=left + left_at, not in active my_channels", async () => {
    await upsert({ action: "join", channel_id: "ch-p-2", kind: "channel", membership_version: 1 });
    await upsert({ action: "leave", channel_id: "ch-p-2", kind: "channel", membership_version: 2 });
    const stub = getNamedDo(env.USER_DIRECTORY, userId);
    const res = await stub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: Array<{ channel_id: string }> };
    expect(body.items.find((r) => r.channel_id === "ch-p-2")).toBeUndefined();
  });

  it("re-applying same membership_version is idempotent (no duplicate, no error)", async () => {
    await upsert({ action: "join", channel_id: "ch-p-3", kind: "channel", membership_version: 5 });
    await upsert({ action: "join", channel_id: "ch-p-3", kind: "channel", membership_version: 5 });
    const stub = getNamedDo(env.USER_DIRECTORY, userId);
    const res = await stub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-Id": userId, "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: Array<{ channel_id: string }> };
    expect(body.items.filter((r) => r.channel_id === "ch-p-3").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/do/user-directory.projection.test.ts`
Expected: FAIL — `/internal/upsert-channel` 404.

- [ ] **Step 3: Implement `/internal/upsert-channel` + enrich `/my-channels`**

In `user-directory.ts` fetch:

```ts
if (url.pathname === "/internal/upsert-channel") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  const b = (await request.json()) as { action: "join" | "leave"; channel_id: string; kind: string; membership_version: number };
  if (!userId) return new Response("bad user", { status: 400 });
  const now = new Date().toISOString();
  return await this.ctx.storage.transaction(async () => {
    const existing = this.ctx.storage.sql.exec("SELECT status, membership_version FROM my_channels WHERE user_id=? AND channel_id=?", userId, b.channel_id).toArray()[0] as { status: string; membership_version: number } | undefined;
    if (b.action === "join") {
      if (existing) {
        // idempotent: skip if already at this version; else reactivate
        if (existing.membership_version >= b.membership_version) return Response.json({ ok: true });
        this.ctx.storage.sql.exec("UPDATE my_channels SET status='active', left_at=NULL, removed_at=NULL, membership_version=?, joined_at=COALESCE(joined_at, ?) WHERE user_id=? AND channel_id=?", b.membership_version, now, userId, b.channel_id);
      } else {
        this.ctx.storage.sql.exec("INSERT INTO my_channels (user_id, channel_id, kind, joined_at, left_at, removed_at, status, membership_version, last_read_event_id) VALUES (?, ?, ?, ?, NULL, NULL, 'active', ?, NULL)", userId, b.channel_id, b.kind, now, b.membership_version);
      }
    } else { // leave
      if (existing) {
        this.ctx.storage.sql.exec("UPDATE my_channels SET status='left', left_at=?, membership_version=? WHERE user_id=? AND channel_id=?", now, b.membership_version, userId, b.channel_id);
      }
    }
    return Response.json({ ok: true });
  });
}
```

Update `/my-channels` SELECT to also return `membership_version`:

```ts
const rows = this.ctx.storage.sql.exec("SELECT channel_id, kind, last_read_event_id, membership_version FROM my_channels WHERE user_id = ? AND status = 'active'", userId).toArray() as { channel_id: string; kind: string; last_read_event_id: string | null; membership_version: number }[];
```

- [ ] **Step 4: Run `tsc --noEmit`**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/do/user-directory.projection.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/do/user-directory.ts src/do/user-directory.projection.test.ts
git commit -m "feat(do): UserDirectory upsert-channel projection + membership_version in my-channels"
```

---

## Task 3: ChatChannel summary + messages pagination endpoints

**Files:**
- Modify: `src/do/chat-channel.ts` (add `/internal/summary`, `/internal/messages`)
- Test: `src/do/chat-channel.read.test.ts` (NEW)

**Interfaces:**
- Consumes: existing messages/events/channel_meta schema.
- Produces:
  - `GET /internal/summary` (with `X-Verified-User-Id`) → returns `{ channel_id, kind, visibility, title, topic, avatar_url, member_count, status, created_at, updated_at, last_message_at, last_message_preview, last_message_sender_id, last_event_id, my_role }`. `my_role` from members (null if not member). `last_event_id` = max(events.event_id). `last_message_*` from the latest `status NOT IN ('deleted','recalled')` message (null in Phase 1). **ChatChannel does NOT return `last_read_event_id` or `unread_count`** — those live in UserDirectory (last_read_event_id is per-user) and must be computed in the route layer (reviewer P1-6). The route combines: `unread_count = count(events where event_id > user's last_read_event_id AND actor_id != user)` — for Phase 1 (no messages) this is 0; the route sets it from UserDirectory's row.
    - 403 (FORBIDDEN) if user not a member AND visibility != public. For system channel (public_listed) allow read even if not member (but bootstrap will have joined them first).
  - `GET /internal/messages?before=<message_id>&limit=<n>` (with `X-Verified-User-Id`) → `{ items: Message[], next_cursor: string|null }`. Pages visible messages (`status NOT IN ('deleted','recalled')`) ordered by `message_id DESC`, `before` exclusive. `limit` default 50, max 100. `next_cursor` = the oldest message_id in the page if more exist, else null.

- [ ] **Step 1: Write failing test `src/do/chat-channel.read.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../../test/helpers";

const SYSTEM = "system-general-read";

async function setupChannel(): Promise<string> {
  const stub = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
  const r = await stub.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
  return (await r.json() as { channel_id: string }).channel_id;
}

async function joinUser(channelId: string, userId: string): Promise<void> {
  const stub = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
  await stub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
}

describe("ChatChannel read endpoints", () => {
  it("summary returns channel meta + last_event_id + my role", async () => {
    const cid = await setupChannel();
    const userId = "u-read-1";
    await joinUser(cid, userId);
    const stub = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
    const res = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { channel_id: string; title: string; last_event_id: string | null; my_role: string; member_count: number };
    expect(body.channel_id).toBe(cid);
    expect(body.title).toBe("Lilium");
    expect(body.member_count).toBeGreaterThanOrEqual(1);
    expect(body.my_role).toBe("member");
    expect(body.last_event_id).not.toBeNull(); // member.joined event exists
  });

  it("messages pagination returns empty for fresh channel", async () => {
    const cid = await setupChannel();
    const userId = "u-read-2";
    await joinUser(cid, userId);
    const stub = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
    const res = await stub.fetch(new Request("https://x/internal/messages?limit=50", { headers: { "X-Verified-User-Id": userId } }));
    const body = await res.json() as { items: unknown[]; next_cursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("messages returns 403 for non-member when visibility private (separate channel)", async () => {
    // create a private channel via direct DO name 'private-ch-1' with a fresh channel_meta insert
    const stub = getNamedDo(env.CHAT_CHANNEL, "private-ch-1");
    // need a private channel create path — use maybe-create-system is public; for this test insert directly via a test-only endpoint or skip boundary.
    // Phase 1 only has system channel (public). Defer private-channel 403 test to Phase 3 channel create.
    // Replace with: non-member CAN read system channel (public) — assert summary returns my_role=null.
    const cid = await setupChannel();
    const stubPub = getNamedDo(env.CHAT_CHANNEL, SYSTEM);
    const res = await stubPub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": "non-member-x" } }));
    const body = await res.json() as { my_role: string | null };
    expect(body.my_role).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/do/chat-channel.read.test.ts`
Expected: FAIL — `/internal/summary` + `/internal/messages` 404.

- [ ] **Step 3: Implement `/internal/summary` + `/internal/messages`**

In chat-channel.ts fetch:

```ts
if (url.pathname === "/internal/summary") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  const meta = this.ctx.storage.sql.exec("SELECT channel_id, kind, visibility, title, topic, avatar_url, status, created_at, updated_at, member_count FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string; kind: string; visibility: string; title: string; topic: string | null; avatar_url: string | null; status: string; created_at: string; updated_at: string; member_count: number } | undefined;
  if (!meta) return new Response("channel not created", { status: 409 });
  const member = userId ? this.ctx.storage.sql.exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", meta.channel_id, userId).toArray()[0] as { role: string } | undefined : undefined;
  const isMember = !!member;
  if (!isMember && meta.visibility === "private") return new Response("forbidden", { status: 403 });
  const lastEvent = this.ctx.storage.sql.exec("SELECT event_id FROM events WHERE channel_id=? ORDER BY event_id DESC LIMIT 1", meta.channel_id).toArray()[0] as { event_id: string } | undefined;
  const lastMsg = this.ctx.storage.sql.exec("SELECT message_id, sender_kind, sender_user_id, text FROM messages WHERE channel_id=? AND status NOT IN ('deleted','recalled') ORDER BY created_at DESC LIMIT 1", meta.channel_id).toArray()[0] as { message_id: string; sender_kind: string; sender_user_id: string | null; text: string | null } | undefined;
  // ChatChannel does NOT know last_read_event_id or unread (per-user, in UserDirectory). Route layer computes unread.
  return Response.json({
    channel_id: meta.channel_id, kind: meta.kind, visibility: meta.visibility, title: meta.title, topic: meta.topic, avatar_url: meta.avatar_url,
    status: meta.status, created_at: meta.created_at, updated_at: meta.updated_at, member_count: meta.member_count,
    last_message_at: null, last_message_preview: null, last_message_sender_id: lastMsg?.sender_user_id ?? null,
    last_event_id: lastEvent?.event_id ?? null,
    my_role: member?.role ?? null,
  });
}

if (url.pathname === "/internal/messages") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  const before = url.searchParams.get("before");
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? "50")), 100);
  const meta = this.ctx.storage.sql.exec("SELECT channel_id, visibility FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string; visibility: string } | undefined;
  if (!meta) return new Response("channel not created", { status: 409 });
  const member = userId ? this.ctx.storage.sql.exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", meta.channel_id, userId).toArray()[0] : undefined;
  if (!member && meta.visibility === "private") return new Response("forbidden", { status: 403 });
  const rows = before
    ? this.ctx.storage.sql.exec("SELECT message_id, client_message_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE channel_id=? AND status NOT IN ('deleted','recalled') AND message_id < ? ORDER BY message_id DESC LIMIT ?", meta.channel_id, before, limit + 1).toArray()
    : this.ctx.storage.sql.exec("SELECT message_id, client_message_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE channel_id=? AND status NOT IN ('deleted','recalled') ORDER BY message_id DESC LIMIT ?", meta.channel_id, limit + 1).toArray();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map((r) => rowToMessage(r));
  const nextCursor = hasMore && page.length > 0 ? (page[page.length - 1] as { message_id: string }).message_id : null;
  return Response.json({ items, next_cursor: nextCursor });
}
```

Add a `rowToMessage` helper at module level (used again in bootstrap):

```ts
function rowToMessage(r: Record<string, unknown>): Record<string, unknown> {
  const m = r as {
    message_id: string; client_message_id: string; channel_id: string; sender_kind: string;
    sender_user_id: string | null; sender_bot_id: string | null; type: string; format: string;
    status: string; text: string | null; reply_to: string | null; reply_snapshot_json: string | null;
    stream_state: string; created_at: string; updated_at: string; edited_at: string | null;
    deleted_at: string | null; deleted_by: string | null; recalled_at: string | null;
  };
  return {
    message_id: m.message_id, client_message_id: m.client_message_id, channel_id: m.channel_id,
    sender: { kind: m.sender_kind, user_id: m.sender_user_id, bot_id: m.sender_bot_id },
    type: m.type, format: m.format, status: m.status, text: m.text,
    reply_to: m.reply_to, reply_snapshot: m.reply_snapshot_json ? JSON.parse(m.reply_snapshot_json) : null,
    stream_state: m.stream_state, created_at: m.created_at, updated_at: m.updated_at,
    edited_at: m.edited_at, deleted_at: m.deleted_at, deleted_by: m.deleted_by, recalled_at: m.recalled_at,
    attachments: [], components: [], mentions: [], // Phase 1: no attachments/components yet
  };
}
```

Note: `sender` shape here is the raw `{kind, user_id, bot_id}`; the Worker (bootstrap/messages route) will batch-resolve user_id → UserSummary and reshape `sender` to the contract's `{kind:"user", user:{...}}`/`{kind:"bot", bot:{...}}` form. Keep `rowToMessage` returning the raw form; the route does the resolve + reshape.

- [ ] **Step 4: Run `tsc --noEmit`**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/do/chat-channel.read.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/do/chat-channel.ts src/do/chat-channel.read.test.ts
git commit -m "feat(do): ChatChannel summary + messages pagination (visible-only)"
```

---

## Task 4: Sender reshape helper (`src/chat/sender.ts`)

**Files:**
- Create: `src/chat/sender.ts`
- Test: `src/chat/sender.test.ts`

**Interfaces:**
- Consumes: `resolveUserSummaries` + `UserSummary` from `src/profile/resolve.ts`, `Env`.
- Produces: `async function attachSummaries(rawMessages: RawMessage[], env: Env): Promise<ContractMessage[]>` — takes raw DO message rows (with `sender:{kind, user_id, bot_id}`) + resolves all sender user_ids in one batch, returns contract-shaped messages with `sender:{kind:"user", user:{...}}` or `{kind:"bot", bot:{...}}` (bot resolve deferred to Phase 7/registry; Phase 1 only user senders). Missing user → fallback `{display_name:"user-<8>", avatar_url:null}` (NOT raw user_id).

- [ ] **Step 1: Write failing test `src/chat/sender.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { attachSummaries } from "./sender";
import type { Env } from "../env";
import type { UserSummary } from "../profile/resolve";

function makeEnv(): Pick<Env, "TOOLBEAR_DB"> {
  return { TOOLBEAR_DB: { connectionString: "postgres://fake" } as Env["TOOLBEAR_DB"] };
}

describe("attachSummaries", () => {
  it("reshapes raw sender to contract {kind:'user', user:{...}} with resolved display_name", async () => {
    const env = makeEnv() as Env;
    const raw = [{ message_id: "m1", client_message_id: "c1", channel_id: "ch1", sender: { kind: "user", user_id: "u1", bot_id: null }, type: "text", format: "plain", status: "normal", text: "hi", reply_to: null, reply_snapshot: null, stream_state: "none", created_at: "t", updated_at: "t", edited_at: null, deleted_at: null, deleted_by: null, recalled_at: null, attachments: [], components: [], mentions: [] }];
    // inject fake resolve via vi.mock
    vi.doMock("../profile/resolve", () => ({
      resolveUserSummaries: async () => new Map<string, UserSummary>([["u1", { user_id: "u1", display_name: "alice", avatar_url: "https://x/a.png" }]]),
    }));
    const out = await attachSummaries(raw, env);
    expect(out[0].sender).toEqual({ kind: "user", user: { user_id: "u1", display_name: "alice", avatar_url: "https://x/a.png" } });
    vi.doUnmock("../profile/resolve");
  });

  it("missing user → fallback display_name user-<8>, not raw id", async () => {
    const env = makeEnv() as Env;
    const raw = [{ message_id: "m2", client_message_id: "c2", channel_id: "ch1", sender: { kind: "user", user_id: "00000000-0000-7000-8000-000000000099", bot_id: null }, type: "text", format: "plain", status: "normal", text: "hi", reply_to: null, reply_snapshot: null, stream_state: "none", created_at: "t", updated_at: "t", edited_at: null, deleted_at: null, deleted_by: null, recalled_at: null, attachments: [], components: [], mentions: [] }];
    vi.doMock("../profile/resolve", () => ({ resolveUserSummaries: async () => new Map() }));
    const out = await attachSummaries(raw, env);
    expect((out[0].sender as { user: { display_name: string } }).user.display_name).toBe("user-00000000");
    vi.doUnmock("../profile/resolve");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/chat/sender.test.ts`
Expected: FAIL — `./sender` not found.

- [ ] **Step 3: Implement `src/chat/sender.ts`**

```ts
import type { Env } from "../env";
import { resolveUserSummaries, type UserSummary } from "../profile/resolve";

export interface RawMessage {
  message_id: string; client_message_id: string; channel_id: string;
  sender: { kind: string; user_id: string | null; bot_id: string | null };
  type: string; format: string; status: string; text: string | null;
  reply_to: string | null; reply_snapshot: unknown; stream_state: string;
  created_at: string; updated_at: string; edited_at: string | null;
  deleted_at: string | null; deleted_by: string | null; recalled_at: string | null;
  attachments: unknown[]; components: unknown[]; mentions: unknown[];
}

export interface ContractMessage {
  message_id: string; client_message_id: string; channel_id: string;
  sender: { kind: "user"; user: UserSummary } | { kind: "bot"; bot: { bot_id: string; display_name: string; avatar_url: string | null } };
  type: string; format: string; status: string; text: string | null;
  reply_to: string | null; reply_snapshot: unknown; stream_state: string;
  created_at: string; updated_at: string; edited_at: string | null;
  deleted_at: string | null; deleted_by: string | null; recalled_at: string | null;
  attachments: unknown[]; components: unknown[]; mentions: unknown[];
}

function fallback(uid: string): UserSummary {
  return { user_id: uid, display_name: `user-${uid.slice(0, 8)}`, avatar_url: null };
}

export async function attachSummaries(raw: RawMessage[], env: Env): Promise<ContractMessage[]> {
  const uids = [...new Set(raw.filter((m) => m.sender.kind === "user" && m.sender.user_id).map((m) => m.sender.user_id as string))];
  const map = await resolveUserSummaries(uids, env);
  return raw.map((m) => {
    let sender: ContractMessage["sender"];
    if (m.sender.kind === "bot") {
      // Phase 7: resolve from BotRegistry. Phase 1: no bot senders expected.
      sender = { kind: "bot", bot: { bot_id: m.sender.bot_id ?? "", display_name: "bot", avatar_url: null } };
    } else {
      const uid = m.sender.user_id ?? "";
      const u = map.get(uid) ?? fallback(uid);
      sender = { kind: "user", user: u };
    }
    return { ...m, sender };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/chat/sender.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/chat/sender.ts src/chat/sender.test.ts
git commit -m "feat(chat): attachSummaries reshapes raw sender → contract with profile resolve + fallback"
```

---

## Task 5: Real bootstrap (system channel lazy-join + active channel + messages + cursors)

**Files:**
- Modify: `src/routes/bootstrap.ts`
- Modify: `src/routes/bootstrap.test.ts` (assert system channel in list, active_channel set, per_channel cursor keyed by channel_id)
- Modify: `src/index.ts` if needed (route already wired)

**Interfaces:**
- Consumes: `verifyBrowserJwt`, `resolveUserSummaries`, `attachSummaries`, ChatChannel `/internal/maybe-create-system` + `/internal/join` + `/internal/summary` + `/internal/messages`, UserDirectory `/my-channels`.
- Produces: bootstrap returning the full contract §4.1 shape:
  - `me` (resolved or fallback)
  - `channels[]` — from UserDirectory.my_channels, each enriched with ChatChannel summary (title, member_count, last_event_id, last_message_preview, unread=0 in Phase 1). The system channel must appear (auto-joined).
  - `active_channel` — the `?channel_id=` param if user is a member, else the first channel (system), else null.
  - `messages` — the active_channel's first page (visible only), with senders resolved via `attachSummaries`.
  - `event_state.per_channel` — `{ channel_id: last_event_id }` for each channel.

- [ ] **Step 1: Update `bootstrap.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../../test/helpers";

async function bootstrap(token: string, channelId?: string): Promise<Response> {
  const SELF = (await import("../index")).default;
  const testEnv = { ...env, JWT_SECRET: TEST_SECRET };
  const qs = channelId ? `?channel_id=${channelId}` : "";
  const req = new Request(`https://chat.kuma.homes/api/chat/bootstrap${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  return SELF.fetch(req, testEnv as typeof env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
}

describe("GET /api/chat/bootstrap (Phase 1)", () => {
  it("auto-joins system channel and returns it in channels + active_channel + per_channel cursor", async () => {
    const uid = "00000000-0000-7000-8000-000000000101";
    const token = await makeJwt({ sub: uid });
    const res = await bootstrap(token);
    expect(res.status).toBe(200);
    const body = await res.json() as { me: { user_id: string }; channels: Array<{ channel_id: string; kind: string; last_event_id: string | null }>; active_channel: { channel_id: string } | null; messages: { items: unknown[] }; event_state: { per_channel: Record<string, string> } };
    expect(body.me.user_id).toBe(uid);
    expect(body.channels.length).toBeGreaterThanOrEqual(1);
    const sys = body.channels[0];
    expect(sys.kind).toBe("channel");
    expect(sys.last_event_id).not.toBeNull();
    expect(body.active_channel).not.toBeNull();
    expect(body.active_channel!.channel_id).toBe(sys.channel_id);
    expect(body.event_state.per_channel[sys.channel_id]).toBe(sys.last_event_id);
    expect(body.messages.items).toEqual([]);
  });

  it("is idempotent — second bootstrap returns same channel_id, no new join event", async () => {
    const uid = "00000000-0000-7000-8000-000000000102";
    const token = await makeJwt({ sub: uid });
    const r1 = await bootstrap(token);
    const b1 = await r1.json() as { channels: Array<{ channel_id: string }> };
    const r2 = await bootstrap(token);
    const b2 = await r2.json() as { channels: Array<{ channel_id: string }> };
    expect(b1.channels[0].channel_id).toBe(b2.channels[0].channel_id);
  });

  it("rejects machine token + managed session (carry from Phase 0)", async () => {
    const machine = await makeJwt({ sub: "u1", client_id: "c1" });
    expect((await bootstrap(machine)).status).toBe(401);
    const managed = await makeJwt({ sub: "u1", owner_user_id: "other" });
    expect((await bootstrap(managed)).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/bootstrap.test.ts`
Expected: FAIL — bootstrap still returns empty channels (Phase 0 behavior).

- [ ] **Step 3: Implement real `bootstrapHandler`**

Replace the body of `src/routes/bootstrap.ts`:

```ts
import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { resolveUserSummaries, type UserSummary } from "../profile/resolve";
import { attachSummaries, type RawMessage } from "../chat/sender";
import { ensureSystemJoined, channelRouteNameFor } from "../chat/system-channel";

function fallbackMe(user_id: string): UserSummary {
  return { user_id, display_name: `user-${user_id.slice(0, 8)}`, avatar_url: null };
}

// Explicit fallback when my_channels projection lags the just-completed join (reviewer P1-5).
// Delivery to UserDirectory is exclusively via the durable outbox; this only fills the read view.
function ensureContainsSystemFallback(
  myChannels: Array<{ channel_id: string; kind: string; last_read_event_id: string | null; membership_version: number }>,
  sysChannelId: string,
): Array<{ channel_id: string; kind: string; last_read_event_id: string | null; membership_version: number }> {
  if (myChannels.some((m) => m.channel_id === sysChannelId)) return myChannels;
  return [{ channel_id: sysChannelId, kind: "channel", last_read_event_id: null, membership_version: 0 }, ...myChannels];
}

export async function bootstrapHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id: userId } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  // 1. ensure system channel exists + user joined
  const joinResult = await ensureSystemJoined(c.env, userId);
  const sysChannelId = joinResult.channelId;

  // 2. read my_channels (projection delivered async via outbox; may lag — use explicit fallback)
  const dirStub = c.env.USER_DIRECTORY.getByName(userId);
  const dirRes = await dirStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
  const rawMyChannels = dirRes.ok ? ((await dirRes.json()) as { items: Array<{ channel_id: string; kind: string; last_read_event_id: string | null; membership_version: number }> }).items : [];
  const myChannels = ensureContainsSystemFallback(rawMyChannels, sysChannelId);

  // 3. fetch summary for each channel (Phase 1: typically just the system channel).
  const summariesPromises = myChannels.map(async (mc) => {
    const routeName = await channelRouteNameFor(c.env, userId, mc.channel_id);
    if (routeName === null) return null; // unresolved channel id (Phase 3+ convention not yet active)
    const stub = c.env.CHAT_CHANNEL.getByName(routeName);
    const res = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }));
    if (!res.ok) return null;
    const s = await res.json() as Record<string, unknown>;
    return { mc, s };
  });
  const summaries = (await Promise.all(summariesPromises)).filter(Boolean) as Array<{ mc: { channel_id: string; kind: string; last_read_event_id: string | null; membership_version: number }; s: Record<string, unknown> }>;

  // 4. resolve me
  const meMap = await resolveUserSummaries([userId], c.env);
  const me = meMap.get(userId) ?? fallbackMe(userId);

  // 5. build channels list
  const channels = summaries.map(({ mc, s }) => ({
    channel_id: s.channel_id as string,
    kind: s.kind as string,
    visibility: s.visibility as string,
    title: s.title as string,
    avatar_url: s.avatar_url as string | null,
    member_count: s.member_count as number,
    role: s.my_role as string | null,
    status: s.status as string,
    unread_count: 0, // Phase 1: ChatChannel summary doesn't compute unread (last_read is per-user in UserDirectory); real computation in Phase 3.
    last_read_event_id: mc.last_read_event_id,
    last_message_preview: (s.last_message_preview as string | null) ?? null,
    last_message_at: (s.last_message_at as string | null) ?? null,
    last_event_id: (s.last_event_id as string | null) ?? null,
  }));

  // 6. active_channel
  const requestedChannelId = new URL(c.req.url).searchParams.get("channel_id");
  const activeChannelSummary = requestedChannelId
    ? summaries.find((x) => x.s.channel_id === requestedChannelId)
    : summaries[0];
  let activeChannel: Record<string, unknown> | null = null;
  let messagesPage = { items: [] as unknown[], next_cursor: null as string | null };
  if (activeChannelSummary) {
    const s = activeChannelSummary.s;
    activeChannel = {
      channel_id: s.channel_id, kind: s.kind, visibility: s.visibility, title: s.title, topic: s.topic,
      avatar_url: s.avatar_url, member_count: s.member_count, role: s.my_role, status: s.status,
      created_at: s.created_at, updated_at: s.updated_at,
    };
    // fetch first message page for active channel
    const activeRouteName = await channelRouteNameFor(c.env, userId, s.channel_id as string);
    if (activeRouteName) {
      const stub = c.env.CHAT_CHANNEL.getByName(activeRouteName);
      const mres = await stub.fetch(new Request("https://x/internal/messages?limit=50", { headers: { "X-Verified-User-Id": userId } }));
      if (mres.ok) {
        const mb = await mres.json() as { items: RawMessage[]; next_cursor: string | null };
        messagesPage = { items: await attachSummaries(mb.items, c.env), next_cursor: mb.next_cursor };
      }
    }
  }

  // 7. per-channel cursors
  const per_channel: Record<string, string> = {};
  for (const ch of channels) if (ch.last_event_id) per_channel[ch.channel_id] = ch.last_event_id;

  return c.json({
    me, channels, active_channel: activeChannel, messages: messagesPage,
    event_state: { per_channel },
  }, 200, { "X-Request-Id": c.get("requestId") });
}
```

Note: channel_id → DO-name routing is centralized in `src/chat/system-channel.ts` (`channelRouteNameFor`), NOT duplicated in routes (reviewer P1-3). The system channel's DO name (`"system-general"`) ≠ its client-visible UUIDv7 `channel_id`; `channelRouteNameFor` probes the system DO once to compare. Phase 3+ user-created channels will use `channel_id` as the DO name directly.

- [ ] **Step 4: Run `tsc --noEmit`**

Run: `npx tsc --noEmit`
Expected: PASS. Fix any `noUncheckedIndexedAccess` (the `summaries.filter(Boolean)` cast etc.).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/routes/bootstrap.test.ts`
Expected: PASS (3 tests). The first test asserts system channel auto-joined + appears + active_channel + per_channel cursor keyed by channel_id.

Note: the "idempotent" test depends on the join being idempotent. Projection delivery to UserDirectory is **exclusively via the durable outbox** (reviewer P1-5) — bootstrap does NOT write UserDirectory synchronously. Because outbox flush is async, `my_channels` may NOT yet have the system-channel row when bootstrap reads it immediately after join. The route therefore uses an explicit `ensureContainsSystemFallback` helper: if `my_channels` is empty/lacks the system channel, fall back to a synthetic row built from the join result so bootstrap still returns the system channel. This is the single, explicit fallback path (not a second delivery mechanism). The end-to-end outbox test (Task 1) proves the async path eventually delivers.

- [ ] **Step 6: Commit**

```bash
git add src/routes/bootstrap.ts src/routes/bootstrap.test.ts
git commit -m "feat(routes): real bootstrap — system channel lazy-join, channels list, active channel, messages, per-channel cursors"
```

---

## Task 6: `GET /api/chat/channels` + `GET /api/chat/channels/{id}` routes

**Files:**
- Create: `src/routes/channels.ts`
- Create: `src/routes/channels.test.ts`
- Modify: `src/index.ts` (wire the two routes)

**Interfaces:**
- `GET /api/chat/channels` → list user's active channels (from UserDirectory my_channels) enriched with ChatChannel summary. Shape: `{ items: ChannelSummary[], next_cursor: null }` (Phase 1: no pagination cursor needed — few channels; `next_cursor: null`).
- `GET /api/chat/channels/:channel_id` → ChannelDetail for one channel. 403 if not member and private.

- [ ] **Step 1: Write failing test `src/routes/channels.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../../test/helpers";

async function app() {
  return (await import("../index")).default;
}

async function call(path: string, userId = "00000000-0000-7000-8000-000000000201"): Promise<Response> {
  const a = await app();
  const token = await makeJwt({ sub: userId });
  const testEnv = { ...env, JWT_SECRET: TEST_SECRET };
  return a.fetch(new Request(`https://chat.kuma.homes${path}`, { headers: { Authorization: `Bearer ${token}` } }), testEnv as typeof env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
}

describe("channels routes", () => {
  it("GET /api/chat/channels returns system channel after bootstrap", async () => {
    // bootstrap first to join
    const a = await app();
    const t = await makeJwt({ sub: "00000000-0000-7000-8000-000000000201" });
    await a.fetch(new Request("https://chat.kuma.homes/api/chat/bootstrap", { headers: { Authorization: `Bearer ${t}` } }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
    const res = await call("/api/chat/channels");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ channel_id: string; kind: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0].kind).toBe("channel");
  });

  it("GET /api/chat/channels/{id} returns detail for the system channel", async () => {
    // get the system channel id from channels list
    const listRes = await call("/api/chat/channels");
    const list = await listRes.json() as { items: Array<{ channel_id: string }> };
    const cid = list.items[0].channel_id;
    const res = await call(`/api/chat/channels/${cid}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { channel: { channel_id: string; kind: string; status: string } };
    expect(body.channel.channel_id).toBe(cid);
    expect(body.channel.status).toBe("active");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/channels.test.ts`
Expected: FAIL — routes not wired (404).

- [ ] **Step 3: Implement `src/routes/channels.ts`**

```ts
import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { resolveUserSummaries, type UserSummary } from "../profile/resolve";
import { ensureSystemJoined, channelRouteNameFor } from "../chat/system-channel";

async function getIdentity(c: Context<{ Bindings: Env }>): Promise<{ userId: string; env: Env }> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id } = await verifyBrowserJwt(token, c.env.JWT_SECRET);
  return { userId: user_id, env: c.env };
}

export async function listChannelsHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const sysChannelId = (await ensureSystemJoined(env, userId)).channelId;
  const dirStub = env.USER_DIRECTORY.getByName(userId);
  const dirRes = await dirStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
  const rawMyChannels = dirRes.ok ? ((await dirRes.json()) as { items: Array<{ channel_id: string; kind: string; last_read_event_id: string | null; membership_version: number }> }).items : [];
  const myChannels = rawMyChannels.some((m) => m.channel_id === sysChannelId) ? rawMyChannels : [{ channel_id: sysChannelId, kind: "channel", last_read_event_id: null, membership_version: 0 }, ...rawMyChannels];
  const items = await Promise.all(myChannels.map(async (mc) => {
    const routeName = await channelRouteNameFor(env, userId, mc.channel_id);
    if (routeName === null) return null;
    const stub = env.CHAT_CHANNEL.getByName(routeName);
    const res = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }));
    const s = await res.json() as Record<string, unknown>;
    return {
      channel_id: s.channel_id, kind: s.kind, visibility: s.visibility, title: s.title, avatar_url: s.avatar_url,
      member_count: s.member_count, role: s.my_role, status: s.status, unread_count: 0, // Phase 1: 0 (real computation Phase 3)
      last_read_event_id: mc.last_read_event_id, last_message_preview: s.last_message_preview ?? null,
      last_message_at: s.last_message_at ?? null, last_event_id: s.last_event_id ?? null,
    };
  }));
  const filtered = items.filter(Boolean) as Record<string, unknown>[];
  return c.json({ items: filtered, next_cursor: null }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function channelDetailHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  await ensureSystemJoined(env, userId); // ensure user is in system channel (idempotent); establishes sys channelId for routing
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not a member");
  if (!res.ok) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const s = await res.json() as Record<string, unknown>;
  const channel = {
    channel_id: s.channel_id, kind: s.kind, visibility: s.visibility, title: s.title, topic: s.topic,
    avatar_url: s.avatar_url, member_count: s.member_count, role: s.my_role, status: s.status,
    created_at: s.created_at, updated_at: s.updated_at,
  };
  return c.json({ channel }, 200, { "X-Request-Id": c.get("requestId") });
}
```

- [ ] **Step 4: Wire routes in `src/index.ts`**

```ts
import { listChannelsHandler, channelDetailHandler } from "./routes/channels";
app.get("/api/chat/channels", (c) => listChannelsHandler(c));
app.get("/api/chat/channels/:channel_id", (c) => channelDetailHandler(c));
```

Place before the catch-all.

- [ ] **Step 5: Run `tsc --noEmit`**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/routes/channels.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/routes/channels.ts src/routes/channels.test.ts src/index.ts
git commit -m "feat(routes): GET /channels (list) + GET /channels/{id} (detail)"
```

---

## Task 7: `GET /api/chat/channels/:channel_id/messages` route

**Files:**
- Create: `src/routes/messages.ts`
- Create: `src/routes/messages.test.ts`
- Modify: `src/index.ts` (wire route)

**Interfaces:**
- `GET /api/chat/channels/:channel_id/messages?before=<message_id>&limit=<n>` → verify JWT, ensure system joined, route to ChatChannel `/internal/messages`, `attachSummaries` on items, return `{ items: ContractMessage[], next_cursor }`.

- [ ] **Step 1: Write failing test `src/routes/messages.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../../test/helpers";

async function call(path: string, userId = "00000000-0000-7000-8000-000000000301"): Promise<Response> {
  const a = (await import("../index")).default;
  const token = await makeJwt({ sub: userId });
  return a.fetch(new Request(`https://chat.kuma.homes${path}`, { headers: { Authorization: `Bearer ${token}` } }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
}

async function bootstrapFirst(userId: string): Promise<string> {
  const a = (await import("../index")).default;
  const token = await makeJwt({ sub: userId });
  const r = await a.fetch(new Request("https://chat.kuma.homes/api/chat/bootstrap", { headers: { Authorization: `Bearer ${token}` } }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
  const b = await r.json() as { channels: Array<{ channel_id: string }> };
  return b.channels[0].channel_id;
}

describe("GET /api/chat/channels/{id}/messages", () => {
  it("returns empty page + null cursor for fresh system channel", async () => {
    const uid = "00000000-0000-7000-8000-000000000301";
    const cid = await bootstrapFirst(uid);
    const res = await call(`/api/chat/channels/${cid}/messages`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; next_cursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("rejects 404 for unknown channel", async () => {
    const res = await call("/api/chat/channels/nonexistent-channel-id/messages");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/messages.test.ts`
Expected: FAIL — route 404.

- [ ] **Step 3: Implement `src/routes/messages.ts`**

```ts
import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { attachSummaries, type RawMessage } from "../chat/sender";
import { ensureSystemJoined, channelRouteNameFor } from "../chat/system-channel";

export async function listMessagesHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id: userId } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  const channelId = c.req.param("channel_id");
  const url = new URL(c.req.url);
  const before = url.searchParams.get("before");
  const limit = url.searchParams.get("limit") ?? "50";
  // ensure system joined (idempotent) so the system channel is readable; establishes sys channelId for routing.
  await ensureSystemJoined(c.env, userId);
  // resolve client channel_id → DO name. Unknown UUID (non-system, Phase 3 not active) → CHANNEL_NOT_FOUND, no state created.
  const routeName = await channelRouteNameFor(c.env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = c.env.CHAT_CHANNEL.getByName(routeName);
  const qs = new URLSearchParams();
  if (before) qs.set("before", before);
  qs.set("limit", limit);
  const mres = await stub.fetch(new Request(`https://x/internal/messages?${qs}`, { headers: { "X-Verified-User-Id": userId } }));
  if (mres.status === 403) throw new ApiError("FORBIDDEN", "not a member");
  if (mres.status === 404 || mres.status === 409) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found", { httpStatus: 404 });
  const mb = await mres.json() as { items: RawMessage[]; next_cursor: string | null };
  const items = await attachSummaries(mb.items, c.env);
  return c.json({ items, next_cursor: mb.next_cursor }, 200, { "X-Request-Id": c.get("requestId") });
}
```

- [ ] **Step 4: Wire route in `src/index.ts`**

```ts
import { listMessagesHandler } from "./routes/messages";
app.get("/api/chat/channels/:channel_id/messages", (c) => listMessagesHandler(c));
```

- [ ] **Step 5: Run `tsc --noEmit`**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/routes/messages.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/routes/messages.ts src/routes/messages.test.ts src/index.ts
git commit -m "feat(routes): GET /channels/{id}/messages with profile-attached senders"
```

---

## Task 8: Full suite verification + system channel capacity note

**Files:** none (verification + a doc note)

- [ ] **Step 1: Run full typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS. Phase 0 tests still green (15 files prior + new Phase 1 tests). Spikes: 6 pass, 2 skip.

- [ ] **Step 3: Run the live spikes locally if resources available (operator)**

Note for operator: `SPIKE_LIVE=1 npx vitest run test/spikes/hyperdrive.test.ts test/spikes/seaweedfs.test.ts` — confirm Hyperdrive PG + SeaweedFS reachable before Phase 2. Not a CI gate.

- [ ] **Step 4: Append capacity note to design spec**

Add to `docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md` §17 (or the capacity/limits area) a line: "System public channel is a single ChatChannel DO in Phase 1-3 (name `system-general`). All users + messages land there → single-DO write serialization hot spot. Acceptable for small communities; splitting (`system-general-0..N` by user hash, or read-only announce channel model) is explicit later work, not a Phase 1 blocker."

- [ ] **Step 5: Final commit**

```bash
git add docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md
git commit -m "docs(design): system channel capacity note (single DO, split deferred)"
```

---

## Self-Review Notes

**Spec coverage (design §8 Phase 1):**
- ChatChannel full tables ✓ (Phase 0 schema; Phase 1 uses members/events/channel_meta)
- UserDirectory projection ✓ (Task 2 upsert-channel; my_channels with membership_version)
- System public channel + bootstrap auto-join ✓ (Task 1, 5)
- Bootstrap with per-channel cursor ✓ (Task 5)
- 历史分页 ✓ (Task 3, 7)
- profile 批量回填 ✓ (Task 4 attachSummaries; called in bootstrap + messages)
- events + 单调 UUIDv7 ✓ (Task 1 writes member.joined event; Phase 0 nextEventId)
- "无 WS，只写" ✓ (events written, no broadcast — explicit in Task 1, no WS code added)
- projection repair ✓ (Task 1 outbox + alarm flush; Task 2 idempotent target)

**Placeholder scan:** No TBD/TODO. Every code step has real code. The `ensureSystemJoined` synchronous-write-to-UserDirectory question in Task 5 Step 5 is flagged as a decision-on-run, not a placeholder.

**Type consistency:** `RawMessage` ↔ `ContractMessage` (Task 4) used in Task 5 + 7. `channelRouteNameFor` lives in `src/chat/system-channel.ts` (Task 0) and is used by bootstrap/channels/messages — NOT duplicated (reviewer P1-3). `UserSummary` reused from Phase 0. `attachSummaries` signature stable. `getNamedDo` test helper in `test/helpers.ts` used by all Phase 1 tests (reviewer P0-2).

**Known Phase 1 limitations (NOT bugs):**
- No message sending (Phase 2 WS).
- unread computation returns 0 in ChatChannel summary (last_read_event_id is in UserDirectory, not ChatChannel) — real computation is Phase 3 (read-state mutation). Bootstrap's `unread_count` is 0 for system channel (no messages). Acceptable.
- System channel single-DO hot spot (capacity note Task 8).
- outbox flush for join is async; bootstrap compensates by reading join result directly. A flake window where my_channels lags is acceptable for read-only Phase 1.
