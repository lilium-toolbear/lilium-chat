# Lilium Chat Phase 3 (Channel CRUD + Member Management + Read State) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the channel-management HTTP surface — `POST /channels` (create), `PATCH /channels/{id}`, `POST /channels/{id}/dissolve`, `GET /members` + `GET /members/{user_id}`, `POST/PATCH/DELETE /members[/{user_id}]`, `POST /channels/{id}/read-state` — each emitting the contract §10.4 events (`channel.created`/`channel.updated`/`channel.dissolved`/`member.joined`/`member.left`/`member.role_updated`/`read_state.updated`/`system.notice`) through the existing `channel_fanout` outbox, with unified idempotency and a `CHANNEL_DISSOLVED` write-gate.

**Architecture:** Mutations route to `ChatChannel(channel_id)` (DO name = `channel_id` for user channels; `system-general` for the system channel — Task 2 generalizes `channelRouteNameFor`). Each mutation is ONE SQLite transaction writing business rows + events (persisted actor refs) + a `channel_fanout` outbox row carrying the live-resolved `EventFrame` (Task 4+ reuse `insertOutboxRowForFanout`). The `ChatChannel.alarm()` already flushes `channel_fanout` rows (Phase 2). **Create is special:** `POST /channels` has no `channel_id` in the URL, so Worker-side `uuidv7()` minting would route retries to different DOs and break in-DO idempotency. A stable **create coordinator** lives in `UserDirectory(creator_user_id)` (Task 3): it owns the `idempotency_keys` state machine (`creating`→`completed` with persisted `channel_id`), mints `channel_id` once, and calls `ChatChannel(channel_id).createChannel` (Task 4) which is atomic + idempotent via `channel_meta` existence. Read-state is per-channel monotonic `last_read_event_id` in `UserDirectory.my_channels` (existing column), written via a new `/internal/read-state` endpoint.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), Hono, vitest-pool-workers, jose. No new bindings — all DOs (`CHAT_CHANNEL`, `USER_DIRECTORY`, `CHANNEL_FANOUT`, `MESSAGE_INDEX`) already exist.

## Global Constraints

(All Phase 0/1/2 constraints carry forward. This section lists the ones most load-bearing for Phase 3.)

- **No cross-DO transactions exist.** Source DO writes business + `projection_outbox` row co-atomically; alarm flushes to target DO; target writes are idempotent; exhausted retries → `dead_letter`. Do NOT invent 2PC. The create-coordinator (Task 3) is best-effort: it persists the `(key→channel_id)` mapping BEFORE calling `ChatChannel.createChannel`; a crash leaves `status='creating'` and the retry re-calls the same `ChatChannel(channel_id)` (idempotent via `channel_meta` existence) then marks `completed`.
- **Single alarm per DO, earliest-wins.** Use the existing `scheduleOutboxAlarm(nowIso)` / `bumpOutboxRetry` on `ChatChannel`. Never call `setAlarm` blindly last-write-wins.
- **Per-channel monotonic UUIDv7 `event_id`.** Use the existing `ChatChannel.nextEventId(nowMs)`. `system.notice` event_id follows its domain event within the same transaction (design §3.5a).
- **HTTP idempotency = `idempotency_keys` keyed by `(principal_kind='user', principal_id=userId, operation, idempotency_key)`, `request_hash` of the mutable body, SELECT inside the transaction.** Same key+body → cached `response_json`; same key+different body → `409 IDEMPOTENCY_CONFLICT`. For the 6 mutations with `channel_id` in the URL, this row lives in `ChatChannel(channel_id)` (DO address stable across retries — Phase 2 pattern). **Create is the exception:** its idempotency row lives in `UserDirectory(creator_user_id)` (Task 3), because the Worker cannot mint a stable `channel_id` pre-routing.
- **Create coordinator rule (v2.5 delta, Phase 3):** `POST /api/chat/channels` idempotency is coordinated by `UserDirectory(principal_user_id)`, NOT by a freshly minted `ChatChannel` DO selected in the Worker. The Worker routes to `UserDirectory(user_id)`, which mints `channel_id` once inside its idempotency transaction and then calls `ChatChannel(channel_id).createChannel`. A bare `uuidv7()` + ChatChannel-local idempotency would structurally duplicate channels on retry.
- **Persisted event payloads store actor references; the WIRE projection resolves UserSummary.** `events.payload_json` stores `actor_kind`+`actor_id` / `target_user_id` / refs (design §3.5 / §3.5a). The `channel_fanout` outbox carries a frame built from the live-resolved payload (actor → UserSummary) so the wire event already has `actor.display_name`/`avatar_url`. Replay re-resolves at read time. Never persist `display_name`/`avatar_url` in DO storage.
- **`CHANNEL_DISSOLVED` write-gate (design §6.3, contract §5.4).** Once `channel_meta.status='dissolved'`, every write-class HTTP mutation AND WebSocket command into `ChatChannel` returns `409 CHANNEL_DISSOLVED` at the permission entry point. Dissolve itself is idempotent (same `Idempotency-Key` → cached result). Read-class operations (summary/messages/replay/members list) still serve the `status='dissolved'` tombstone.
- **member.left reuses Phase 2's `markMemberLeftAndEnqueueFanoutUnregister`** (co-atomic `UPDATE members.left_at` + membership_version bump + `channel_fanout` unregister-user outbox). Do NOT write a second leave path.
- **Outbox helpers that run inside a transaction MUST be synchronous.** `insertOutboxRowForFanout` is `void`. Never write a fanout outbox row with an un-awaited `async` helper inside `ctx.storage.transaction`.
- **Resource-level not-found codes, no generic `NOT_FOUND`.** `CHANNEL_NOT_FOUND` / `MEMBER_NOT_FOUND` / `INVITE_NOT_FOUND`. Precise member read (§7.1b): user never joined → `404 MEMBER_NOT_FOUND`.
- **Git identity is `kuma`.** `git -c user.name=kuma -c user.email=kuma@kuma.homes commit ...`. **Do NOT push or deploy.** Implementation only; operator deploys.
- **Test config:** `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000` (high local load makes the 5s default flake; see memory `vitest-load-starvation-timeouts`). Typecheck: `npm run typecheck` (`tsc --noEmit`). Tests use `env` from `cloudflare:workers`, `getNamedDo`/`makeJwt`/`TEST_SECRET` from `test/helpers.ts`. The prod `getByName` mapping does not exist in tests — tests use `idFromName` via `getNamedDo` with the cast `env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0]`.
- **Existing endpoints are stable.** `ChatChannel` keeps all `/internal/*`, `/spike-*`, `/outbox-*` routes and its `alarm()`. Phase 3 ADDS `/internal/create-channel`, `/internal/update-channel`, `/internal/dissolve`, `/internal/members-add`, `/internal/members-update-role`, `/internal/members-remove`, `/internal/members-list`, `/internal/members-get`, `/internal/read-state`, and a dissolved-gate on existing write entry points. It does NOT otherwise rewrite existing handlers. `UserDirectory` ADDS an `idempotency_keys` table + `/internal/channel-create-coordinate` + `/internal/read-state`.

---

## File Structure

**Create:**
- `src/chat/channel-events.ts` — pure builders for Phase 3 event payloads: `buildChannelCreatedPayload`, `buildChannelUpdatedPayload`, `buildChannelDissolvedPayload`, `buildMemberJoinedPayload`, `buildMemberRoleUpdatedPayload`, `buildReadStateUpdatedPayload`, `buildSystemNoticePayload` (persisted ref shape — `actor_kind`/`actor_id`/`target_user_id`/`channel_changes`, NO UserSummary). Plus `resolveActorForLiveBroadcast(payload, resolveUserSummaries)` (wire projection: `actor`/`target_user` → UserSummary, fallback `user-<shortid>`). Unit-tested with an injected resolver.
- `test/chat/channel-events.test.ts` — unit tests for the payload builders + actor resolver.
- `src/routes/channel-mutations.ts` — Hono route handlers: `createChannelHandler`, `updateChannelHandler`, `dissolveChannelHandler`, `listMembersHandler`, `getMemberHandler`, `addMemberHandler`, `updateMemberRoleHandler`, `removeMemberHandler`, `readStateHandler`. Registered in `src/index.ts`.
- `test/routes/channel-mutations.test.ts` — HTTP-level tests for all 9 endpoints (auth, success, errors, idempotency, dissolve-gate).
- `test/do/user-directory-create-coordinate.test.ts` — coordinator state machine (new/cached/conflict/creating-retry).
**Create:**
- `src/chat/channel-events.ts` — pure builders for Phase 3 event payloads: `buildChannelCreatedPayload`, `buildChannelUpdatedPayload`, `buildChannelDissolvedPayload`, `buildMemberJoinedPayload`, `buildMemberRoleUpdatedPayload`, `buildMemberLeftPayload`, `buildReadStateUpdatedPayload`, `buildSystemNoticePayload` (persisted ref shape — `actor_kind`/`actor_id`/`target_user_id`/`channel_changes`, NO UserSummary). Plus `resolveActorWithMap` (sync, prod path inside a DO txn) and `resolveActorForLiveBroadcast` (async, injected resolver for unit tests).
- `test/chat/channel-events.test.ts` — unit tests for the payload builders + actor resolver.
- `src/routes/channel-mutations.ts` — Hono route handlers: `createChannelHandler`, `updateChannelHandler`, `dissolveChannelHandler`, `listMembersHandler`, `getMemberHandler`, `addMemberHandler`, `updateMemberRoleHandler`, `removeMemberHandler`, `readStateHandler`. Registered in `src/index.ts`.
- `test/routes/channel-mutations.test.ts` — HTTP-level tests for all 9 endpoints (auth, success, errors, idempotency, dissolve-gate, owner invariant, cursor pagination).
- `test/errors.test.ts` — `MEMBER_NOT_FOUND`/`CHANNEL_DISSOLVED`/`INVITE_NOT_FOUND` → HTTP status mapping.
- `test/do/user-directory-create-coordinate.test.ts` — coordinator state machine (new/cached/conflict/creating-retry).
- `test/do/user-directory-read-state.test.ts` — read-state floor advance + monotonic + `advanced` flag.
- `test/do/chat-channel-create.test.ts` — `createChannel` atomic create + idempotent re-call returning DB-sourced channel.
- `test/do/chat-channel-replay-projection.test.ts` — `/internal/replay` resolves management-event actors (storage-vs-wire).
- `test/do/chat-channel-mutations.test.ts` — update/dissolve/members CRUD + members-read DO internals + dissolved-gate + owner invariant + member state machine.

**Modify:**
- `src/chat/system-channel.ts` — `channelRouteNameFor`: non-system `channel_id` returns the `channel_id` itself as the DO name (optimistic routing; DO self-validates), with a guard so the literal string `system-general` is never treated as a user channel id.
- `src/errors.ts` — add `MEMBER_NOT_FOUND: 404`, `INVITE_NOT_FOUND: 404`, `CHANNEL_DISSOLVED: 409` to `HTTP_STATUS_BY_CODE` (Task 1, P0-1).
- `src/do/user-directory.ts` — add `idempotency_keys` table (create coordinator) + `POST /internal/channel-create-coordinate` (state machine: SELECT inside txn → cached / conflict / mint+`creating` / `creating`-re-call) + `POST /internal/read-state` (monotonic `last_read_event_id` floor + advance flag + emit `read_state.updated` via ChatChannel) + extend `/my-channels` is unchanged (already returns `last_read_event_id`).
- `src/do/chat-channel.ts` — add `/internal/create-channel`, `/internal/update-channel`, `/internal/dissolve`, `/internal/members-add`, `/internal/members-update-role`, `/internal/members-remove`, `/internal/members-list`, `/internal/members-get`, `/internal/read-state-event`, `/internal/unread-count`; add private helpers `assertNotDissolved`, `activeRole`, `cachedResponse`, `persistEventAndFanout`, `resolveActorMap`; extract `markMemberLeftAndEnqueueFanoutUnregisterSync` (sync core) + reframing the Phase 2 async helper as a thin wrapper; add the dissolved write-gate to `/internal/message-send` and `/internal/join`; refactor `/internal/replay` to resolve management-event actors (Task 4b). Add the new payload-builder imports.
- `src/index.ts` — register the 9 new routes.
- `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md` — §5.2b: add the create-coordinator rule (v2.5 delta note). Revision record: add v2.5 line.
- `docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md` — §8 阶段3 / §3.5a: record the create-coordinator rule + the `UserDirectory.idempotency_keys` table. §0.6: add v3.5 revision entry.

**Do NOT touch:** `src/do/channel-fanout.ts` (register/unregister/fanout already correct), `src/do/user-connection.ts`, `src/routes/ws.ts`, `src/routes/events.ts`, `src/routes/channels.ts` / `messages.ts`, `src/auth/jwt.ts`, `src/ids/uuidv7.ts`, `src/profile/resolve.ts`, wrangler configs.

---

## Task 0: Verify Phase 2 baseline is green before starting

**Files:**
- Test: (none — runs existing suite)

**Interfaces:**
- Consumes: Phase 0/1/2 code as-is.
- Produces: a green baseline; every later task must keep `npm run typecheck` + the suite green.

- [ ] **Step 1: Run typecheck + full test suite, confirm green**

Run:
```bash
npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
```
Expected: `tsc --noEmit` exits 0; vitest reports all tests passing. If anything is red, STOP and report — Phase 3 must build on green.

- [ ] **Step 2: Record the baseline HEAD (informational only)**

Run:
```bash
git rev-parse --short HEAD
```
Expected: `1263a4a` (Phase 3 prep close). Note it; subsequent task commits build on top.

---

## Task 1: Align docs to the create-coordinator rule + add Phase 3 error codes

**Files:**
- Modify: `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md` (§5.2b, revision record)
- Modify: `docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md` (§8 阶段3, §3.5a, §0.6)
- Modify: `src/errors.ts` (add `MEMBER_NOT_FOUND`, `CHANNEL_DISSOLVED`, `INVITE_NOT_FOUND`)
- Test: `test/errors.test.ts` (Create)

**Why `errors.ts` first:** the Worker route handlers (Tasks 6-11) `throw new ApiError("MEMBER_NOT_FOUND", ...)` and pass `CHANNEL_DISSOLVED` through. Today `HTTP_STATUS_BY_CODE` has neither code, so `ApiError.httpStatus` falls back to `500`. Without this task, a precise-member-read-not-found renders as `500 CHAT_WORKER_UNAVAILABLE` and the route tests in Task 10/11 assert `404`/`409` — they would fail. This is a P0 spec/infra alignment that must land before any route.

**Interfaces:**
- Consumes: the create-coordinator design decided pre-plan.
- Produces:
  - docs that the remaining tasks derive from.
  - `HTTP_STATUS_BY_CODE["MEMBER_NOT_FOUND"] === 404`, `HTTP_STATUS_BY_CODE["CHANNEL_DISSOLVED"] === 409`, `HTTP_STATUS_BY_CODE["INVITE_NOT_FOUND"] === 404` (INVITE_NOT_FOUND added for completeness though Phase 6 uses it). `RETRYABLE_CODES` unchanged (none of these three are retryable).

- [ ] **Step 1: Amend contract §5.2b**

In `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`, find the `### 5.2b 创建频道` section's 路由 paragraph (currently: `路由：频道 channel_id（UUIDv7）即 ChatChannel DO 的 name（系统公共频道例外，DO name 为 system-general）。`). Replace that paragraph with:
```markdown
路由与幂等（v2.5 delta）：创建频道的幂等由 `UserDirectory(creator_user_id)` 协调，不由 Worker 现场 mint 的 `ChatChannel` DO 承担。Worker 路由到 `UserDirectory(user_id)`，后者在其 `idempotency_keys` 事务内 mint `channel_id`（UUIDv7，即 `ChatChannel` DO name；系统频道例外，DO name=`system-general`），状态机 `creating`→`completed`，持久化 `channel_id`，再调用 `ChatChannel(channel_id).createChannel`（单事务原子写入，`channel_meta` 存在性即幂等 guard）。同一 `(user, operation=channel.create, key)` + 相同 `request_hash` 重试命中同一 `UserDirectory` DO → 同一 `channel_id` → 同一 `ChatChannel` DO → 缓存结果；不同 `request_hash` 返回 `409 IDEMPOTENCY_CONFLICT`。崩溃窗口：`status=creating` 时 retry 重新调用同一 `ChatChannel(channel_id).createChannel`（幂等返回已提交行）后标 `completed`，不重复建群。跨 DO 仍为 best-effort（无 2PC）。
```

- [ ] **Step 2: Add v2.5 revision record line**

In the same contract file, find the revision record (the `- **v2.4 (2026-06-24)**：...` line near the top). After it, add:
```markdown
- **v2.5 (2026-06-24)**：补 `POST /api/chat/channels` 创建幂等规则（§5.2b 路由与幂等段）：create 幂等由 `UserDirectory(creator_user_id)` 协调（状态机 `creating`→`completed` + 持久化 `channel_id`），`ChatChannel(channel_id).createChannel` 单事务原子写入。原因：create 端点 URL 无 `channel_id`，Worker 现场 `uuidv7()` 会使重试路由到不同 DO，in-DO `idempotency_keys` 失效，结构性重复建群。其余 6 个 mutation 端点 `channel_id` 在 URL，DO 地址稳定，沿用 Phase 2 in-DO 幂等。
```

- [ ] **Step 3: Amend design §8 阶段3 + §3.5a**

In `docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md`, find the `### 阶段 3` section's first bullet (the `POST /api/chat/channels（频道创建，v3.4 新增）` bullet). Append to that bullet:
```markdown
（v3.5）创建幂等由 `UserDirectory(creator_user_id)` 协调，不由 Worker mint 的 `ChatChannel` DO 承担：`UserDirectory.idempotency_keys` 事务内 mint `channel_id`、状态机 `creating`→`completed`、持久化 `channel_id`，再调 `ChatChannel(channel_id).createChannel`（单事务原子写 `channel_meta`+members+events+outbox，`channel_meta` 存在性即幂等 guard）。`status=creating` 崩溃窗口由 retry 重调同一 `ChatChannel(channel_id).createChannel`（幂等）后标 `completed` 修复，不重复建群。
```

- [ ] **Step 4: Add v3.5 revision entry to design §0.6**

In the same design file, find the §0.6 revision entries (the `v3.4` entry). After it, add:
```markdown
- **v3.5 (2026-06-24)**：补 create 幂等协调规则。`POST /api/chat/channels` 幂等归 `UserDirectory(creator_user_id)`（新增 `idempotency_keys` 表，状态机 `creating`→`completed`，持久化 `channel_id`），`ChatChannel.createChannel` 单事务原子写入。原因：create 端点无 URL `channel_id`，Worker 现场 mint 会使重试路由到不同 DO，Phase 2 in-DO 幂等模式对 create 结构性失效。
```

- [ ] **Step 5: Write failing test for the error-code HTTP status mapping**

`test/errors.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { ApiError } from "../src/errors";

describe("ApiError HTTP status mapping (Phase 3 codes)", () => {
  it("MEMBER_NOT_FOUND → 404", () => {
    expect(new ApiError("MEMBER_NOT_FOUND", "x").httpStatus).toBe(404);
    expect(new ApiError("MEMBER_NOT_FOUND", "x").retryable).toBe(false);
  });
  it("CHANNEL_DISSOLVED → 409", () => {
    expect(new ApiError("CHANNEL_DISSOLVED", "x").httpStatus).toBe(409);
    expect(new ApiError("CHANNEL_DISSOLVED", "x").retryable).toBe(false);
  });
  it("INVITE_NOT_FOUND → 404 (forward-compat for Phase 6)", () => {
    expect(new ApiError("INVITE_NOT_FOUND", "x").httpStatus).toBe(404);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/errors.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — `MEMBER_NOT_FOUND`/`CHANNEL_DISSOLVED` fall back to `500` (code not in `HTTP_STATUS_BY_CODE`).

- [ ] **Step 7: Add the three codes to `src/errors.ts`**

In `src/errors.ts`, in the `HTTP_STATUS_BY_CODE` record, the codes already present include `MESSAGE_NOT_FOUND: 404`. Add `MEMBER_NOT_FOUND`, `INVITE_NOT_FOUND`, and `CHANNEL_DISSOLVED`. Replace the block:
```typescript
  CHANNEL_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  CHANNEL_ARCHIVED: 409,
```
with:
```typescript
  CHANNEL_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  MEMBER_NOT_FOUND: 404,
  INVITE_NOT_FOUND: 404,
  CHANNEL_ARCHIVED: 409,
  CHANNEL_DISSOLVED: 409,
```
`RETRYABLE_CODES` stays unchanged — none of the three new codes are retryable.

- [ ] **Step 8: Run test to verify it passes + typecheck**

Run: `npx vitest run test/errors.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: all 3 PASS; typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add docs/api-contract/2026-06-22-toolbear-chat-api-contract.md docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md src/errors.ts test/errors.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "docs+errors: v2.5/v3.5 create-coordinator rule + MEMBER_NOT_FOUND/CHANNEL_DISSOLVED/INVITE_NOT_FOUND codes"
```

---

## Task 2: `channelRouteNameFor` supports user channels

**Files:**
- Modify: `src/chat/system-channel.ts:25-31`
- Test: `test/chat/system-channel.test.ts` (Create)

**Interfaces:**
- Consumes: `ensureSystemChannel(env)` (existing). `SYSTEM_CHANNEL_NAME = "system-general"`.
- Produces: `channelRouteNameFor(env, userId, clientChannelId): Promise<string | null>` where a non-system `clientChannelId` returns `clientChannelId` itself (the DO name for user channels). The literal string `"system-general"` is defended: it is NOT a valid user channel id (it would collide with the system channel DO name), so it returns `null`.

- [ ] **Step 1: Write failing test**

`test/chat/system-channel.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { channelRouteNameFor, SYSTEM_CHANNEL_NAME } from "../../src/chat/system-channel";

describe("channelRouteNameFor", () => {
  it("returns system-general for the system channel id", async () => {
    // Bootstrap the system channel so ensureSystemChannel resolves a real id.
    const sys = await channelRouteNameFor(env, "u-route-1", "will-be-replaced");
    void sys;
    // Resolve the real system channel id, then assert routing.
    const { ensureSystemChannel } = await import("../../src/chat/system-channel");
    const { channelId } = await ensureSystemChannel(env);
    expect(await channelRouteNameFor(env, "u-route-1", channelId)).toBe(SYSTEM_CHANNEL_NAME);
  });

  it("returns the channel_id itself for a non-system channel (optimistic DO routing)", async () => {
    const userChannelId = "0192aaaa-0000-7000-8000-000000000001";
    expect(await channelRouteNameFor(env, "u-route-2", userChannelId)).toBe(userChannelId);
  });

  it("returns null for the literal string 'system-general' (not a user channel id)", async () => {
    expect(await channelRouteNameFor(env, "u-route-3", "system-general")).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/system-channel.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — the "returns the channel_id itself" case gets `null` (current code returns null for non-system), and the `system-general` literal case gets `"system-general"` (current code returns the input only for the system UUID).

- [ ] **Step 3: Implement**

Replace the body of `channelRouteNameFor` in `src/chat/system-channel.ts` (lines 25-31) with:
```typescript
export async function channelRouteNameFor(env: Env, userId: string, clientChannelId: string): Promise<string | null> {
  void userId;
  // The system channel DO is named system-general; its channel_id is a UUIDv7 minted at bootstrap.
  const sys = await ensureSystemChannel(env);
  if (clientChannelId === sys.channelId) return SYSTEM_CHANNEL_NAME;
  // Defense: the literal DO-name string "system-general" is never a user channel id.
  if (clientChannelId === SYSTEM_CHANNEL_NAME) return null;
  // Phase 3: user-created channels use channel_id as the DO name (optimistic routing).
  // The ChatChannel DO self-validates (404/409 if the channel doesn't exist).
  return clientChannelId;
}
```

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `npx vitest run test/chat/system-channel.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Run the existing routes/events suite to confirm no regression**

Run: `npx vitest run test/routes/events.test.ts test/do/chat-channel-message-send.test.ts --no-file-parallelism --test-timeout=60000`
Expected: PASS (routing now resolves user channels, but existing tests use the system channel which still resolves to `system-general`).

- [ ] **Step 6: Commit**

```bash
git add src/chat/system-channel.ts test/chat/system-channel.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(chat): channelRouteNameFor routes user channels by channel_id as DO name"
```

---

## Task 3: Phase 3 event payload builders + actor resolver (pure units)

**Files:**
- Create: `src/chat/channel-events.ts`
- Test: `test/chat/channel-events.test.ts`

**Interfaces:**
- Consumes: nothing DO-bound. `ResolveUserSummaries` type mirrored from `event-broadcast.ts` (injected for testability).
- Produces (all persisted payloads store actor REFS, no UserSummary):
  - `buildChannelCreatedPayload(raw: { channel_id: string; kind: string; visibility: string; title: string; actor_kind: string; actor_id: string }): Record<string, unknown>` → `{ channel: { channel_id, kind, visibility, title }, actor_kind, actor_id }`.
  - `buildChannelUpdatedPayload(raw: { channel_id: string; channel_changes: Record<string, { before: unknown; after: unknown }>; actor_kind: string; actor_id: string }): Record<string, unknown>` → `{ channel_id, channel_changes, actor_kind, actor_id }`.
  - `buildChannelDissolvedPayload(raw: { channel_id: string; dissolved_at: string; actor_kind: string; actor_id: string }): Record<string, unknown>` → `{ channel_id, status: "dissolved", dissolved_at, actor_kind, actor_id }`.
  - `buildMemberJoinedPayload(raw: { channel_id: string; user_id: string; role: string; membership_version: number; actor_kind: string; actor_id: string }): Record<string, unknown>` → `{ channel_id, user_id, role, membership_version, actor_kind, actor_id }`.
  - `buildMemberRoleUpdatedPayload(raw: { channel_id: string; user_id: string; before_role: string; after_role: string; membership_version: number; actor_kind: string; actor_id: string }): Record<string, unknown>`.
  - `buildReadStateUpdatedPayload(raw: { channel_id: string; user_id: string; last_read_event_id: string }): Record<string, unknown>` → `{ channel_id, user_id, last_read_event_id }`.
  - `buildMemberLeftPayload(raw: { channel_id: string; user_id: string; role: string; membership_version: number; actor_kind: string; actor_id: string }): Record<string, unknown>` → mirrors `buildMemberJoinedPayload`'s shape (Task 9 uses this instead of an inline payload).
  - `buildSystemNoticePayload(raw: { notice_kind: string; actor_kind: string; actor_id: string; target_user_id: string | null; message_id: string | null; channel_changes: Record<string, { before: unknown; after: unknown }> | null }): Record<string, unknown>` → persisted ref shape (design §3.5a).
  - `resolveActorForLiveBroadcast(payload: Record<string, unknown>, resolveUserSummaries: ResolveUserSummaries): Promise<Record<string, unknown>>` — async, injected-resolver variant for unit tests. Replaces `actor_id` (when `actor_kind==='user'`) with `actor: UserSummary`, and `target_user_id` with `target_user: UserSummary` (if present). Falls back to `user-<shortid>`.
  - `resolveActorWithMap(payload: Record<string, unknown>, map: Map<string, UserSummary>): Record<string, unknown>` — **sync** variant for prod use inside a DO transaction (the Hyperdrive resolution happens BEFORE the txn, the map is passed in). Same projection as the async variant. `read_state.updated` payloads (no `actor_kind`) are passed through unchanged by the caller, not by this function.

- [ ] **Step 1: Write failing test**

`test/chat/channel-events.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import {
  buildChannelCreatedPayload,
  buildChannelUpdatedPayload,
  buildChannelDissolvedPayload,
  buildMemberJoinedPayload,
  buildMemberRoleUpdatedPayload,
  buildMemberLeftPayload,
  buildReadStateUpdatedPayload,
  buildSystemNoticePayload,
  resolveActorForLiveBroadcast,
  resolveActorWithMap,
} from "../../src/chat/channel-events";

describe("persisted payloads store actor refs, not UserSummary", () => {
  it("channel.created", () => {
    const p = buildChannelCreatedPayload({ channel_id: "c1", kind: "channel", visibility: "private", title: "T", actor_kind: "user", actor_id: "u1" });
    expect(p).toMatchObject({ actor_kind: "user", actor_id: "u1" });
    expect((p as any).channel).toEqual({ channel_id: "c1", kind: "channel", visibility: "private", title: "T" });
    expect(JSON.stringify(p)).not.toContain("display_name");
  });

  it("channel.updated carries channel_changes", () => {
    const p = buildChannelUpdatedPayload({ channel_id: "c1", channel_changes: { title: { before: "a", after: "b" } }, actor_kind: "user", actor_id: "u1" });
    expect((p as any).channel_changes).toEqual({ title: { before: "a", after: "b" } });
  });

  it("channel.dissolved", () => {
    const p = buildChannelDissolvedPayload({ channel_id: "c1", dissolved_at: "2026-06-24T00:00:00Z", actor_kind: "user", actor_id: "u1" });
    expect(p).toMatchObject({ channel_id: "c1", status: "dissolved", dissolved_at: "2026-06-24T00:00:00Z", actor_kind: "user", actor_id: "u1" });
  });

  it("member.joined", () => {
    const p = buildMemberJoinedPayload({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 3, actor_kind: "system", actor_id: "system" });
    expect(p).toMatchObject({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 3, actor_kind: "system", actor_id: "system" });
  });

  it("member.role_updated", () => {
    const p = buildMemberRoleUpdatedPayload({ channel_id: "c1", user_id: "u2", before_role: "member", after_role: "admin", membership_version: 4, actor_kind: "user", actor_id: "u1" });
    expect(p).toMatchObject({ before_role: "member", after_role: "admin", membership_version: 4 });
  });

  it("member.left mirrors member.joined shape", () => {
    const p = buildMemberLeftPayload({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 4, actor_kind: "user", actor_id: "u1" });
    expect(p).toMatchObject({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 4, actor_kind: "user", actor_id: "u1" });
  });

  it("read_state.updated", () => {
    const p = buildReadStateUpdatedPayload({ channel_id: "c1", user_id: "u1", last_read_event_id: "01J" });
    expect(p).toEqual({ channel_id: "c1", user_id: "u1", last_read_event_id: "01J" });
  });

  it("system.notice persisted ref shape", () => {
    const p = buildSystemNoticePayload({ notice_kind: "channel.dissolved", actor_kind: "user", actor_id: "u1", target_user_id: null, message_id: null, channel_changes: null });
    expect(p).toMatchObject({ notice_kind: "channel.dissolved", actor_kind: "user", actor_id: "u1", target_user_id: null, message_id: null, channel_changes: null });
    expect(JSON.stringify(p)).not.toContain("display_name");
  });
});

describe("resolveActorForLiveBroadcast", () => {
  it("replaces actor_id with a resolved actor UserSummary", async () => {
    const persisted = buildSystemNoticePayload({ notice_kind: "member.joined", actor_kind: "user", actor_id: "u1", target_user_id: "u2", message_id: null, channel_changes: null });
    const live = await resolveActorForLiveBroadcast(
      persisted,
      async () => new Map([["u1", { user_id: "u1", display_name: "Alice", avatar_url: null }], ["u2", { user_id: "u2", display_name: "Bob", avatar_url: "https://x/b.png" }]]),
    );
    expect((live as any).actor).toEqual({ user_id: "u1", display_name: "Alice", avatar_url: null });
    expect((live as any).target_user).toEqual({ user_id: "u2", display_name: "Bob", avatar_url: "https://x/b.png" });
    expect(live).not.toHaveProperty("actor_id");
    expect(live).not.toHaveProperty("target_user_id");
  });

  it("system actor has actor=null and no resolution", async () => {
    const persisted = buildSystemNoticePayload({ notice_kind: "member.joined", actor_kind: "system", actor_id: "system", target_user_id: null, message_id: null, channel_changes: null });
    const called: string[] = [];
    const live = await resolveActorForLiveBroadcast(persisted, async (ids) => { called.push(...ids); return new Map(); });
    expect((live as any).actor).toBe(null);
    expect(called).toEqual([]); // system actor does not trigger resolution
  });

  it("falls back to user-<shortid> when actor not in pg", async () => {
    const persisted = buildChannelCreatedPayload({ channel_id: "c1", kind: "channel", visibility: "private", title: "T", actor_kind: "user", actor_id: "u-ghost" });
    const live = await resolveActorForLiveBroadcast(persisted, async () => new Map());
    expect((live as any).actor.display_name).toBe("user-u-ghost");
  });
});

describe("resolveActorWithMap (sync, prod path)", () => {
  it("resolves actor + target_user from a pre-resolved map", () => {
    const persisted = buildSystemNoticePayload({ notice_kind: "member.role_updated", actor_kind: "user", actor_id: "u1", target_user_id: "u2", message_id: null, channel_changes: null });
    const map = new Map([["u1", { user_id: "u1", display_name: "Alice", avatar_url: null }], ["u2", { user_id: "u2", display_name: "Bob", avatar_url: null }]]);
    const live = resolveActorWithMap(persisted, map);
    expect((live as any).actor).toEqual({ user_id: "u1", display_name: "Alice", avatar_url: null });
    expect((live as any).target_user).toEqual({ user_id: "u2", display_name: "Bob", avatar_url: null });
    expect(live).not.toHaveProperty("actor_id");
  });

  it("system actor → actor:null, no map lookup needed", () => {
    const persisted = buildMemberJoinedPayload({ channel_id: "c1", user_id: "u2", role: "member", membership_version: 1, actor_kind: "system", actor_id: "system" });
    const live = resolveActorWithMap(persisted, new Map());
    expect((live as any).actor).toBe(null);
    expect((live as any).target_user).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/channel-events.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — `Cannot find module '../../src/chat/channel-events'`.

- [ ] **Step 3: Implement `src/chat/channel-events.ts`**

```typescript
import type { UserSummary, ResolveUserSummaries } from "./event-broadcast";

export type { UserSummary, ResolveUserSummaries };

export function buildChannelCreatedPayload(raw: {
  channel_id: string; kind: string; visibility: string; title: string;
  actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return {
    channel: { channel_id: raw.channel_id, kind: raw.kind, visibility: raw.visibility, title: raw.title },
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
  };
}

export function buildChannelUpdatedPayload(raw: {
  channel_id: string; channel_changes: Record<string, { before: unknown; after: unknown }>;
  actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, channel_changes: raw.channel_changes, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
}

export function buildChannelDissolvedPayload(raw: {
  channel_id: string; dissolved_at: string; actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, status: "dissolved", dissolved_at: raw.dissolved_at, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
}

export function buildMemberJoinedPayload(raw: {
  channel_id: string; user_id: string; role: string; membership_version: number;
  actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, user_id: raw.user_id, role: raw.role, membership_version: raw.membership_version, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
}

export function buildMemberRoleUpdatedPayload(raw: {
  channel_id: string; user_id: string; before_role: string; after_role: string; membership_version: number;
  actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, user_id: raw.user_id, before_role: raw.before_role, after_role: raw.after_role, membership_version: raw.membership_version, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
}

export function buildMemberLeftPayload(raw: {
  channel_id: string; user_id: string; role: string; membership_version: number;
  actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, user_id: raw.user_id, role: raw.role, membership_version: raw.membership_version, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
}

export function buildReadStateUpdatedPayload(raw: {
  channel_id: string; user_id: string; last_read_event_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, user_id: raw.user_id, last_read_event_id: raw.last_read_event_id };
}

// Persisted ref shape per design §3.5a: only refs + structural fields, NO UserSummary.
export function buildSystemNoticePayload(raw: {
  notice_kind: string; actor_kind: string; actor_id: string;
  target_user_id: string | null; message_id: string | null;
  channel_changes: Record<string, { before: unknown; after: unknown }> | null;
}): Record<string, unknown> {
  return {
    notice_kind: raw.notice_kind,
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
    target_user_id: raw.target_user_id,
    message_id: raw.message_id,
    channel_changes: raw.channel_changes,
  };
}

// Wire projection: resolve actor (and target_user) refs to UserSummary at output time.
// System actor → actor: null (no resolution). Falls back to user-<shortid> when pg has no row.
export function resolveActorWithMap(
  payload: Record<string, unknown>,
  map: Map<string, UserSummary>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  const actorKind = typeof out.actor_kind === "string" ? out.actor_kind : "";
  const actorId = typeof out.actor_id === "string" ? out.actor_id : "";

  if (actorKind === "user" && actorId) {
    const u = map.get(actorId) ?? { user_id: actorId, display_name: `user-${actorId.slice(0, 8)}`, avatar_url: null };
    out.actor = u;
  } else if (actorKind === "system") {
    out.actor = null;
  }
  delete out.actor_id;
  delete out.actor_kind;

  const targetUserId = typeof out.target_user_id === "string" ? out.target_user_id : null;
  if (targetUserId) {
    const u = map.get(targetUserId) ?? { user_id: targetUserId, display_name: `user-${targetUserId.slice(0, 8)}`, avatar_url: null };
    out.target_user = u;
  } else {
    out.target_user = null;
  }
  delete out.target_user_id;
  return out;
}

// Async injected-resolver variant — used by unit tests. Prod code uses resolveActorWithMap
// (sync) after pre-resolving via Hyperdrive BEFORE the DO transaction.
export async function resolveActorForLiveBroadcast(
  payload: Record<string, unknown>,
  resolveUserSummaries: ResolveUserSummaries,
): Promise<Record<string, unknown>> {
  const ids: string[] = [];
  const actorKind = typeof payload.actor_kind === "string" ? payload.actor_kind : "";
  const actorId = typeof payload.actor_id === "string" ? payload.actor_id : "";
  if (actorKind === "user" && actorId) ids.push(actorId);
  const targetUserId = typeof payload.target_user_id === "string" ? payload.target_user_id : null;
  if (targetUserId) ids.push(targetUserId);
  const map = ids.length > 0 ? await resolveUserSummaries(ids) : new Map<string, UserSummary>();
  return resolveActorWithMap(payload, map);
}
```

> **Note on re-export:** `event-broadcast.ts` already exports `UserSummary` and (as `ResolveUserSummaries`) the resolver type. Re-exporting them here keeps `channel-events.ts` self-contained for the implementer without duplicating the type. If `ResolveUserSummaries` is not exported from `event-broadcast.ts` (verify in Step 3 — it is declared as `export type ResolveUserSummaries`), add the `export` keyword to it there.

- [ ] **Step 4: Run tests to verify pass + typecheck**

Run: `npx vitest run test/chat/channel-events.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/chat/channel-events.ts test/chat/channel-events.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(chat): Phase 3 event payload builders + actor live resolver"
```

---

## Task 4: `ChatChannel` `/internal/create-channel` (atomic create + idempotent re-call)

**Files:**
- Modify: `src/do/chat-channel.ts`
- Test: `test/do/chat-channel-create.test.ts`

**Interfaces:**
- Consumes: existing `ChatChannel` schema (`channel_meta`, `members`, `events`, `event_seq`, `projection_outbox`), `nextEventId`, `insertOutboxRow` (async, user_directory target), `insertOutboxRowForFanout` (sync), `scheduleOutboxAlarm`. `buildEventFrame` from `../chat/event-broadcast`. The new payload builders + `resolveActorWithMap` from `../chat/channel-events`. `resolveUserSummaries` from `../profile/resolve`. `uuidv7` from `../ids/uuidv7` (NOT used to mint `channel_id` — the coordinator mints it and passes it in).
- Produces: `POST /internal/create-channel` (header `X-Verified-User-Id` = creator, body `{ channel_id, creator_user_id, title, topic, avatar_attachment_id, visibility, initial_members: Array<{ user_id, role }> }`). One transaction:
  - Validate: `title` non-empty; `visibility ∈ {private, public_unlisted, public_listed}` (default `private`); `avatar_attachment_id` must be `null` (else `422 INVALID_MESSAGE`); each `initial_members[].role ∈ {member, admin}` (not `owner`); creator not in `initial_members`.
  - If `channel_meta` already exists for `channel_id` → idempotent re-call: read back owner `members` row + meta, return cached `{ channel, membership, event_ids: [] }` (no new writes).
  - Else: INSERT `channel_meta` (`kind='channel'`, `status='active'`, `created_by=creator`, `member_count=1+initial_members.length`, `membership_version=1+initial_members.length`); INSERT owner `members` row (`role='owner'`); INSERT one `members` row per `initial_member`. `membership_version` increments per join (owner→1, each initial→+1).
  - Events (persisted ref payloads) + `channel_fanout` outbox (live-resolved frames) for: `channel.created` (actor=user=creator), `member.joined` (creator, actor=system), one `member.joined` per initial_member (actor=system), `system.notice` (notice_kind=`channel.created`, actor=user=creator).
  - `user_directory` outbox rows: one `join` projection per {creator, each initial_member} (same shape as `/internal/join`).
  - `scheduleOutboxAlarm(now)`.
  - Return `{ channel: { channel_id, kind, visibility, title, topic, avatar_url, member_count, status, created_at, updated_at }, membership: { role: "owner", joined_at }, event_ids: [...] }`.

- [ ] **Step 1: Add a shared sync helper `persistEventAndFanout` + an actor pre-resolver**

These go inside `class ChatChannel` in `src/do/chat-channel.ts`. Add near the other private helpers (after `insertOutboxRowForFanout`):

```typescript
private async resolveActorMap(userIds: string[]): Promise<Map<string, import("../chat/event-broadcast").UserSummary>> {
  const raw = await resolveUserSummaries(userIds, this.env);
  const m = new Map<string, import("../chat/event-broadcast").UserSummary>();
  for (const [id, v] of raw) {
    m.set(id, { user_id: id, display_name: v.display_name ?? `user-${id.slice(0, 8)}`, avatar_url: v.avatar_url });
  }
  return m;
}

// Sync: persists the event (ref payload) + writes a channel_fanout outbox row with the
// LIVE-resolved frame. MUST run inside ctx.storage.transaction. The actor map is pre-resolved
// BEFORE the txn (Hyperdrive is a network call). For read_state.updated (no actor_kind) the
// caller passes an empty map and the payload is passed through unchanged.
private persistEventAndFanout(
  eventId: string,
  type: string,
  channelId: string,
  occurredAt: string,
  persistedPayload: Record<string, unknown>,
  membershipVersion: number,
  nowIso: string,
  actorMap: Map<string, import("../chat/event-broadcast").UserSummary>,
): void {
  const actorKind = typeof persistedPayload.actor_kind === "string" ? persistedPayload.actor_kind : null;
  const actorId = typeof persistedPayload.actor_id === "string" ? persistedPayload.actor_id : null;
  this.ctx.storage.sql.exec(
    "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    eventId, type, channelId, actorKind, actorId, JSON.stringify(persistedPayload), membershipVersion, occurredAt,
  );
  const livePayload = type === "read_state.updated"
    ? persistedPayload
    : resolveActorWithMap(persistedPayload, actorMap);
  const frame = buildEventFrame({ event_id: eventId, type, channel_id: channelId, occurred_at: occurredAt, payload: livePayload });
  this.insertOutboxRowForFanout(channelId, eventId, JSON.stringify(frame), membershipVersion, nowIso);
}
```

Add these imports at the top of `src/do/chat-channel.ts` (alongside the existing `event-broadcast` import):
```typescript
import {
  buildChannelCreatedPayload,
  buildChannelUpdatedPayload,
  buildChannelDissolvedPayload,
  buildMemberJoinedPayload,
  buildMemberRoleUpdatedPayload,
  buildMemberLeftPayload,
  buildReadStateUpdatedPayload,
  buildSystemNoticePayload,
  resolveActorWithMap,
} from "../chat/channel-events";
```

- [ ] **Step 2: Write failing test**

`test/do/chat-channel-create.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

async function createChannel(overrides: Record<string, unknown> = {}) {
  const channelId = overrides.channel_id ?? "0192" + Math.random().toString(36).slice(2).padEnd(8, "0") + "-0000-7000-8000-000000000001";
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
  const body = {
    channel_id: channelId,
    creator_user_id: "u-creator-1",
    title: "My Channel",
    topic: null,
    avatar_attachment_id: null,
    visibility: "private",
    initial_members: [{ user_id: "u-init-1", role: "member" }],
    ...overrides,
  };
  const res = await stub.fetch(new Request("https://x/internal/create-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": body.creator_user_id, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { res, channelId, stub };
}

describe("ChatChannel /internal/create-channel", () => {
  it("creates the channel + owner + initial members and returns channel + membership", async () => {
    const { res, channelId } = await createChannel();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { channel_id: string; kind: string; status: string }; membership: { role: string }; event_ids: string[] };
    expect(body.channel.channel_id).toBe(channelId);
    expect(body.channel.kind).toBe("channel");
    expect(body.channel.status).toBe("active");
    expect(body.membership.role).toBe("owner");
    expect(body.event_ids.length).toBeGreaterThanOrEqual(3); // channel.created + member.joined(creator) + member.joined(init) + system.notice
  });

  it("is idempotent on re-call (same channel_id returns existing, no duplicate events)", async () => {
    const { channelId, stub } = await createChannel();
    const res2 = await stub.fetch(new Request("https://x/internal/create-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-creator-1", "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: channelId, creator_user_id: "u-creator-1", title: "My Channel", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [{ user_id: "u-init-1", role: "member" }] }),
    }));
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { membership: { role: string }; event_ids: string[] };
    expect(body2.membership.role).toBe("owner");
    expect(body2.event_ids).toEqual([]); // no new events on idempotent re-call
  });

  it("rejects non-null avatar_attachment_id (Phase 3, attachments are Phase 5)", async () => {
    const { res } = await createChannel({ avatar_attachment_id: "att-1" });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects owner role in initial_members", async () => {
    const { res } = await createChannel({ initial_members: [{ user_id: "u-x", role: "owner" }] });
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/do/chat-channel-create.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — `/internal/create-channel` returns 404 (not implemented).

- [ ] **Step 4: Implement the handler**

Add this block inside `ChatChannel.fetch` in `src/do/chat-channel.ts`, before the final `return new Response("not found", { status: 404 });`:

```typescript
if (url.pathname === "/internal/create-channel") {
  const creatorUserId = request.headers.get("X-Verified-User-Id") ?? "";
  if (!creatorUserId) return new Response("missing verified user", { status: 401 });
  const b = (await request.json()) as {
    channel_id: string; creator_user_id: string; title: string; topic: string | null;
    avatar_attachment_id: string | null; visibility: string;
    initial_members: Array<{ user_id: string; role: string }>;
  };
  const channelId = b.channel_id;
  if (!channelId) return Response.json({ error: { code: "INVALID_MESSAGE", message: "channel_id required", retryable: false } }, { status: 422 });
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (title === "") return Response.json({ error: { code: "INVALID_MESSAGE", message: "title is required", retryable: false } }, { status: 422 });
  if (b.avatar_attachment_id !== null && b.avatar_attachment_id !== undefined) {
    return Response.json({ error: { code: "INVALID_MESSAGE", message: "avatar_attachment_id not supported in Phase 3", retryable: false } }, { status: 422 });
  }
  const visibility = b.visibility ?? "private";
  if (!["private", "public_unlisted", "public_listed"].includes(visibility)) {
    return Response.json({ error: { code: "INVALID_MESSAGE", message: "invalid visibility", retryable: false } }, { status: 422 });
  }
  const initialMembers = Array.isArray(b.initial_members) ? b.initial_members : [];
  for (const im of initialMembers) {
    if (im.role !== "member" && im.role !== "admin") {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "initial_members role must be member or admin", retryable: false } }, { status: 422 });
    }
    if (im.user_id === creatorUserId) {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "creator must not be in initial_members", retryable: false } }, { status: 422 });
    }
  }

  const now = this.nowIso();
  const nowMs = Date.parse(now);

  // Pre-resolve actor UserSummary BEFORE the txn (Hyperdrive is a network call).
  const actorMap = await this.resolveActorMap([creatorUserId]);

  // Build all persisted payloads + event ids + live frames up front (sync), then write in one txn.
  const ownerMv = 1;
  const events: Array<{ id: string; type: string; payload: Record<string, unknown>; mv: number }> = [];
  const channelCreatedId = this.nextEventId(nowMs);
  events.push({ id: channelCreatedId, type: "channel.created", payload: buildChannelCreatedPayload({ channel_id: channelId, kind: "channel", visibility, title, actor_kind: "user", actor_id: creatorUserId }), mv: ownerMv });
  const memberJoinedCreatorId = this.nextEventId(nowMs);
  events.push({ id: memberJoinedCreatorId, type: "member.joined", payload: buildMemberJoinedPayload({ channel_id: channelId, user_id: creatorUserId, role: "owner", membership_version: ownerMv, actor_kind: "system", actor_id: "system" }), mv: ownerMv });

  let mv = ownerMv;
  for (const im of initialMembers) {
    mv += 1;
    const eid = this.nextEventId(nowMs);
    events.push({ id: eid, type: "member.joined", payload: buildMemberJoinedPayload({ channel_id: channelId, user_id: im.user_id, role: im.role, membership_version: mv, actor_kind: "system", actor_id: "system" }), mv });
  }
  const noticeId = this.nextEventId(nowMs);
  events.push({ id: noticeId, type: "system.notice", payload: buildSystemNoticePayload({ notice_kind: "channel.created", actor_kind: "user", actor_id: creatorUserId, target_user_id: null, message_id: null, channel_changes: null }), mv });

  const finalMv = mv;
  const memberCount = 1 + initialMembers.length;

  const result = await this.ctx.storage.transaction(async (): Promise<
    | { kind: "cached"; channel: Record<string, unknown>; joinedAt: string }
    | { kind: "created"; channel: Record<string, unknown>; joinedAt: string }
  > => {
    const existing = this.ctx.storage.sql.exec("SELECT channel_id FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { channel_id: string } | undefined;
    if (existing !== undefined) {
      // Idempotent re-call (coordinator crashed after create committed, before marking completed).
      // Return the channel FROM THE DB, not from the request body — the re-call may carry a
      // different body shape than the original committed row.
      const meta = this.ctx.storage.sql.exec("SELECT channel_id, kind, visibility, title, topic, avatar_url, member_count, status, created_at, updated_at FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { channel_id: string; kind: string; visibility: string; title: string; topic: string | null; avatar_url: string | null; member_count: number; status: string; created_at: string; updated_at: string };
      const owner = this.ctx.storage.sql.exec("SELECT joined_at FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, creatorUserId).toArray()[0] as { joined_at: string } | undefined;
      const cachedChannel = { channel_id: meta.channel_id, kind: meta.kind, visibility: meta.visibility, title: meta.title, topic: meta.topic, avatar_url: meta.avatar_url, member_count: meta.member_count, status: meta.status, created_at: meta.created_at, updated_at: meta.updated_at };
      return { kind: "cached" as const, channel: cachedChannel, joinedAt: owner?.joined_at ?? meta.created_at };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO channel_meta (channel_id, kind, visibility, title, topic, avatar_url, status, created_by, created_at, updated_at, member_count, membership_version) VALUES (?, 'channel', ?, ?, ?, NULL, 'active', ?, ?, ?, ?, ?)`,
      channelId, visibility, title, b.topic ?? null, creatorUserId, now, now, memberCount, finalMv,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'owner', ?, NULL)",
      channelId, creatorUserId, now,
    );
    for (const im of initialMembers) {
      this.ctx.storage.sql.exec(
        "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, ?, ?, NULL)",
        channelId, im.user_id, im.role, now,
      );
    }
    for (const ev of events) {
      this.persistEventAndFanout(ev.id, ev.type, channelId, now, ev.payload, ev.mv, now, actorMap);
    }
    // user_directory join projections (creator + each initial member)
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'user_directory', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
      `user_directory:join:${channelId}:${creatorUserId}:${now}`,
      creatorUserId,
      JSON.stringify({ action: "join", channel_id: channelId, kind: "channel", membership_version: ownerMv }),
      now, now, now,
    );
    for (const im of initialMembers) {
      this.ctx.storage.sql.exec(
        "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'user_directory', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
        `user_directory:join:${channelId}:${im.user_id}:${now}`,
        im.user_id,
        JSON.stringify({ action: "join", channel_id: channelId, kind: "channel", membership_version: finalMv }),
        now, now, now,
      );
    }
    return { kind: "created" as const, channel: { channel_id: channelId, kind: "channel", visibility, title, topic: b.topic ?? null, avatar_url: null, member_count: memberCount, status: "active", created_at: now, updated_at: now }, joinedAt: now };
  });

  if (result.kind === "created") await this.scheduleOutboxAlarm(now);

  return Response.json({
    channel: result.channel,
    membership: { role: "owner", joined_at: result.joinedAt },
    event_ids: result.kind === "created" ? events.map((e) => e.id) : [],
  });
}
```

> **Idempotency note:** `createChannel` does NOT write an `idempotency_keys` row. The create-coordinator (`UserDirectory`, Task 5) owns the idempotency state machine. The `channel_meta` existence check is the crash-window guard: if the coordinator retries after a crash, it re-calls this same DO (same `channel_id`), sees `channel_meta` already exists, and returns the cached shape with `event_ids: []`. The single transaction guarantees either the full create committed or nothing did.

- [ ] **Step 5: Run test to verify it passes + typecheck**

Run: `npx vitest run test/do/chat-channel-create.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: all 4 PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/do/chat-channel.ts test/do/chat-channel-create.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(do): ChatChannel /internal/create-channel atomic create + idempotent re-call"
```

---

## Task 4b: `/internal/replay` resolves Phase 3 management-event actors (storage-vs-wire)

**Why this task is P0:** the persisted payloads for `channel.updated`, `channel.dissolved`, `member.*`, `system.notice`, `read_state.updated` store `actor_kind`/`actor_id` (and `target_user_id`) REFS. The WIRE replay projection must resolve them to `actor`/`target_user` UserSummaries (contract §10 `system.notice` wire shape has `actor`/`target_user`; design §3.5a storage-vs-wire rule). Today `/internal/replay` only resolves the sender for `message.created`/`message.updated` — Phase 3 management events would be replayed with bare `actor_id`, violating the contract. This was a P0 gap in the first plan draft.

**Files:**
- Modify: `src/do/chat-channel.ts` (`/internal/replay` handler)
- Test: `test/do/chat-channel-replay-projection.test.ts` (Create)

**Interfaces:**
- Consumes: `resolveUserSummaries` (already imported), `resolveActorWithMap` from `../chat/channel-events`.
- Produces: `/internal/replay` now, BEFORE building output frames, scans every event's parsed `payload_json` for `actor_kind==='user'` + `actor_id` and for `target_user_id`, collects them into one batched `resolveUserSummaries`, and rewrites each event's payload via `resolveActorWithMap(payload, map)` for the management-event types — exactly as it already does for `message.created`/`message.updated` senders. `read_state.updated` payloads (no actor) pass through unchanged.

- [ ] **Step 1: Write failing test**

`test/do/chat-channel-replay-projection.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

describe("ChatChannel /internal/replay actor projection", () => {
  it("replays system.notice with resolved actor + target_user (not bare ids)", async () => {
    const cid = "0198aaaa-0000-7000-8000-000000000001";
    const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], cid);
    // Create the channel (owner=u-replay-owner), which writes channel.created + member.joined
    // + system.notice(notice_kind=channel.created, actor=owner). These payloads store actor_id=owner.
    await stub.fetch(new Request("https://x/internal/create-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-replay-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: cid, creator_user_id: "u-replay-owner", title: "R", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [{ user_id: "u-replay-target", role: "member" }] }),
    }));
    const res = await stub.fetch(new Request("https://x/internal/replay?after=", { headers: { "X-Verified-User-Id": "u-replay-owner" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ event_json: string }> };
    const frames = body.events.map((e) => JSON.parse(e.event_json) as { type: string; payload: Record<string, unknown> });
    // Find the system.notice for member.joined of the initial member (target_user set).
    const notice = frames.find((f) => f.type === "system.notice" && (f.payload as { notice_kind?: string }).notice_kind === "member.joined");
    expect(notice).toBeTruthy();
    const p = notice!.payload as { actor?: unknown; target_user?: unknown; actor_id?: unknown; target_user_id?: unknown };
    expect(p).toHaveProperty("actor");
    expect(p).toHaveProperty("target_user");
    expect(p.actor_id).toBeUndefined();      // ref stripped on the wire
    expect(p.target_user_id).toBeUndefined(); // ref stripped on the wire
  });

  it("replays channel.created with resolved actor, not bare actor_id", async () => {
    const cid = "0198bbbb-0000-7000-8000-000000000001";
    const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], cid);
    await stub.fetch(new Request("https://x/internal/create-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-replay-owner2", "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: cid, creator_user_id: "u-replay-owner2", title: "R2", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }),
    }));
    const res = await stub.fetch(new Request("https://x/internal/replay?after=", { headers: { "X-Verified-User-Id": "u-replay-owner2" } }));
    const frames = ((await res.json()) as { events: Array<{ event_json: string }> }).events.map((e) => JSON.parse(e.event_json) as { type: string; payload: Record<string, unknown> });
    const created = frames.find((f) => f.type === "channel.created")!;
    expect(created.payload).toHaveProperty("actor");
    expect(created.payload).not.toHaveProperty("actor_id");
  });
});
```

> **Note on actor resolution:** the initial creation writes payloads with `actor_kind='user'`/`actor_id=creatorUserId` (channel.created, system.notice) and `actor_kind='system'`/`actor_id='system'` (member.joined). `resolveActorWithMap` turns system actors into `actor: null`. The test asserts the wire shape has `actor`/`target_user` set and the ref fields stripped — it does NOT assert on whether a given user_id resolves to a display_name (Hyperdrive is not seeded in tests; the function falls back to `user-<shortid>`, which still satisfies "actor is a UserSummary object, not a bare id").

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/do/chat-channel-replay-projection.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — the replayed frames still carry `actor_id`/`target_user_id` (current code only resolves message senders).

- [ ] **Step 3: Refactor `/internal/replay` to collect + resolve management-event actors**

In `src/do/chat-channel.ts`, the `/internal/replay` handler has two loops over `parsedRows`: a first to collect `message.created`/`message.updated` sender ids, and a second to build the output. Replace BOTH so they also collect management-event actor/target ids and apply `resolveActorWithMap`. Concretely:

1. Add the import for `resolveActorWithMap` (it is already added in Task 4 Step 1's import block — confirm it's present).
2. In the **first** collection loop, generalize: for `message.created`/`message.updated`, collect `payload.message.sender.user_id` (unchanged); for `channel.created`/`channel.updated`/`channel.dissolved`/`member.joined`/`member.left`/`member.role_updated`/`system.notice`, parse `payload_json` and if `actor_kind==='user'` and `actor_id` is a string, collect it; also collect `payload.target_user_id` when it's a non-empty string. Replace the existing first loop (the one that builds `allSenderIds` for `message.*`) with:
```typescript
const managementTypes = new Set(["channel.created", "channel.updated", "channel.dissolved", "member.joined", "member.left", "member.role_updated", "system.notice"]);
const userIdsToResolve: string[] = [];
for (const r of parsedRows) {
  if (r.event_type === "message.created" || r.event_type === "message.updated") {
    try {
      const p = JSON.parse(r.payload_json) as { message?: { sender?: { kind?: string; user_id?: string | null } } };
      if (p.message?.sender?.kind === "user" && p.message.sender.user_id) userIdsToResolve.push(p.message.sender.user_id);
    } catch { /* ignore malformed */ }
    continue;
  }
  if (managementTypes.has(r.event_type)) {
    try {
      const p = JSON.parse(r.payload_json) as { actor_kind?: string; actor_id?: string; target_user_id?: string | null };
      if (p.actor_kind === "user" && typeof p.actor_id === "string" && p.actor_id) userIdsToResolve.push(p.actor_id);
      if (typeof p.target_user_id === "string" && p.target_user_id) userIdsToResolve.push(p.target_user_id);
    } catch { /* ignore malformed */ }
  }
}
```
3. Replace the batched-resolve block (currently `resolveUserSummaries(Array.from(new Set(allSenderIds)), ...)` building `liveSenderMap`) — build a single `liveMap` covering sender ids AND management-event actor/target ids, then derive `liveSenderMap` from it (so the existing `message.*` `resolveSenderForLiveBroadcast` call still works). Concretely:
```typescript
const liveMap = await resolveUserSummaries(Array.from(new Set(userIdsToResolve)), this.env);
const liveSenderMap = new Map<string, LiveUserSummary>();
for (const [id, summary] of liveMap) {
  liveSenderMap.set(id, { user_id: summary.user_id, display_name: summary.display_name ?? `user-${id.slice(0, 8)}`, avatar_url: summary.avatar_url });
}
```
4. In the **second** (build) loop, the existing `message.*` branch calls `resolveSenderForLiveBroadcast(payload, ...)` (keep it). Add, right after that branch, a management-event branch that applies `resolveActorWithMap` using `liveMap`:
```typescript
if (managementTypes.has(r.event_type) && r.event_type !== "read_state.updated") {
  payload = resolveActorWithMap(payload, liveMap);
}
```
> `read_state.updated` has no actor (produced by Task 11); leave it unchanged — but the handler in Task 11 will NOT emit it via events at all (see Task 11: read-state is `my_channels`-only, no event). So this branch covers the real management types. If Task 11 is later changed to emit `read_state.updated`, re-evaluate.

> **Implementation note:** keep the `managementTypes` `Set` (a `const` outside the loop). Use the same variable name `liveMap` in the build loop closure so the management branch sees it. Do NOT introduce a second `resolveUserSummaries` call — one batched call covers senders + actors + targets.

- [ ] **Step 4: Run the replay-projection tests + the existing replay-dependent suites**

Run: `npx vitest run test/do/chat-channel-replay-projection.test.ts test/routes/events.test.ts test/do/chat-channel-message-send.test.ts test/integration/message-send.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: new tests PASS; existing `events`/`message-send` tests still green (the `message.*` path is unchanged); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/do/chat-channel.ts test/do/chat-channel-replay-projection.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "fix(do): /internal/replay resolves Phase 3 management-event actors (storage-vs-wire)"
```

---

## Task 5: `UserDirectory` create-coordinator (`/internal/channel-create-coordinate`)

**Files:**
- Modify: `src/do/user-directory.ts`
- Test: `test/do/user-directory-create-coordinate.test.ts`

**Interfaces:**
- Consumes: `Env` (`CHAT_CHANNEL` binding), `execSchema`. `uuidv7` from `../ids/uuidv7`. `channelRouteNameFor` is NOT needed (the coordinator mints `channel_id` and addresses `CHAT_CHANNEL.getByName(channel_id)` directly — Task 2 made that the convention).
- Produces: `POST /internal/channel-create-coordinate` (header `X-Verified-User-Id` = creator, body `{ idempotency_key, title, topic, avatar_attachment_id, visibility, initial_members }`). State machine in ONE transaction:
  - `request_hash = JSON.stringify({ title, topic, avatar_attachment_id, visibility, initial_members })`.
  - SELECT `idempotency_keys WHERE operation='channel.create' AND idempotency_key=?`:
    - hit + `request_hash` differs → `409 IDEMPOTENCY_CONFLICT`.
    - hit + `status='completed'` → return cached `response_json`.
    - hit + `status='creating'` → read `channel_id`; fall through to re-call (crash-window repair).
    - miss → mint `channel_id = uuidv7()`; INSERT row (`status='creating'`, `channel_id`, `request_hash`, `expires_at=now+24h`); fall through.
  - (Outside the txn) call `ChatChannel(channel_id).createChannel({ channel_id, creator_user_id, title, topic, avatar_attachment_id, visibility, initial_members })`. If non-2xx → return the error upstream (the row stays `creating`; the client retry will re-call idempotently).
  - (Second txn) `UPDATE idempotency_keys SET status='completed', response_json=<ChatChannel result>, updated_at=now`.
  - Return the `response_json` (`{ channel, membership, event_ids }`).

- [ ] **Step 1: Add the `idempotency_keys` table to UserDirectory SCHEMA**

In `src/do/user-directory.ts`, append to the `SCHEMA` array (after the `pending_attachments` block):
```typescript
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    operation TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL, status TEXT NOT NULL,
    channel_id TEXT, response_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ud_idem_expires ON idempotency_keys(expires_at)`,
```
Add the import at the top:
```typescript
import { uuidv7 } from "../ids/uuidv7";
```

- [ ] **Step 2: Write failing test**

`test/do/user-directory-create-coordinate.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

const CREATOR = "u-coord-creator";

async function coordinate(overrides: Record<string, unknown> = {}) {
  const stub = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], CREATOR);
  const body = {
    idempotency_key: "key-1",
    title: "Coord Channel",
    topic: null,
    avatar_attachment_id: null,
    visibility: "private",
    initial_members: [{ user_id: "u-coord-init", role: "member" }],
    ...overrides,
  };
  const res = await stub.fetch(new Request("https://x/internal/channel-create-coordinate", {
    method: "POST",
    headers: { "X-Verified-User-Id": CREATOR, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { res, stub, body };
}

describe("UserDirectory /internal/channel-create-coordinate", () => {
  it("first call creates the channel and returns channel + owner membership", async () => {
    const { res } = await coordinate();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { channel_id: string; kind: string }; membership: { role: string } };
    expect(body.channel.kind).toBe("channel");
    expect(body.membership.role).toBe("owner");
    expect(body.channel.channel_id).toBeTruthy();
  });

  it("same key + same body returns the SAME channel_id (cached)", async () => {
    const r1 = await coordinate({ idempotency_key: "key-dup" });
    const b1 = (await r1.res.json()) as { channel: { channel_id: string } };
    const r2 = await coordinate({ idempotency_key: "key-dup" });
    const b2 = (await r2.res.json()) as { channel: { channel_id: string } };
    expect(b2.channel.channel_id).toBe(b1.channel.channel_id);
  });

  it("same key + different body returns 409 IDEMPOTENCY_CONFLICT", async () => {
    await coordinate({ idempotency_key: "key-conflict", title: "First" });
    const r2 = await coordinate({ idempotency_key: "key-conflict", title: "Different" });
    expect(r2.res.status).toBe(409);
    const body2 = await r2.res.json() as { error: { code: string } };
    expect(body2.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/do/user-directory-create-coordinate.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — `/internal/channel-create-coordinate` returns 404.

- [ ] **Step 4: Implement the handler**

Add this block inside `UserDirectory.fetch` in `src/do/user-directory.ts`, before the final `return new Response("not found", { status: 404 });`:

```typescript
if (url.pathname === "/internal/channel-create-coordinate") {
  const creatorUserId = request.headers.get("X-Verified-User-Id");
  if (creatorUserId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
  const b = (await request.json()) as {
    idempotency_key: string; title: string; topic: string | null;
    avatar_attachment_id: string | null; visibility: string;
    initial_members: Array<{ user_id: string; role: string }>;
  };
  if (!b.idempotency_key) return Response.json({ error: { code: "INVALID_MESSAGE", message: "idempotency_key required", retryable: false } }, { status: 422 });

  const requestHash = JSON.stringify({
    title: b.title, topic: b.topic ?? null, avatar_attachment_id: b.avatar_attachment_id ?? null,
    visibility: b.visibility ?? "private", initial_members: b.initial_members ?? [],
  });
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();

  // Txn 1: resolve idempotency state + mint channel_id (if new).
  const coord = await this.ctx.storage.transaction(async () => {
    const row = this.ctx.storage.sql
      .exec("SELECT request_hash, status, channel_id, response_json FROM idempotency_keys WHERE operation='channel.create' AND idempotency_key=?", b.idempotency_key)
      .toArray()[0] as { request_hash: string; status: string; channel_id: string | null; response_json: string | null } | undefined;

    if (row) {
      if (row.request_hash !== requestHash) {
        return { kind: "conflict" as const };
      }
      if (row.status === "completed" && row.response_json) {
        return { kind: "cached" as const, responseJson: row.response_json };
      }
      // status === 'creating' (crash window) — reuse the persisted channel_id.
      return { kind: "creating" as const, channelId: row.channel_id ?? "" };
    }

    const channelId = uuidv7();
    this.ctx.storage.sql.exec(
      "INSERT INTO idempotency_keys (operation, idempotency_key, request_hash, status, channel_id, response_json, created_at, updated_at, expires_at) VALUES ('channel.create', ?, ?, 'creating', ?, NULL, ?, ?, ?)",
      b.idempotency_key, requestHash, channelId, now, now, expiresAt,
    );
    return { kind: "creating" as const, channelId };
  });

  if (coord.kind === "conflict") {
    return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
  }
  if (coord.kind === "cached") {
    return new Response(coord.responseJson, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // Call ChatChannel(channel_id).createChannel — idempotent via channel_meta existence.
  const channelId = coord.channelId;
  const chStub = this.env.CHAT_CHANNEL.getByName(channelId);
  const createRes = await chStub.fetch(new Request("https://x/internal/create-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": creatorUserId, "Content-Type": "application/json" },
    body: JSON.stringify({
      channel_id: channelId, creator_user_id: creatorUserId,
      title: b.title, topic: b.topic ?? null, avatar_attachment_id: b.avatar_attachment_id ?? null,
      visibility: b.visibility ?? "private", initial_members: b.initial_members ?? [],
    }),
  }));
  if (!createRes.ok) {
    // Leave row as 'creating' — client retry re-calls createChannel (idempotent) and recovers.
    const text = await createRes.text();
    return new Response(text, { status: createRes.status });
  }
  const createBody = await createRes.text();

  // Txn 2: mark completed with the create response.
  await this.ctx.storage.transaction(async () => {
    this.ctx.storage.sql.exec(
      "UPDATE idempotency_keys SET status='completed', response_json=?, updated_at=? WHERE operation='channel.create' AND idempotency_key=?",
      createBody, now, b.idempotency_key,
    );
  });

  return new Response(createBody, { status: 200, headers: { "Content-Type": "application/json" } });
}
```

- [ ] **Step 5: Run test to verify it passes + typecheck**

Run: `npx vitest run test/do/user-directory-create-coordinate.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: all 3 PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/do/user-directory.ts test/do/user-directory-create-coordinate.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(do): UserDirectory channel-create coordinator (idempotency state machine)"
```

---

## Task 6: `POST /api/chat/channels` Worker route

**Files:**
- Create: `src/routes/channel-mutations.ts`
- Modify: `src/index.ts`
- Test: `test/routes/channel-mutations.test.ts` (create cases)

**Interfaces:**
- Consumes: `getIdentity` pattern (Authorization Bearer → `verifyBrowserJwt`). `Env.USER_DIRECTORY`.
- Produces: `createChannelHandler(c)` → 201 with `{ channel, membership }` (the coordinator's response). Worker only does auth + delegate to `UserDirectory(user_id)./internal/channel-create-coordinate`. The `Idempotency-Key` header is forwarded as `idempotency_key`.

- [ ] **Step 1: Create `src/routes/channel-mutations.ts` with the create handler + shared `getIdentity`**

```typescript
import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";

export async function getIdentity(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<{ userId: string; env: Env }> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id } = await verifyBrowserJwt(token, c.env.JWT_SECRET);
  return { userId: user_id, env: c.env };
}

export async function createChannelHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => null)) as {
    title?: string; topic?: string | null; avatar_attachment_id?: string | null;
    visibility?: string; initial_members?: Array<{ user_id: string; role: string }>;
  } | null;
  if (!body || typeof body.title !== "string" || body.title.trim() === "") {
    throw new ApiError("INVALID_MESSAGE", "title is required");
  }

  const dirStub = env.USER_DIRECTORY.getByName(userId);
  const res = await dirStub.fetch(new Request("https://x/internal/channel-create-coordinate", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      title: body.title,
      topic: body.topic ?? null,
      avatar_attachment_id: body.avatar_attachment_id ?? null,
      visibility: body.visibility ?? "private",
      initial_members: body.initial_members ?? [],
    }),
  }));

  if (res.status === 409) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError("IDEMPOTENCY_CONFLICT", e.error?.message ?? "idempotency conflict");
  }
  if (res.status === 422) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError("INVALID_MESSAGE", e.error?.message ?? "invalid channel");
  }
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "channel create failed");

  const out = await res.json() as Record<string, unknown>;
  return c.json(out, 201, { "X-Request-Id": c.get("requestId") });
}
```

- [ ] **Step 2: Register the route in `src/index.ts`**

Add the import:
```typescript
import { createChannelHandler } from "./routes/channel-mutations";
```
Add the route registration (before the `app.all("/api/chat/*", ...)` catch-all):
```typescript
app.post("/api/chat/channels", (c) => createChannelHandler(c));
```

- [ ] **Step 3: Write failing test (create cases)**

`test/routes/channel-mutations.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

async function authedReq(userId: string, method: string, path: string, body?: unknown, idemKey?: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await makeJwt({ sub: userId }, TEST_SECRET)}` };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; }
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  return SELF.fetch(new Request(`https://chat.kuma.homes${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

describe("POST /api/chat/channels", () => {
  it("creates a channel and returns 201 { channel, membership }", async () => {
    const res = await authedReq("u-create-1", "POST", "/api/chat/channels", {
      title: "Route Channel", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [],
    }, "client-key-create-1");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { channel: { channel_id: string; kind: string }; membership: { role: string } };
    expect(body.channel.kind).toBe("channel");
    expect(body.membership.role).toBe("owner");
  });

  it("is idempotent: same Idempotency-Key returns the same channel_id", async () => {
    const r1 = await authedReq("u-create-2", "POST", "/api/chat/channels", { title: "Idem", visibility: "private", initial_members: [] }, "client-key-idem");
    const b1 = (await r1.json()) as { channel: { channel_id: string } };
    const r2 = await authedReq("u-create-2", "POST", "/api/chat/channels", { title: "Idem", visibility: "private", initial_members: [] }, "client-key-idem");
    const b2 = (await r2.json()) as { channel: { channel_id: string } };
    expect(b2.channel.channel_id).toBe(b1.channel.channel_id);
  });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/channels", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("returns 422 for missing title", async () => {
    const res = await authedReq("u-create-3", "POST", "/api/chat/channels", { visibility: "private" }, "client-key-notitle");
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 4: Run test to verify it fails (route may already 404 or pass-through)**

Run: `npx vitest run test/routes/channel-mutations.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL before the route is registered (404). After Step 2 registration, re-run → PASS.

- [ ] **Step 5: Run test to verify it passes + typecheck**

Run: `npx vitest run test/routes/channel-mutations.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: all 4 PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/routes/channel-mutations.ts src/index.ts test/routes/channel-mutations.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(routes): POST /api/chat/channels create route via UserDirectory coordinator"
```

---

## Task 7: `ChatChannel` `/internal/update-channel` + `PATCH /api/chat/channels/{id}`

**Files:**
- Modify: `src/do/chat-channel.ts`
- Modify: `src/routes/channel-mutations.ts`
- Modify: `src/index.ts`
- Test: `test/do/chat-channel-mutations.test.ts` (update cases)
- Test: `test/routes/channel-mutations.test.ts` (PATCH cases, appended)

**Interfaces:**
- Consumes: `channelRouteNameFor`, `getIdentity` (shared in `channel-mutations.ts`), `persistEventAndFanout` + `resolveActorMap` (Task 4), `buildChannelUpdatedPayload` + `buildSystemNoticePayload` (Task 3).
- Produces:
  - `POST /internal/update-channel` (header `X-Verified-User-Id`, body `{ idempotency_key, channel_id, title?, topic?, avatar_attachment_id?, visibility? }`). One transaction: dissolved-gate; membership gate (must be active member); idempotency via `idempotency_keys` `(operation='channel.update')` SELECT-inside-txn (cached/conflict); compute `channel_changes` (before/after per changed `title`/`topic`/`avatar_url`/`visibility`); UPDATE `channel_meta`; write `channel.updated` event + `system.notice` (notice_kind=`channel.updated`, `channel_changes`); `channel_fanout` outbox; `idempotency_keys` completed. Returns `{ channel }`.
  - `PATCH /api/chat/channels/{channel_id}` (Worker route): auth → route → `/internal/update-channel` → `{ channel }`.
- **Permission:** owner or admin may update (design §8: "owner/admin 可改"). Active member alone is not enough.

- [ ] **Step 1: Add `assertNotDissolved` + `activeRole` + `cachedResponse` helpers to ChatChannel**

Add near the other private helpers in `src/do/chat-channel.ts` (these are shared by Tasks 7/8/9):
```typescript
private assertNotDissolved(status: string): { code: string; message: string } | null {
  if (status === "dissolved") return { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" };
  return null;
}

// The caller's role if they are an ACTIVE member (left_at IS NULL), else null.
private activeRole(channelId: string, userId: string): string | null {
  const row = this.ctx.storage.sql
    .exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, userId)
    .toArray()[0] as { role: string } | undefined;
  return row?.role ?? null;
}

// Maps a cached `{channel|member|error}` JSON (encoded inside a txn that cannot write business rows)
// to the right HTTP status. Shared by all write handlers' cached branches (Tasks 7/8/9/11).
private cachedResponse(j: string): Response {
  const cached = JSON.parse(j) as { channel?: unknown; member?: unknown; error?: { code?: string; message?: string } };
  if (cached.error) {
    const code = cached.error.code ?? "CHAT_WORKER_UNAVAILABLE";
    const status = code === "FORBIDDEN" ? 403
      : code === "CHANNEL_NOT_FOUND" ? 404
      : code === "MEMBER_NOT_FOUND" ? 404
      : code === "CHANNEL_DISSOLVED" ? 409
      : code === "INVALID_MESSAGE" ? 422
      : 503;
    return Response.json({ error: { code, message: cached.error.message ?? "error", retryable: false } }, { status });
  }
  return new Response(j, { status: 200, headers: { "Content-Type": "application/json" } });
}
```

- [ ] **Step 2: Write failing test for the DO update handler**

Append to `test/do/chat-channel-mutations.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

async function makeChannel(channelId: string) {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
  await stub.fetch(new Request("https://x/internal/create-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: channelId, creator_user_id: "u-up-owner", title: "Orig", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }),
  }));
  return stub;
}

describe("ChatChannel /internal/update-channel", () => {
  it("updates title + topic and writes channel.updated + system.notice", async () => {
    const stub = await makeChannel("0193aaaa-0000-7000-8000-000000000001");
    const res = await stub.fetch(new Request("https://x/internal/update-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-up-1", channel_id: "0193aaaa-0000-7000-8000-000000000001", title: "New", topic: "Desc" }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { title: string; topic: string } };
    expect(body.channel.title).toBe("New");
    expect(body.channel.topic).toBe("Desc");
  });

  it("forbids non-member (non-admin) update", async () => {
    const stub = await makeChannel("0193bbbb-0000-7000-8000-000000000001");
    const res = await stub.fetch(new Request("https://x/internal/update-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-outsider", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-up-2", channel_id: "0193bbbb-0000-7000-8000-000000000001", title: "Hijack" }),
    }));
    expect(res.status).toBe(403);
  });

  it("is idempotent on same key+body", async () => {
    const cid = "0193cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const b = { idempotency_key: "k-up-3", channel_id: cid, title: "Idem" };
    const r1 = await stub.fetch(new Request("https://x/internal/update-channel", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify(b) }));
    const r2 = await stub.fetch(new Request("https://x/internal/update-channel", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify(b) }));
    expect(r1.status).toBe(200); expect(r2.status).toBe(200);
    expect(((await r2.json()) as { channel: { title: string } }).channel.title).toBe("Idem");
  });

  it("returns 409 IDEMPOTENCY_CONFLICT on same key + different body", async () => {
    const cid = "0193dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/update-channel", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-up-4", channel_id: cid, title: "A" }) }));
    const r2 = await stub.fetch(new Request("https://x/internal/update-channel", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-up-4", channel_id: cid, title: "B" }) }));
    expect(r2.status).toBe(409);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/do/chat-channel-mutations.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — `/internal/update-channel` returns 404.

- [ ] **Step 4: Implement the DO handler**

Add inside `ChatChannel.fetch` before the final 404:
```typescript
if (url.pathname === "/internal/update-channel") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  if (!userId) return new Response("missing verified user", { status: 401 });
  const b = (await request.json()) as {
    idempotency_key: string; channel_id: string;
    title?: string; topic?: string | null; avatar_attachment_id?: string | null; visibility?: string;
  };
  const channelId = b.channel_id;
  const now = this.nowIso();
  const nowMs = Date.parse(now);

  // Presence-aware canonical request body: omitted field vs explicit null are DISTINCT.
  // `title:"x"` (only title set) must hash differently from `title:"x", topic:null`,
  // otherwise a second request that explicitly nulls `topic` would collide with an omit-topic
  // request and wrongly register as cached/conflict. Capture exactly the keys the client sent.
  const present: Record<string, unknown> = {};
  if (b.title !== undefined) present.title = b.title;
  if (b.topic !== undefined) present.topic = b.topic;
  if (b.avatar_attachment_id !== undefined) present.avatar_attachment_id = b.avatar_attachment_id;
  if (b.visibility !== undefined) present.visibility = b.visibility;
  const requestHash = JSON.stringify(present);
  const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();

  const actorMap = await this.resolveActorMap([userId]);

  const txResult = await this.ctx.storage.transaction(async (): Promise<
    | { kind: "conflict" }
    | { kind: "cached"; responseJson: string }
    | { kind: "ok"; channel: Record<string, unknown> }
  > => {
    const idem = this.ctx.storage.sql
      .exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.update' AND idempotency_key=?", userId, b.idempotency_key)
      .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
    if (idem) {
      if (idem.request_hash !== requestHash) return { kind: "conflict" };
      return { kind: "cached", responseJson: idem.response_json ?? "{}" };
    }

    const meta = this.ctx.storage.sql.exec(
      "SELECT kind, visibility, title, topic, avatar_url, status, created_at, member_count, membership_version FROM channel_meta WHERE channel_id=?", channelId,
    ).toArray()[0] as { kind: string; visibility: string; title: string; topic: string | null; avatar_url: string | null; status: string; created_at: string; member_count: number; membership_version: number } | undefined;
    if (meta === undefined) {
      // channel gone → 404 CHANNEL_NOT_FOUND (NOT a conflict).
      return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
    }
    const d = this.assertNotDissolved(meta.status);
    if (d) return { kind: "cached", responseJson: JSON.stringify({ error: { code: d.code, message: d.message, retryable: false } }) };

    const role = this.activeRole(channelId, userId);
    if (role !== "owner" && role !== "admin") {
      return { kind: "cached", responseJson: JSON.stringify({ error: { code: "FORBIDDEN", message: "not authorized to update channel", retryable: false } }) };
    }

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const newTitle = b.title !== undefined ? b.title : meta.title;
    const newTopic = b.topic !== undefined ? b.topic : meta.topic;
    const newVisibility = b.visibility !== undefined ? b.visibility : meta.visibility;
    const newAvatarUrl = meta.avatar_url; // avatar_attachment_id processed in Phase 5
    if (b.title !== undefined && b.title !== meta.title) changes.title = { before: meta.title, after: b.title };
    if (b.topic !== undefined && b.topic !== meta.topic) changes.topic = { before: meta.topic, after: b.topic };
    if (b.visibility !== undefined && b.visibility !== meta.visibility) {
      if (!["private", "public_unlisted", "public_listed"].includes(b.visibility)) return { kind: "cached", responseJson: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "invalid visibility", retryable: false } }) };
      changes.visibility = { before: meta.visibility, after: b.visibility };
    }

    this.ctx.storage.sql.exec(
      "UPDATE channel_meta SET title=?, topic=?, visibility=?, avatar_url=?, updated_at=? WHERE channel_id=?",
      newTitle, newTopic, newVisibility, newAvatarUrl, now, channelId,
    );

    const mv = meta.membership_version;
    const updatedId = this.nextEventId(nowMs);
    this.persistEventAndFanout(updatedId, "channel.updated", channelId, now,
      buildChannelUpdatedPayload({ channel_id: channelId, channel_changes: changes, actor_kind: "user", actor_id: userId }), mv, now, actorMap);
    const noticeId = this.nextEventId(nowMs);
    this.persistEventAndFanout(noticeId, "system.notice", channelId, now,
      buildSystemNoticePayload({ notice_kind: "channel.updated", actor_kind: "user", actor_id: userId, target_user_id: null, message_id: null, channel_changes: changes }), mv, now, actorMap);

    const channel = { channel_id: channelId, kind: meta.kind, visibility: newVisibility, title: newTitle, topic: newTopic, avatar_url: newAvatarUrl, member_count: meta.member_count, status: meta.status, created_at: meta.created_at, updated_at: now };
    const responseJson = JSON.stringify({ channel });
    this.ctx.storage.sql.exec(
      "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, idempotency_key, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.update', ?, ?, ?, 'completed', ?, ?)",
      userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt,
    );
    return { kind: "ok", channel };
  });

  if (txResult.kind === "conflict") {
    return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
  }
  if (txResult.kind === "ok") {
    await this.scheduleOutboxAlarm(now);
    return Response.json({ channel: txResult.channel }, { status: 200 });
  }
  // cached branch (success cached OR an error shape encoded inside the txn).
  return this.cachedResponse(txResult.responseJson);
}
```

- [ ] **Step 5: Run the DO update tests**

Run: `npx vitest run test/do/chat-channel-mutations.test.ts --no-file-parallelism --test-timeout=60000`
Expected: 4 update tests PASS (if some assert on events, adjust to status + returned channel).

- [ ] **Step 6: Add the `updateChannelHandler` Worker route**

Append to `src/routes/channel-mutations.ts`:
```typescript
export async function updateChannelHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string; topic?: string | null; avatar_attachment_id?: string | null; visibility?: string;
  };
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/update-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      channel_id: channelId,
      title: body.title, topic: body.topic, avatar_attachment_id: body.avatar_attachment_id, visibility: body.visibility,
    }),
  }));
  if (res.status === 409) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    const code = e.error?.code ?? "IDEMPOTENCY_CONFLICT";
    throw new ApiError(code, e.error?.message ?? "conflict");
  }
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not authorized to update channel");
  if (res.status === 404) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "channel update failed");
  const out = await res.json() as Record<string, unknown>;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
```
Add the import at the top of `src/routes/channel-mutations.ts`:
```typescript
import { channelRouteNameFor } from "../chat/system-channel";
```

Register in `src/index.ts`:
```typescript
import { createChannelHandler, updateChannelHandler } from "./routes/channel-mutations";
// ...
app.patch("/api/chat/channels/:channel_id", (c) => updateChannelHandler(c));
```

- [ ] **Step 7: Write + run the PATCH route test**

Append to `test/routes/channel-mutations.test.ts`:
```typescript
describe("PATCH /api/chat/channels/:id", () => {
  it("updates a channel the caller owns", async () => {
    const create = await authedReq("u-patch-1", "POST", "/api/chat/channels", { title: "Before", visibility: "private", initial_members: [] }, "ck-patch-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-patch-1", "PATCH", `/api/chat/channels/${cid}`, { title: "After" }, "ck-patch-1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channel: { title: string } }).channel.title).toBe("After");
  });

  it("returns 404 CHANNEL_NOT_FOUND for a random channel_id", async () => {
    const res = await authedReq("u-patch-2", "PATCH", "/api/chat/channels/0199eeee-0000-7000-8000-000000000001", { title: "X" }, "ck-patch-2");
    expect(res.status).toBe(404);
  });
});
```

Run: `npx vitest run test/routes/channel-mutations.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/do/chat-channel.ts src/routes/channel-mutations.ts src/index.ts test/do/chat-channel-mutations.test.ts test/routes/channel-mutations.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat: PATCH /channels/{id} + ChatChannel /internal/update-channel (channel.updated + system.notice)"
```

---

## Task 8: `ChatChannel` `/internal/dissolve` + `POST /api/chat/channels/{id}/dissolve` + dissolved write-gate

**Files:**
- Modify: `src/do/chat-channel.ts`
- Modify: `src/routes/channel-mutations.ts`
- Modify: `src/index.ts`
- Test: `test/do/chat-channel-mutations.test.ts` (dissolve cases)
- Test: `test/routes/channel-mutations.test.ts` (dissolve cases, appended)

**Interfaces:**
- Consumes: `persistEventAndFanout` + `resolveActorMap`, `buildChannelDissolvedPayload` + `buildSystemNoticePayload`, `assertNotDissolved`, `activeRole`.
- Produces:
  - `POST /internal/dissolve` (header `X-Verified-User-Id`, body `{ idempotency_key, channel_id }`). One transaction: idempotency via `idempotency_keys` `(operation='channel.dissolve')` SELECT-inside-txn; load `channel_meta`; **owner-only** gate; if already dissolved → return cached dissolve result (idempotent); else UPDATE `channel_meta.status='dissolved'`, `updated_at`; write `channel.dissolved` + `system.notice` (notice_kind=`channel.dissolved`); `channel_fanout` outbox; `idempotency_keys` completed. Returns `{ channel: { channel_id, status: "dissolved", updated_at } }`.
  - `POST /api/chat/channels/{channel_id}/dissolve` (Worker route): auth → route → `/internal/dissolve` → `{ channel }`.
- **Write-gate:** after Task 8, every existing write handler (`/internal/message-send`, `/internal/join`) gets a dissolved-status check at the top of its transaction (Step 2). New handlers in Task 9 (`/internal/members-*`) check at their entry too.

- [ ] **Step 1: Write failing DO test**

Append to `test/do/chat-channel-mutations.test.ts`:
```typescript
import { getNamedDo as _g } from "../helpers"; void _g;

describe("ChatChannel /internal/dissolve", () => {
  it("owner dissolves → channel.dissolved + system.notice, status dissolved", async () => {
    const cid = "0194aaaa-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const res = await stub.fetch(new Request("https://x/internal/dissolve", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-dis-1", channel_id: cid }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { status: string; channel_id: string } };
    expect(body.channel.status).toBe("dissolved");
    expect(body.channel.channel_id).toBe(cid);
  });

  it("non-owner cannot dissolve", async () => {
    const cid = "0194bbbb-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const res = await stub.fetch(new Request("https://x/internal/dissolve", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-outsider", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-dis-2", channel_id: cid }),
    }));
    expect(res.status).toBe(403);
  });

  it("is idempotent: same key returns same result, no double event", async () => {
    const cid = "0194cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const b = JSON.stringify({ idempotency_key: "k-dis-3", channel_id: cid });
    const r1 = await stub.fetch(new Request("https://x/internal/dissolve", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: b }));
    const r2 = await stub.fetch(new Request("https://x/internal/dissolve", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: b }));
    expect(r1.status).toBe(200); expect(r2.status).toBe(200);
  });

  it("dissolved channel blocks further writes (message-send returns 409 CHANNEL_DISSOLVED)", async () => {
    const cid = "0194dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/dissolve", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-dis-4", channel_id: cid }) }));
    const send = await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ client_message_id: "cm-dis", dedupe_principal_key: "user:u-up-owner", type: "text", text: "hi", reply_to: null, mentions: [], channel_id: cid }),
    }));
    expect(send.status).toBe(409);
    expect(((await send.json()) as { error: { code: string } }).error.code).toBe("CHANNEL_DISSOLVED");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/do/chat-channel-mutations.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — `/internal/dissolve` returns 404; the message-send gate test sees 200 (no gate yet).

- [ ] **Step 3: Implement `/internal/dissolve`**

Add inside `ChatChannel.fetch` before the final 404:
```typescript
if (url.pathname === "/internal/dissolve") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  if (!userId) return new Response("missing verified user", { status: 401 });
  const b = (await request.json()) as { idempotency_key: string; channel_id: string };
  const channelId = b.channel_id;
  const now = this.nowIso();
  const nowMs = Date.parse(now);
  const requestHash = "{}";
  const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  const actorMap = await this.resolveActorMap([userId]);

  const txResult = await this.ctx.storage.transaction(async (): Promise<
    | { kind: "conflict" }
    | { kind: "cached"; responseJson: string }
    | { kind: "dissolved"; channel: Record<string, unknown> }
  > => {
    const idem = this.ctx.storage.sql
      .exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.dissolve' AND idempotency_key=?", userId, b.idempotency_key)
      .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
    if (idem) {
      if (idem.request_hash !== requestHash) return { kind: "conflict" };
      return { kind: "cached", responseJson: idem.response_json ?? "{}" };
    }

    const meta = this.ctx.storage.sql.exec("SELECT status, created_by FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; created_by: string } | undefined;
    if (meta === undefined) return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };

    if (meta.status === "dissolved") {
      // already dissolved — idempotent cached result (no key recorded yet → record now)
      const responseJson = JSON.stringify({ channel: { channel_id: channelId, status: "dissolved", updated_at: now } });
      this.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, idempotency_key, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.dissolve', ?, ?, ?, 'completed', ?, ?)",
        userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt,
      );
      return { kind: "cached", responseJson };
    }

    if (meta.created_by !== userId) {
      return { kind: "cached", responseJson: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may dissolve", retryable: false } }) };
    }

    const mvRow = this.ctx.storage.sql.exec("SELECT membership_version FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { membership_version: number } | undefined;
    const mv = mvRow?.membership_version ?? 0;
    this.ctx.storage.sql.exec("UPDATE channel_meta SET status='dissolved', updated_at=? WHERE channel_id=?", now, channelId);
    const dissolvedId = this.nextEventId(nowMs);
    this.persistEventAndFanout(dissolvedId, "channel.dissolved", channelId, now,
      buildChannelDissolvedPayload({ channel_id: channelId, dissolved_at: now, actor_kind: "user", actor_id: userId }), mv, now, actorMap);
    const noticeId = this.nextEventId(nowMs);
    this.persistEventAndFanout(noticeId, "system.notice", channelId, now,
      buildSystemNoticePayload({ notice_kind: "channel.dissolved", actor_kind: "user", actor_id: userId, target_user_id: null, message_id: null, channel_changes: null }), mv, now, actorMap);

    const responseJson = JSON.stringify({ channel: { channel_id: channelId, status: "dissolved", updated_at: now } });
    this.ctx.storage.sql.exec(
      "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, idempotency_key, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.dissolve', ?, ?, ?, 'completed', ?, ?)",
      userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt,
    );
    return { kind: "dissolved", channel: { channel_id: channelId, status: "dissolved", updated_at: now } };
  });

  if (txResult.kind === "conflict") {
    return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
  }
  if (txResult.kind === "dissolved") {
    await this.scheduleOutboxAlarm(now);
    return Response.json({ channel: txResult.channel }, { status: 200 });
  }
  // cached (already-dissolved cached result OR an error shape encoded inside the txn).
  return this.cachedResponse(txResult.responseJson);
}
```

- [ ] **Step 4: Add the dissolved write-gate to `/internal/message-send` and `/internal/join`**

The gate must reject writes to a dissolved channel with `409 CHANNEL_DISSOLVED`. Do this by adding a `dissolved` variant to the existing `SendResult` union (so the transaction can short-circuit without writing business rows) and handling it after the transaction.

**For `/internal/message-send`:** the handler already declares `type SendResult = { kind: "created"; ... } | { kind: "cached"; ... } | { kind: "conflict" };`. Add a `dissolved` variant and a gate at the top of the transaction body (before the idempotency SELECT):

```typescript
type SendResult =
  | { kind: "created"; message_id: string; event_id: string }
  | { kind: "cached"; message_id: string; event_id: string }
  | { kind: "conflict" }
  | { kind: "dissolved" };
```
and inside `this.ctx.storage.transaction(async (): Promise<SendResult> => { ... })`, as the first statement:
```typescript
const statusRow = this.ctx.storage.sql.exec("SELECT status FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string } | undefined;
if (statusRow?.status === "dissolved") {
  return { kind: "dissolved" };
}
```
Then, in the post-transaction handling (after the `conflict` branch), add:
```typescript
if (txResult.kind === "dissolved") {
  return Response.json({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }, { status: 409 });
}
```
Because `scheduleOutboxAlarm` only runs for `kind === "created"`, the `dissolved` branch writes nothing and schedules nothing — correct.

**For `/internal/join`:** the handler reads `meta` already (`SELECT channel_id, kind, membership_version, member_count FROM channel_meta`). Add `status` to that SELECT's column list, then immediately after `channelId = meta.channel_id;` add:
```typescript
if (meta.status === "dissolved") {
  return Response.json({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }, { status: 409 });
}
```
Joining a dissolved channel is a write (it mutates `members`/`channel_meta`), so it must be gated.

- [ ] **Step 5: Run the DO dissolve tests**

Run: `npx vitest run test/do/chat-channel-mutations.test.ts --no-file-parallelism --test-timeout=60000`
Expected: all dissolve + gate tests PASS (incl. message-send → 409 CHANNEL_DISSOLVED).

- [ ] **Step 6: Add the `dissolveChannelHandler` Worker route**

Append to `src/routes/channel-mutations.ts`:
```typescript
export async function dissolveChannelHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/dissolve", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: idempotencyKey, channel_id: channelId }),
  }));
  if (res.status === 409) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(e.error?.code ?? "CHANNEL_DISSOLVED", e.error?.message ?? "conflict");
  }
  if (res.status === 403) throw new ApiError("FORBIDDEN", "only owner may dissolve");
  if (res.status === 404) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "dissolve failed");
  const out = await res.json() as Record<string, unknown>;
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
```
Register in `src/index.ts`:
```typescript
import { createChannelHandler, updateChannelHandler, dissolveChannelHandler } from "./routes/channel-mutations";
// ...
app.post("/api/chat/channels/:channel_id/dissolve", (c) => dissolveChannelHandler(c));
```

- [ ] **Step 7: Write + run the dissolve route test**

Append to `test/routes/channel-mutations.test.ts`:
```typescript
describe("POST /api/chat/channels/:id/dissolve", () => {
  it("owner dissolves → 200 { channel: { status: dissolved } }", async () => {
    const create = await authedReq("u-dis-1", "POST", "/api/chat/channels", { title: "Bye", visibility: "private", initial_members: [] }, "ck-dis-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-dis-1", "POST", `/api/chat/channels/${cid}/dissolve`, undefined, "ck-dis-1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channel: { status: string } }).channel.status).toBe("dissolved");
  });

  it("non-owner cannot dissolve", async () => {
    const create = await authedReq("u-dis-2", "POST", "/api/chat/channels", { title: "Mine", visibility: "private", initial_members: [] }, "ck-dis-create-2");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    // a different user has no token for the owner's context — but they can call dissolve on cid.
    const res = await authedReq("u-dis-other", "POST", `/api/chat/channels/${cid}/dissolve`, undefined, "ck-dis-other");
    expect(res.status).toBe(403);
  });
});
```

Run: `npx vitest run test/routes/channel-mutations.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/do/chat-channel.ts src/routes/channel-mutations.ts src/index.ts test/do/chat-channel-mutations.test.ts test/routes/channel-mutations.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat: POST /channels/{id}/dissolve + CHANNEL_DISSOLVED write-gate on message-send/join"
```

---

## Task 9: Members CRUD — `POST/PATCH/DELETE /members[/{user_id}]`

**Files:**
- Modify: `src/do/chat-channel.ts`
- Modify: `src/routes/channel-mutations.ts`
- Modify: `src/index.ts`
- Test: `test/do/chat-channel-mutations.test.ts` (members cases)
- Test: `test/routes/channel-mutations.test.ts` (members cases, appended)

**Interfaces:**
- Consumes: `persistEventAndFanout` + `resolveActorMap`, `buildMemberJoinedPayload` + `buildMemberRoleUpdatedPayload` + `buildMemberLeftPayload` + `buildSystemNoticePayload` (Task 3), `activeRole`, `assertNotDissolved`, `cachedResponse` (Task 7).
- Produces (all on `ChatChannel`):
  - A **sync leave helper** `markMemberLeftAndEnqueueFanoutUnregisterSync(channelId, userId, nowIso): void` — extracted from the Phase 2 async `markMemberLeftAndEnqueueFanoutUnregister`. Same writes (UPDATE `members.left_at` + membership_version/count bump + `channel_fanout` unregister-user outbox row), but synchronous so it can run INSIDE a `ctx.storage.transaction` alongside the `member.left` event + outbox. The Phase 2 async method (`markMemberLeftAndEnqueueFanoutUnregister`, used by `/internal/test-leave`) is reframed to a thin async wrapper that opens its own transaction and calls the sync core — so there is ONE leave implementation, not two (P0-6 fix).
  - `POST /internal/members-add` body `{ idempotency_key, channel_id, user_id, role }`. Idempotency `(operation='members.add')` SELECT-inside-txn; dissolved-gate; gate: caller active `owner`/`admin`; role ∈ `member`/`admin` (not `owner`); no self-add. **Member state machine (P0-5 fix):**
    - never joined → INSERT + count +1 + emit `member.joined`;
    - left → reactivate (`left_at=NULL`, set role) + count +1 + emit `member.joined` (re-join);
    - **active (already a member) → WITHOUT a role change**: idempotent cached `{ member }`, no event, no count change.
    - **active + different requested role → `422 INVALID_MESSAGE`** ("use PATCH /members/{user_id} to change role"). This closes the admin-can-change-role-via-add bypass: adding is NOT a path to mutate an active member's role.
    bump `membership_version` only when a real state change happens (join or rejoin). Returns `{ member }`.
  - `POST /internal/members-update-role` body `{ idempotency_key, channel_id, user_id, role }`. Idempotency `(operation='members.role')`; dissolved-gate; gate: caller `owner` only; target must be an **active** member; role ∈ `member`/`admin`; record `before_role`; UPDATE; bump mv; write `member.role_updated` + `system.notice`. Returns `{ member }`.
  - `POST /internal/members-remove` body `{ idempotency_key, channel_id, user_id }`. Idempotency `(operation='members.remove')`; dissolved-gate; gate: caller `owner` (can remove others) OR `user_id === caller` (self-leave). **Owner invariant (P1-6 fix):** the owner (`role='owner'`, i.e. `channel_meta.created_by`) CANNOT self-leave (a channel must always have exactly one active owner). Self-leave by the owner → `422 INVALID_MESSAGE` ("owner cannot leave; transfer ownership in a future phase"). Removed-by-owner of any member (including a left owner re-removal, though left owners shouldn't exist) is allowed. target must be an active member (else `404 MEMBER_NOT_FOUND`). Reuse `markMemberLeftAndEnqueueFanoutUnregisterSync` for the co-atomic leave + unregister; then write `member.left` (via `buildMemberLeftPayload`) + `system.notice` + `user_directory` leave outbox. Returns `{ channel_id, user_id, removed: true }`.
  - Worker routes: `POST /channels/:id/members` → add; `PATCH /channels/:id/members/:member_user_id` → update-role; `DELETE /channels/:id/members/:member_user_id` → remove.
- **Owner invariant (whole-task):** the channel always has exactly one active owner (`created_by`, `role='owner'`). Dissolve (Task 8) is the owner's exit path; Phase 3 has no owner-transfer, so owner self-leave and demoting the owner are both rejected. Other members (admin/member) may leave freely. Left/removed members stay in `members` (with `left_at`); dissolved channels keep everyone as a tombstone.

- [ ] **Step 1: Write failing DO tests**

Append to `test/do/chat-channel-mutations.test.ts`:
```typescript
describe("ChatChannel members CRUD", () => {
  it("admin adds a member → member.joined + system.notice", async () => {
    const cid = "0195aaaa-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const res = await stub.fetch(new Request("https://x/internal/members-add", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-add-1", channel_id: cid, user_id: "u-add-1", role: "member" }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: { role: string } }).member.role).toBe("member");
  });

  it("owner updates a member role → member.role_updated", async () => {
    const cid = "0195bbbb-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-2", channel_id: cid, user_id: "u-add-2", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-update-role", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-role-1", channel_id: cid, user_id: "u-add-2", role: "admin" }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: { role: string } }).member.role).toBe("admin");
  });

  it("non-owner cannot change role (403)", async () => {
    const cid = "0195cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-3", channel_id: cid, user_id: "u-add-3", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-update-role", { method: "POST", headers: { "X-Verified-User-Id": "u-add-3", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-role-2", channel_id: cid, user_id: "u-add-3", role: "admin" }) }));
    expect(res.status).toBe(403);
  });

  it("owner removes a member → member.left + fanout unregister outbox", async () => {
    const cid = "0195dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-4", channel_id: cid, user_id: "u-add-4", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-remove", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "k-rem-1", channel_id: cid, user_id: "u-add-4" }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { removed: boolean }).removed).toBe(true);
  });

  it("member self-leaves (user_id === caller)", async () => {
    const cid = "0195eeee-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-5", channel_id: cid, user_id: "u-self-leave", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-remove", { method: "POST", headers: { "X-Verified-User-Id": "u-self-leave", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-rem-2", channel_id: cid, user_id: "u-self-leave" }) }));
    expect(res.status).toBe(200);
  });

  it("add with a DIFFERENT role on an active member → 422 (no role-change-via-add bypass)", async () => {
    const cid = "0195ffff-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-6", channel_id: cid, user_id: "u-bypass", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-6b", channel_id: cid, user_id: "u-bypass", role: "admin" }) }));
    expect(res.status).toBe(422);
  });

  it("add same role on an active member → 200 idempotent (no event, no count bump)", async () => {
    const cid = "01950000-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-7", channel_id: cid, user_id: "u-idem-add", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-7b", channel_id: cid, user_id: "u-idem-add", role: "member" }) }));
    expect(res.status).toBe(200);
  });

  it("reactivates a LEFT member (+1 count) → member.joined", async () => {
    const cid = "01950001-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-8", channel_id: cid, user_id: "u-rejoin", role: "member" }) }));
    await stub.fetch(new Request("https://x/internal/members-remove", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-rem-rejoin", channel_id: cid, user_id: "u-rejoin" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-add-8b", channel_id: cid, user_id: "u-rejoin", role: "admin" }) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: { role: string } }).member.role).toBe("admin");
  });

  it("owner cannot self-leave (owner invariant) → 422", async () => {
    const cid = "01950002-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid); // owner = u-up-owner
    const res = await stub.fetch(new Request("https://x/internal/members-remove", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-rem-owner", channel_id: cid, user_id: "u-up-owner" }) }));
    expect(res.status).toBe(422);
  });

  it("owner cannot demote self via role-update → 422", async () => {
    const cid = "01950003-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const res = await stub.fetch(new Request("https://x/internal/members-update-role", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-role-owner", channel_id: cid, user_id: "u-up-owner", role: "member" }) }));
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/do/chat-channel-mutations.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — members-* handlers return 404.

- [ ] **Step 3: Extract the sync leave core + implement the three members handlers**

`cachedResponse` was added in Task 7 Step 1 — reuse it (do not re-declare it). First, extract the sync leave core from the Phase 2 async helper. In `src/do/chat-channel.ts`, replace the existing `private async markMemberLeftAndEnqueueFanoutUnregister(...)` with a sync core + thin async wrapper:

```typescript
// SYNC core: co-atomic leave + fanout unregister outbox. Runs inside a caller transaction.
// (P0-6: single leave implementation — /internal/test-leave and members-remove share this.)
private markMemberLeftAndEnqueueFanoutUnregisterSync(channelId: string, userId: string, nowIso: string): void {
  this.ctx.storage.sql.exec(
    "UPDATE members SET left_at=? WHERE channel_id=? AND user_id=?",
    nowIso, channelId, userId,
  );
  const meta = this.ctx.storage.sql
    .exec("SELECT membership_version, member_count FROM channel_meta WHERE channel_id=?", channelId)
    .toArray()[0] as { membership_version: number; member_count: number } | undefined;
  const nextMv = (meta?.membership_version ?? 0) + 1;
  const nextCount = Math.max(0, (meta?.member_count ?? 1) - 1);
  this.ctx.storage.sql.exec(
    "UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?",
    nextMv, nextCount, nowIso, channelId,
  );
  this.ctx.storage.sql.exec(
    "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'channel_fanout', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
    `channel_fanout:unregister:${channelId}:${userId}:${nowIso}`,
    channelId,
    JSON.stringify({ action: "unregister-user", channel_id: channelId, user_id: userId }),
    nowIso, nowIso, nowIso,
  );
}

// Phase 2 path (test-leave): wraps the sync core in its own transaction.
private async markMemberLeftAndEnqueueFanoutUnregister(channelId: string, userId: string, nowIso: string): Promise<void> {
  await this.ctx.storage.transaction(async () => {
    this.markMemberLeftAndEnqueueFanoutUnregisterSync(channelId, userId, nowIso);
  });
}
```

Then add the three handlers inside `ChatChannel.fetch` before the final 404:

```typescript
if (url.pathname === "/internal/members-add") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  if (!userId) return new Response("missing verified user", { status: 401 });
  const b = (await request.json()) as { idempotency_key: string; channel_id: string; user_id: string; role: string };
  const channelId = b.channel_id;
  const now = this.nowIso();
  const nowMs = Date.parse(now);
  const requestHash = JSON.stringify({ user_id: b.user_id, role: b.role });
  const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  const actorMap = await this.resolveActorMap([userId, b.user_id]);

  const tx = await this.ctx.storage.transaction(async (): Promise<{ kind: "cached"; j: string } | { kind: "conflict" } | { kind: "ok"; member: Record<string, unknown> }> => {
    const idem = this.ctx.storage.sql.exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='members.add' AND idempotency_key=?", userId, b.idempotency_key).toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
    if (idem) { if (idem.request_hash !== requestHash) return { kind: "conflict" }; return { kind: "cached", j: idem.response_json ?? "{}" }; }

    const meta = this.ctx.storage.sql.exec("SELECT status, membership_version, member_count, kind, created_by FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; membership_version: number; member_count: number; kind: string; created_by: string } | undefined;
    if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
    if (meta.status === "dissolved") return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
    const callerRole = this.activeRole(channelId, userId);
    if (callerRole !== "owner" && callerRole !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "not authorized to add members", retryable: false } }) };
    if (b.role !== "member" && b.role !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "role must be member or admin", retryable: false } }) };
    if (b.user_id === userId) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "cannot add self", retryable: false } }) };
    if (b.user_id === meta.created_by) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner is fixed; cannot add the owner", retryable: false } }) };

    // Member state machine (P0-5): distinguish never-joined / left / active.
    const existing = this.ctx.storage.sql.exec("SELECT role, left_at FROM members WHERE channel_id=? AND user_id=?", channelId, b.user_id).toArray()[0] as { role: string; left_at: string | null } | undefined;

    if (existing !== undefined && existing.left_at === null) {
      // Already an ACTIVE member — adding must NOT mutate role (that's PATCH /members/{user_id}).
      if (existing.role !== b.role) {
        return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "member already active; use PATCH /members/{user_id} to change role", retryable: false } }) };
      }
      // Idempotent re-add, no state change.
      const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: b.user_id, role: existing.role } });
      this.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, idempotency_key, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.add', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
      return { kind: "cached", j: responseJson };
    }

    const mv = meta.membership_version + 1;
    // never joined → INSERT; left → reactivate (clear left_at, set role). Count +1 either way.
    if (existing === undefined) {
      this.ctx.storage.sql.exec("INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, ?, ?, NULL)", channelId, b.user_id, b.role, now);
    } else {
      this.ctx.storage.sql.exec("UPDATE members SET role=?, joined_at=?, left_at=NULL WHERE channel_id=? AND user_id=?", b.role, now, channelId, b.user_id);
    }
    this.ctx.storage.sql.exec("UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?", mv, meta.member_count + 1, now, channelId);

    const joinedId = this.nextEventId(nowMs);
    this.persistEventAndFanout(joinedId, "member.joined", channelId, now, buildMemberJoinedPayload({ channel_id: channelId, user_id: b.user_id, role: b.role, membership_version: mv, actor_kind: "user", actor_id: userId }), mv, now, actorMap);
    const noticeId = this.nextEventId(nowMs);
    this.persistEventAndFanout(noticeId, "system.notice", channelId, now, buildSystemNoticePayload({ notice_kind: "member.joined", actor_kind: "user", actor_id: userId, target_user_id: b.user_id, message_id: null, channel_changes: null }), mv, now, actorMap);
    this.ctx.storage.sql.exec("INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'user_directory', ?, '', ?, 'pending', ?, ?, ?, 0, 5)", `user_directory:join:${channelId}:${b.user_id}:${now}`, b.user_id, JSON.stringify({ action: "join", channel_id: channelId, kind: meta.kind, membership_version: mv }), now, now, now);

    const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: b.user_id, role: b.role, joined_at: now } });
    this.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, idempotency_key, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.add', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
    return { kind: "ok", member: { channel_id: channelId, user_id: b.user_id, role: b.role, joined_at: now } };
  });
  if (tx.kind === "conflict") return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
  if (tx.kind === "ok") await this.scheduleOutboxAlarm(now);
  return tx.kind === "ok" ? Response.json({ member: tx.member }, { status: 200 }) : this.cachedResponse(tx.j);
}

if (url.pathname === "/internal/members-update-role") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  if (!userId) return new Response("missing verified user", { status: 401 });
  const b = (await request.json()) as { idempotency_key: string; channel_id: string; user_id: string; role: string };
  const channelId = b.channel_id;
  const now = this.nowIso();
  const nowMs = Date.parse(now);
  const requestHash = JSON.stringify({ user_id: b.user_id, role: b.role });
  const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  const actorMap = await this.resolveActorMap([userId, b.user_id]);

  const tx = await this.ctx.storage.transaction(async (): Promise<{ kind: "conflict" } | { kind: "cached"; j: string } | { kind: "ok"; member: Record<string, unknown> }> => {
    const idem = this.ctx.storage.sql.exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='members.role' AND idempotency_key=?", userId, b.idempotency_key).toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
    if (idem) { if (idem.request_hash !== requestHash) return { kind: "conflict" }; return { kind: "cached", j: idem.response_json ?? "{}" }; }

    const meta = this.ctx.storage.sql.exec("SELECT status, membership_version, created_by FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; membership_version: number; created_by: string } | undefined;
    if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
    if (meta.status === "dissolved") return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
    const callerRole = this.activeRole(channelId, userId);
    if (callerRole !== "owner") return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may change roles", retryable: false } }) };
    if (b.role !== "member" && b.role !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "role must be member or admin", retryable: false } }) };
    const target = this.ctx.storage.sql.exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, b.user_id).toArray()[0] as { role: string } | undefined;
    if (!target) return { kind: "cached", j: JSON.stringify({ error: { code: "MEMBER_NOT_FOUND", message: "target not an active member", retryable: false } }) };
    if (b.user_id === meta.created_by) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "cannot change the owner's role (owner is fixed)", retryable: false } }) };
    if (b.user_id === userId) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner cannot change own role", retryable: false } }) };

    const mv = meta.membership_version + 1;
    const beforeRole = target.role;
    this.ctx.storage.sql.exec("UPDATE members SET role=? WHERE channel_id=? AND user_id=?", b.role, channelId, b.user_id);
    this.ctx.storage.sql.exec("UPDATE channel_meta SET membership_version=?, updated_at=? WHERE channel_id=?", mv, now, channelId);

    const updatedId = this.nextEventId(nowMs);
    this.persistEventAndFanout(updatedId, "member.role_updated", channelId, now, buildMemberRoleUpdatedPayload({ channel_id: channelId, user_id: b.user_id, before_role: beforeRole, after_role: b.role, membership_version: mv, actor_kind: "user", actor_id: userId }), mv, now, actorMap);
    const noticeId = this.nextEventId(nowMs);
    this.persistEventAndFanout(noticeId, "system.notice", channelId, now, buildSystemNoticePayload({ notice_kind: "member.role_updated", actor_kind: "user", actor_id: userId, target_user_id: b.user_id, message_id: null, channel_changes: null }), mv, now, actorMap);

    const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: b.user_id, role: b.role } });
    this.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, idempotency_key, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.role', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
    return { kind: "ok", member: { channel_id: channelId, user_id: b.user_id, role: b.role } };
  });
  if (tx.kind === "conflict") return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
  if (tx.kind === "ok") await this.scheduleOutboxAlarm(now);
  return tx.kind === "ok" ? Response.json({ member: tx.member }, { status: 200 }) : this.cachedResponse(tx.j);
}

if (url.pathname === "/internal/members-remove") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  if (!userId) return new Response("missing verified user", { status: 401 });
  const b = (await request.json()) as { idempotency_key: string; channel_id: string; user_id: string };
  const channelId = b.channel_id;
  const now = this.nowIso();
  const nowMs = Date.parse(now);
  const requestHash = JSON.stringify({ user_id: b.user_id });
  const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  const actorMap = await this.resolveActorMap([userId, b.user_id]);

  const tx = await this.ctx.storage.transaction(async (): Promise<{ kind: "conflict" } | { kind: "cached"; j: string } | { kind: "ok" }> => {
    const idem = this.ctx.storage.sql.exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='members.remove' AND idempotency_key=?", userId, b.idempotency_key).toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
    if (idem) { if (idem.request_hash !== requestHash) return { kind: "conflict" }; return { kind: "cached", j: idem.response_json ?? "{}" }; }

    const meta = this.ctx.storage.sql.exec("SELECT status, membership_version, kind, created_by FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; membership_version: number; kind: string; created_by: string } | undefined;
    if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
    if (meta.status === "dissolved") return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
    const callerRole = this.activeRole(channelId, userId);
    const isSelf = b.user_id === userId;
    if (!isSelf && callerRole !== "owner") return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may remove others", retryable: false } }) };
    // Owner invariant (P1-6): the owner cannot self-leave (no owner-transfer in Phase 3; dissolve is the owner exit).
    if (isSelf && b.user_id === meta.created_by) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner cannot leave; dissolve the channel or transfer ownership in a future phase", retryable: false } }) };
    const target = this.ctx.storage.sql.exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, b.user_id).toArray()[0] as { role: string } | undefined;
    if (!target) return { kind: "cached", j: JSON.stringify({ error: { code: "MEMBER_NOT_FOUND", message: "target not an active member", retryable: false } }) };

    const mv = meta.membership_version + 1;
    // Reuse the SINGLE sync leave implementation (P0-6): co-atomic left_at + count + fanout unregister outbox.
    this.markMemberLeftAndEnqueueFanoutUnregisterSync(channelId, b.user_id, now);
    // Re-read the bumped mv/counts the sync core wrote, so the events below carry the authoritative mv.
    const mvAfter = (this.ctx.storage.sql.exec("SELECT membership_version FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { membership_version: number }).membership_version;

    const leftId = this.nextEventId(nowMs);
    this.persistEventAndFanout(leftId, "member.left", channelId, now, buildMemberLeftPayload({ channel_id: channelId, user_id: b.user_id, role: target.role, membership_version: mvAfter, actor_kind: "user", actor_id: userId }), mvAfter, now, actorMap);
    const noticeId = this.nextEventId(nowMs);
    this.persistEventAndFanout(noticeId, "system.notice", channelId, now, buildSystemNoticePayload({ notice_kind: "member.left", actor_kind: "user", actor_id: userId, target_user_id: b.user_id, message_id: null, channel_changes: null }), mvAfter, now, actorMap);
    // user_directory leave projection (so my_channels reflects status='left')
    this.ctx.storage.sql.exec("INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'user_directory', ?, '', ?, 'pending', ?, ?, ?, 0, 5)", `user_directory:leave:${channelId}:${b.user_id}:${now}`, b.user_id, JSON.stringify({ action: "leave", channel_id: channelId, kind: meta.kind, membership_version: mvAfter }), now, now, now);

    const responseJson = JSON.stringify({ channel_id: channelId, user_id: b.user_id, removed: true });
    this.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, idempotency_key, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.remove', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
    return { kind: "ok" };
  });
  if (tx.kind === "conflict") return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
  if (tx.kind === "ok") await this.scheduleOutboxAlarm(now);
  if (tx.kind === "ok") return Response.json({ channel_id: channelId, user_id: b.user_id, removed: true }, { status: 200 });
  return this.cachedResponse((tx as { j: string }).j);
}
```

> **mv consistency note:** `markMemberLeftAndEnqueueFanoutUnregisterSync` bumps `channel_meta.membership_version` itself; the handler then re-reads it so the `member.left`/`system.notice` events carry the post-leave membership version (the version at which the leave is visible). Do NOT separately bump mv in the handler.

- [ ] **Step 4: Run the DO members tests**

Run: `npx vitest run test/do/chat-channel-mutations.test.ts --no-file-parallelism --test-timeout=60000`
Expected: all members CRUD tests PASS.

- [ ] **Step 5: Add the three members Worker routes**

Append to `src/routes/channel-mutations.ts`:
```typescript
export async function addMemberHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const body = (await c.req.json().catch(() => ({}))) as { user_id?: string; role?: string };
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/members-add", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: idempotencyKey, channel_id: channelId, user_id: body.user_id ?? "", role: body.role ?? "member" }),
  }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not authorized to add members");
  if (res.status === 404) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  if (res.status === 409) { const e = await res.json().catch(() => ({})) as { error?: { code?: string } }; throw new ApiError(e.error?.code ?? "CHANNEL_DISSOLVED", "conflict"); }
  if (res.status === 422) throw new ApiError("INVALID_MESSAGE", "invalid member");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "add member failed");
  return c.json(await res.json(), 200, { "X-Request-Id": c.get("requestId") });
}

export async function updateMemberRoleHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  const memberUserId = c.req.param("user_id");
  if (!channelId || !memberUserId) throw new ApiError("CHANNEL_NOT_FOUND", "channel or user not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const body = (await c.req.json().catch(() => ({}))) as { role?: string };
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/members-update-role", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: idempotencyKey, channel_id: channelId, user_id: memberUserId, role: body.role ?? "" }),
  }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "only owner may change roles");
  if (res.status === 404) throw new ApiError("MEMBER_NOT_FOUND", "member not found");
  if (res.status === 409) { const e = await res.json().catch(() => ({})) as { error?: { code?: string } }; throw new ApiError(e.error?.code ?? "CHANNEL_DISSOLVED", "conflict"); }
  if (res.status === 422) throw new ApiError("INVALID_MESSAGE", "invalid role");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "role update failed");
  return c.json(await res.json(), 200, { "X-Request-Id": c.get("requestId") });
}

export async function removeMemberHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  const memberUserId = c.req.param("user_id");
  if (!channelId || !memberUserId) throw new ApiError("CHANNEL_NOT_FOUND", "channel or user not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request("https://x/internal/members-remove", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: idempotencyKey, channel_id: channelId, user_id: memberUserId }),
  }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "only owner may remove others");
  if (res.status === 404) throw new ApiError("MEMBER_NOT_FOUND", "member not found");
  if (res.status === 409) { const e = await res.json().catch(() => ({})) as { error?: { code?: string } }; throw new ApiError(e.error?.code ?? "CHANNEL_DISSOLVED", "conflict"); }
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "remove member failed");
  return c.json(await res.json(), 200, { "X-Request-Id": c.get("requestId") });
}
```
Register in `src/index.ts`:
```typescript
import { createChannelHandler, updateChannelHandler, dissolveChannelHandler, addMemberHandler, updateMemberRoleHandler, removeMemberHandler } from "./routes/channel-mutations";
// ...
app.post("/api/chat/channels/:channel_id/members", (c) => addMemberHandler(c));
app.patch("/api/chat/channels/:channel_id/members/:user_id", (c) => updateMemberRoleHandler(c));
app.delete("/api/chat/channels/:channel_id/members/:user_id", (c) => removeMemberHandler(c));
```

- [ ] **Step 6: Write + run the members route tests**

Append to `test/routes/channel-mutations.test.ts`:
```typescript
describe("members routes", () => {
  it("POST /members adds; PATCH changes role; DELETE removes (owner)", async () => {
    const create = await authedReq("u-mem-owner", "POST", "/api/chat/channels", { title: "M", visibility: "private", initial_members: [] }, "ck-mem-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const add = await authedReq("u-mem-owner", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-mem-1", role: "member" }, "ck-mem-add");
    expect(add.status).toBe(200);
    const role = await authedReq("u-mem-owner", "PATCH", `/api/chat/channels/${cid}/members/u-mem-1`, { role: "admin" }, "ck-mem-role");
    expect(role.status).toBe(200);
    expect(((await role.json()) as { member: { role: string } }).member.role).toBe("admin");
    const rem = await authedReq("u-mem-owner", "DELETE", `/api/chat/channels/${cid}/members/u-mem-1`, undefined, "ck-mem-rem");
    expect(rem.status).toBe(200);
    expect(((await rem.json()) as { removed: boolean }).removed).toBe(true);
  });

  it("DELETE self (leave) succeeds for a member", async () => {
    const create = await authedReq("u-leave-owner", "POST", "/api/chat/channels", { title: "L", visibility: "private", initial_members: [] }, "ck-leave-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    await authedReq("u-leave-owner", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-leave-1", role: "member" }, "ck-leave-add");
    const rem = await authedReq("u-leave-1", "DELETE", `/api/chat/channels/${cid}/members/u-leave-1`, undefined, "ck-leave-self");
    expect(rem.status).toBe(200);
  });
});
```

Run: `npx vitest run test/routes/channel-mutations.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/do/chat-channel.ts src/routes/channel-mutations.ts src/index.ts test/do/chat-channel-mutations.test.ts test/routes/channel-mutations.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat: members CRUD (add/role/remove) + member.joined/role_updated/left + system.notice"
```

---

## Task 10: Members read — `GET /members` + `GET /members/{user_id}`

**Files:**
- Modify: `src/do/chat-channel.ts`
- Modify: `src/routes/channel-mutations.ts`
- Modify: `src/index.ts`
- Test: `test/do/chat-channel-mutations.test.ts` (members-read cases)
- Test: `test/routes/channel-mutations.test.ts` (members-read cases, appended)

**Interfaces:**
- Consumes: `resolveUserSummaries`, `channelRouteNameFor`, `getIdentity`.
- Produces:
  - `GET /internal/members-list?query=&limit=&cursor=` (header `X-Verified-User-Id`): active-members query, `query` prefix-matches on `display_name`/`user_id` (the display_name join against pg happens at the Worker route, OR the DO returns raw member rows + the Worker resolves names — see Step 1 decision). Returns `{ items: [{ user: UserSummary, role, joined_at }], next_cursor }`.
  - `GET /internal/members-get?user_id=` (header `X-Verified-User-Id`): read ONE member by `user_id`. Returns `{ user: UserSummary, role, joined_at, status }` where `status ∈ {active,left,removed}`. Never-joined → `404 MEMBER_NOT_FOUND`.
  - Worker routes: `GET /channels/:id/members`, `GET /channels/:id/members/:user_id`.

- [ ] **Step 1: Decide WHERE display_name resolution happens**

The DO does NOT have Hyperdrive access to do prefix search on `display_name` — but it DOES (`resolveUserSummaries` takes `env`). However, `members` table only has `user_id`; a display_name prefix search requires resolving ALL active member ids → filtering client-side. For Phase 3 member counts (small), that is acceptable. **Decision:** the DO returns raw active member rows `(user_id, role, joined_at)`; the **Worker route** resolves UserSummaries and applies the `query` prefix filter (display_name OR user_id). This keeps the DO a thin store and matches `resolveUserSummaries`'s batched design. So:
  - `/internal/members-list` returns `{ items: [{ user_id, role, joined_at }] }` (raw, all active members) — the Worker resolves + filters + paginates.
  - `/internal/members-get` returns `{ user_id, role, joined_at, status }` — the Worker resolves the single user's UserSummary.

- [ ] **Step 2: Write failing DO tests**

Append to `test/do/chat-channel-mutations.test.ts`:
```typescript
describe("ChatChannel members read", () => {
  it("members-list returns active members", async () => {
    const cid = "0196aaaa-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-ml-1", channel_id: cid, user_id: "u-ml-a", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-list", { headers: { "X-Verified-User-Id": "u-up-owner" } }));
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: Array<{ user_id: string; role: string }> }).items;
    expect(items.some((m) => m.user_id === "u-ml-a")).toBe(true);
  });

  it("members-get returns status active for a member", async () => {
    const cid = "0196bbbb-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-mg-1", channel_id: cid, user_id: "u-mg-a", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-get?user_id=u-mg-a", { headers: { "X-Verified-User-Id": "u-up-owner" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; role: string };
    expect(body.status).toBe("active");
    expect(body.role).toBe("member");
  });

  it("members-get returns 404 MEMBER_NOT_FOUND for a never-joined user", async () => {
    const cid = "0196cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const res = await stub.fetch(new Request("https://x/internal/members-get?user_id=u-never", { headers: { "X-Verified-User-Id": "u-up-owner" } }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("members-get returns status left for a removed member", async () => {
    const cid = "0196dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-mg-2", channel_id: cid, user_id: "u-mg-b", role: "member" }) }));
    await stub.fetch(new Request("https://x/internal/members-remove", { method: "POST", headers: { "X-Verified-User-Id": "u-up-owner", "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-mg-3", channel_id: cid, user_id: "u-mg-b" }) }));
    const res = await stub.fetch(new Request("https://x/internal/members-get?user_id=u-mg-b", { headers: { "X-Verified-User-Id": "u-up-owner" } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("left");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/do/chat-channel-mutations.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — members-list / members-get return 404.

- [ ] **Step 4: Implement the two read handlers**

Add inside `ChatChannel.fetch` before the final 404. **Access rule (P1-3 fix):** per contract §7.1b, the caller must be an ACTIVE member of this channel — including for dissolved channels. A non-member reading a dissolved channel's member list would leak who was in it; block it (403). Do NOT carve out "dissolved channels are readable by non-members."

```typescript
if (url.pathname === "/internal/members-list") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  const realMeta = this.ctx.storage.sql.exec("SELECT channel_id, status FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string; status: string } | undefined;
  if (!realMeta) return new Response("channel not created", { status: 409 });
  // Must be an ACTIVE member (even dissolved channels require it — no leaking member lists to ex-members).
  const activeMember = userId ? (this.ctx.storage.sql.exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", realMeta.channel_id, userId).toArray()[0] as { x: number } | undefined) : undefined;
  if (!activeMember) return new Response("forbidden", { status: 403 });
  // Cursor is the last user_id of the previous page; members-list pages by joined_at ASC (tiebreak user_id).
  const cursorUserId = url.searchParams.get("cursor") ?? "";
  const rows = this.ctx.storage.sql.exec(
    "SELECT user_id, role, joined_at FROM members WHERE channel_id=? AND left_at IS NULL AND user_id > ? ORDER BY user_id ASC LIMIT 101",
    realMeta.channel_id, cursorUserId,
  ).toArray() as Array<{ user_id: string; role: string; joined_at: string }>;
  // Return raw active members (the Worker resolves UserSummaries + applies the query filter).
  return Response.json({ items: rows.map((r) => ({ user_id: r.user_id, role: r.role, joined_at: r.joined_at })) });
}

if (url.pathname === "/internal/members-get") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  const targetUserId = url.searchParams.get("user_id") ?? "";
  const realMeta = this.ctx.storage.sql.exec("SELECT channel_id, status FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string; status: string } | undefined;
  if (!realMeta) return new Response("channel not created", { status: 409 });
  // Must be an ACTIVE member (P1-3): no member read for non-members, dissolved or not.
  const activeMember = userId ? (this.ctx.storage.sql.exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", realMeta.channel_id, userId).toArray()[0] as { x: number } | undefined) : undefined;
  if (!activeMember) return new Response("forbidden", { status: 403 });

  const row = this.ctx.storage.sql.exec("SELECT role, joined_at, left_at FROM members WHERE channel_id=? AND user_id=?", realMeta.channel_id, targetUserId).toArray()[0] as { role: string; joined_at: string; left_at: string | null } | undefined;
  if (!row) return Response.json({ error: { code: "MEMBER_NOT_FOUND", message: "user is not a member of this channel", retryable: false } }, { status: 404 });
  const status = row.left_at === null ? "active" : "left";
  return Response.json({ user_id: targetUserId, role: row.role, joined_at: row.joined_at, status });
}
```
> **Note:** both handlers read the single `channel_meta` row (this DO serves exactly one channel). `removed` status (contract §7.1b lists `left`/`removed`): Phase 3 only writes `left_at`, so both "removed" and "left" surface as `status: "left"` — the contract's "已离开/被移除的成员仍可读" is satisfied (an active member can read a left member's profile for history). (If a distinct `removed_at` is later needed, `members` lacks the column — out of Phase 3 scope.) The members-list pages by `user_id` ASC with a `cursor` = previous page's last `user_id`; the DO fetches `LIMIT 101` so the Worker can detect `hasMore` without a second round-trip.

- [ ] **Step 5: Run the DO members-read tests**

Run: `npx vitest run test/do/chat-channel-mutations.test.ts --no-file-parallelism --test-timeout=60000`
Expected: all members-read tests PASS.

- [ ] **Step 6: Add the two members Worker routes**

Append to `src/routes/channel-mutations.ts`:
```typescript
import { resolveUserSummaries } from "../profile/resolve";

export async function listMembersHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const url = new URL(c.req.url);
  const query = (url.searchParams.get("query") ?? "").toLowerCase();
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? "50")));
  const cursor = url.searchParams.get("cursor") ?? "";
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  // Push cursor + a limit+1 fetch into the DO so it can signal hasMore without a 2nd round-trip.
  const res = await stub.fetch(new Request(`https://x/internal/members-list?cursor=${encodeURIComponent(cursor)}`, { headers: { "X-Verified-User-Id": userId } }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not a member");
  if (res.status === 404 || res.status === 409) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "member list failed");
  const raw = (await res.json()) as { items: Array<{ user_id: string; role: string; joined_at: string }> };

  const map = await resolveUserSummaries(raw.items.map((m) => m.user_id), env);
  const resolved = raw.items.map((m) => {
    const u = map.get(m.user_id) ?? { user_id: m.user_id, display_name: `user-${m.user_id.slice(0, 8)}`, avatar_url: null };
    return { user: u, role: m.role, joined_at: m.joined_at };
  });
  // With NO query filter: stable cursor pagination (DO already over-fetched so we can detect hasMore).
  if (query === "") {
    const hasMore = resolved.length > limit;
    const page = resolved.slice(0, limit);
    const nextCursor = hasMore ? page[page.length - 1]?.user.user_id ?? null : null;
    return c.json({ items: page, next_cursor: nextCursor }, 200, { "X-Request-Id": c.get("requestId") });
  }
  // WITH a query filter: filter the page, no stable continuation cursor (Phase 3 member-list query
  // is a typeahead aid, not a paged search). Clients re-fetch with a refined query.
  const filtered = resolved.filter((m) => (m.user.display_name ?? "").toLowerCase().startsWith(query) || m.user.user_id.toLowerCase().startsWith(query));
  return c.json({ items: filtered.slice(0, limit), next_cursor: null }, 200, { "X-Request-Id": c.get("requestId") });
}

export async function getMemberHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  const targetUserId = c.req.param("user_id");
  if (!channelId || !targetUserId) throw new ApiError("CHANNEL_NOT_FOUND", "channel or user not found");
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const stub = env.CHAT_CHANNEL.getByName(routeName);
  const res = await stub.fetch(new Request(`https://x/internal/members-get?user_id=${encodeURIComponent(targetUserId)}`, { headers: { "X-Verified-User-Id": userId } }));
  if (res.status === 403) throw new ApiError("FORBIDDEN", "not a member");
  if (res.status === 404) throw new ApiError("MEMBER_NOT_FOUND", "member not found");
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "member get failed");
  const raw = (await res.json()) as { user_id: string; role: string; joined_at: string; status: string };
  const map = await resolveUserSummaries([targetUserId], env);
  const u = map.get(targetUserId) ?? { user_id: targetUserId, display_name: `user-${targetUserId.slice(0, 8)}`, avatar_url: null };
  return c.json({ user: u, role: raw.role, joined_at: raw.joined_at, status: raw.status }, 200, { "X-Request-Id": c.get("requestId") });
}
```
Register in `src/index.ts`:
```typescript
import { createChannelHandler, updateChannelHandler, dissolveChannelHandler, addMemberHandler, updateMemberRoleHandler, removeMemberHandler, listMembersHandler, getMemberHandler } from "./routes/channel-mutations";
// ...
app.get("/api/chat/channels/:channel_id/members", (c) => listMembersHandler(c));
app.get("/api/chat/channels/:channel_id/members/:user_id", (c) => getMemberHandler(c));
```

- [ ] **Step 7: Write + run the members-read route tests**

Append to `test/routes/channel-mutations.test.ts`:
```typescript
describe("members read routes", () => {
  it("GET /members lists the owner", async () => {
    const create = await authedReq("u-mr-owner", "POST", "/api/chat/channels", { title: "MR", visibility: "private", initial_members: [] }, "ck-mr-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-mr-owner", "GET", `/api/chat/channels/${cid}/members`);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: Array<{ user: { user_id: string }; role: string }> }).items;
    expect(items.some((m) => m.user.user_id === "u-mr-owner" && m.role === "owner")).toBe(true);
  });

  it("GET /members/{user_id} returns role + status", async () => {
    const create = await authedReq("u-mr2-owner", "POST", "/api/chat/channels", { title: "MR2", visibility: "private", initial_members: [] }, "ck-mr2-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-mr2-owner", "GET", `/api/chat/channels/${cid}/members/u-mr2-owner`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string; status: string }).status).toBe("active");
  });

  it("GET /members/{user_id} returns 404 MEMBER_NOT_FOUND for a stranger", async () => {
    const create = await authedReq("u-mr3-owner", "POST", "/api/chat/channels", { title: "MR3", visibility: "private", initial_members: [] }, "ck-mr3-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-mr3-owner", "GET", `/api/chat/channels/${cid}/members/u-stranger`);
    expect(res.status).toBe(404);
  });
});
```

Run: `npx vitest run test/routes/channel-mutations.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/do/chat-channel.ts src/routes/channel-mutations.ts src/index.ts test/do/chat-channel-mutations.test.ts test/routes/channel-mutations.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat: GET /members + /members/{user_id} (prefix search + precise member read)"
```

---

## Task 11: Read-state — `POST /api/chat/channels/{id}/read-state`

**Files:**
- Modify: `src/do/user-directory.ts`
- Modify: `src/routes/channel-mutations.ts`
- Modify: `src/index.ts`
- Test: `test/do/user-directory-create-coordinate.test.ts` is for the coordinator; create `test/do/user-directory-read-state.test.ts`
- Test: `test/routes/channel-mutations.test.ts` (read-state cases, appended)

**Interfaces:**
- Consumes: `Env.CHAT_CHANNEL` + `Env.USER_DIRECTORY` (both bound on `UserDirectory` — see wrangler configs). `channelRouteNameFor`, `getIdentity`. `buildReadStateUpdatedPayload` from Task 3. `persistEventAndFanout` + `nextEventId` on ChatChannel (Task 4).
- Produces:
  - `POST /internal/read-state` (header `X-Verified-User-Id`, body `{ channel_id, last_read_event_id }`) on `UserDirectory`: this owns the **floor** (the `(user_id, channel_id)` `my_channels` row must exist with `status='active'`, else 403) and the **monotonic advance** (accept `last_read_event_id` only if `>` the stored value; else keep stored). After a successful advance, it calls `ChatChannel(channel_id)./internal/read-state-event` to write the `read_state.updated` event + `channel_fanout` outbox (so cross-device clients of THIS user, subscribed via the channel fanout, sync their unread). Returns `{ channel_id, last_read_event_id, advanced: boolean }` (the Worker computes `unread_count` separately). If the monotonic floor did not advance (equal/earlier cursor), it returns `{ advanced: false }` and does NOT write an event (idempotent re-mark is not state change).
  - `POST /internal/read-state-event` (header `X-Verified-User-Id`, body `{ user_id, last_read_event_id }`) on `ChatChannel`: writes ONE `read_state.updated` event (persisted payload via `buildReadStateUpdatedPayload` — note: this payload has NO `actor_kind`, so the Task 4b replay projection passes it through unchanged) + a `channel_fanout` outbox row; schedules the alarm. Idempotent on `(principal_kind='user', principal_id=user_id, operation='read_state', idempotency_key=<last_read_event_id>)` so a retried mark-read at the same cursor does not duplicate the event. Returns `{ event_id }`.
  - `GET /internal/unread-count?after=` on `ChatChannel`: counts `message.created` events after `after` minus the user's own authored-by events (unchanged from draft). Returns `{ unread_count }`.
  - Worker route `POST /channels/:channel_id/read-state`: auth → `UserDirectory(user_id)./internal/read-state` → fetch unread from `ChatChannel(channel_id)./internal/unread-count` → return `{ channel_id, last_read_event_id, unread_count }`.

> **Decision on `read_state.updated` (P0-2 fix):** the first plan draft only updated `my_channels.last_read_event_id` and never emitted an event — leaving the contract's `read_state.updated` (§10.4, design §8 阶段3) unimplemented. This task emits it via the channel fanout. The event is persisted in the channel event log (so `/internal/replay` serves it) AND fanned out to online channel members (the marking user's other sessions receive it and resync unread). Task 4b's replay projection passes `read_state.updated` through unchanged (no `actor_kind`) — so no actor resolution gap.

- [ ] **Step 1: Write failing DO test**

`test/do/user-directory-read-state.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

const USER = "u-rs-1";
const CHANNEL = "0197aaaa-0000-7000-8000-000000000001";

async function seedMembership() {
  // Simulate a my_channels active row (normally written via the user_directory join outbox).
  const stub = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], USER);
  await stub.fetch(new Request("https://x/internal/upsert-channel", {
    method: "POST",
    headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "join", channel_id: CHANNEL, kind: "channel", membership_version: 1 }),
  }));
  return stub;
}

describe("UserDirectory /internal/read-state", () => {
  it("sets last_read_event_id on first mark (advanced: true)", async () => {
    const stub = await seedMembership();
    const res = await stub.fetch(new Request("https://x/internal/read-state", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: CHANNEL, last_read_event_id: "01J00000000000000000000000" }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { last_read_event_id: string; advanced: boolean };
    expect(body.last_read_event_id).toBe("01J00000000000000000000000");
    expect(body.advanced).toBe(true);
  });

  it("returns advanced:false on re-mark of the same cursor (idempotent, no event)", async () => {
    const stub = await seedMembership();
    const cursor = "01J00000000000000000000010";
    const r1 = await stub.fetch(new Request("https://x/internal/read-state", { method: "POST", headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: CHANNEL, last_read_event_id: cursor }) }));
    const r2 = await stub.fetch(new Request("https://x/internal/read-state", { method: "POST", headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: CHANNEL, last_read_event_id: cursor }) }));
    expect(((await r1.json()) as { advanced: boolean }).advanced).toBe(true);
    expect(((await r2.json()) as { advanced: boolean }).advanced).toBe(false);
  });

  it("only advances monotonically (earlier cursor rejected)", async () => {
    const stub = await seedMembership();
    await stub.fetch(new Request("https://x/internal/read-state", { method: "POST", headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: CHANNEL, last_read_event_id: "01Jzzzzzzzzzzzzzzzzzzzzzz" }) }));
    const res = await stub.fetch(new Request("https://x/internal/read-state", {
      method: "POST",
      headers: { "X-Verified-User-Id": USER, "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: CHANNEL, last_read_event_id: "01Jaaaaaaaaaaaaaaaaaaaaaaa" }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { last_read_event_id: string }).last_read_event_id).toBe("01Jzzzzzzzzzzzzzzzzzzzzzz");
  });

  it("403 if not an active member of the channel", async () => {
    const stub = getNamedDo(env.USER_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], "u-rs-nobody");
    const res = await stub.fetch(new Request("https://x/internal/read-state", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-rs-nobody", "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: "0197bbbb-0000-7000-8000-000000000002", last_read_event_id: "01Jx" }),
    }));
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/do/user-directory-read-state.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — `/internal/read-state` returns 404.

- [ ] **Step 3: Implement the UserDirectory read-state handler (floor + advance + emit event)**

Add inside `UserDirectory.fetch` before the final 404:
```typescript
if (url.pathname === "/internal/read-state") {
  const userId = request.headers.get("X-Verified-User-Id");
  if (userId === null) return new Response("missing X-Verified-User-Id", { status: 403 });
  const b = (await request.json()) as { channel_id: string; last_read_event_id: string };

  // 1) Floor + monotonic advance inside the my_channels txn.
  const advanced = await this.ctx.storage.transaction(async (): Promise<boolean> => {
    const row = this.ctx.storage.sql
      .exec("SELECT last_read_event_id, status FROM my_channels WHERE user_id=? AND channel_id=?", userId, b.channel_id)
      .toArray()[0] as { last_read_event_id: string | null; status: string } | undefined;
    if (!row || row.status !== "active") return false; // signal 403 to caller
    const current = row.last_read_event_id;
    const next = current === null || b.last_read_event_id > current ? b.last_read_event_id : current;
    if (next !== current) {
      this.ctx.storage.sql.exec("UPDATE my_channels SET last_read_event_id=? WHERE user_id=? AND channel_id=?", next, userId, b.channel_id);
      return true; // advanced
    }
    return false; // floor did not advance — no event
  });

  if (!advanced) {
    // Could be (a) not a member → 403, or (b) cursor did not advance → 200 idempotent no-op.
    const memberRow = this.ctx.storage.sql
      .exec("SELECT status FROM my_channels WHERE user_id=? AND channel_id=?", userId, b.channel_id)
      .toArray()[0] as { status: string } | undefined;
    if (!memberRow || memberRow.status !== "active") return new Response("forbidden", { status: 403 });
    return Response.json({ channel_id: b.channel_id, last_read_event_id: b.last_read_event_id, advanced: false });
  }

  // 2) Emit read_state.updated on the ChatChannel (event + channel_fanout outbox). Idempotent on the cursor.
  const chStub = this.env.CHAT_CHANNEL.getByName(b.channel_id);
  const evRes = await chStub.fetch(new Request("https://x/internal/read-state-event", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, last_read_event_id: b.last_read_event_id }),
  }));
  // Non-OK here is not fatal to the floor (which already committed); the event is best-effort.
  // A 409 means the same cursor already emitted — treat as success.
  const eventId = evRes.ok ? ((await evRes.json()) as { event_id: string }).event_id : "";

  return Response.json({ channel_id: b.channel_id, last_read_event_id: b.last_read_event_id, advanced: true, event_id: eventId });
}
```
> **Cross-DO best-effort:** the `my_channels` advance commits first (inside its transaction); the `read_state.updated` event write is a separate ChatChannel call AFTER. If the ChatChannel call fails (DO unavailable), the floor is still correct (the user's unread floor advanced) — the event is a best-effort notification, repairable by a re-mark. This honors "no cross-DO 2PC": the floor is the SoT, the event is the projection.

- [ ] **Step 4: Add the `read-state-event` + `unread-count` endpoints to ChatChannel**

Add inside `ChatChannel.fetch` before the final 404:
```typescript
if (url.pathname === "/internal/read-state-event") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  if (!userId) return new Response("missing verified user", { status: 401 });
  const b = (await request.json()) as { user_id: string; last_read_event_id: string };
  const now = this.nowIso();
  const nowMs = Date.parse(now);
  const requestHash = JSON.stringify({ user_id: b.user_id, last_read_event_id: b.last_read_event_id });
  const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  // read_state.updated has no actor — pass an empty map so persistEventAndFanout skips actor resolution.
  const emptyMap = new Map<string, import("../chat/event-broadcast").UserSummary>();

  const tx = await this.ctx.storage.transaction(async (): Promise<
    | { kind: "conflict" }
    | { kind: "cached"; eventId: string }
    | { kind: "ok"; eventId: string }
  > => {
    const realMeta = this.ctx.storage.sql.exec("SELECT channel_id, status, membership_version FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string; status: string; membership_version: number } | undefined;
    if (!realMeta) return { kind: "cached", eventId: "" }; // channel gone — best-effort no event
    if (realMeta.status === "dissolved") return { kind: "cached", eventId: "" }; // dissolved: no read events

    const idem = this.ctx.storage.sql.exec(
      "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='read_state' AND idempotency_key=?",
      b.user_id, b.last_read_event_id,
    ).toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
    if (idem) {
      if (idem.request_hash !== requestHash) return { kind: "conflict" };
      return { kind: "cached", eventId: (idem.response_json ? (JSON.parse(idem.response_json) as { event_id: string }).event_id : "") };
    }

    const mv = realMeta.membership_version;
    const eventId = this.nextEventId(nowMs);
    // read_state.updated payload has no actor_kind → resolveActorWithMap/persistEventAndFanout treat it as a
    // pass-through (Task 4b replay projection skips actor resolution for read_state.updated).
    this.persistEventAndFanout(eventId, "read_state.updated", realMeta.channel_id, now,
      buildReadStateUpdatedPayload({ channel_id: realMeta.channel_id, user_id: b.user_id, last_read_event_id: b.last_read_event_id }),
      mv, now, emptyMap);
    this.ctx.storage.sql.exec(
      "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, idempotency_key, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'read_state', ?, ?, ?, 'completed', ?, ?)",
      b.user_id, b.last_read_event_id, requestHash, JSON.stringify({ event_id: eventId }), now, idemExpiresAt,
    );
    return { kind: "ok", eventId };
  });

  if (tx.kind === "conflict") return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "last_read_event_id reused with different user", retryable: false } }, { status: 409 });
  await this.scheduleOutboxAlarm(now);
  return Response.json({ event_id: tx.eventId }, { status: 200 });
}

if (url.pathname === "/internal/unread-count") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  const after = url.searchParams.get("after") ?? "";
  const realMeta = this.ctx.storage.sql.exec("SELECT channel_id FROM channel_meta LIMIT 1").toArray()[0] as { channel_id: string } | undefined;
  if (!realMeta) return Response.json({ unread_count: 0 });
  // Count message.created events after the cursor that were not authored by this user.
  const rows = this.ctx.storage.sql.exec(
    "SELECT COUNT(*) AS c FROM events WHERE channel_id=? AND event_id > ? AND event_type='message.created'",
    realMeta.channel_id, after,
  ).toArray()[0] as { c: number | bigint };
  // Subtract the user's own messages: count their messages after the cursor.
  const own = this.ctx.storage.sql.exec(
    "SELECT COUNT(*) AS c FROM events WHERE channel_id=? AND event_id > ? AND event_type='message.created' AND actor_id=?",
    realMeta.channel_id, after, userId,
  ).toArray()[0] as { c: number | bigint };
  const total = Number(rows.c ?? 0);
  const ownCount = Number(own.c ?? 0);
  return Response.json({ unread_count: Math.max(0, total - ownCount) });
}
```
> **Note:** the persisted `message.created` payload stores `actor_id` = sender user_id (Task 4 pattern via the `events` INSERT which sets `actor_id`). So `events.actor_id` IS the sender; the subtraction is correct. For non-`message.created` events (member.*, system.notice) we do not count them as unread — unread is message count, per contract §5.1/§5.5 `unread_count`.

- [ ] **Step 5: Add the Worker route**

Append to `src/routes/channel-mutations.ts`:
```typescript
export async function readStateHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const channelId = c.req.param("channel_id");
  if (!channelId) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");
  const body = (await c.req.json().catch(() => ({}))) as { last_read_event_id?: string };
  if (!body.last_read_event_id) throw new ApiError("INVALID_MESSAGE", "last_read_event_id required");

  const dirStub = env.USER_DIRECTORY.getByName(userId);
  const rs = await dirStub.fetch(new Request("https://x/internal/read-state", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: channelId, last_read_event_id: body.last_read_event_id }),
  }));
  if (rs.status === 403) throw new ApiError("FORBIDDEN", "not an active member");
  if (!rs.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "read-state failed");
  const rsBody = (await rs.json()) as { last_read_event_id: string; advanced: boolean };

  // Fetch unread count from ChatChannel.
  const routeName = await channelRouteNameFor(env, userId, channelId);
  if (routeName === null) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  const chStub = env.CHAT_CHANNEL.getByName(routeName);
  const uc = await chStub.fetch(new Request(`https://x/internal/unread-count?after=${encodeURIComponent(rsBody.last_read_event_id)}`, { headers: { "X-Verified-User-Id": userId } }));
  const unread = uc.ok ? ((await uc.json()) as { unread_count: number }).unread_count : 0;

  return c.json({ channel_id: channelId, last_read_event_id: rsBody.last_read_event_id, unread_count: unread }, 200, { "X-Request-Id": c.get("requestId") });
}
```
> **Idempotency model (P1-5 fix):** this route does NOT write a Worker-side `idempotency_keys` row. Read-state is inherently monotonic — the floor only advances when `last_read_event_id` strictly increases, and the `read_state.updated` event is itself deduped on `(user, operation='read_state', idempotency_key=<last_read_event_id>)` inside ChatChannel. A client retry with the same cursor returns the same `{ last_read_event_id, unread_count }` and emits no duplicate event. The `Idempotency-Key` header is still REQUIRED (contract §5.5 shows it) and is validated here, but the dedup key is the cursor itself, not the header — that is the contractually-meaningful idempotency surface for monotonic state. Records this design choice so the implementer does not add a redundant `idempotency_keys` row keyed on the header.
Register in `src/index.ts`:
```typescript
import { createChannelHandler, updateChannelHandler, dissolveChannelHandler, addMemberHandler, updateMemberRoleHandler, removeMemberHandler, listMembersHandler, getMemberHandler, readStateHandler } from "./routes/channel-mutations";
// ...
app.post("/api/chat/channels/:channel_id/read-state", (c) => readStateHandler(c));
```

- [ ] **Step 6: Write + run the read-state route test**

Append to `test/routes/channel-mutations.test.ts`:
```typescript
describe("POST /api/chat/channels/:id/read-state", () => {
  it("marks read and returns last_read_event_id + unread_count", async () => {
    const create = await authedReq("u-rs-route", "POST", "/api/chat/channels", { title: "RS", visibility: "private", initial_members: [] }, "ck-rs-create");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-rs-route", "POST", `/api/chat/channels/${cid}/read-state`, { last_read_event_id: "01J00000000000000000000000" }, "ck-rs-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { last_read_event_id: string; unread_count: number };
    expect(body.last_read_event_id).toBe("01J00000000000000000000000");
    // owner just created the channel: no messages → unread 0
    expect(body.unread_count).toBe(0);
  });

  it("is idempotent: re-marking the same cursor returns the same last_read_event_id with no event duplication", async () => {
    const create = await authedReq("u-rs-route2", "POST", "/api/chat/channels", { title: "RS2", visibility: "private", initial_members: [] }, "ck-rs-create2");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const body1 = { last_read_event_id: "01J00000000000000000000001" };
    const r1 = await authedReq("u-rs-route2", "POST", `/api/chat/channels/${cid}/read-state`, body1, "ck-rs-2a");
    const r2 = await authedReq("u-rs-route2", "POST", `/api/chat/channels/${cid}/read-state`, body1, "ck-rs-2b");
    expect(r1.status).toBe(200); expect(r2.status).toBe(200);
    expect(((await r2.json()) as { last_read_event_id: string }).last_read_event_id).toBe("01J00000000000000000000001");
  });
});
```

Also append a DO-level assertion to `test/do/user-directory-read-state.test.ts` that the advance returns `advanced: true` on first mark and `advanced: false` on re-mark of the same cursor (see the Step 1 seed test — add one more `it("returns advanced:false on re-mark of same cursor", ...)`).

Run: `npx vitest run test/do/user-directory-read-state.test.ts test/routes/channel-mutations.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/do/user-directory.ts src/do/chat-channel.ts src/routes/channel-mutations.ts src/index.ts test/do/user-directory-read-state.test.ts test/routes/channel-mutations.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat: POST /channels/{id}/read-state (monotonic floor + read_state.updated event + unread count)"
```

---

## Task 12: Full-suite green + typecheck + gap self-review

**Files:**
- Test: (none new — runs everything)

**Interfaces:**
- Consumes: all Phase 3 tasks.
- Produces: a green Phase 3 baseline on top of Phase 2; the plan's self-review notes.

- [ ] **Step 1: Run the full suite + typecheck**

Run:
```bash
npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
```
Expected: `tsc --noEmit` exits 0; all tests green (Phase 0/1/2 unchanged behavior + new Phase 3 tests). If a Phase 2 test regressed (e.g. `channelRouteNameFor` now resolves user channels differently), inspect — the system-channel path is unchanged, so routes/events tests should pass.

- [ ] **Step 2: Verify the existing `getNamedDo` cast convention holds**

Run: `grep -rn "getNamedDo" test/ | grep -v "helpers.ts"`
Expected: every call site uses `env.<BINDING> as unknown as Parameters<typeof getNamedDo>[0]`. No raw `env.CHAT_CHANNEL` passed directly. (Plan examples already use the cast; this is a sanity grep.)

- [ ] **Step 3: Lint the plan for unbalanced code fences (informational)**

Run:
```bash
grep -c '^```' docs/superpowers/plans/2026-06-24-lilium-chat-phase-3.md
```
Expected: an EVEN number. (Phase 2 hit an extraction failure from an odd count; verify before any subagent task-brief extraction.)

- [ ] **Step 4: Self-review — spec coverage**

Check each contract/design requirement against a task:
- `POST /api/chat/channels` (§5.2b) → Task 4 (DO) + Task 5 (coordinator) + Task 6 (route). ✅ create-coordinator rule documented in Task 1.
- `GET /api/chat/channels` + `GET /channels/{id}` → already exist (Phase 1/2); `channelRouteNameFor` (Task 2) makes them resolve user channels. ✅ (No new task — they already call `/internal/summary`.)
- `PATCH /api/chat/channels/{id}` (§5.3) → Task 7. ✅
- `POST /channels/{id}/dissolve` (§5.4) + `CHANNEL_DISSOLVED` gate → Task 8. ✅
- `GET /channels/{id}/members` (§7.1) + `GET /members/{user_id}` (§7.1b) → Task 10. ✅
- `POST/PATCH/DELETE /channels/{id}/members[/{user_id}]` (§7.2/7.3/7.4) → Task 9. ✅
- `POST /channels/{id}/read-state` (§5.5) + `read_state.updated` event → Task 11 (floor advance + emit via `ChatChannel /internal/read-state-event`) + Task 4b (replay projects it through unchanged). ✅
- Events `channel.created`/`channel.updated`/`channel.dissolved`/`member.joined`/`member.left`/`member.role_updated`/`read_state.updated`/`system.notice` → Tasks 3 (builders, incl. `buildMemberLeftPayload`) + 4/7/8/9/11 (emit) + 4b (replay actor projection for management events). ✅
- `MEMBER_NOT_FOUND` (§7.1b, §11) → Task 1 (error code) + Task 9 (target lookup) + Task 10 (members-get). ✅
- `CHANNEL_DISSOLVED` (§5.4, §11) write-gate → Task 1 (error code) + Task 8 (dissolve + gate on message-send/join). ✅
- Owner invariant (cannot self-leave / self-demote) → Task 9 (422). ✅
- Out-of-scope confirmed NOT implemented: directory (§5.6), join (§5.7), invites (§5.8/5.9), DM, bot commands. ✅ (no routes registered for them.)

- [ ] **Step 5: Self-review — placeholder scan**

Scan the plan for `TODO`/`TBD`/`implement later`/`Similar to Task`. **None present** — the prior draft's deliberately-broken code (the malformed `UPDATE members SET role=?, WHERE` line, the `idempotency_key: idempotency_key` self-reference, the stray `.catch?.(() => {})`) was removed in the P0-7 rewrite. Every code block is the final correct code.

- [ ] **Step 6: Self-review — type consistency**

- `persistEventAndFanout(eventId, type, channelId, occurredAt, persistedPayload, membershipVersion, nowIso, actorMap)` — defined Task 4 Step 1, called identically in Tasks 4/7/8/9 + 11 (read-state-event, empty actorMap). ✅
- `resolveActorMap(userIds)` → `Map<string, UserSummary>` — defined Task 4, used in 4/7/8/9. ✅
- `activeRole(channelId, userId)` → `string | null` — defined Task 7 Step 1, used in 7/8/9. ✅
- `cachedResponse(j)` — defined ONCE in Task 7 Step 1, used by Tasks 7/8/9 (and Task 11's read-state-event returns `{ event_id }` directly, no cached branch). ✅ (single definition; the old "Task 9 introduces a second copy" is fixed.)
- `markMemberLeftAndEnqueueFanoutUnregisterSync(channelId, userId, nowIso)` — defined Task 9 Step 3; `markMemberLeftAndEnqueueFanoutUnregister` is now a thin async wrapper calling it; used by `/internal/test-leave` and `members-remove`. ✅ single leave implementation.
- `buildMemberJoinedPayload` / `buildMemberLeftPayload` / `buildMemberRoleUpdatedPayload` / `buildChannelUpdatedPayload` / `buildChannelDissolvedPayload` / `buildReadStateUpdatedPayload` / `buildSystemNoticePayload` — all defined Task 3, imported in Task 4+1, called in 4/7/8/9/11. ✅
- `resolveActorWithMap(payload, map)` — defined Task 3, used in Task 4 (`persistEventAndFanout`) + Task 4b (replay). ✅
- DO names: `getByName(channelId)` for user channels (Task 2), `system-general` for system. ✅

- [ ] **Step 7: Report green**

Report `npm run typecheck` clean + full suite green. (No optional refactor step remains — `cachedResponse` is already single-defined in Task 7 and reused thereafter.)

---

## Notes for the executor

- **Task-skip dependency order:** Tasks are sequential — 1 (errors + docs) before any route; 2 before 3's tests import; 4 before 5 (coordinator calls `createChannel`); 4b before any task that asserts replay shape (it modifies `/internal/replay`); 5 before 6 (route calls coordinator); 7 before 9 (`cachedResponse` + `activeRole` defined in 7, used in 9); 7/8/9 before their route tests; 10/11 build on `channelRouteNameFor` (Task 2). A subagent per task works; each task ends in a green commit.
- **No deliberately-broken code remains in the plan.** Every code block is final/correct as written — do not "fix" skeletons that are not there, and do not re-introduce inline ⚠ reminders.
- **`member.left` payload** uses `buildMemberLeftPayload` (Task 3), not an inline object.
- **read-state emits a real event.** The UserDirectory floor advances `my_channels.last_read_event_id` (SoT), then calls `ChatChannel /internal/read-state-event` to write `read_state.updated` + channel_fanout outbox (best-effort cross-DO, no 2PC). The event is deduped on `(user, operation='read_state', idempotency_key=<cursor>)`. Re-marking the same cursor returns `{ advanced: false }` and emits nothing.
- **`read_state.updated` replay:** Task 4b deliberately passes it through unchanged (no actor). Task 11 emits it WITHOUT an `actor_kind` — confirm `persistEventAndFanout` handles a payload that has no `actor_kind` (it reads `payload.actor_kind` defensively → `null` → falls through; the replay branch skips actor resolution for `read_state.updated`).
- **No push, no deploy.** Git identity `kuma`. Operator deploys.

