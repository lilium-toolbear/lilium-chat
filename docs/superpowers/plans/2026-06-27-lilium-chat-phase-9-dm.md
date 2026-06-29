# Lilium Chat Phase 9 — Direct Message (DM) Backend (`kind="dm"`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement backend support for one-to-one Direct Messages per `docs/plans/2026-06-27-dm-channel-design.md` and `docs/api-contract/2026-06-27-dm-api-contract-addendum.md`. DM is a `ChatChannel` with `channel_meta.kind='dm'` (not a separate message model). Deliver `POST /api/chat/dms` get-or-create, pair uniqueness via new `DMDirectory` DO, `dm.open` idempotency via `UserDirectory(current_user_id)` (mirror `channel-create-coordinate`), viewer-specific `ChannelSummary` projection (`dm_peer`, `title`, `avatar_url`), permission gates returning `409 UNSUPPORTED_CHANNEL_KIND`, and full message/read-state/live reuse on DM channels.

**Architecture:** `UserDirectory(current_user_id)` owns HTTP `Idempotency-Key` idempotency for `operation=dm.open` (same structural reason as `POST /channels` → `/internal/channel-create-coordinate`: `recipient_user_id` is not in the URL). `DMDirectory(pair_key)` owns canonical pair uniqueness and A↔B concurrent get-or-create (`pair_key = min:max` UUID string comparison). `ChatChannel(channel_id)./internal/create-dm` writes `channel_meta` + exactly two `members` rows + audit + `projection_outbox` → both participants' `UserDirectory` (`kind=dm`). **No** `channel_directory` or `invite_directory` projections. Worker inflates viewer-specific `dm_peer` / `title` / `avatar_url` via `resolveUserSummaries` (Hyperdrive); DOs never persist UserSummary. Live `my_channels_changed` reuses existing ChatChannel alarm flush → `UserDirectory/internal/upsert-channel` → `notifyLiveMembershipChanged` → `UserConnection/internal/live-memberships-changed` path (chat-channel.ts lines 3606–3639).

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), Hono, vitest-pool-workers, jose, Hyperdrive (`LILIUM_DB`). New binding: `DM_DIRECTORY`.

## Global Constraints

(Phase 0–8 + v4.0 constraints carry forward. Load-bearing for this plan:)

- **No cross-DO 2PC.** ChatChannel writes business rows + `projection_outbox` co-atomically; per-DO alarm flushes to target DOs; target writes are idempotent; exhausted retries → `dead_letter`. DM creation follows the same outbox pattern as `user_directory` join projections (see `create-channel` at chat-channel.ts ~2653–2668).
- **`UserDirectory(current_user_id)` owns `dm.open` idempotency; `DMDirectory(pair_key)` owns pair uniqueness.** Do not merge these into one DO. A→B and B→A route to different `UserDirectory` instances; only `DMDirectory(pair_key)` converges to one `channel_id`. Same `Idempotency-Key` + different `recipient_user_id` → `409 IDEMPOTENCY_CONFLICT` (detected in `UserDirectory`, not `DMDirectory`).
- **`pair_key` canonical form:** `user_low = min(current_user_id, recipient_user_id)` and `user_high = max(...)` by **dictionary-order UUID string comparison**; `pair_key = \`${user_low}:${user_high}\``. Route: `env.DM_DIRECTORY.getByName(pair_key)`.
- **`POST /dms` response shape:** `channel` MUST be a **full** `ChannelSummary` (all list fields: `unread_count`, `last_read_event_id`, `last_message_preview`, `last_message_at`, `last_event_id`, plus `dm_peer` when `kind=dm`). Cached `idempotency_keys.response_json` stores this full inflated shape. **`POST /dms` must not block on `my_channels` projection flush** — when the row is absent, use list-field defaults (`unread_count=0`, `last_read_event_id=null`, `last_message_*=null`).
- **`/internal/open-dm` response protocol:** discriminated union `OpenDmInternalResponse`: `{ kind: 'cached', response: OpenDmResponse }` (return directly to Browser) or `{ kind: 'needs_inflate', channel_id, joined_at, role }` (Worker inflates → `open-dm-complete`). Completed idempotency replays must hit `cached` path for byte-identical responses.
- **`joined_at` source of truth:** always from idempotent `ChatChannel./internal/create-dm` (`joined_at_by_user`), whether DMDirectory returned `active` or `creating`. Never read `joined_at` from `UserDirectory.my_channels` during `open-dm` (projection may lag).
- **`DMDirectory` mints `channel_id`:** request body to `get-or-create-dm` has no `channel_id` field; only this DO calls `uuidv7()` for new DM channels.
- **Viewer-specific projection at Worker layer only.** `channel_meta.title` / `avatar_url` stay empty for DM. Worker resolves `dm_peer` via `src/profile/resolve.ts` `resolveUserSummaries`. `ChatChannel/internal/summary` may return `dm_peer_user_id` (the other member's UUID) but must NOT call Hyperdrive.
- **DM forbidden mutations → `409 UNSUPPORTED_CHANNEL_KIND`** (`retryable=false`). Not 422. Exception: `GET .../commands` on DM → `200 { "items": [] }`.
- **`npm run cf-typegen`** after any `wrangler.jsonc` / `wrangler.test.jsonc` binding or migration tag change (regenerates gitignored `worker-configuration.d.ts`).
- **Do NOT push or deploy.** Commit using the repo default git config.
- **Test config:** `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Typecheck: `npm run typecheck`.
- **Optimistic routing unchanged.** DM channels use `channelRouteNameFor` → DO name = `channel_id` (system-channel.ts line 32–34). `DMDirectory` is pair-index only, not the message/auth source of truth.

---

## File Structure

**Create:**
- `src/chat/dm-pair.ts` — `canonicalDmPairKey(userA, userB): { pair_key, user_low, user_high }` (pure helper, unit-testable).
- `src/chat/channel-summary.ts` — `inflateChannelSummaryForViewer(summary, viewerUserId, myChannelRow, env)` shared by bootstrap/list/detail/`POST /dms`; adds `dm_peer`, viewer-specific `title`/`avatar_url`, list fields.
- `src/do/dm-directory.ts` — `DMDirectory` DO class (`/ping`, `/internal/get-or-create-dm`, `/internal/schema-version`).
- `src/do/migrations/dm-directory.ts` — `dm_pairs` baseline schema + `migrateDmDirectorySchema`.
- `src/routes/dms.ts` — `openDmHandler` for `POST /api/chat/dms`.
- `test/chat/dm-pair.test.ts` — canonical pair_key ordering tests.
- `test/do/dm-directory.test.ts` — pair get-or-create, concurrent A↔B, `status=creating` resume.
- `test/do/user-directory-open-dm.test.ts` — `dm.open` idempotency (mirror `user-directory-create-coordinate.test.ts`).
- `test/do/chat-channel-create-dm.test.ts` — `create-dm` txn, members, outbox rows, no channel_directory.
- `test/routes/dms.test.ts` — full HTTP `POST /api/chat/dms` flow + error codes.
- `test/routes/channel-summary-dm.test.ts` — bootstrap/list/detail `dm_peer` projection.
- `test/do/chat-channel-dm-gates.test.ts` — `UNSUPPORTED_CHANNEL_KIND` on forbidden mutations.
- `test/do/chat-channel-dm-messages.test.ts` — message.send/edit/recall/mark_read on `kind=dm` (adapt patterns from `chat-channel-message-send.test.ts`).
- `test/routes/channel-directory-dm.test.ts` — directory list never contains DM (regression).
- `test/do/user-connection-dm-commands.test.ts` — WS `command.invoke` / `interaction.submit` → `UNSUPPORTED_CHANNEL_KIND` on DM.

**Modify:**
- `src/errors.ts` — add `INVALID_DM_TARGET` (422), `DM_TARGET_NOT_FOUND` (404), `UNSUPPORTED_CHANNEL_KIND` (409, `retryable=false`).
- `wrangler.jsonc` — `DM_DIRECTORY` binding + migration tag `v3` with `new_sqlite_classes: ["DMDirectory"]`.
- `wrangler.test.jsonc` — `DM_DIRECTORY` binding; add `DMDirectory` to `migrations[].new_sqlite_classes` (keep `SCHEDULER_PROBE` test-only binding separate).
- `src/index.ts` — export `DMDirectory`; register `POST /api/chat/dms`.
- `src/do/user-directory.ts` — `POST /internal/open-dm` (idempotency + orchestration).
- `src/do/chat-channel.ts` — `POST /internal/create-dm`; extend `/internal/summary` with `dm_peer_user_id` when `kind=dm`; `rejectIfDmForChannelManagement()` helper; DM gate on forbidden handlers; DM-specific `message.delete` rule (sender only).
- `src/routes/bootstrap.ts`, `src/routes/channels.ts` — use `inflateChannelSummaryForViewer`.
- `src/routes/channel-mutations.ts` — early DM kind check OR rely on ChatChannel gates (prefer ChatChannel as source of truth).
- `src/routes/bot-installations.ts` — `listChannelCommandsHandler` short-circuit empty list for DM.
- `src/do/user-connection.ts` — `command.invoke` / `interaction.submit` branches with DM kind pre-check (before Phase 7 delegation).
- `src/do/shells.test.ts` — add `["DM_DIRECTORY", "DMDirectory"]`.
- `test/do/sql-migrations.test.ts` — DMDirectory migration smoke (mirror ChannelDirectory block).

**Do NOT touch:** `src/chat/system-channel.ts` routing rules (DM uses `channel_id` DO name like user channels), `src/do/channel-fanout.ts`, `src/auth/jwt.ts`, `src/ids/uuidv7.ts` (reuse `uuidv7()` for new channel_ids), frontend code (Phase DM-3 in dzmm_archive).

---

## Section A — DM-0 baseline / infrastructure

### Task A0: Baseline green

**Files:** (none)

- [ ] **Step 1:** Run `npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Expected: clean + green. Record HEAD (`git rev-parse --short HEAD`).

---

### Task A1: Error codes in `src/errors.ts`

**Files:**
- Modify: `src/errors.ts`

**Interfaces:**
- Add to `HTTP_STATUS_BY_CODE`:
  - `INVALID_DM_TARGET: 422`
  - `DM_TARGET_NOT_FOUND: 404`
  - `UNSUPPORTED_CHANNEL_KIND: 409`
- `UNSUPPORTED_CHANNEL_KIND` is **not** in `RETRYABLE_CODES` (explicit `retryable: false` at throw sites).

- [ ] **Step 1: Write failing test** — add assertions in a new `test/errors/dm-codes.test.ts` (or extend existing errors test if present) that `HTTP_STATUS_BY_CODE.INVALID_DM_TARGET === 422`, `DM_TARGET_NOT_FOUND === 404`, `UNSUPPORTED_CHANNEL_KIND === 409`, and `RETRYABLE_CODES` does not contain `UNSUPPORTED_CHANNEL_KIND`.
- [ ] **Step 2: Implement** the three codes in `src/errors.ts`.
- [ ] **Step 3:** Run `npx vitest run test/errors/dm-codes.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/errors.ts test/errors/dm-codes.test.ts
git commit -m "feat(errors): add DM error codes for phase 9"
```

---

### Task A2: `canonicalDmPairKey` helper + tests

**Files:**
- Create: `src/chat/dm-pair.ts`
- Test: `test/chat/dm-pair.test.ts`

**Interfaces:**
```ts
export function canonicalDmPairKey(userA: string, userB: string): {
  pair_key: string;
  user_low: string;
  user_high: string;
}
```
- Compare UUIDs as strings (`userA < userB` lexicographic).
- `pair_key = `${user_low}:${user_high}``.

- [ ] **Step 1: Write failing tests** (`test/chat/dm-pair.test.ts`):
  - A < B and B < A produce the same `pair_key`.
  - `user_low` / `user_high` ordering is stable.
  - Equal IDs throw or are rejected by caller (open-dm rejects self-DM separately).
- [ ] **Step 2: Implement** `src/chat/dm-pair.ts`.
- [ ] **Step 3:** Run `npx vitest run test/chat/dm-pair.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/chat/dm-pair.ts test/chat/dm-pair.test.ts
git commit -m "feat(chat): canonical DM pair_key helper"
```

---

### Task A3: DMDirectory migration module

**Files:**
- Create: `src/do/migrations/dm-directory.ts`

**Interfaces:**
- `DM_DIRECTORY_CURRENT_SCHEMA_VERSION = 1`
- `DM_DIRECTORY_BASELINE_SCHEMA`:
```sql
CREATE TABLE IF NOT EXISTS dm_pairs (
  pair_key TEXT PRIMARY KEY,
  user_low TEXT NOT NULL,
  user_high TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL,  -- creating | active
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_pairs_channel_id ON dm_pairs(channel_id);
```
- `migrateDmDirectorySchema(ctx)` via `migrateSqlite` (mirror `migrations/channel-directory.ts`).

- [ ] **Step 1: Write failing test** in `test/do/sql-migrations.test.ts` — add DMDirectory block (mirror ChannelDirectory): fresh DO reports `current_version === 1`, `dm_pairs` table exists.
- [ ] **Step 2: Implement** `src/do/migrations/dm-directory.ts`.
- [ ] **Step 3:** Run `npx vitest run test/do/sql-migrations.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/do/migrations/dm-directory.ts test/do/sql-migrations.test.ts
git commit -m "feat(migrations): DMDirectory dm_pairs baseline schema"
```

---

### Task A4: DMDirectory DO skeleton + Wrangler bindings

**Files:**
- Create: `src/do/dm-directory.ts`
- Modify: `wrangler.jsonc`, `wrangler.test.jsonc`, `src/index.ts`, `src/do/shells.test.ts`

**Interfaces:**
- `DMDirectory` class: constructor runs `migrateDmDirectorySchema`; `fetch` handles `/ping` → `{ok:true}`, `handleSchemaVersionRequest`.
- `wrangler.jsonc`: add `{ "name": "DM_DIRECTORY", "class_name": "DMDirectory" }` to `durable_objects.bindings`; add migration `{ "tag": "v3", "new_sqlite_classes": ["DMDirectory"] }`.
- `wrangler.test.jsonc`: add same binding; add `DMDirectory` to migrations (new `v2` tag or extend list — keep `SCHEDULER_PROBE` test-only).
- `src/index.ts`: `export { DMDirectory } from "./do/dm-directory";`
- `src/do/shells.test.ts`: add `["DM_DIRECTORY", "DMDirectory"]`.

- [ ] **Step 1: Write failing test** — `src/do/shells.test.ts` DMDirectory ping (will fail until class exists).
- [ ] **Step 2: Implement** skeleton DO + wrangler + export.
- [ ] **Step 3:** Run `npm run cf-typegen && npm run typecheck`.
- [ ] **Step 4:** Run `npx vitest run src/do/shells.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 5:** Commit:
```bash
git add src/do/dm-directory.ts src/do/migrations/dm-directory.ts wrangler.jsonc wrangler.test.jsonc src/index.ts src/do/shells.test.ts
git commit -m "feat(do): DMDirectory skeleton + DM_DIRECTORY binding"
```

---

## Section B — DM-1 core (DMDirectory + open-dm + POST /dms + create-dm + projection)

### Task B1: DMDirectory `/internal/get-or-create-dm` + tests

**Files:**
- Modify: `src/do/dm-directory.ts`
- Test: `test/do/dm-directory.test.ts`

**Interfaces:**
- `POST /internal/get-or-create-dm` body:
```json
{
  "user_a": "<uuid>",
  "user_b": "<uuid>",
  "created_by": "<uuid>"
}
```
- **Do not** accept `channel_id` in the request body. `DMDirectory` is the sole minter of new DM `channel_id` values (`uuidv7()` inside this DO). UserDirectory and Worker must never mint `channel_id` for DM.
- Returns `{ channel_id, status: "active" | "creating", created: boolean }`.
- Logic (single `storage.transaction` per attempt):
  1. If `dm_pairs` row exists with `status=active` → return existing `channel_id`, `created: false`.
  2. If `status=creating` → return same `channel_id`, `created: false` (resume path).
  3. Else mint `channel_id = uuidv7()`, `INSERT dm_pairs (status=creating)`, return `{ channel_id, status: "creating", created: true }`.
  4. After successful `ChatChannel.createDm` (caller responsibility), caller invokes `POST /internal/complete-dm` body `{ pair_key, channel_id }` that sets `status=active` only when `channel_id` matches (idempotent). **Only call `complete-dm` when this open path actually created the pair row or the row is still `creating`** — if `get-or-create-dm` returned `status=active`, skip `complete-dm`.
- Internal invariant violation (e.g. `dm_pairs` row exists but cannot be read back consistently): log + return 500 (not exposed to Browser). Callers never supply `channel_id`; existing rows are always returned as-is.

- [ ] **Step 1: Write failing tests** (`test/do/dm-directory.test.ts`):
  - First get-or-create inserts `creating` row and returns `channel_id`.
  - Second call same pair returns same `channel_id` (even if first still `creating`).
  - A→B and B→A with swapped `user_a`/`user_b` but same canonical pair_key converge (tests use `canonicalDmPairKey` to compute DO name).
  - `complete-dm` marks `active`; repeat is no-op.
  - Concurrent double-insert simulation: only one `channel_id` wins (use sequential calls in test; true parallel optional).
- [ ] **Step 2: Implement** handlers in `src/do/dm-directory.ts`.
- [ ] **Step 3:** Run `npx vitest run test/do/dm-directory.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/do/dm-directory.ts test/do/dm-directory.test.ts
git commit -m "feat(do): DMDirectory get-or-create-dm pair uniqueness"
```

---

### Task B2: ChatChannel `/internal/create-dm` + tests

**Files:**
- Modify: `src/do/chat-channel.ts`
- Test: `test/do/chat-channel-create-dm.test.ts`

**Interfaces:**
- `POST /internal/create-dm` body:
```json
{
  "channel_id": "<uuid>",
  "user_a": "<uuid>",
  "user_b": "<uuid>",
  "created_by": "<uuid>"
}
```
- Single `storage.transaction` (mirror `create-channel` idempotency guard at line 2625):
  1. If `channel_meta` exists → return cached `{ channel_id, kind, visibility, member_count, status, created_at, updated_at, joined_at_by_user: { [userId]: iso } }` from DB (do not trust request body on retry).
  2. Else `INSERT channel_meta`: `kind='dm'`, `visibility='private'`, `title=''`, `topic=NULL`, `avatar_url=NULL`, `status='active'`, `created_by`, `member_count=2`, `membership_version=1`.
  3. `INSERT members` ×2: both `role='member'` (no owner/admin).
  4. `audit_logs` with `action='channel.create_dm'` (or equivalent existing audit pattern).
  5. `projection_outbox` → `user_directory` for **both** `user_a` and `user_b`: `{ action: "join", channel_id, kind: "dm", membership_version: 1 }`.
  6. **Do not** write `channel_directory` or `invite_directory` outbox rows.
  7. Optional: `channel.created` event without visible `system.notice` (if emitted, set `last_event_id` accordingly in downstream projection).

- [ ] **Step 1: Write failing tests** (`test/do/chat-channel-create-dm.test.ts`):
  - Creates `kind=dm` meta + exactly 2 active members with `role=member`.
  - Idempotent retry returns same meta without duplicate members.
  - Two `user_directory` outbox rows with `kind=dm`.
  - Zero `channel_directory` outbox rows.
  - `title` and `avatar_url` empty/null in `channel_meta`.
- [ ] **Step 2: Implement** `/internal/create-dm` in `src/do/chat-channel.ts`.
- [ ] **Step 3:** Run `npx vitest run test/do/chat-channel-create-dm.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts test/do/chat-channel-create-dm.test.ts
git commit -m "feat(do): ChatChannel create-dm for kind=dm channels"
```

---

### Task B3: UserDirectory `/internal/open-dm` idempotency + tests

**Files:**
- Modify: `src/do/user-directory.ts`
- Test: `test/do/user-directory-open-dm.test.ts`

**Interfaces:**
- Mirror `/internal/channel-create-coordinate` (user-directory.ts lines 185–261):
- `POST /internal/open-dm` header `X-Verified-User-Id` = opener; body:
```json
{
  "idempotency_key": "<Idempotency-Key>",
  "recipient_user_id": "<uuid>"
}
```
- `request_hash = JSON.stringify({ recipient_user_id })`.
- `operation = 'dm.open'`, `operation_id = idempotency_key` in `idempotency_keys` (PK `(operation, operation_id)` — DO already scoped per user).
- Txn 1: idempotency state machine (`cached` / `conflict` / `creating` with reserved `channel_id` optional — **DM does not mint channel_id in UserDirectory**; only DMDirectory mints).
- Before DMDirectory call: validate `recipient_user_id !== current_user_id` → fail idempotency row + return 422 `INVALID_DM_TARGET`.
- Validate UUID format → 422 `INVALID_DM_TARGET`.
- Resolve recipient via `resolveUserSummaries([recipient_user_id], env, opts)` — absent → 404 `DM_TARGET_NOT_FOUND` + fail idempotency row.
- `pair_key = canonicalDmPairKey(current, recipient).pair_key`.
- Orchestration after idempotency reserve (always, whether DMDirectory returned `active` or `creating`):
  1. `DMDirectory(pair_key)./internal/get-or-create-dm` → `{ channel_id, status, created }`.
  2. **Always** call `ChatChannel(channel_id)./internal/create-dm` — idempotent: if `channel_meta` already exists, return existing meta + `joined_at_by_user` from DB (do not trust request body). This is the **source of truth for `joined_at`** when B opens an existing pair created by A; do not read `joined_at` from `UserDirectory.my_channels` projection (may not be flushed yet).
  3. Call `DMDirectory.complete-dm` **only when** step 1 returned `status=creating` (new pair or crash-resume while still `creating`). Skip when step 1 returned `status=active`.
- **Internal response protocol (discriminated union).** `POST /internal/open-dm` returns one of:
```ts
type OpenDmResponse = {
  channel: ChannelSummary
  membership: { role: 'member'; joined_at: string }
}

type OpenDmInternalResponse =
  | { kind: 'cached'; response: OpenDmResponse }
  | {
      kind: 'needs_inflate'
      channel_id: string
      joined_at: string
      role: 'member'
    }
```
- Txn 1 idempotency: if `status=completed` and `response_json` present → return `{ kind: 'cached', response: JSON.parse(response_json) }` immediately (byte-identical replay path).
- Success path before Worker inflation → return `{ kind: 'needs_inflate', channel_id, joined_at, role: 'member' }` where `joined_at` comes from `create-dm` response `joined_at_by_user[current_user_id]`.
- `POST /internal/open-dm-complete` — body `{ idempotency_key, response_json }` writes `status=completed` + stores full inflated `OpenDmResponse` JSON (same txn pattern as channel-create line 254–258). Worker calls this only on `needs_inflate` path after inflation.
- **Do not** store inflated HTTP response inside `open-dm` itself; Worker owns inflation + complete.

- [ ] **Step 1: Write failing tests** (`test/do/user-directory-open-dm.test.ts`) — mirror `user-directory-create-coordinate.test.ts`:
  - First open creates DM; returns `{ kind: 'needs_inflate', channel_id, joined_at, role: 'member' }`.
  - B opens A after A created pair → same `channel_id`, `joined_at` read from `ChatChannel.create-dm` idempotent path (not from projection).
  - Same key + same recipient after `open-dm-complete` → `{ kind: 'cached', response: <full OpenDmResponse> }` directly from `response_json`.
  - Same key + same recipient while row is `creating` and `response_json` absent → resumes orchestration, returns `needs_inflate`, then completes.
  - Same key + different recipient → `409 IDEMPOTENCY_CONFLICT`.
  - Self-DM → `422 INVALID_DM_TARGET`.
  - Unknown recipient (mock `resolveUserSummaries` via `clientFactory` returning empty map) → `404 DM_TARGET_NOT_FOUND`.
  - A opens B, then B opens A → same `channel_id` (integration across two UserDirectory + one DMDirectory stubs).
- [ ] **Step 2: Implement** `/internal/open-dm` + `/internal/open-dm-complete` in `src/do/user-directory.ts`.
- [ ] **Step 3:** Run `npx vitest run test/do/user-directory-open-dm.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/do/user-directory.ts test/do/user-directory-open-dm.test.ts
git commit -m "feat(do): UserDirectory dm.open idempotency orchestration"
```

---

### Task B4: Viewer-specific `ChannelSummary` inflation + `/internal/summary` dm peer id

**Files:**
- Create: `src/chat/channel-summary.ts`
- Modify: `src/do/chat-channel.ts` (`/internal/summary`)
- Modify: `src/routes/bootstrap.ts`, `src/routes/channels.ts`
- Test: `test/routes/channel-summary-dm.test.ts`

**Interfaces:**
- Extend `/internal/summary` JSON when `kind=dm` and caller is member: add `dm_peer_user_id` (the other active member's `user_id`; SQL: `SELECT user_id FROM members WHERE channel_id=? AND user_id != ? AND left_at IS NULL LIMIT 1`).
- `inflateChannelSummaryForViewer({ summary, viewerUserId, lastReadEventId, env })` returns contract `ChannelSummary`:
  - For `kind=channel`: pass through `title`/`avatar_url`; `dm_peer` omitted/null.
  - For `kind=dm`: `resolveUserSummaries([dm_peer_user_id])`; set `dm_peer`, `title = display_name ?? fallback`, `avatar_url = dm_peer.avatar_url`, `role = 'member'`.
  - Always include list fields: `unread_count` (0 for now, matching bootstrap.ts line 105), `last_read_event_id`, `last_message_preview`, `last_message_at`, `last_event_id`.

- [ ] **Step 1: Write failing tests** (`test/routes/channel-summary-dm.test.ts`):
  - Helper unit test: given mock summary + profile map, inflation sets `dm_peer` and viewer-specific title.
  - HTTP `GET /channels/:id` on DM returns `dm_peer` for viewer (route test with seeded DM).
- [ ] **Step 2: Implement** `channel-summary.ts`, summary extension, wire bootstrap + list + detail handlers.
- [ ] **Step 3:** Run `npx vitest run test/routes/channel-summary-dm.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/chat/channel-summary.ts src/do/chat-channel.ts src/routes/bootstrap.ts src/routes/channels.ts test/routes/channel-summary-dm.test.ts
git commit -m "feat(routes): viewer-specific DM ChannelSummary inflation"
```

---

### Task B5: Worker `POST /api/chat/dms` route + tests

**Files:**
- Create: `src/routes/dms.ts`
- Modify: `src/index.ts` (register before catch-all `app.all("/api/chat/*", ...)`)
- Test: `test/routes/dms.test.ts`

**`openDmHandler` flow** (mirror `createChannelHandler` in channel-mutations.ts lines 16–54):
1. `getIdentity(c)` → `{ userId, env }`.
2. `idempotencyKey = c.req.header("Idempotency-Key")`; empty → `400 INVALID_MESSAGE` "Idempotency-Key required".
3. Parse `{ recipient_user_id }`; missing → `422 INVALID_DM_TARGET`.
4. `recipient_user_id === userId` → `422 INVALID_DM_TARGET` (Worker fast-path optional; DO also enforces).
5. `dirStub = env.USER_DIRECTORY.getByName(userId)`.
6. `res = await dirStub.fetch("/internal/open-dm", { idempotency_key, recipient_user_id })`.
7. Map errors: 404 → `DM_TARGET_NOT_FOUND`; 409 → `IDEMPOTENCY_CONFLICT`; 422 → `INVALID_DM_TARGET`.
8. Parse `OpenDmInternalResponse`:
   - `kind === 'cached'` → return `response` directly (200). No inflation, no `open-dm-complete`.
   - `kind === 'needs_inflate'` → fetch `ChatChannel(channel_id)/internal/summary`; optionally read `UserDirectory` `my_channels` row for `last_read_event_id` **best-effort only** — **do not block or poll** waiting for projection flush. If row absent, use defaults: `last_read_event_id = null`, `unread_count = 0`, `last_message_preview = null`, `last_message_at = null`, `last_event_id = null`. `inflateChannelSummaryForViewer` merges summary + defaults + profile resolution into full `ChannelSummary`. Build `{ channel, membership: { role, joined_at } }`; call `/internal/open-dm-complete` with full JSON; return 200.

- [ ] **Step 1: Write failing tests** (`test/routes/dms.test.ts`):
  - `POST /dms` happy path returns full `ChannelSummary` with all list fields + `dm_peer` even when `my_channels` projection not yet flushed (defaults for unread/last_message_*).
  - B opens A after A opened B → same `channel_id`; B gets correct `joined_at` from ChatChannel source-of-truth.
  - Missing `Idempotency-Key` → 400.
  - Self-DM → 422 `INVALID_DM_TARGET`.
  - Same Idempotency-Key + same recipient after completed → Worker returns cached full response directly (`kind=cached` path); byte-identical `channel` object.
  - Same Idempotency-Key + same recipient while `creating`/no `response_json` → resumes, inflates, completes, then subsequent retry hits cached path.
- [ ] **Step 2: Implement** `openDmHandler` + `app.post("/api/chat/dms", ...)`.
- [ ] **Step 3:** Run `npx vitest run test/routes/dms.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/routes/dms.ts src/index.ts test/routes/dms.test.ts
git commit -m "feat(routes): POST /api/chat/dms get-or-create DM"
```

---

### Task B6: Projection flush + live `my_channels_changed` verification

**Files:**
- Test: extend `test/routes/dms.test.ts` or `test/do/user-connection-live-start.test.ts`

**Behavior:** `create-dm` outbox rows flush via existing ChatChannel `alarm()` → `UserDirectory/internal/upsert-channel` → `notifyLiveMembershipChanged` (chat-channel.ts ~3639). Recipient online session receives `user_event` `my_channels_changed` (user-connection.ts ~737).

- [ ] **Step 1: Write failing test:**
  - User A opens DM with B; poll UserDirectory(B)/my-channels until `kind=dm` row appears.
  - With B's `UserConnection` live session open, assert WS receives `my_channels_changed` after outbox flush (poll alarm on ChatChannel stub — pattern from `user-connection-live-start.test.ts`).
- [ ] **Step 2:** Ensure `create-dm` outbox payload uses `action: "join"` so `notifyLiveMembershipChanged` reason = `channel_joined` (existing `liveMembershipReason`).
- [ ] **Step 3:** Run `npx vitest run test/routes/dms.test.ts test/do/user-connection-live-start.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add test/routes/dms.test.ts test/do/user-connection-live-start.test.ts src/do/chat-channel.ts
git commit -m "test(dm): verify my_channels projection and live hint"
```

---

## Section C — DM-2 message chain + permission gates

### Task C1: `rejectIfDmChannelManagement` helper + ChatChannel gates

**Files:**
- Modify: `src/do/chat-channel.ts`
- Test: `test/do/chat-channel-dm-gates.test.ts`

**Interfaces:**
- Private helper:
```ts
private dmChannelManagementError(): Response {
  return Response.json(
    { error: { code: "UNSUPPORTED_CHANNEL_KIND", message: "operation not supported for DM channels", retryable: false } },
    { status: 409 },
  );
}
private async requireChannelKindChannel(): Promise<{ ok: true; meta } | { ok: false; response: Response }>
```
- Apply at start of handlers (return 409 when `meta.kind === 'dm'`):
  - `/internal/update-channel`
  - `/internal/dissolve`
  - `/internal/join` (upgrade from current 403 FORBIDDEN at line 751 to **409 UNSUPPORTED_CHANNEL_KIND** per contract)
  - `/internal/members-add`, `/internal/members-update-role`, `/internal/members-remove`
  - `/internal/owner-transfer` (if present)
  - `/internal/bot-install`, `/internal/bot-install-update`, command binding updates

- [ ] **Step 1: Write failing tests** (`test/do/chat-channel-dm-gates.test.ts`):
  - Seed a `kind=dm` channel via `create-dm`.
  - PATCH/update, dissolve, join, members-add, owner-transfer, bot-install each return 409 `UNSUPPORTED_CHANNEL_KIND`.
- [ ] **Step 2: Implement** gates on all listed handlers.
- [ ] **Step 3:** Run `npx vitest run test/do/chat-channel-dm-gates.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts test/do/chat-channel-dm-gates.test.ts
git commit -m "feat(do): UNSUPPORTED_CHANNEL_KIND gates for DM mutations"
```

---

### Task C2: HTTP route-level gate tests (channel-mutations + invites)

**Files:**
- Test: `test/routes/dm-forbidden-mutations.test.ts` (new)
- Modify: `src/routes/channel-mutations.ts` (only if any handler bypasses ChatChannel)

**Endpoints to cover** (contract addendum §4):
- `PATCH /api/chat/channels/{dm_id}`
- `POST .../dissolve`, `.../join`, `.../invites`, `.../members`, `PATCH/DELETE .../members/{user_id}`, `.../owner-transfer`
- `POST .../bot-installations`, `PATCH .../bot-installations/{bot_id}`, `PATCH .../commands/{bot_command_id}`

- [ ] **Step 1: Write failing HTTP tests** using `makeJwt` + seeded DM channel.
- [ ] **Step 2:** Fix any route that maps 403/404 incorrectly; ensure 409 + `UNSUPPORTED_CHANNEL_KIND`.
- [ ] **Step 3:** Run `npx vitest run test/routes/dm-forbidden-mutations.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add test/routes/dm-forbidden-mutations.test.ts src/routes/channel-mutations.ts
git commit -m "test(routes): DM forbidden HTTP mutations return 409"
```

---

### Task C3: `GET .../commands` returns empty list for DM

**Files:**
- Modify: `src/routes/bot-installations.ts` (`listChannelCommandsHandler`)
- Test: assert in `test/routes/dm-forbidden-mutations.test.ts`

**Behavior:** Before calling ChatChannel, fetch summary or meta kind; if `dm` → return `{ items: [] }` with 200 (not 409).

- [ ] **Step 1: Write failing test** — `GET /channels/{dm_id}/commands` → 200 `{ items: [] }`.
- [ ] **Step 2: Implement** short-circuit in `listChannelCommandsHandler`.
- [ ] **Step 3:** Run `npx vitest run test/routes/dm-forbidden-mutations.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/routes/bot-installations.ts test/routes/dm-forbidden-mutations.test.ts
git commit -m "feat(routes): empty commands list for DM channels"
```

---

### Task C4: WS `command.invoke` / `interaction.submit` rejection for DM

**Files:**
- Modify: `src/do/user-connection.ts`
- Test: `test/do/user-connection-dm-commands.test.ts`

**Behavior:** Add explicit branches before the `unsupported command` fallback (user-connection.ts line 302):
```ts
if (frame.command === "command.invoke" || frame.command === "interaction.submit") {
  // fetch kind via ChatChannel/internal/summary or lightweight meta
  if (kind === "dm") {
    sendCommandError(ws, frame.command_id, { code: "UNSUPPORTED_CHANNEL_KIND", message: "...", retryable: false });
    return;
  }
  // Phase 7: delegate to ChatChannel — gate must remain above delegation
}
```
Even before Phase 7 full bot invoke wiring, these branches must exist and reject DM.

- [ ] **Step 1: Write failing tests** with DM channel + WS connection sending `command.invoke` frame.
- [ ] **Step 2: Implement** branches in `webSocketMessage`.
- [ ] **Step 3:** Run `npx vitest run test/do/user-connection-dm-commands.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/do/user-connection.ts test/do/user-connection-dm-commands.test.ts
git commit -m "feat(ws): reject command.invoke on DM channels"
```

---

### Task C5: Admin delete others disabled for `kind=dm`

**Files:**
- Modify: `src/do/chat-channel.ts` (`message.delete` path, line ~384–386)
- Test: extend `test/do/chat-channel-dm-messages.test.ts`

**Behavior:** For `kind=dm`, `message.delete` allows **only sender** (remove owner/admin override even though DM has no owner/admin).

- [ ] **Step 1: Write failing test** — non-sender delete on DM → `FORBIDDEN` (not success).
- [ ] **Step 2: Implement** kind check in delete mutation gate.
- [ ] **Step 3:** Run `npx vitest run test/do/chat-channel-dm-messages.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts test/do/chat-channel-dm-messages.test.ts
git commit -m "fix(do): DM message.delete sender-only"
```

---

### Task C6: Directory never returns DM

**Files:**
- Test: `test/routes/channel-directory-dm.test.ts`

**Behavior:** `create-dm` writes no `channel_directory` outbox; `GET /api/chat/channels/directory` never lists `kind=dm`. Regression test: create DM, assert directory HTTP response items have no DM `channel_id`.

- [ ] **Step 1: Write failing test** (should pass once B2 enforced — write test first anyway).
- [ ] **Step 2:** No code change if B2 correct; else fix stray projection writes.
- [ ] **Step 3:** Run `npx vitest run test/routes/channel-directory-dm.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add test/routes/channel-directory-dm.test.ts
git commit -m "test(routes): public directory excludes DM channels"
```

---

### Task C7: Message chain on DM (send / edit / recall / read-state)

**Files:**
- Test: `test/do/chat-channel-dm-messages.test.ts`
- Reuse patterns from: `test/do/chat-channel-message-send.test.ts`, `test/do/user-connection-message-lifecycle.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `message.send` on DM → event + fanout to both participants.
  - `message.edit` / `message.recall` sender-only success.
  - `channel.mark_read` via UserConnection WS on DM channel.
  - `GET .../messages` and `GET .../events` return data for DM member.
- [ ] **Step 2:** Fix any regressions uncovered (expect none if channel-scoped paths are kind-agnostic).
- [ ] **Step 3:** Run `npx vitest run test/do/chat-channel-dm-messages.test.ts test/do/chat-channel-message-send.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add test/do/chat-channel-dm-messages.test.ts
git commit -m "test(dm): message lifecycle on kind=dm channels"
```

---

### Task C8: Full suite green + typecheck

**Files:** (none)

- [ ] **Step 1:** `npm run typecheck`. Clean.
- [ ] **Step 2:** `npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Full suite green.
- [ ] **Step 3:** `npx vitest run test/chat/dm-pair.test.ts test/do/dm-directory.test.ts test/do/user-directory-open-dm.test.ts test/do/chat-channel-create-dm.test.ts test/routes/dms.test.ts test/routes/channel-summary-dm.test.ts test/do/chat-channel-dm-gates.test.ts test/routes/dm-forbidden-mutations.test.ts test/do/user-connection-dm-commands.test.ts test/do/chat-channel-dm-messages.test.ts test/routes/channel-directory-dm.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. All green.
- [ ] **Step 4:** Record final HEAD. No deploy.

---

## Summary of task-body edits the executor makes

- A1: Three DM error codes in `errors.ts`; `UNSUPPORTED_CHANNEL_KIND` not retryable.
- A2: Pure `canonicalDmPairKey` helper (lexicographic UUID compare).
- A3–A4: `DMDirectory` DO + `dm_pairs` schema + `DM_DIRECTORY` wrangler binding (prod `v3` migration tag) + `cf-typegen`.
- B1: Pair get-or-create + `complete-dm` in `DMDirectory`; no idempotency keys in this DO.
- B2: `create-dm` txn with idempotent guard, two members, dual `user_directory` outbox, no public directory.
- B1: `DMDirectory` mints `channel_id` internally; request body has no `channel_id`.
- B3: `UserDirectory` `dm.open` idempotency mirrors `channel-create-coordinate`; always calls idempotent `create-dm` for `joined_at`; `OpenDmInternalResponse` discriminated union (`cached` vs `needs_inflate`); `open-dm-complete` stores full `response_json`.
- B4: Worker-side `inflateChannelSummaryForViewer`; `internal/summary` exposes `dm_peer_user_id` only (no Hyperdrive in DO).
- B5: `POST /api/chat/dms` returns full `ChannelSummary` + `membership`; does not wait for `my_channels` projection flush (defaults when row absent).
- B6: Reuse existing outbox → live `my_channels_changed` path; poll-based tests.
- C1–C2: All channel management HTTP mutations → 409 on DM; join gate upgraded from 403 to 409.
- C3: `GET commands` → `{ items: [] }` for DM.
- C4: WS invoke/interaction branches reject DM before Phase 7 delegation.
- C5: DM `message.delete` sender-only.
- C6–C7: Directory exclusion + message chain regression tests on DM.

---

## Out of scope

- Frontend DM UI (`dzmm_archive` Phase DM-3).
- `source_channel_id`, privacy settings, blacklist, message request, DM rate limits (Phase DM-4).
- Bot install/invoke on DM beyond rejection gates (v1 bots do not enter DM).
- Bot HTTP 发消息路由（contract v2.17 已移除；DM 上 Bot 消息 mutation 经 WS effects，须返回 `UNSUPPORTED_CHANNEL_KIND`）。
- Merging addendum into main contract v2.13 (docs-only; can land separately).
- Hyperdrive live integration tests (use `clientFactory` injection in unit tests).

---

## Acceptance checklist

(from `docs/plans/2026-06-27-dm-channel-design.md` §8)

```text
[ ] A POST /dms B → 创建 kind=dm channel，双方 member
[ ] B POST /dms A → 返回同一 channel_id
[ ] A 并发两次 POST /dms B → 单一 channel_id
[ ] 同 Idempotency-Key 同 body 重试 → 同响应
[ ] 同 Idempotency-Key 不同 recipient → IDEMPOTENCY_CONFLICT
[ ] POST /dms self → INVALID_DM_TARGET
[ ] POST /dms nonexistent user → DM_TARGET_NOT_FOUND
[ ] DM 出现在双方 GET /channels / bootstrap
[ ] recipient 在线 → my_channels_changed + live resync
[ ] DM 中 message.send fanout 双方
[ ] GET /channels/directory 不含 kind=dm
[ ] PATCH/dissolve/join/invites/members on DM → 409 UNSUPPORTED_CHANNEL_KIND
[ ] GET .../commands on DM -> { items: [] }
[ ] WS command.invoke / interaction.submit on DM -> UNSUPPORTED_CHANNEL_KIND
[ ] POST /bot/channels/{dm_id}/messages — **N/A**（contract v2.17 无此路由）；Bot WS effects on DM → `UNSUPPORTED_CHANNEL_KIND`
[ ] DM 中不能 admin delete 对方消息
[ ] POST /dms 响应含完整 ChannelSummary 列表字段
[ ] ChannelSummary title/avatar/dm_peer 为 viewer-specific 投影
[ ] channel_meta 不持久化对方 display name
```
