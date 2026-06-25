# Lilium Chat Phase 6 Completion — Public Directory + Join Public Channel (backend)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Phase 6 tail. Deliver the public channel directory read model (`GET /api/chat/channels/directory`) and the join-public-channel HTTP mutation (`POST /api/chat/channels/{channel_id}/join`) on the v4.0 base. The ChannelDirectory DO becomes the read model fed by a new `channel_directory` projection_outbox target; the existing ChatChannel `/internal/join` becomes the join path, gated by `visibility=public_listed` + `status=active`, exposed as an idempotent HTTP endpoint.

**Architecture:** ChannelDirectory is a single global DO (DO name `shared`) holding the `public_channels` table (already created by `migrations/channel-directory.ts`). ChatChannel writes `projection_outbox(target_kind=channel_directory)` rows co-atomically with the business mutations that change a channel's public-directory footprint: create-public, visibility→`public_listed`, title/topic/avatar update while public, member_count delta, dissolve. The ChatChannel alarm flushes them to `ChannelDirectory(shared)/internal/apply-projection`, which upserts/deletes the `public_channels` row. The Worker `GET /api/chat/channels/directory` proxies to `ChannelDirectory(shared)/internal/list`. The Worker `POST /api/chat/channels/:channel_id/join` resolves the route via `channelRouteNameFor`, calls `ChatChannel/internal/join` (already ships the member upsert + `member.joined` event + `user_directory` outbox + `channel_fanout` outbox), wraps the response into the contract `{channel, membership}` shape. Idempotency via `Idempotency-Key` mapped to `operation_id` in a new `idempotency_keys` row inside the ChatChannel join txn (the current `/internal/join` is NOT idempotent at the operation layer — it returns the existing membership if already joined, which is correct behavior, but it has no `idempotency_keys` cache; this plan adds the cache so duplicate `Idempotency-Key` returns the cached full response, matching the other Phase 4+6 mutations).

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), Hono, vitest-pool-workers, jose. No new bindings — `CHAT_CHANNEL`, `CHANNEL_DIRECTORY` both exist.

## Global Constraints

(Phase 0–5 + v4.0 constraints carry forward. Load-bearing for this plan:)

- **No cross-DO 2PC.** ChatChannel writes business + `projection_outbox` row co-atomically; alarm flushes to ChannelDirectory; target write is idempotent; exhausted retries → `dead_letter`. Same pattern as `invite_directory` and `user_directory` outbox targets.
- **Contract route reconciliation.** Contract §1.1 routes table lists `/api/chat/channels/{channel_id}/public-catalog` (incorrect — a global directory has no channel_id). Contract §5.6 body and design spec §6 both specify `GET /api/chat/channels/directory` (no channel_id). **This plan implements `GET /api/chat/channels/directory` as authoritative.** A follow-up contract patch edits §1.1 to match §5.6; that edit is in scope (Task D1).
- **`CHANNEL_DISSOLVED` write-gate** applies to join (every write into ChatChannel). Dissolved channels cannot be joined; returns `409 CHANNEL_DISSOLVED`.
- **Join visibility gate.** `POST /channels/:id/join` only succeeds when `channel_meta.visibility='public_listed'` AND `channel_meta.status='active'` AND `channel_meta.kind='channel'`. Private / `public_unlisted` / DM → `403 FORBIDDEN` (not `CHANNEL_NOT_FOUND`, so the UI can distinguish "exists but private" from "does not exist"). The system channel (`system-general`) is `public_listed` (set at creation in `maybe-create-system`), so it passes the gate — browser join of the system channel is allowed and returns the existing membership (the system channel is auto-joined at first login via `ensureSystemJoined`, so a browser join is an already-active-member no-op). Already-a-member → returns the existing membership (idempotent success, not error).
- **`operation_id` idempotency.** HTTP `Idempotency-Key` ≡ internal `operation_id`. The ChatChannel `/internal/join` handler gains an optional `operation_id` body field; when present, it writes `idempotency_keys(operation='channel.join', operation_id=<operation_id>)` with the full response payload, same shape as Phase 4+6 mutations. Duplicate same-operation_id+same-body → cached full response; different body → `409 IDEMPOTENCY_CONFLICT`. When `operation_id` is absent (legacy/internal callers like `ensureSystemJoined`), the handler keeps the current behavior (no idempotency row, idempotent-by-existing-membership).
- **`projectMessageForBrowser` / `channel_summary` reuse.** The join response's `channel` field is the same `ChannelDetail` projection used by `GET /channels/:id` (built from `channel_meta` + resolved profile + last message). The `membership` field is `{role, joined_at}`. No new serializer.
- **Public directory row shape.** `public_channels` columns: `channel_id, title, avatar_url, member_count, last_message_at, status, updated_at` (already in the migration). The contract §5.6 response shape adds `kind, visibility, role, unread_count, last_read_event_id, last_message_preview` — these are NOT stored in `public_channels`; they are joined at read time:
  - `kind`, `visibility` — fixed to `'channel'` / `'public_listed'` for every row in the directory (the directory only contains public_listed channels, so these are constants; we still return them for shape parity).
  - `role`, `unread_count`, `last_read_event_id` — require the calling user's membership + read-state. **`UserDirectory.my_channels` does NOT store `role`** (schema: `user_id/channel_id/kind/joined_at/left_at/removed_at/status/membership_version/last_read_event_id`); the existing `/my-channels` returns only `{channel_id, kind, last_read_event_id, membership_version}`. So `role` is NOT fetched from UserDirectory. The Worker handler resolves membership in two steps:
    1. `UserDirectory(user_id)/my-channels` (existing, user-directory.ts line 85, pathname `/my-channels` — NOT `/internal/my-channels`) → set of `channel_id` where the caller is an **active** member, plus `last_read_event_id` per channel. This gives `last_read_event_id` (directly) and the membership boolean (channel_id in the active set).
    2. For each directory row whose `channel_id` is in the caller's active set, fetch `role` from `ChatChannel(channel_id)/internal/summary` (existing handler, line 719 of chat-channel.ts). The summary returns `{ my_role, ... }` (line 787 — the field is `my_role`, NOT `role`); the handler reads `summary.my_role`. Batch this as one `summary` fetch per joined channel in the page (worst case 50 fetches; acceptable for a directory list and avoids expanding UserDirectory's projection).
    3. If the caller is not an active member of a row's channel → `role=null, unread_count=0, last_read_event_id=null`.
    4. `unread_count` is set to `0` for all directory rows (computing real unread for arbitrary public channels is expensive and not needed for the discover list; the left rail already shows unread for joined channels). Documented in contract v2.9.
    This keeps `UserDirectory.my_channels` schema unchanged (no Phase 6 migration of user state) and reuses the existing `ChatChannel/internal/summary` which already returns `my_role`.
  - `last_message_preview`, `last_message_at` — stored in `public_channels.last_message_at` (projected); `last_message_preview` is NOT stored (preview text is not in the read model to avoid stale/profanity issues). The Worker handler sets `last_message_preview=null` (the directory UI shows member_count + last_message_at only). A future plan can backfill preview; out of scope here.
- **Do NOT push or deploy.** Commit using the repo default git config.
- **Test config:** `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Typecheck: `npm run typecheck`.
- **Existing endpoints are stable.** This plan ADDS: `ChannelDirectory/internal/apply-projection`, `ChannelDirectory/internal/list`, `ChatChannel` outbox writes for `channel_directory`, ChatChannel alarm `channel_directory` flush branch, `idempotency_keys` in `/internal/join`, Worker routes `GET /channels/directory` + `POST /channels/:id/join`. It MODIFIES: the existing `update-channel` handler (to write `channel_directory` outbox when a public channel's title/topic/avatar changes), the existing `dissolve` handler (to write `channel_directory` outbox with `action=delete`), the existing `create-channel` path (to write `channel_directory` outbox when `visibility=public_listed` at create time). It does NOT rewrite the join member-upsert logic.

---

## File Structure

**Create:**
- `test/do/channel-directory.test.ts` — ChannelDirectory `/internal/apply-projection` upsert/delete idempotency + `/internal/list` pagination + visibility filter (read model only returns `status=active` rows).
- `test/do/chat-channel-public-projection.test.ts` — ChatChannel writes `channel_directory` outbox on: create-public, visibility private→public_listed, public title/topic/avatar update, member_count delta, dissolve. Asserts outbox rows co-atomic with business rows.
- `test/do/chat-channel-join.test.ts` — `POST /internal/join` with `operation_id`: idempotency cache hit, conflict on different body, visibility gate (`private`/`public_unlisted`/`system`/`dissolved` rejections), already-a-member success, dissolved rejection.
- `test/routes/channel-directory.test.ts` — `GET /api/chat/channels/directory` HTTP route: pagination, q filter, merges caller's `role`/`unread_count`/`last_read_event_id` from UserDirectory, shape parity with contract §5.6.
- `test/routes/channel-join.test.ts` — `POST /api/chat/channels/:channel_id/join` HTTP route: idempotency, visibility gate, dissolved, already-member, returns `{channel, membership}`.

**Modify:**
- `src/do/channel-directory.ts` — implement `/internal/apply-projection` (upsert/delete by `channel_id`, idempotent) + `/internal/list` (paginated `LIKE` on title, `status='active'` filter, returns `public_channels` rows).
- `src/do/chat-channel.ts` — add private `insertOutboxRowForChannelDirectory(channelId, action, summary, now)` helper. Call it in:
  - `/internal/create-channel` (createChannel path) when `visibility='public_listed'` (action=`upsert`).
  - `/internal/update-channel` when the channel is currently public OR is becoming public (action=`upsert`); if changing from `public_listed` to `private`/`public_unlisted`, action=`delete`.
  - `/internal/dissolve` (action=`delete`).
  - `/internal/join` and member add/remove/leave paths — only when the channel is public, write an `upsert` with the new `member_count` (cheap; the directory row needs current count). This is a small write amplification but keeps the count fresh; the outbox is co-atomic with the membership txn so no drift.
  - Add `channel_directory` flush branch in `alarm()` mirroring the `invite_directory` branch (target `CHANNEL_DIRECTORY.getByName("shared")`, endpoint `/internal/apply-projection`).
  - Extend `/internal/join` to accept optional `operation_id`; when present, write `idempotency_keys` (operation=`channel.join`) with the full response payload, co-atomic with the member upsert. Pre-check cache before the member logic.
- `src/routes/channel-mutations.ts` — add `listPublicDirectoryHandler` + `joinChannelHandler`.
- `src/index.ts` — register `GET /api/chat/channels/directory` + `POST /api/chat/channels/:channel_id/join`.

**Do NOT touch:** `src/do/user-connection.ts`, `src/do/channel-fanout.ts`, `src/do/user-directory.ts` (read-state floor stays), `src/auth/jwt.ts`, `src/ids/uuidv7.ts`, `src/chat/system-channel.ts` (`channelRouteNameFor` unchanged — join uses optimistic routing by `channel_id` like the other mutations), `src/ws/frames.ts`, wrangler configs.

---

## Section A — ChannelDirectory read model + projection target

### Task A0: Baseline green

**Files:** (none)

- [ ] **Step 1:** Run `npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Expected: clean + green. Record HEAD (`git rev-parse --short HEAD`).

---

### Task A1: ChannelDirectory `/internal/apply-projection` + `/internal/list` + tests

**Files:**
- Modify: `src/do/channel-directory.ts`
- Test: `test/do/channel-directory.test.ts`

**Interfaces:**
- `/internal/apply-projection` (POST): body `{ action: "upsert" | "delete", channel_id, fields: { title, avatar_url, member_count, last_message_at, status }, fields_present: string[] }`. **Every `upsert` carries a FULL snapshot** (P0-3 closure: `public_channels` has `title/member_count/status` as NOT NULL per migration line 12-13; a partial upsert cannot INSERT a valid row, and relying on partial upsert for repair breaks convergence when a row is missing due to dead-letter/reorder). All call sites (create-public, visibility transition, public title/topic/avatar update, member_count delta, `message.send` `last_message_at`, dissolve) MUST read the current complete channel state and project all fields. `fields_present` is kept only to distinguish "explicit null" from "absent" for nullable columns (`avatar_url`, `last_message_at`); it is NOT used to skip required fields. Implementation: `INSERT ... ON CONFLICT(channel_id) DO UPDATE SET title=excluded.title, avatar_url=excluded.avatar_url, member_count=excluded.member_count, last_message_at=excluded.last_message_at, status=excluded.status, updated_at=<now>` — a full-row upsert. For nullable fields where the payload explicitly sets null, include them in `fields_present` so the executor knows the null is intentional (the SET clause always writes `excluded.X`, so `fields_present` is informational here, but kept for forward-compat if a future schema adds optional columns). For `delete`: `DELETE FROM public_channels WHERE channel_id=?`. Idempotent: repeated upsert with same payload yields same row; repeated delete is a no-op. Returns `{ok:true}`.
- `/internal/list` (GET, query `?q=&limit=&cursor=`): returns `{ items: PublicChannelRow[], next_cursor: string | null }` where `PublicChannelRow = { channel_id, title, avatar_url, member_count, last_message_at, status, updated_at }`. Filter `status='active'` always. `q` → `WHERE title LIKE '%' || ? || '%'`. **Sort order (P1-1 closure, authoritative for both backend and frontend):** `ORDER BY COALESCE(last_message_at, updated_at) DESC, channel_id DESC` — most-recently-active first, ties broken by `channel_id` descending. Cursor → opaque base64url of `JSON.stringify({ last_activity: <COALESCE(last_message_at, updated_at)>, channel_id })` (keyset pagination on the same sort tuple). `limit` default 50, max 100.

- [ ] **Step 1: Write failing tests** (`test/do/channel-directory.test.ts`):
  - upsert with a full snapshot inserts a new row (all NOT NULL fields present: title/member_count/status).
  - upsert with a full snapshot on an existing row overwrites all fields (full-row upsert, not partial); a subsequent upsert with different `member_count`/`last_message_at` reflects the latest values.
  - upsert where `avatar_url=null` (in `fields_present`) writes `NULL` to that nullable column (P1-2: explicit null preserved, not old value).
  - upsert where `last_message_at=null` writes `NULL` (e.g. a brand-new public channel with no messages yet).
  - delete removes row; second delete is no-op (200).
  - **repair convergence (P0-3):** a missing row (simulated by `DELETE FROM public_channels`) is restored by the next full-snapshot upsert from any call site (create/update/message.send), because every upsert carries all NOT NULL fields. A `message.send` upsert that only changes `last_message_at` still carries the full `title/avatar_url/member_count/status` snapshot, so it INSERTs a valid row even when the row was previously missing.
  - list returns only `status='active'`; `q` filters by title substring; cursor paginates correctly on the `COALESCE(last_message_at, updated_at) DESC, channel_id DESC` order; limit clamped to 100; rows with null `last_message_at` sort by `updated_at`.
- [ ] **Step 2: Implement** `/internal/apply-projection` + `/internal/list` in `src/do/channel-directory.ts`.
- [ ] **Step 3:** Run `npx vitest run test/do/channel-directory.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/do/channel-directory.ts test/do/channel-directory.test.ts
git commit -m "feat(do): ChannelDirectory apply-projection + list read model"
```

---

### Task A2: ChatChannel `channel_directory` outbox writes + alarm flush branch + tests

**Files:**
- Modify: `src/do/chat-channel.ts`
- Test: `test/do/chat-channel-public-projection.test.ts`

**Interfaces:**
- New private helper `insertOutboxRowForChannelDirectory(channelId, action, summary, nowIso)` where `action: "upsert" | "delete"` and `summary: { title?, avatar_url?, member_count?, last_message_at?, status? }`. Writes `projection_outbox(target_kind='channel_directory', target_key='shared', payload_json=JSON.stringify({action, channel_id, ...summary}))`. Reuses `insertOutboxRow` with `target_kind='channel_directory'`.
- Alarm flush branch: `if (r.target_kind === "channel_directory") { target = this.env.CHANNEL_DIRECTORY.getByName("shared"); res = await target.fetch(new Request("https://x/internal/apply-projection", { method:"POST", headers:{"Content-Type":"application/json"}, body: r.payload_json })); ... }` — mirrors the `invite_directory` branch.

**Call sites to add the outbox write (co-atomic with the existing business txn):**
- `createChannel` (the `POST /internal/create-channel` path, around line 2423): after the `channel_meta` insert, if `body.visibility === 'public_listed'`, write `upsert` with `{title, avatar_url: null, member_count: initial_member_count+1, last_message_at: null, status: 'active'}`.
- `/internal/update-channel`: after the `channel_meta` update, determine visibility transition:
  - if old visibility was `public_listed` and new visibility is `private`/`public_unlisted` → `delete`.
  - if old visibility was non-public and new is `public_listed` → `upsert` with current full summary.
  - if both old and new are `public_listed` → `upsert` with the changed fields (title/topic/avatar).
  - if both non-public → no outbox write.
- `/internal/dissolve`: after `channel_meta.status='dissolved'`, write `delete` (so the directory stops listing it). (Design spec §6 already calls this out; current code does not write it — this plan adds it.)
- `/internal/join` and the member add/remove/leave handlers: only when `channel_meta.visibility='public_listed'`, write `upsert` with the new `member_count` (and current title/avatar/status). For remove/leave/dissolve the count decreases; for join/add it increases.
- `/internal/message-send` (and the edit/recall/delete handlers): only when `channel_meta.visibility='public_listed'`, write an `upsert` carrying a **FULL snapshot** (`title, avatar_url, member_count, status` read from the current `channel_meta`/`members` count, plus `last_message_at=<now>`). Do NOT project `last_message_preview` text (out of scope — contract v2.9 returns `null`). This keeps the directory's "last activity" column fresh AND ensures a missing row is repaired by the next message (P0-3: a `last_message_at`-only partial upsert could not INSERT a valid row because `title/member_count/status` are NOT NULL). On `message.delete`/`message.recall`, do NOT rewind `last_message_at` to an older message — the directory shows last-activity-at, not last-visible-message-at; a deleted message still counts as activity. (Rationale: rewinding requires scanning for the prior message, which is expensive and racy; last-activity is sufficient for the directory sort/display.)

- [ ] **Step 1: Write failing tests** (`test/do/chat-channel-public-projection.test.ts`):
  - create-public writes one `channel_directory` upsert outbox row co-atomic with `channel_meta` insert.
  - create-private writes no `channel_directory` outbox row.
  - update visibility private→public_listed writes `upsert`; public_listed→private writes `delete`; public_listed→public_listed with title change writes `upsert`.
  - dissolve writes `delete` outbox row.
  - join on a public channel writes `upsert` with bumped `member_count`; join on a private channel writes no `channel_directory` outbox.
  - message.send on a public channel writes `upsert` with a FULL snapshot (`title/avatar_url/member_count/status` + `last_message_at=<now>`); message.send on a private channel writes no `channel_directory` outbox. Assert the outbox payload contains all NOT NULL fields, not just `last_message_at`.
  - message.delete/recall on a public channel does NOT rewind `last_message_at` (no outbox write for the timestamp rewind, or a full-snapshot upsert with the same `last_message_at` — either is acceptable as long as it does not go backwards).
  - alarm flush delivers an upsert payload to `ChannelDirectory(shared)/internal/apply-projection` and marks the row `delivered`; a failed delivery bumps retry; after `max_attempts` the row goes to `dead_letter`; re-running the alarm with a fresh outbox row for the same `channel_id` succeeds and `apply-projection` is idempotent so the directory row converges (repair/reconciliation coverage).
- [ ] **Step 2: Implement** the helper + call sites + alarm branch in `src/do/chat-channel.ts`.
- [ ] **Step 3:** Run `npx vitest run test/do/chat-channel-public-projection.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts test/do/chat-channel-public-projection.test.ts
git commit -m "feat(do): ChatChannel channel_directory projection outbox + flush"
```

---

## Section B — Join public channel (HTTP + idempotency + visibility gate)

### Task B1: ChatChannel `/internal/join` idempotency + visibility gate + tests

**Files:**
- Modify: `src/do/chat-channel.ts` (`/internal/join` handler, around line 619)
- Test: `test/do/chat-channel-join.test.ts`

**Behavior changes to `/internal/join`:**
- Accept optional body field `operation_id: string`. When present, all idempotency operations are **principal-scoped** (P0-2 closure): `principal_kind='user'`, `principal_id=<caller user_id>` (from `X-Verified-User-Id`), `operation='channel.join'`, `operation_id=<operation_id>`. This matches the existing `idempotency_keys` schema (PK = `principal_kind, principal_id, operation, operation_id`) and the existing `message.send`/`message.edit`/`channel.owner_transfer` handlers (chat-channel.ts lines 213/252/426/1290/1517/1635). Never query or insert without `principal_kind='user' AND principal_id=?`.
- Pre-check (when `operation_id` present): `SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.join' AND operation_id=?`. If hit and `request_hash` matches the current request hash → return cached `response_json` (200). If hit and `request_hash` differs → `409 IDEMPOTENCY_CONFLICT`. Compute `request_hash` from `{user_id, channel_id}` (the only body fields that matter for join).
- **All three success branches write the idempotency row (P0-3 closure):** fresh join, rejoin (left/removed), and already-active-member no-op. The no-op branch MUST write the row so that a retry of the same `operation_id` after the user later leaves does NOT become a real rejoin mutation. The cached `response_json` stores the raw internal response `{ channel_id, membership_version, joined_at, role }` (see P0-4 for `role`). The Worker re-inflates `ChannelDetail` fresh on each call (rationale: `ChannelDetail` goes stale on title/avatar changes; the idempotency guarantee is on the membership mutation identity + role, not the channel snapshot). This is documented as a join-specific exception in contract Task D1: the cached response is the membership result; the `channel` field is re-inflated and may differ in transient fields (title/avatar) but the `membership` is stable.
  - `request_hash` for the already-active-member no-op is still `{user_id, channel_id}` — the same as a fresh join. The differentiator is the existing membership state at execution time, not the request body. A retry with the same `operation_id` always returns the cached no-op result (even if the user later left), because the operation was committed as a no-op at first call. This is the correct idempotency semantics: the operation result is frozen at first execution.
- `expires_at`: set to `now + 24h` (matches the existing `message.send`/`owner_transfer` idempotency expiry convention).
- Visibility gate (NEW — current code joins regardless of visibility): before the member upsert, check `channel_meta.visibility`. If `!= 'public_listed'` AND the caller is not already a member → `403 FORBIDDEN` with `{error:{code:"FORBIDDEN", message:"channel is not publicly joinable"}}`. Already-a-member bypasses the gate (returns existing membership).
  - **Design decision:** the visibility gate applies **always** (regardless of `operation_id` presence). `ensureSystemJoined` calls `/internal/join` without `operation_id`; the system channel (`system-general`) has `visibility='public_listed'` (set at creation in `maybe-create-system`), so the gate passes and `ensureSystemJoined` still works. Browser join of the system channel is also allowed (it is `public_listed`); since the user is auto-joined at first login, a browser join is an already-active-member no-op returning the existing membership. There is no "system channel → 403" branch. Add a test asserting `ensureSystemJoined` still works after the gate, and a test asserting browser join of the system channel returns 200 (already-member no-op).
- `channel_meta.status='dissolved'` → `409 CHANNEL_DISSOLVED` (current code already does this — keep).
- `channel_meta.kind='dm'` → `403 FORBIDDEN` (DMs are not joinable; no DM creation is exposed yet but defend now).
- **Rejoin semantics (P0-3 closure):** when the caller has an existing `members` row with `left_at IS NOT NULL` (status `left` or `removed`), the handler treats this as a re-join, NOT as the "already-a-member" idempotent branch:
  - The visibility gate still applies (`public_listed` required; a `left`/`removed` user rejoining a private channel → `403 FORBIDDEN`). Rationale: `left`/`removed` means the user is no longer a member, so they must meet the same join precondition as a fresh joiner.
  - The existing member-upsert path runs: `UPDATE members SET joined_at=<now>, left_at=NULL, role='member' WHERE channel_id=? AND user_id=?` (current code line 660–665), bump `member_count`, emit `member.joined` event, write `user_directory` outbox (action=`join`) + `channel_directory` outbox (bumped count), and write the `idempotency_keys` row with the new `joined_at` and `role='member'`. This is a real mutation, not a cached return.
  - The "already-a-member" idempotent branch (return existing `joined_at`, no event, no count bump) applies ONLY when `left_at IS NULL` (active member). **The active-member no-op returns the EXISTING `role`** (read from the `members` row — could be `owner`/`admin`/`member`), NOT a hardcoded `'member'`. This is P0-4: the API must reflect the caller's actual current role.
  - `role` on rejoin is reset to `'member'` (an admin/owner who left and rejoins becomes a member; this matches the current code and the design spec's "join path = member role" rule). If the channel needs to re-promote, that's a separate `PATCH /members/:id` call by an owner.
- **Internal response now carries `role` (P0-4 closure):** the `/internal/join` response body changes from `{ channel_id, membership_version, joined_at }` to `{ channel_id, membership_version, joined_at, role }`. The `role` value:
  - fresh join → `'member'`
  - rejoin (left/removed) → `'member'` (reset)
  - already-active-member no-op → the existing `members.role` value (could be `owner`/`admin`/`member`)
  The Worker `joinChannelHandler` uses this `role` to build `membership.role` (no hardcoded `'member'`). The cached `idempotency_keys.response_json` includes `role` so the cached retry returns the same role.

- [ ] **Step 1: Write failing tests** (`test/do/chat-channel-join.test.ts`):
  - join public_listed channel as non-member → 200, member row inserted, `member.joined` event, `user_directory` outbox, `channel_directory` outbox with bumped count, `idempotency_keys` row (when `operation_id` provided).
  - duplicate same `operation_id` → cached response, no second member row, no second event.
  - duplicate same `operation_id` different `request_hash` → `409 IDEMPOTENCY_CONFLICT`.
  - join private channel as non-member → `403 FORBIDDEN`.
  - join `public_unlisted` channel as non-member → `403 FORBIDDEN`.
  - join dissolved channel → `409 CHANNEL_DISSOLVED`.
  - join `kind='dm'` channel → `403 FORBIDDEN`.
  - already-active-member join (`left_at IS NULL`) → 200, returns existing `joined_at`/`membership_version`/existing `role` (NOT reset to member), no duplicate event, no `member_count` bump, no `member.joined` event, **idempotency_keys row IS written** (P0-3: no-op success must be cached so a later retry after leave does not become a rejoin).
  - already-active-owner join → `role='owner'` in response (P0-4).
  - cached retry of an already-active-member no-op returns the cached `role`/`joined_at` even after the user later leaves (the operation result is frozen at first execution).
  - rejoin as a `left` user (`left_at` set) on a public channel → 200, `joined_at` updated to now, `left_at=NULL`, `role='member'`, `member.joined` event emitted, `member_count` bumped, `user_directory` + `channel_directory` outbox written.
  - rejoin as a `removed` user (`left_at` set) on a public channel → same as `left` rejoin (removed users can rejoin public channels via the join endpoint).
  - rejoin as a `left` user on a private channel → `403 FORBIDDEN` (visibility gate applies to rejoin too).
  - rejoin as a former admin (`left_at` set, prior `role='admin'`) on a public channel → `role` reset to `'member'` (not restored to admin).
  - `ensureSystemJoined` still succeeds (system channel is `public_listed`).
- [ ] **Step 2: Implement** the gate + idempotency cache in `/internal/join`.
- [ ] **Step 3:** Run `npx vitest run test/do/chat-channel-join.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts test/do/chat-channel-join.test.ts
git commit -m "feat(do): ChatChannel /internal/join idempotency + public visibility gate"
```

---

### Task B2: Worker `POST /api/chat/channels/:channel_id/join` route + tests

**Files:**
- Modify: `src/routes/channel-mutations.ts` (add `joinChannelHandler`)
- Modify: `src/index.ts` (register route)
- Test: `test/routes/channel-join.test.ts`

**`joinChannelHandler` flow:**
1. `getIdentity(c)` → `{userId, env}`.
2. `channelId = c.req.param("channel_id")`. `idempotencyKey = c.req.header("Idempotency-Key") ?? ""`. If empty → `400 INVALID_MESSAGE "Idempotency-Key required"` (all mutating HTTP endpoints require it, per Phase 4+6 convention).
3. `routeName = await channelRouteNameFor(env, userId, channelId)`. If `null` → `404 CHANNEL_NOT_FOUND`.
4. `stub = env.CHAT_CHANNEL.getByName(routeName)`.
5. `res = await stub.fetch(new Request("https://x/internal/join", { method:"POST", headers:{"X-Verified-User-Id": userId, "Content-Type":"application/json"}, body: JSON.stringify({ user_id: userId, operation_id: idempotencyKey }) }))`.
6. Map `res.status`: 200 → continue; 403 → `FORBIDDEN`; 409 → parse `{error.code}` → `CHANNEL_DISSOLVED` or `IDEMPOTENCY_CONFLICT`; else → `CHAT_WORKER_UNAVAILABLE`.
7. On 200: `joinBody = await res.json()` → `{channel_id, membership_version, joined_at, role}` (P0-4: `role` comes from the internal response, not hardcoded). Then fetch the full `ChannelDetail` via `stub.fetch("/internal/summary", {headers:{X-Verified-User-Id: userId}})` (existing handler) and resolve profiles via `resolveUserSummaries`. Build `membership = { role: joinBody.role, joined_at: joinBody.joined_at }`. Return `c.json({ channel: detail, membership }, 200, {"X-Request-Id": ...})`.

- [ ] **Step 1: Write failing tests** (`test/routes/channel-join.test.ts`): full HTTP flow for public join (fresh → `membership.role='member'`), private→403, dissolved→409, already-active-member→200 with existing `joined_at` AND existing `role` (assert an already-owner joining returns `membership.role='owner'`, not `'member'`), missing `Idempotency-Key`→400, duplicate `Idempotency-Key`→cached (assert cached `membership.role` matches the first call), rejoin of a `left` former-admin → `membership.role='member'` (reset), response shape `{channel, membership}`.
- [ ] **Step 2: Implement** `joinChannelHandler` + register `app.post("/api/chat/channels/:channel_id/join", ...)` in `src/index.ts`.
- [ ] **Step 3:** Run `npx vitest run test/routes/channel-join.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/routes/channel-mutations.ts src/index.ts test/routes/channel-join.test.ts
git commit -m "feat(routes): POST /api/chat/channels/:channel_id/join"
```

---

## Section C — Public directory HTTP route

### Task C1: Worker `GET /api/chat/channels/directory` route + tests

**Files:**
- Modify: `src/routes/channel-mutations.ts` (add `listPublicDirectoryHandler`)
- Modify: `src/index.ts` (register route)
- Test: `test/routes/channel-directory.test.ts`

**`listPublicDirectoryHandler` flow:**
1. `getIdentity(c)` → `{userId, env}`.
2. Parse query: `q = c.req.query("q") ?? ""`, `limit = clamp(parseInt(c.req.query("limit") ?? "50"), 1, 100)`, `cursor = c.req.query("cursor") ?? null`.
3. `dirStub = env.CHANNEL_DIRECTORY.getByName("shared")`.
4. `res = await dirStub.fetch(new Request("https://x/internal/list?q="+encodeURIComponent(q)+"&limit="+limit+(cursor?"&cursor="+cursor:"")))`.
5. `dirBody = await res.json()` → `{ items: PublicChannelRow[], next_cursor }`.
6. **Membership + read-state merge (two-step, P0-1 closure):**
   a. `udStub = env.USER_DIRECTORY.getByName(userId)`; `udRes = await udStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }))` → existing endpoint (user-directory.ts line 85, pathname `/my-channels` — NOT `/internal/my-channels`) returns `[{ channel_id, kind, last_read_event_id, membership_version }]` for active memberships. Build `activeChannelIds: Set<string>` and `lastReadByChannel: Map<ChatId, ChatId | null>` from this.
   b. For each `item` in `dirBody.items` whose `channel_id` is in `activeChannelIds`: fetch `role` via `ChatChannel(channel_id)/internal/summary` (existing handler, chat-channel.ts line 719 — pass `X-Verified-User-Id: userId`). The summary returns `{ my_role, ... }` (chat-channel.ts line 787 — the field is named `my_role`, NOT `role`; the existing `listChannelsHandler` maps `s.my_role` → browser `role`). Build `roleByChannel: Map<ChatId, ChannelRole>` by reading `summary.my_role`. Run these fetches concurrently with `Promise.all` (worst case `limit` fetches; `limit` max 100, but directory default 50 — acceptable; each is a cheap single-row read).
   c. If a `channel_id` is NOT in `activeChannelIds` → `role=null, last_read_event_id=null`.
7. For each `item` in `items`: build the contract §5.6 row:
   ```json
   {
     "channel_id": item.channel_id,
     "kind": "channel",
     "visibility": "public_listed",
     "title": item.title,
     "avatar_url": item.avatar_url,
     "member_count": item.member_count,
     "role": roleByChannel.get(item.channel_id) ?? null,
     "status": "active",
     "unread_count": 0,
     "last_read_event_id": lastReadByChannel.get(item.channel_id) ?? null,
     "last_message_preview": null,
     "last_message_at": item.last_message_at
   }
   ```
   `unread_count` is set to 0 for all directory rows (see Global Constraints). `last_message_preview` is `null` (not stored).
8. Return `c.json({ items: mergedRows, next_cursor: dirBody.next_cursor }, 200, {"X-Request-Id": ...})`.

### Task C2: UserDirectory — no change needed (P1-3 closure)

**Files:** (none — Task C2 deleted)

The existing `UserDirectory/my-channels` (user-directory.ts line 85, pathname `/my-channels` — NOT `/internal/my-channels`) already returns the active-membership set + `last_read_event_id` that Task C1 needs. `role` is fetched from `ChatChannel/internal/summary` (existing). **No modification to `src/do/user-directory.ts` is required.** The earlier draft's `/internal/my-channels-index` is removed; `user-directory.ts` stays in the "Do NOT touch" list.

### Task C1 (continued): tests + implementation

- [ ] **Step 1: Write failing tests** (`test/routes/channel-directory.test.ts`): pagination, `q` filter, **two-step membership merge** (caller is active member of one listed channel → `role` fetched from that channel's `/internal/summary` field `my_role` + `last_read_event_id` from UserDirectory; non-member → `role=null, last_read_event_id=null`), shape parity with §5.6, `kind='channel'` + `visibility='public_listed'` constants, `last_message_preview=null`, `unread_count=0`. Assert that `UserDirectory/my-channels` is called once (not per-row) and `ChatChannel/internal/summary` is called once per active-member row, and that the handler reads `summary.my_role` (not `summary.role`).
- [ ] **Step 2: Implement** `listPublicDirectoryHandler` + register `app.get("/api/chat/channels/directory", ...)` in `src/index.ts`.
- [ ] **Step 3:** Run `npx vitest run test/routes/channel-directory.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Green.
- [ ] **Step 4:** `npm run typecheck`. Clean.
- [ ] **Step 5:** Commit:
```bash
git add src/routes/channel-mutations.ts src/index.ts test/routes/channel-directory.test.ts
git commit -m "feat(routes): GET /api/chat/channels/directory public catalog"
```

---

## Section D — Contract reconciliation + final verification

### Task D1: Contract §1.1 route table fix + directory row shape documentation

**Files:**
- Modify: `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`

- [ ] **Step 1:** Edit §1.1 routes table: change `GET /api/chat/channels/{channel_id}/public-catalog` → `GET /api/chat/channels/directory` (remove the erroneous `{channel_id}`). Add a revision entry `v2.9 (2026-06-26): Phase 6 tail — public directory + join implemented; §1.1 route corrected to /channels/directory (matches §5.6); directory row shape finalized (last_message_preview=null, unread_count=0, kind/visibility constants); directory sort = COALESCE(last_message_at, updated_at) DESC, channel_id DESC; join idempotency cache exception documented (cached response = membership result {role, joined_at}; the `channel` field is re-inflated per call and may differ in transient fields like title/avatar, but membership is stable — this is a join-specific exception to the v4.0 "cache full ack payload" rule because ChannelDetail is mutable post-join while membership is not); join response `membership.role` reflects the caller's actual current role (owner/admin/member), not a hardcoded 'member'`.
- [ ] **Step 2:** In §5.6, add a note clarifying `last_message_preview=null` and `unread_count=0` in the current implementation, and that `kind`/`visibility` are constants (`channel`/`public_listed`) for directory rows.
- [ ] **Step 3:** Commit:
```bash
git add docs/api-contract/2026-06-22-toolbear-chat-api-contract.md
git commit -m "docs(chat): contract v2.9 — Phase 6 directory route + row shape"
```

---

### Task D2: Full suite green + typecheck

**Files:** (none)

- [ ] **Step 1:** `npm run typecheck`. Clean.
- [ ] **Step 2:** `npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Full suite green (previous count + new tests).
- [ ] **Step 3:** `npx vitest run test/do/channel-directory.test.ts test/do/chat-channel-public-projection.test.ts test/do/chat-channel-join.test.ts test/routes/channel-directory.test.ts test/routes/channel-join.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. All green.
- [ ] **Step 4:** Record final HEAD. No deploy.

---

## Summary of task-body edits the executor makes

- A1: `apply-projection` is a **full-snapshot upsert** (`INSERT ... ON CONFLICT DO UPDATE SET title/avatar_url/member_count/last_message_at/status/updated_at`). Every call site carries all NOT NULL fields so a missing row is always repairable (P0-3). `fields_present` only marks intentional nulls for nullable columns. `delete` is idempotent. `/internal/list` sorts by `COALESCE(last_message_at, updated_at) DESC, channel_id DESC`; cursor is a base64url keyset on that tuple.
- A2: `channel_directory` outbox writes are co-atomic with each business txn (create-public, visibility transition, public title/topic/avatar update, member_count delta on join/add/remove/leave, message.send full-snapshot+last_message_at, dissolve). **Every upsert payload is a full snapshot** (title/avatar_url/member_count/status + the delta field). `message.delete`/`recall` do NOT rewind `last_message_at`. Alarm flush branch mirrors `invite_directory`; dead_letter rows are repairable by any subsequent full-snapshot outbox write since `apply-projection` is idempotent and always INSERTs a valid row.
- B1: visibility gate applies **always**. `ensureSystemJoined` still passes. `kind='dm'` → 403. **Idempotency is principal-scoped** (`principal_kind='user', principal_id=userId`). **All three success branches (fresh/rejoin/active-no-op) write the idempotency row**; cached response includes `role`. Rejoin (`left`/`removed`) is a real mutation (member-upsert, `member.joined`, count bump, `role='member'` reset). Active-no-op returns the EXISTING `role` (could be owner/admin) and writes the row.
- B2: Worker `joinChannelHandler` requires `Idempotency-Key`, calls `/internal/join` with `operation_id`, uses the internal response's `role` for `membership.role` (no hardcoded `'member'`), re-inflates `ChannelDetail` fresh.
- C1: `role` fetched per active-member row from `ChatChannel/internal/summary` field `my_role` (chat-channel.ts line 787 — NOT `role`; existing `listChannelsHandler` also maps `my_role`→browser `role`). Active-membership set + `last_read_event_id` from existing `UserDirectory/my-channels` (user-directory.ts line 85, pathname `/my-channels`). `last_message_preview=null` and `unread_count=0`. `kind='channel'`, `visibility='public_listed'` constants.
- C2: deleted — no `user-directory.ts` change needed.
- D1: contract §1.1 route table corrected to `/channels/directory`; v2.9 revision entry documents the join idempotency cache exception (membership result cached, `channel` re-inflated).

---

## Out of scope

- `last_message_preview` backfill (requires projecting preview text; defer).
- Real `unread_count` for directory rows (current: 0; the left rail already shows unread for joined channels).
- Public directory search beyond `LIKE %q%` on title (no trigram/FTS; defer).
- DM join (DMs are not exposed).
- Frontend UI (separate plan: `2026-06-26-lilium-chat-frontend-phase-f-public-directory.md` in dzmm_archive).
- Phase 7 (bot slash commands + interactions).
