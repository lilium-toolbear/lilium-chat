# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`lilium-chat` is a chat **backend only** — a Cloudflare Worker (Hono) fronting Durable
Objects with SQLite storage. It is called cross-origin by the ToolBear SPA at
`lilium.kuma.homes` ( Worker serves `chat.kuma.homes`). There is no frontend in this
repo. Auth is ToolBear-issued JWTs verified by the Worker (HS256 via `jose`).

## Commands

```bash
npm run typecheck            # tsc --noEmit  (run after touching wrangler.jsonc bindings/vars)
npm test                     # vitest (watch)
npm run test:once            # vitest run
npm run cf-typegen           # wrangler types → regenerates worker-configuration.d.ts
npm run dev                  # wrangler dev (local)
npm run deploy               # scripts/deploy.mjs: typegen → typecheck → vitest → wrangler deploy
```

**Run tests under machine load** (this host frequently sits at load 30+; the vitest-pool-workers
default 5s timeout then produces *false* `timed out` / `EnvironmentTeardownError` failures
that are not code regressions):

```bash
npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
# single file:
npx vitest run test/do/chat-channel-message-send.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
```

Do not push or deploy unless explicitly asked — the operator deploys.

## Toolchain gotchas (load-bearing, re-breaks silently)

- `worker-configuration.d.ts` is **generated** (`wrangler types`) and **gitignored**. It
  declares the global `interface Env` with all DO bindings, `LILIUM_DB` (Hyperdrive), vars,
  and `CF_VERSION_METADATA`. **After editing `wrangler.jsonc` bindings/vars, re-run
  `npm run cf-typegen`** or typecheck will drift.
- `src/env.ts` does **not** redeclare `interface Env`. It augments the generated global with
  secret fields (`JWT_SECRET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SENTRY_DSN`) and
  re-exports `type Env = globalThis.Env`. Add new secrets here, never to wrangler.jsonc.
- `tsconfig.json` uses `"types": []` and includes `worker-configuration.d.ts`. Do **not** add
  `@cloudflare/workers-types` or put the generated file in `types` — globals (`Response`,
  `crypto`, DO classes) come from the generated file via `include`.
- Hono app is typed `new Hono<{ Bindings: Env; Variables: { requestId: string } }>()` so
  `c.get/c.set("requestId")` typecheck. Keep that signature when adding middleware.
- `vitest.config.ts` points at `wrangler.test.jsonc` (test worker name `lilium-chat-test`).
  miniflare validates **every binding** at pool startup, so the test config's Hyperdrive
  entry has a placeholder `localConnectionString` even though no test connects — remove it
  and the pool refuses to start.
- `wrangler.test.jsonc` declares an extra `SCHEDULER_PROBE` binding (class `SchedulerProbe`)
  not present in prod `wrangler.jsonc`. Both configs list DO classes under
  `migrations[].new_sqlite_classes`; keep these in sync when adding a DO class.

## Architecture

Authoritative design references, in priority order:
1. `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md` — the Browser/Bot API
   contract. When code and contract disagree, the contract wins and code changes.
2. `docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md` — backend design spec
   (currently v4.2). Its §0 has a layered revision history (v2→v3→v3.x→v4.0) documenting
   *why* each platform-impossible pattern was rejected. Read §0 before attempting any
   cross-DO coordination, idempotency, or fanout change — the rejected approaches there are
   the obvious-but-wrong ones.
3. `docs/superpowers/plans/*.md` — phase implementation plans. Each phase is executed
   task-by-task via the SDD workflow (see "Workflow" below).

### DO topology (9 production classes + SchedulerProbe in test, all SQLite-backed)

The Worker (`src/index.ts`) is a thin Hono router. It authenticates JWTs and proxies to
DOs by name. WS upgrades (`src/routes/ws.ts`) verify the JWT, extract `user_id`, and forward
it via the `X-Verified-User-Id` header to a `UserConnection` DO named by `user_id`.

- **`ChatChannel`** (named by `channel_id`) — auth
  source-of-truth. Owns `channel_meta`, `members`, `messages`, `events` (per-channel event
  log), `audit_logs`, `attachments`, `projection_outbox`, `idempotency_keys`. All message
  mutations, member mutations, channel mutations, and the event log live here.
- **`UserDirectory`** (named by `user_id`) — **repairable projection** of `ChatChannel.members`
  into `my_channels` (per-user channel index + read-state floor + personal sticker library +
  attachment ownership). Not authoritative; repaired via outbox.
- **`UserConnection`** (named by `user_id`) — owns WebSocket hibernation
  (`ctx.acceptWebSocket`), per-channel cursors (serialized in the WS attachment), and routes
  **WS commands** (`message.send/edit/recall/delete`, `channel.mark_read`) to `ChatChannel`.
  `webSocketMessage` is the WS command dispatcher.
- **`ChannelFanout`** (named by `channel_id`) — holds online sessions per channel, delivers
  events to online `UserConnection`s. Delivery failure never blocks command success.
- **`ChannelDirectory`** (single global DO, name `shared`) — public channel directory read
  model, fed by `projection_outbox(target_kind='channel_directory')`.
- **`InviteDirectory`** (single global DO, name `shared`) — invite-code → channel_id index
  (invite codes are URL-opaque, so they need a global index DO).
- **`BotRegistry`** (single global DO) — global bot identity + token hash store.
- **`BotConnection`** (named by `bot_id`) — bot WebSocket hibernation, delivery queue, and
  outbound event fan-in from `ChatChannel` outbox (`target_kind='bot_connection'`).
- **`DMDirectory`** (single global DO, name `shared`) — canonical DM pair → channel_id index
  for idempotent DM open/create flows.
- **`SchedulerProbe`** — test-only DO (declared only in `wrangler.test.jsonc`; used to
  validate `scheduleNextAlarm` / `runDueJobs` without touching production DOs).

Production `wrangler.jsonc` binds 9 DO classes. The test worker adds **`SchedulerProbe`**
as a 10th class. Internal test probe routes (`/internal/outbox-pending`, `ChannelFanout`
`/dump`, `UserConnection` `/test-last-deliver`) require both `ALLOW_INTERNAL_TEST_ROUTES=1`
(test worker var only) and `X-Test-Only: 1`.

### Load-bearing invariants (do not violate without reading spec §0)

- **No cross-DO 2PC.** CF has no such API. Cross-DO consistency is done with a **durable
  outbox**: the source DO writes a business row + a `projection_outbox` row **in the same
  `storage.transactionSync`**, then a per-DO **alarm** flushes outbox rows to the target DO,
  which writes idempotently. Exhausted retries → `dead_letter`. Targets seen in
  `ChatChannel`: `user_directory`, `channel_fanout`, `invite_directory`, `channel_directory`.
- **Per-DO unified scheduler.** Each DO that needs deferred work uses
  `scheduleNextAlarm`/`runDueJobs` from `src/do/scheduler.ts` over a set of `DueTable`s. **Do
  not call `ctx.storage.setAlarm` directly** — it is last-write-wins per DO; the scheduler
  picks the earliest due row across all tables.
- **Per-channel cursor + per-channel monotonic UUIDv7.** `event_id`s are monotonic within a
  channel (DO-local counter combined into UUIDv7, see `src/ids/uuidv7.ts` `monotonicUuidV7`).
  There is **no global event cursor** — clients hold a per-channel `last_read_event_id`.
- **WS commands routed by `UserConnection`, not the Worker.** Hibernation requires the
  message handler to live on the DO. HTTP mutations are routed by the Worker; WS commands by
  `UserConnection.webSocketMessage`.
- **ChatChannel DO routing**：`ChatChannel` DO name 恒等于 client `channel_id`（UUIDv7）。所有路由直接用 `env.CHAT_CHANNEL.getByName(channel_id)`；用户通过 create/join/invite/member-add 获得 membership，无默认频道。
- **Idempotency via `command_id`.** v4.0 collapsed `client_message_id`/`idempotency_key` into
  `command_id` = durable operation id = idempotency key. HTTP `Idempotency-Key` ≡ internal
  `operation_id`. Dedup is namespaced by `dedupe_principal_key` (`user:<uid>`/`bot:<id>`/
  `system:<...>`) so different principals never collide on the same client-supplied id.
- **Replay re-projects.** Event payloads store only stable ids (`sender_user_id`,
  `actor_user_id`, `bot_id`) — **never** UserSummary display names/avatars. On replay,
  content-bearing events are re-projected against current `messages.status` so
  deleted/recalled messages don't leak their original payload. UserSummary is resolved
  live by the Worker/`UserConnection` via Hyperdrive (`src/profile/resolve.ts`).
- **Message mutations are channel-scoped (v4.0).** Locators are always
  `{channel_id, message_id}`. There is no `MessageIndex` DO and no message-id-only mutation
  route. Removed `ROUTE_INDEX_PENDING` for messages (only invite-code routes still use it).
- **Attachments** upload to self-hosted SeaweedFS (`s3.kuma.homes`, S3-compatible via
  `aws4fetch`), public-read by explicit product risk-acceptance (even private-channel
  attachments are public). Presign + finalize live in `UserDirectory`; projection in
  `src/chat/attachment-projection.ts`.

### SQLite migrations

Each DO has a per-class migration module under `src/do/migrations/<do-name>.ts` exporting a
`*_BASELINE_SCHEMA` (fresh-create) + a versioned `SqlMigration[]` list. The runner
(`src/do/sql-migrations.ts` `migrateSqlite`) runs in the DO constructor: stamps the baseline
on a fresh DB, then applies each migration with `version > current`. Helpers:
`tableExists` / `columnExists` / `indexExists` / `quoteIdent` (always quote user-influenced
identifiers; the runner rejects identifiers failing `IDENT_RE`). Each DO's
`fetch` short-circuits `handleSchemaVersionRequest` for a `/schema-version` probe. When
adding a column/index, add a migration with an incremented `*_CURRENT_SCHEMA_VERSION` rather
than editing the baseline.

### Error contract

`src/errors.ts` is the single source for error codes, HTTP status (`HTTP_STATUS_BY_CODE`),
and retryability (`RETRYABLE_CODES`). `ApiError` carries `code`/`message`/`retryable`/
`httpStatus`. The Hono `onError` maps unknown errors to `CHAT_WORKER_UNAVAILABLE`. When
adding an error code, add it to both `HTTP_STATUS_BY_CODE` and (if transient)
`RETRYABLE_CODES`, and to the contract. `errorResponse` emits the
`{error:{code,message,retryable}, request_id}` envelope.

### Request id

`/api/chat/*` middleware assigns `req_<uuidv7>` if no `X-Request-Id` header, sets it on the
context, and echoes it back. Internal DO-to-DO `fetch` calls thread `X-Verified-User-Id`
(verified user) and propagate `request_id` where relevant.

## Workflow

This repo uses phase-based Subagent-Driven Development. Each phase has a plan in
`docs/superpowers/plans/<date>-lilium-chat-phase-N-<topic>.md` with checkbox tasks. When
implementing from a plan: follow the plan's task ordering and file lists exactly, write
failing tests first, run typecheck + the load-adjusted vitest command after each task, and
update the plan's checkboxes. `.superpowers/sdd/` (gitignored) holds per-phase execution
ledgers; `docs/superpowers/` (committed) holds plans + specs. Phases are merged via PRs
against `master` (e.g. recent commits show `(#1)` PR numbers).

## Testing conventions

- Tests run under `@cloudflare/vitest-pool-workers` against miniflare (real DO SQLite + WS
  hibernation, not mocks). `test/helpers.ts` provides `makeJwt` (HS256 with `TEST_SECRET`)
  and `getNamedDo` (uses `idFromName`+`get`, works in both prod `getByName` and test).
- DO instances are obtained via `env.<BINDING>.getByName(...)` / `idFromName(...)`; DO-to-DO
  calls go through `stub.fetch(new Request("https://x/internal/...", {...}))` — the URL host
  is irrelevant, only the pathname routes inside the DO's `fetch` switch.
- When a test polls an async outbox/alarm side effect, prefer polling over fixed sleeps
  (load makes timing nondeterministic); existing tests use generous poll loops.