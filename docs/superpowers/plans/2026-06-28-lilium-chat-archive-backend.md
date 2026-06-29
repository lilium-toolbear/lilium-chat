# Lilium Chat — Local PG Archive (Backend Sub-Plan)

> **This is Phase A (backend sub-plan), not the full archive acceptance gate.**
> Full one-shot implementation acceptance requires Phase B (local daemon + PG
> replay) from the same spec. This plan delivers the Worker/DO producer path only;
> Phase B is specified in spec §7–9, §12.2, §12.3 (PG-side), and §13 and must
> ship in the same branch/PR series as Phase B before the archive feature is
> considered complete.
>
> **Phase A scope (this plan):** spec §1–6, §11, backend-relevant §12.1/§12.3/
> §12.4, §14 (backend runbook). Covers transactional `archive_outbox`, Queue
> producer flush, mutation instrumentation, and backend unit/resilience/drift tests.
>
> **Phase B scope (not this plan's tasks, required for full acceptance):** local
> archiver daemon (`scripts/archive-local/`), local PG schema/migration, raw-record
> insert, watermark drain, table replay handlers, `archive:replay`, PG integration
> tests (spec §12.2), and end-to-end drain-to-PG validation (spec §15 items 7–12,
> 15).

Reference spec: `docs/superpowers/specs/2026-06-28-lilium-chat-local-pg-archive-cf-queue.md`
(authoritative for cross-phase contracts; when code and spec disagree, change code
**or** update the spec in the same commit before implementation proceeds).
The spec file must be committed alongside this plan (T1).

---

## 0. Approach & key decisions

### 0.1 What the backend delivers

A transactional archive outbox per source DO + a Cloudflare Queue producer. Every
archived business mutation writes an `archive_outbox` row **in the same SQLite
transaction** as its canonical business rows. A per-DO alarm flushes pending
`archive_outbox` rows to the `lilium-chat-archive` Queue via `sendBatch`. The
local daemon (out of scope here) pulls and replays them.

### 0.2 Separate table, not a new `projection_outbox` target_kind

The existing `projection_outbox` flush (`ChatChannel.flushProjectionOutboxRows`,
`src/do/chat-channel.ts:1296`) targets other DOs over HTTP and marks rows
`status='delivered'`. The archive path targets a **Cloudflare Queue** with
different size/batch rules (§2.5), a different status lifecycle
(`pending` → `queued`/`failed`), and `max_attempts=20`. To avoid coupling the
two retry/size policies, `archive_outbox` is a **separate table** with its own
flush function `flushArchiveOutboxToQueue` and archive-specific
`bumpArchiveRetry`. Both tables share `scheduleNextAlarm` for earliest-due
scheduling; archive flush is **not** routed through `runDueJobs` (§0.4).

### 0.3 `appendArchiveRecordSync` works in both `transactionSync` and `transaction`

Codebase reality (from exploration):
- `ChatChannel` message/channel/membership mutations use **async**
  `ctx.storage.transaction(async () => {...})` (e.g. `message-routes.ts:265`,
  `channel-routes.ts:430`, `membership-routes.ts:462`).
- `ChatChannel` bot mutations + `BotRegistry.commands-sync` use **sync**
  `ctx.storage.transactionSync(() => {...})` (e.g. `chat-channel.ts:911`,
  `bot-registry.ts:241`).
- `UserDirectory` and `DMDirectory` use **async** `transaction()`.
- `BotRegistry.seed-official-bot` uses **bare `sql.exec` (auto-commit)** with no
  explicit transaction wrapper (`bot-registry.ts:551–694`).

`appendArchiveRecordSync(ctx, input)` performs only sync `ctx.storage.sql.exec`
calls (SELECT/UPDATE/INSERT on `archive_seq` + `archive_outbox`).
`ctx.storage.sql.exec` participates in whichever transaction is open, so it is
safe inside both `transactionSync` and `transaction` callbacks. This is the
single append entry point called at the **end** of each business transaction,
after all canonical rows + events are written, but before the txn commits.

**`BotRegistry.seed-official-bot` refactor required**: it currently auto-commits
each statement. To satisfy "archive_outbox in the same transaction as business
rows" (spec §1.3, §4.4), wrap its write block in `ctx.storage.transactionSync`
and append the archive record inside it. `BotRegistry.handleSeedOfficialBot` and
any other bare-`sql.exec` bot app/token path must be wrapped the same way.

### 0.4 Alarm wiring without breaking existing behavior

**Do not register `archive_outbox` in `runDueJobs`.** `runDueJobs` executes an
unbounded `SELECT * … ORDER BY due ASC` with no `LIMIT` (`scheduler.ts:47–52`).
Archive backlog can be much larger than `projection_outbox`; loading all due rows
into memory would destabilize DO alarms.

Pattern for every source DO:

1. `runDueJobs` — existing due tables only (`projection_outbox`,
   `pending_attachments`, …).
2. `flushArchiveOutboxToQueue(ctx, queue, { limit: 100, now })` — **direct call**
   from `alarm()`, not via `runDueJobs`. The flush helper owns its own bounded
   `LIMIT` query.
3. `scheduleNextAlarm(ctx, dueTables)` — dueTables array **includes**
   `archive_outbox` (for `MIN(next_attempt_at)` scheduling only; no handler). One
   alarm timestamp covers projection + archive + any other due tables.

Archive flush failure must be caught so it never prevents projection retry
scheduling (spec §4.5).

Per-DO wiring:

- `ChatChannel.alarm()` (`chat-channel.ts:1453`): keep
  `runDueJobs(ctx, now, this.outboxDueTables(handler))` for `projection_outbox`
  only; then `await flushArchiveOutboxToQueue(...)`; then `scheduleOutboxAlarm`
  passing due tables `[projection_outbox, archive_outbox]`.
- `UserDirectory.alarm()` (`user-directory.ts:1155`): keep
  `pending_attachments` in `runDueJobs`; then archive flush; then
  `scheduleNextAlarm` over `[pending_attachments, archive_outbox]`.
- `DMDirectory`: **no alarm today**. Add `alarm()` that calls archive flush +
  `scheduleNextAlarm` over `[archive_outbox]`.
- `BotRegistry`: **no-op alarm today** (`bot-registry.ts:110`). Replace with
  archive flush + `scheduleNextAlarm` over `[archive_outbox]`.

### 0.5 `archive_id` is deterministic, not a UUID

Per spec §4.4: `archive_id` is built from a **per-source-DO** `archive_seq`
counter (separate from `event_seq`). `source_key` is the raw DO name
(`channel_id` / `user_id` / `pair_key` / `"registry"`). Because `pair_key` is
`${user_low}:${user_high}` (contains `:`), **never** build or parse `archive_id`
with naive `split(":")`.

Encoding:

```ts
archive_id = `${source_kind}:${base64url(source_key)}:${source_seq}`
```

`base64url` = standard base64url without padding. `validateArchiveRecord`
reconstructs the expected `archive_id` from `(source_kind, source_key, source_seq)`
and compares for equality — do not parse `archive_id` by splitting on `:`.

### 0.6 `row_version` rule (spec §5.3) — per change, not per record

`row_version` is set **per `ArchiveChange`**, not once for the whole record.

Rules:

- `chat_events` changes: always use that change row's `event_id`.
- All other tables in a **single-event** mutation: use that mutation's
  `event_id`.
- All other tables in a **multi-event** mutation (e.g. `create-channel` emits
  both `channel.created` and `member.joined`): use
  `source_seq:<n>` where `n` is the record's `source_seq`.
- UserDirectory / DMDirectory / BotRegistry (no channel events): always
  `source_seq:<n>`.

Example — `create-channel`: `chat_events` upserts use their respective
`event_id`s; `chat_channels` and `chat_channel_members` upserts use
`source_seq:<n>`.

Because `source_seq` is assigned inside `appendArchiveRecordSync`, callers pass
`buildChanges(sourceSeq)` (§2.2) so `row_version` can reference the assigned seq.

### 0.7 Queue binding type & `sendBatch` shape

`ArchiveQueueMessage = ArchiveRecord`. Env:
`CHAT_ARCHIVE_QUEUE: Queue<ArchiveRecord>`.

`sendBatch` requires `MessageSendRequest[]`, not bare record objects:

```ts
const batch: MessageSendRequest<ArchiveRecord>[] = records.map((record) => ({
  body: record,
  contentType: "json",
}));
await queue.sendBatch(batch);
```

The daemon (Phase B) must accept both object and JSON-string bodies on pull.

### 0.8 Oversized payload fails before business commit

Queue single-message hard limit is 128 KiB; `sendBatch` is capped at 100 messages
or 256 KiB total. Policy: target ≤ 96 KiB, hard reject > 120 KiB.

**`appendArchiveRecordSync` must measure canonical payload byte length after
building the record and before INSERT.** If `> 120 KiB`, throw
`ARCHIVE_RECORD_TOO_LARGE` so the open business transaction rolls back. Never
mark an `archive_outbox` row `failed` for size at flush time — by then the
business txn has already committed and the archive fact would be lost forever.

Transient Queue send failure after a valid-sized record is fine: row stays
`pending` with backoff. Deterministic oversize is a business-path error.

### 0.9 Testability: flush helper takes the queue as a direct param

`flushArchiveOutboxToQueue(ctx, queue, opts?)` — matches spec §4.6. The DO
passes `this.env.CHAT_ARCHIVE_QUEUE`; unit tests pass a **fake queue** recording
`sendBatch`/`send` calls.

For the **integration** path (real miniflare queue), `wrangler.test.jsonc`
declares the same producer binding; miniflare materializes a real `Queue`. We do
**not** add a `queue()` push-consumer handler to `src/index.ts` (spec §2.4
forbids a prod push consumer, and we don't need one to test the producer side).

### 0.10 Validation helper lives in the backend

Spec §9 puts message validation in the daemon. We additionally expose a pure
`validateArchiveRecord(record)` in `src/archive/payload.ts` so backend unit
tests can assert shape, and so the flush helper can defensively skip malformed
rows (which should never occur since we build them, but guards against bugs).
This does not remove the daemon's responsibility to re-validate (untrusted
input).

---

## 1. New files

```
src/archive/payload.ts          # ArchiveRecord / ArchiveChange / ArchiveSourceKind types + validateArchiveRecord + canonicalStringify
src/archive/hash.ts             # canonicalStringify (deterministic key order) + sha256Hex(payload) for size/dedup/log
src/archive/source-outbox.ts    # appendArchiveRecordSync(ctx, input) — archive_seq bump + archive_outbox insert
src/archive/queue-flush.ts      # flushArchiveOutboxToQueue + bumpArchiveRetry (archive-specific retry; do not use bumpQueueRetry)
src/archive/source-key.ts       # sourceKeyFor(doName) helpers + ARCHIVE_TABLE_WHITELIST + RUNTIME_TABLE_BLACKLIST (for drift tests)
docs/superpowers/specs/2026-06-28-lilium-chat-local-pg-archive-cf-queue.md  # the spec itself (commit it)
docs/superpowers/plans/2026-06-28-lilium-chat-archive-backend.md             # this plan
```

> `src/archive/hash.ts` and `canonicalStringify`: the spec lists `hash.ts` but
> doesn't pin its use. We use `canonicalStringify` for the stored `payload_json`
> and for the 120 KiB / 240 KiB size checks (byte length must be on the
> canonical form, not an arbitrary re-serialization). `sha256Hex` is available
> for structured logging/dedup; no archive_outbox column depends on it.

---

## 2. Shared archive helpers — detailed contracts

### 2.1 `src/archive/payload.ts`

Types exactly per spec §4.3 (`ArchiveSourceKind`, `ArchiveChange` union of
`upsert`/`delete`/`replace_scope`, `ArchiveRecord` with
`format: "lilium.chat.archive.record.v1"`). Plus:

- `ArchiveQueueMessage = ArchiveRecord` (re-exported for the Env type).
- `canonicalStringify(record): string` (delegates to `hash.ts`).
- `ARCHIVE_FORMAT = "lilium.chat.archive.record.v1"`.
- `encodeArchiveId(sourceKind, sourceKey, sourceSeq): string` — builds
  `${source_kind}:${base64url(source_key)}:${source_seq}` (§0.5).
- `validateArchiveRecord(record): { ok: true } | { ok: false; error: string }`
  implementing spec §9 rules: format; `archive_id` equals
  `encodeArchiveId(record.source_kind, record.source_key, record.source_seq)`
  (never `split(":")` on `archive_id`); `source_kind` in allowed set; non-empty
  `source_key`; positive-int `source_seq`; valid `occurred_at`; non-empty
  `changes`; every `table` in `ARCHIVE_TABLE_WHITELIST`; every `op` in
  `{upsert,delete,replace_scope}`; required `pk`/`scope` present.
- `ARCHIVE_TABLE_WHITELIST`: the normalized target table names from spec §7.5
  (`chat_channels`, `chat_channel_members`, … `chat_interactions`). This is the
  single source of truth for "tables that may appear in a payload".
- `RUNTIME_TABLE_BLACKLIST`: spec §3.6 / §12.4 list (`live_sessions`,
  `fanout_queue`, `projection_outbox`, `idempotency_keys`, `rate_buckets`,
  `event_seq`, …). Used by drift tests.

### 2.2 `src/archive/source-outbox.ts`

```ts
appendArchiveRecordSync(ctx: DurableObjectState, input: {
  sourceKind: ArchiveSourceKind;
  sourceKey: string;
  occurredAt: string;            // ISO; also used as next_attempt_at
  businessEventIds: string[];     // event_ids touched by this mutation (may be [])
  buildChanges: (sourceSeq: number) => ArchiveChange[];
}): { archive_id: string; source_seq: number }
```

Behavior (spec §4.4), all sync `ctx.storage.sql.exec`:
1. `SELECT last_seq FROM archive_seq WHERE id=1` (the row is seeded by migration).
2. `last_seq + 1` → `source_seq`.
3. `UPDATE archive_seq SET last_seq=? WHERE id=1`.
4. `changes = input.buildChanges(source_seq)` — callers set per-change `row_version`
   using `source_seq` or event ids per §0.6.
5. `archive_id = encodeArchiveId(sourceKind, sourceKey, sourceSeq)`.
6. Build `ArchiveRecord` (`format`, `archive_id`, `source_kind`, `source_key`,
   `source_seq`, `business_event_ids`, `occurred_at`, `changes`).
7. `payload_json = canonicalStringify(record)`.
8. **Size gate (§0.8):** `byteLength = new TextEncoder().encode(payload_json).byteLength`.
   If `> 120 * 1024`, throw `ApiError` / `ARCHIVE_RECORD_TOO_LARGE` (rolls back
   the open business transaction). Do not INSERT.
9. `INSERT INTO archive_outbox (archive_id, source_kind, source_key, source_seq,
   payload_json, status='pending', attempts=0, max_attempts=20, last_error=NULL,
   next_attempt_at=occurredAt, created_at=occurredAt, updated_at=occurredAt)`.
10. Return `{archive_id, source_seq}`.

`UNIQUE(source_kind, source_key, source_seq)` guarantees no duplicate per source
even under re-issue.

### 2.3 `src/archive/queue-flush.ts`

```ts
flushArchiveOutboxToQueue(
  ctx: DurableObjectState,
  queue: Queue<ArchiveRecord>,
  opts?: { limit?: number; now?: string }
): Promise<{ flushed: number; failed: number; remaining: number }>
```

Behavior (spec §4.6, §2.5, §10.1):
1. `SELECT archive_id, source_kind, source_key, source_seq, payload_json FROM
   archive_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY
   source_seq ASC LIMIT ?` (default 100).
2. Parse each `payload_json` to `ArchiveRecord`. Rows that fail
   `validateArchiveRecord` are marked `failed` with `last_error` describing the
   validation error (defensive — should not happen for rows we built).
3. Build batches from valid rows: ≤100 msgs/batch, target ≤240 KiB total
   canonical payload per batch. When adding a message would exceed 240 KiB, flush
   the current batch and start a new one.
4. **No flush-time oversize handling** — oversize records cannot exist in
   `archive_outbox` because `appendArchiveRecordSync` rejects them before commit
   (§0.8).
5. `await queue.sendBatch(batch)` where each entry is
   `{ body: record, contentType: "json" }`.
   - On success: `UPDATE archive_outbox SET status='queued', updated_at=? WHERE
     archive_id IN (...)`. (Rows kept for local inspection; spec §4.7.)
   - On failure: for each affected row, call `bumpArchiveRetry` (§below); keep
     `status='pending'` until max attempts, then `status='failed'`.
6. After flush: if any `status='pending'` rows remain, the caller (alarm)
   re-arms via `scheduleNextAlarm`. Return counts.

**`bumpArchiveRetry`** (in `queue-flush.ts`, not `bumpQueueRetry` from
`retry-backoff.ts`): reuses `computeRetryBackoffMs` only. On retryable failure:
`attempts+1`, `next_attempt_at = now + backoff`, `status='pending'`. When
`attempts >= max_attempts`: `status='failed'`, `last_error=<error>`. Do **not**
write `status='dead_letter'` or `failed_at` — `archive_outbox` has neither
column (`projection_outbox` uses `bumpQueueRetry` + `dead_letter`; archive does
not).

---

## 3. Migrations — add `archive_seq` + `archive_outbox` to the 4 source DOs

For each of `ChatChannel`, `UserDirectory`, `DMDirectory`, `BotRegistry`, add a
new `SqlMigration` (incremented version) with the DDL from spec §4.1 (verbatim;
both tables + both indexes). Do **not** edit baselines.

| DO | Migration module | Current version | New version |
|---|---|---|---|
| ChatChannel | `src/do/migrations/chat-channel.ts` | `2026062602` (line 11) | `2026062803` |
| UserDirectory | `src/do/migrations/user-directory.ts` | `2026062802` (line 9) | `2026062803` |
| DMDirectory | `src/do/migrations/dm-directory.ts` | `1` (line 8) | `2` |
| BotRegistry | `src/do/migrations/bot-registry.ts` | `2` (line 10) | `3` |

Each migration bumps `*_CURRENT_SCHEMA_VERSION` and appends the DDL. The
`archive_seq` row is seeded with `INSERT OR IGNORE INTO archive_seq (id,
last_seq) VALUES (1, 0)` inside the migration (idempotent across re-runs).

The two `archive_outbox` indexes (`idx_archive_outbox_due` on
`(status, next_attempt_at)`; `idx_archive_outbox_source_seq` on `(source_kind,
source_key, source_seq)`) are required for the flush query and for the drift
`UNIQUE` guarantee.

---

## 4. Env, wrangler, typegen

### 4.1 `wrangler.jsonc`

Add top-level `queues.producers` (sibling of `durable_objects`):
```jsonc
"queues": {
  "producers": [{ "binding": "CHAT_ARCHIVE_QUEUE", "queue": "lilium-chat-archive" }]
}
```

### 4.2 `wrangler.test.jsonc`

Add the same `queues.producers` block so the test worker has the binding. (No
`consumers` — we are not a push consumer in test either; unit tests use a fake
queue per §0.8.)

### 4.3 `src/env.ts`

No change needed for the binding — `worker-configuration.d.ts` (generated)
will declare `CHAT_ARCHIVE_QUEUE: Queue<...>`. But the generated `Queue<Body>`
body type defaults to `unknown`/`Json`; to type it as `ArchiveRecord`, add an
augmentation in `src/env.ts`:

```ts
declare global {
  interface Env {
    // existing secrets...
    CHAT_ARCHIVE_QUEUE: Queue<import("./archive/payload").ArchiveRecord>;
  }
}
```

(Clarify: if `wrangler types` already emits `CHAT_ARCHIVE_QUEUE: Queue<unknown>`,
this augmentation narrows the body type. Verify after typegen.)

### 4.4 Regenerate types

`npm run cf-typegen` after editing both wrangler configs. Then `npm run
typecheck`. (`worker-configuration.d.ts` is gitignored; CI regenerates.)

### 4.5 Operator steps (documented, not automated)

Per spec §2.4 / §13, document in the runbook:

**Wrangler config split (do not conflate producer and HTTP pull consumer):**

- `queues.producers` → **in** `wrangler.jsonc` / `wrangler.test.jsonc` (Worker
  sends to Queue).
- HTTP pull consumer → **not** in `wrangler.jsonc`. Do not add `queues.consumers`
  or legacy `type: "http_pull"` to wrangler config. Enable only via operator CLI
  or dashboard.

```bash
npx wrangler queues create lilium-chat-archive \
  --message-retention-period-secs 1209600

# If queue already exists:
npx wrangler queues update lilium-chat-archive \
  --message-retention-period-secs 1209600

npx wrangler queues consumer http add lilium-chat-archive \
  --batch-size 100 \
  --message-retries 100 \
  --visibility-timeout-secs 600
```

Cloudflare no longer supports enabling HTTP pull consumers through Wrangler
config files; the CLI/dashboard step is required.

**Queue retention (Plan B):** operational constraint for daemon **full stop**;
also configure `--message-retries 100` so retry window is maximized. No
source-DO requeue from `queued` rows. Daemon **must not pull** when PG is
unhealthy — otherwise `max_retries` burns before retention (spec §8.5, §10.3).
See spec §4.7 for `pending` / `queued` / `failed` semantics.

---

## 5. Alarm wiring per source DO

> **Reminder:** `archive_outbox` is for `scheduleNextAlarm` MIN scheduling only.
> Archive flush is a direct `flushArchiveOutboxToQueue` call — never a
> `runDueJobs` handler (§0.4).

### 5.1 ChatChannel (`src/do/chat-channel.ts`)

- `outboxDueTables()` (line 627) stays **projection_outbox only** for
  `runDueJobs`.
- `alarm()` (line 1453):
  1. `await runDueJobs(ctx, now, this.outboxDueTables(projectionHandler))`
  2. `await flushArchiveOutboxToQueue(this.ctx, this.env.CHAT_ARCHIVE_QUEUE, { now })`
     — catch/log errors so archive failure never blocks projection retries.
  3. `scheduleOutboxAlarm(now)` — pass due tables
     `[projection_outbox, archive_outbox]` to `scheduleNextAlarm` (archive table
     included for MIN due only).
- Add `archiveOutboxDueTable(): DueTable` — table metadata for scheduling; no
  flush handler attached.

### 5.2 UserDirectory (`src/do/user-directory.ts`)

- `alarm()` (line 1155):
  1. `runDueJobs` for `pending_attachments` only.
  2. `flushArchiveOutboxToQueue`.
  3. `scheduleNextAlarm` over `[pending_attachments, archive_outbox]`.
- Generalize `schedulePendingAlarm` (line 1149) → `scheduleAlarm` with both tables.

### 5.3 DMDirectory (`src/do/dm-directory.ts`)

- Add `alarm()`:
  1. `flushArchiveOutboxToQueue`.
  2. `scheduleNextAlarm(ctx, [archive_outbox])`.
- Add `scheduleArchiveAlarm()`; call at end of dm mutations that append archive rows.

### 5.4 BotRegistry (`src/do/bot-registry.ts`)

- Replace no-op `alarm()` (line 110):
  1. `flushArchiveOutboxToQueue`.
  2. `scheduleNextAlarm(ctx, [archive_outbox])`.
- Add `scheduleArchiveAlarm()`; call after commands-sync / seed-official-bot / token mutations.

> For all four DOs: after appending an archive row inside a mutation txn, call
> the DO's `scheduleArchiveAlarm(now)` (with `respectExistingAlarm: true`) so
> the flush alarm is armed without disturbing any existing alarm.

---

## 6. Mutation instrumentation

For **every** mutation below: build `changes` via `buildChanges(sourceSeq)` (§2.2),
then call `appendArchiveRecordSync(ctx, { sourceKind, sourceKey, occurredAt,
businessEventIds, buildChanges })` **inside the same transaction**, then
`scheduleArchiveAlarm`. One archive record per business transaction (spec §2.5:
never split one txn into multiple records).

`row_version` per change follows §0.6.

`sourceKind` mapping: ChatChannel→`chat_channel`, UserDirectory→`user_directory`,
DMDirectory→`dm_directory`, BotRegistry→`bot_registry`.
`sourceKey` = the DO name (`channel_id` / `user_id` / `pair_key` / `"registry"`).

### 6.1 ChatChannel (`sourceKind="chat_channel"`, `sourceKey=channel_id`)

Tables → normalized archive table names (spec §3.2 / §7.5):
`channel_meta→chat_channels`, `members→chat_channel_members`,
`messages→chat_messages`, `message_edits→chat_message_edits`,
`audit_logs→chat_audit_logs`, `attachments→chat_attachments`,
`message_attachments→chat_message_attachments`,
`message_stickers→chat_message_stickers`, `mentions→chat_mentions`,
`invites→chat_invites`, `events→chat_events`,
`bot_installations→chat_bot_installations`,
`channel_command_bindings→chat_channel_command_bindings`,
`channel_command_names→chat_channel_command_names`,
`command_invocations→chat_command_invocations`, `interactions→chat_interactions`,
`channel_bot_event_subscriptions→chat_channel_bot_event_subscriptions`.

Per-mutation changes (spec §6.1). **`row_version` is per change (§0.6):**
`chat_events` upserts use each row's `event_id`; all other tables in a
single-event mutation use that mutation's `event_id`; multi-event mutations
(e.g. create-channel) use `source_seq:<n>` for non-event tables.

| Route (file:line) | Changes (table: op) |
|---|---|
| create-channel `channel-routes.ts:430` | chat_channels:upsert; chat_channel_members:upsert (creator+initial); chat_events:upsert (channel.created, member.joined) — **multi-event row_version** |
| create-dm `channel-routes.ts:495` | chat_channels:upsert(kind=dm); chat_channel_members:upsert (both); chat_audit_logs:upsert(create_dm); chat_events:upsert(channel.created) |
| update-channel `channel-routes.ts:622` | chat_channels:upsert; chat_events:upsert(channel.updated); chat_audit_logs:upsert if written |
| dissolve-channel `membership-routes.ts:365` | chat_channels:upsert(status=dissolved); chat_channel_members:upsert if mutated; chat_events:upsert(channel.dissolved); chat_audit_logs:upsert if written |
| join `membership-routes.ts:13` | chat_channels:upsert(member_count, membership_version); chat_channel_members:upsert; chat_invites:upsert if used_count changes; chat_events:upsert(member.joined) |
| invites-create `channel-routes.ts:16` | chat_invites:upsert (+ event/audit if current code writes them) |
| invites-accept `channel-routes.ts:166` | chat_channels:upsert; chat_channel_members:upsert; chat_invites:upsert(used_count); chat_events:upsert(member.joined) |
| owner-transfer `membership-routes.ts:228` | chat_channel_members:upsert(affected); chat_channels:upsert(membership_version if changed); chat_events:upsert(member.role_updated); chat_audit_logs:upsert if written |
| members-add `membership-routes.ts:449` | chat_channels:upsert; chat_channel_members:upsert; chat_events:upsert(member.joined) |
| members-remove `membership-routes.ts:571` | chat_channels:upsert; chat_channel_members:upsert(left_at); chat_events:upsert(member.left); chat_audit_logs:upsert if written |
| members-role-update `membership-routes.ts:520` | chat_channel_members:upsert(affected); chat_channels:upsert(membership_version if changed); chat_events:upsert(member.role_updated); chat_audit_logs:upsert if written |
| message-send `message-routes.ts:265` | chat_messages:upsert; chat_mentions:replace_scope{message_id}; chat_attachments:upsert(image copies); chat_message_attachments:replace_scope{message_id}; chat_message_stickers:replace_scope{message_id}; chat_events:upsert(message.created) |
| message-edit `message-routes.ts:418` | chat_messages:upsert(status/text/edited_at); chat_message_edits:upsert; chat_mentions:replace_scope{message_id} if loaded; chat_events:upsert(message.updated) |
| message-recall `message-routes.ts:443` | chat_messages:upsert(status/recalled_at); chat_audit_logs:upsert if written; chat_events:upsert(message.recalled). Do NOT delete archived attachments/stickers. |
| message-delete `message-routes.ts:466` | chat_messages:upsert(status/deleted_at/deleted_by); chat_audit_logs:upsert if written; chat_events:upsert(message.deleted) |
| bot-install `chat-channel.ts:854` | chat_bot_installations:upsert; chat_channel_command_bindings:replace_scope{channel_id,bot_id}; chat_channel_command_names:replace_scope{channel_id,bot_id}; chat_channel_bot_event_subscriptions:replace_scope{channel_id,bot_id}; chat_events:upsert(bot.installed) |
| bot-install-update `chat-channel.ts:1081` | chat_bot_installations:upsert; chat_channel_bot_event_subscriptions:upsert-or-replace_scope{bot_id} if changed; chat_events:upsert(bot.updated) |
| command-binding-update `chat-channel.ts:1178` | chat_channel_command_bindings:upsert; chat_channel_command_names:replace_scope{channel_id,bot_command_id}; chat_events:upsert(command.binding_updated) |
| command-invoke | **Not yet implemented as a ChatChannel route** (UserConnection stub at `user-connection.ts:316`). When implemented: chat_command_invocations:upsert; chat_interactions:upsert if created; chat_events:upsert if visible. **Flag:** track as TODO; instrument when the route lands. |
| interaction-submit | **Not yet implemented.** Same status as command-invoke. **Flag.** |
| bot effect paths (create/update message or interaction) | chat_messages:upsert; chat_interactions:upsert if created; chat_command_invocations:upsert if status changes; chat_events:upsert if visible; chat_audit_logs:upsert if written |

**Implementation note for `replace_scope`**: source logic deletes/rebuilds scoped
child rows (e.g. `DELETE FROM message_attachments WHERE message_id=?` then
re-insert). The archive `replace_scope{message_id}` change must carry the
**final** set of rows after rebuild, so PG can delete+reinsert the scope.

**Message payload rule (spec §5.4):** every message mutation archive record must
include normalized changes for all relevant tables — do **not** rely on
`chat_events.payload_json` for message data.

### 6.2 UserDirectory (`sourceKind="user_directory"`, `sourceKey=user_id`)

| Route (file:line) | Changes |
|---|---|
| attachment-finalize `user-directory.ts:951` | chat_attachments:upsert — **only when finalized or already-finalized and a canonical finalized row is returned**. Columns: attachment_id, owner_user_id, kind, filename, mime_type, size_bytes, width, height, blurhash, storage_key, url, status, created_at (matches `AttachmentRow` in `src/chat/attachment-projection.ts:3`). |
| sticker-save `user-directory.ts:484` | chat_personal_stickers:upsert. If restoring a soft-deleted sticker, `deleted_at=null` in `after`. |
| sticker-delete `user-directory.ts:722` | chat_personal_stickers:upsert with `deleted_at` set (soft delete). |

`UserDirectory` uses async `transaction()` — `appendArchiveRecordSync` is safe
inside it (§0.3).

### 6.3 DMDirectory (`sourceKind="dm_directory"`, `sourceKey=pair_key`)

| Route (file:line) | Changes |
|---|---|
| get-or-create-dm `dm-directory.ts:21` | chat_dm_pairs:upsert(status=creating) — **only if a new row was inserted**. No record when returning an existing row unchanged. |
| complete-dm `dm-directory.ts:52` | chat_dm_pairs:upsert(status=active) — **only if status changed creating→active**. No record if already active. |

### 6.4 BotRegistry (`sourceKind="bot_registry"`, `sourceKey="registry"`)

Slash-catalog alignment: see spec §0.1 (`006_slash_catalog_archive.sql`, `chat_bot_command_names`, removed `chat_bot_event_capabilities`).

| Route (file) | Changes |
|---|---|
| commands-sync | `chat_bot_commands` upsert; `chat_bot_command_aliases` + `chat_bot_command_names` replace_scope `{bot_command_id}` per command in request |
| seed-official-bot | `chat_bot_apps` upsert; `chat_bot_tokens` upsert (**token_hash only**); catalog rows as commands-sync. Wrapped in `transactionSync` + `appendBotRegistryArchive` |
| `/internal/bots-create` | `chat_bot_apps` upsert; optional `chat_bot_tokens` upsert when `issue_initial_token` |
| `/internal/bots-token-create` | `chat_bot_tokens` upsert |
| `/internal/bots-token-revoke` | `chat_bot_tokens` upsert with `revoked_at` (first revoke only) |

Test: `test/routes/bots.test.ts` — `bot create, token create, and revoke append archive_outbox`.

`commands-sync` and all token paths append inside `transactionSync`, then `scheduleArchiveAlarm()`.

---

## 7. Docs (spec §14)

Commit:
- `docs/superpowers/specs/2026-06-28-lilium-chat-local-pg-archive-cf-queue.md` (the spec itself — must exist in repo before implementation).
- A backend runbook section covering:
  - **Wrangler split:** `queues.producers` in `wrangler.jsonc`; HTTP pull consumer
    **not** in wrangler config (operator CLI/dashboard only).
  - Queue setup: explicit wrangler create/update retention + consumer flags
    (spec §2.4, §13).
  - Daemon pull body uses `visibility_timeout` (not `_ms`); env
    `QUEUE_VISIBILITY_TIMEOUT_MS` maps to that field (spec §8.3).
  - Producer binding, source-DO → archive_outbox → Queue flow.
  - **Plan B retention:** retention for full-stop; `--message-retries 100`;
    no requeue from `queued`. **PG health gate:** daemon must not pull when PG
    down (spec §8.5, §10.3).
  - Why source-local outbox is required (§1.3), why no ArchiveRelay DO (§1.4).
  - How to inspect source lag (`SELECT count(*) FROM archive_outbox WHERE status='pending'`).
  - Optional `/internal/archive-outbox-pending` probe (test-gated).
  - What is **not** archived (spec §3.6).
  - Phase B (local daemon + PG) is required for full feature acceptance.

---

## 8. Tests (backend-relevant subset of spec §12)

Run with the load-adjusted command from `CLAUDE.md`:
`npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`.

### 8.1 Unit tests — `test/archive/*.test.ts`

New files under `test/archive/`:
- `payload.test.ts` — `validateArchiveRecord`: valid record passes; bad format
  / bad `archive_id` / unknown `source_kind` / empty `source_key` /
  non-positive `source_seq` / empty `changes` / unknown table / unknown op all
  rejected. `canonicalStringify` is stable across key reordering.
- `source-outbox.test.ts` — `appendArchiveRecordSync`:
  - `archive_seq` increments monotonically across calls in the same DO.
  - `archive_id` is deterministic via `encodeArchiveId` (base64url `source_key`).
  - `buildChanges(sourceSeq)` receives the assigned seq before insert.
  - Payload `> 120 KiB` throws before INSERT; business txn rolls back (no
    `archive_outbox` row).
  - Appending inside `ctx.storage.transactionSync` is atomic with business rows
    (write business row + append in one txn, rollback on simulated failure → no
    archive row).
  - `UNIQUE(source_kind, source_key, source_seq)` holds.
- `queue-flush.test.ts` — `flushArchiveOutboxToQueue` with a **fake queue**:
  - pending rows → `sendBatch` called with `{ body, contentType: "json" }[]`;
    rows marked `queued`.
  - `sendBatch` throws → rows stay `pending`, `attempts+1`,
    `next_attempt_at` backoff set via `bumpArchiveRetry`; `attempts>=max_attempts`
    → `status='failed'` (not `dead_letter`).
  - `sendBatch` never exceeds 100 messages.
  - `sendBatch` total payload ≤ 240 KiB target (split into multiple batches).
  - default limit 100.

### 8.2 Resilience tests — `test/archive/resilience.test.ts`

- Queue `sendBatch` failure does **not** fail the business mutation (mutation
  returns success; archive_outbox row stays `pending`).
- Duplicate `appendArchiveRecordSync` with same source_seq is rejected by the
  UNIQUE constraint (does not duplicate).
- Runtime tables (`live_sessions`, `projection_outbox`, `idempotency_keys`,
  `rate_buckets`, `event_seq`, …) never appear in any produced payload — assert
  by driving representative mutations and inspecting the appended
  `archive_outbox.payload_json`.

### 8.3 Drift / static tests — `test/archive/drift.test.ts`

- Assert no table name in `ARCHIVE_TABLE_WHITELIST` equals or starts with any
  `RUNTIME_TABLE_BLACKLIST` entry (spec §12.4).
- For each source DO migration module, enumerate its business tables and assert
  each is either in the archive scope (§3.2–§3.5) or in an explicit
  exclusion set with a reason. This is a static table over the migration
  `BASELINE_SCHEMA` + migrations — keeps the plan honest as schemas evolve.
- Assert every ChatChannel mutation route listed in §6.1 has a call site that
  invokes `appendArchiveRecordSync` (grep/static check), so an un-instrumented
  new route fails CI.

### 8.4 Phase B (local daemon + PG) — out of this plan, required for full acceptance

Tracked in spec §7–9, §12.2, §13, §15 (items 7–12, 15). Phase A must not block
on Phase B, but **the archive feature is not shippable until Phase B lands** in
the same implementation series:

- PG raw insert idempotency, watermark init, ordered drain, out-of-order replay
- upsert/replace_scope `source_seq` guards, duplicate-delivery-into-PG
- drain-to-PG integration flow (spec §12.2), `archive:replay` (spec §8.8)
- daemon PG health gate before pull (spec §8.5); queue pull `visibility_timeout` smoke test

---

## 9. Task ordering (checkboxes)

Execute in order; after each task run `npm run typecheck` + the load-adjusted
vitest command.

```
[ ] T1  Commit the spec doc (docs/superpowers/specs/2026-06-28-...md) + this plan.
[ ] T2  Add queues.producers CHAT_ARCHIVE_QUEUE to wrangler.jsonc + wrangler.test.jsonc.
[ ] T3  npm run cf-typegen; augment src/env.ts to type CHAT_ARCHIVE_QUEUE: Queue<ArchiveRecord>.
[ ] T4  src/archive/payload.ts (types, encodeArchiveId, ARCHIVE_TABLE_WHITELIST, RUNTIME_TABLE_BLACKLIST, validateArchiveRecord) + src/archive/hash.ts.
[ ] T5  src/archive/source-outbox.ts (appendArchiveRecordSync with buildChanges + commit-time size gate) + unit tests.
[ ] T6  src/archive/queue-flush.ts (flushArchiveOutboxToQueue, bumpArchiveRetry, sendBatch [{body,contentType}]) + unit tests.
[ ] T7  Add archive_seq/archive_outbox migration to ChatChannel (ver 2026062803).
[ ] T8  Add same migration to UserDirectory (2026062803), DMDirectory (2), BotRegistry (3).
[ ] T9  ChatChannel: alarm calls flushArchiveOutboxToQueue directly (not runDueJobs); scheduleNextAlarm includes archive_outbox for MIN due only.
[ ] T10 UserDirectory: same pattern — runDueJobs for pending_attachments only; direct archive flush; schedule both tables.
[ ] T11 DMDirectory: add alarm (direct archive flush + scheduleNextAlarm); scheduleArchiveAlarm after dm mutations.
[ ] T12 BotRegistry: replace no-op alarm with direct archive flush + scheduleNextAlarm; wrap seed-official-bot in transactionSync.
[ ] T13 Instrument ChatChannel mutations (§6.1 table) — message/channel/membership routes first, then bot routes.
[ ] T14 Instrument UserDirectory attachment-finalize / sticker-save / sticker-delete (§6.2).
[ ] T15 Instrument DMDirectory get-or-create-dm / complete-dm (§6.3).
[ ] T16 Instrument BotRegistry commands-sync / seed-official-bot / token paths (§6.4).
[ ] T17 Resilience tests (§8.2): queue-failure-isolates-business, duplicate append, runtime-tables-not-archived.
[ ] T18 Drift/static tests (§8.3): whitelist/blacklist disjoint, per-DO table coverage, route-instrumentation grep.
[ ] T19 Backend runbook doc (§7): wrangler producer vs HTTP-pull split, queue setup, flow, lag inspection, Phase B note.
[ ] T20 Final typecheck + full vitest run (load-adjusted); verify no ArchiveRelay DO exists; verify no queue push consumer configured.
```

Dependencies: T4→T5→T6 (helpers first). T7/T8 (migrations) before T9–T12
(alarms) before T13–T16 (instrumentation, which needs the helpers + tables).
T17/T18 last (they assert over instrumented code).

---

## 10. Acceptance criteria (Phase A — backend subset of spec §15)

Phase A (this plan) is accepted when all of:

1. No `ArchiveRelay` DO exists (grep confirms none).
2. `CHAT_ARCHIVE_QUEUE` producer binding present in `wrangler.jsonc` +
   `wrangler.test.jsonc`. No `queues.consumers` or HTTP pull in wrangler config.
3. HTTP pull consumer enablement documented as operator CLI step (§4.5, §7).
4. Spec file committed at
   `docs/superpowers/specs/2026-06-28-lilium-chat-local-pg-archive-cf-queue.md`.
5. All 4 source DOs write `archive_outbox` in the same SQLite transaction as
   business rows (T5 atomicity test + per-mutation instrumentation).
6. All 4 source DO alarms call `flushArchiveOutboxToQueue` directly (not via
   unbounded `runDueJobs` SELECT).
7. Business writes do not synchronously depend on the Queue.
8. Oversized records (`> 120 KiB`) fail in `appendArchiveRecordSync` before
   commit — no flush-time `ARCHIVE_RECORD_TOO_LARGE` → `failed` path.
9. `sendBatch` uses `{ body, contentType: "json" }[]`; respects 100-msg and
   240 KiB batch limits.
10. `bumpArchiveRetry` uses `status='failed'` at max attempts (not `dead_letter`).
11. `archive_id` uses `base64url(source_key)` encoding; validator reconstructs,
    does not `split(":")`.
12. `buildChanges(sourceSeq)` API used for all instrumentation.
13. Runtime state (§3.6) never appears in a payload (drift + resilience tests).
14. Every listed mutation path in §6.1–§6.4 is instrumented.
15. `npm run typecheck` passes.
16. Full vitest suite (load-adjusted) passes.

**Full archive feature acceptance** additionally requires Phase B (spec §15 items
7–12, 15): local daemon HTTP pull, PG raw insert before ack, ordered replay,
out-of-order safety, replay repair, and integration drain-to-PG.

---

## 11. Risks & open questions

- **miniflare Queue producer**: confirm `wrangler.test.jsonc` `queues.producers`
  is accepted by `@cloudflare/vitest-pool-workers` at pool startup (like the
  Hyperdrive placeholder caveat in `CLAUDE.md`). If miniflare rejects an
  un-consumed producer, the fallback is to keep the binding in prod config only
  and inject a fake `CHAT_ARCHIVE_QUEUE` into the test env via
  `vitest.config.ts` `miniflare`/`bindings`. **Resolve at T3.**
- **`Queue<ArchiveRecord>` body typing**: confirm `wrangler types` emits the
  binding and whether the `src/env.ts` augmentation narrows or conflicts.
  Resolve at T3; if conflict, type as `Queue<ArchiveRecord>` only in `env.ts`
  and remove from generated if duplicated.
- **`BotRegistry.seed-official-bot` refactor**: wrapping bare `sql.exec` in
  `transactionSync` must not change observable behavior (idempotency, token
  uniqueness). Add a regression test that re-calling seed-official-bot is
  idempotent and does not duplicate tokens/commands.
- **`command-invoke` / `interaction-submit`**: no ChatChannel route exists yet
  (UserConnection returns "unsupported"). This plan instruments them **when they
  land**; until then they are documented TODOs and excluded from the route-
  instrumentation static test via an explicit allowlist.
- **Canonical JSON byte length**: Workers lacks `Buffer`; use
  `new TextEncoder().encode(str).byteLength` for size checks in
  `appendArchiveRecordSync` (commit-time gate, §0.8). Ensure `canonicalStringify`
  is the exact bytes both stored and measured.
- **Archive alarm backlog**: `archive_outbox` must never enter `runDueJobs`
  (unbounded SELECT). Alarm calls `flushArchiveOutboxToQueue({ limit: 100 })`
  directly; only `scheduleNextAlarm` reads `MIN(next_attempt_at)` from
  `archive_outbox`.