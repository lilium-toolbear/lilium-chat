# Repository Guidelines

`lilium-chat` is a chat **backend only** — Cloudflare Worker (Hono) + SQLite-backed Durable Objects. Cross-origin from ToolBear SPA (`lilium.kuma.homes` → Worker `chat.kuma.homes`). No frontend in this repo. Auth: ToolBear-issued JWTs (HS256 via `jose`).

## Project Structure & Module Organization

Runtime code lives in `src/`: routes in `src/routes/`, Durable Objects in `src/do/`, shared chat logic in `src/chat/`, auth in `src/auth/`, profiles in `src/profile/`, S3 helpers in `src/s3/`. Tests beside code as `src/**/*.test.ts` and under `test/`. Contracts and phase plans in `docs/`; deployment in `scripts/`.

## Build, Test, and Development Commands

```bash
npm run typecheck   # tsc --noEmit — run after wrangler.jsonc binding/vars changes
npm test            # vitest watch
npm run test:once   # vitest run once
npm run cf-typegen  # wrangler types → regenerates gitignored worker-configuration.d.ts
npm run dev         # wrangler dev
npm run deploy      # typegen → typecheck → vitest → deploy (do not run unless asked)
```

Under heavy local load (host load 30+), prefer:

```bash
npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
```

Do not push or deploy unless explicitly asked.

## Toolchain gotchas (load-bearing, re-breaks silently)

- `worker-configuration.d.ts` is **generated** (`wrangler types`) and **gitignored**. After editing `wrangler.jsonc` bindings/vars, **re-run `npm run cf-typegen`** or typecheck drifts.
- `src/env.ts` augments the generated global `Env` with secrets (`JWT_SECRET`, `S3_*`, `SENTRY_DSN`). Add secrets here, never to `wrangler.jsonc`.
- `tsconfig.json` uses `"types": []` and includes `worker-configuration.d.ts`. Do **not** add `@cloudflare/workers-types`.
- Hono app: `new Hono<{ Bindings: Env; Variables: { requestId: string } }>()` — keep when adding middleware.
- `vitest.config.ts` uses `wrangler.test.jsonc`. Test Hyperdrive needs a placeholder `localConnectionString` or miniflare refuses to start.
- `wrangler.test.jsonc` adds **`SchedulerProbe`** (test-only). Keep `migrations[].new_sqlite_classes` in sync when adding a DO class.

## Coding Style & Naming Conventions

TypeScript ES modules, strict typing, two-space indent. File names kebab-case; tests `*.test.ts`. Avoid `Record<string, unknown>` for domain data — use explicit types or discriminated unions.

## Architecture

Authoritative references (priority order):

1. [`docs/api-contract.md`](docs/api-contract.md) — Browser/Bot API **single source of truth**. Code changes when contract and implementation disagree.
2. [`docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md`](docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md) — backend design (read §0 before cross-DO / idempotency / fanout changes).
3. [`docs/superpowers/plans/*.md`](docs/superpowers/plans/) — phase implementation plans (SDD workflow).

### API contract (source of truth)

- **All API wire-shape changes** update `docs/api-contract.md` + **修订记录** entry only.
- **Do not retroactively edit** historical addenda, phase plans, or gap trackers for contract changes.
- [`docs/api-contract/`](docs/api-contract/) — patches/discussion/redirect stubs, **not** normative. See [`docs/api-contract/README.md`](docs/api-contract/README.md).
- Historical §13–§17 / §12-legacy references → tombstone sections at end of `docs/api-contract.md`.

### DO topology (10 production classes + SchedulerProbe in test)

Worker (`src/index.ts`) authenticates and routes to DOs by name. Browser WS (`src/routes/ws.ts`) forwards verified `user_id` via `X-Verified-User-Id` to `UserConnection(user_id)`.

| DO | Name | Role |
|---|---|---|
| `ChatChannel` | `channel_id` | Auth source-of-truth: messages, members, events, outbox, idempotency |
| `UserDirectory` | `user_id` | Repairable projection: `my_channels`, stickers, attachment ownership |
| `UserConnection` | `user_id` | Browser WS hibernation; WS command dispatcher → `ChatChannel` |
| `ChannelFanout` | `channel_id` | Online sessions; best-effort live delivery |
| `ChannelDirectory` | `shared` | Public channel directory (outbox-fed) |
| `InviteDirectory` | `shared` | Invite code → `channel_id` |
| `BotRegistry` | singleton | Bot identity + token hashes |
| `BotConnection` | `bot_id` | Bot Gateway WS, delivery queue |
| `BotStreamConnection` | `` `${channel_id}#${message_id}` `` | Stream WS buffer, seq/ack, live stream fanout |
| `DMDirectory` | `shared` | DM pair → `channel_id` |
| `SchedulerProbe` | test only | Alarm/scheduler tests |

Internal test routes need `ALLOW_INTERNAL_TEST_ROUTES=1` + `X-Test-Only: 1` (test worker only).

### Load-bearing invariants

- **No cross-DO 2PC.** Consistency via **durable outbox** + per-DO **alarm** (`scheduleNextAlarm`/`runDueJobs`). **Do not call `ctx.storage.setAlarm` directly.**
- **Per-channel monotonic UUIDv7** `event_id`; no global event cursor.
- **WS commands on `UserConnection`**, not Worker (hibernation).
- **`ChatChannel` DO name = `channel_id`.** No default channel; membership via create/join/invite/member-add.
- **Idempotency via `command_id`** / HTTP `Idempotency-Key` ≡ `operation_id`; dedupe by `dedupe_principal_key`.
- **Replay re-projects** UserSummary live; event storage keeps stable ids only.
- **Message mutations channel-scoped** `{channel_id, message_id}` — no message-id-only routes.
- **Attachments:** SeaweedFS via `aws4fetch`; presign/finalize in `UserDirectory`.

### SQLite migrations

Per-DO modules under `src/do/migrations/<do-name>.ts`: baseline + versioned `SqlMigration[]`. Runner in DO constructor. **Add migrations, do not edit baselines.** Quote user-influenced identifiers via `quoteIdent`.

### Error contract & request id

- `src/errors.ts`: codes, `HTTP_STATUS_BY_CODE`, `RETRYABLE_CODES`, contract alignment.
- `/api/chat/*`: assign `req_<uuidv7>`; thread `X-Verified-User-Id` and `request_id` on internal DO fetches.

### DO SQLite ↔ PG archive parity (required)

Any DO schema change **must** sync archive in the same change set:

1. `src/archive/payload.ts` `ARCHIVE_TABLE_WHITELIST` + producer in mutating DO
2. `scripts/archive-local/migrations/00N_<topic>.sql` (append-only)
3. Register in `migrate.mjs` / `backfill-raw.ts`
4. `src/archive-consumer/replay-tables.ts` if PK/json/scope changes
5. `test/archive/drift.test.ts` aligned
6. Docs: archive spec §0.1 + runbook for non-trivial shape changes

Operator apply: `DATABASE_URL=... npm run archive:migrate` (see archive runbook). **Never apply DB migrations without explicit user approval.**

## Workflow

Phase plans in `docs/superpowers/plans/`. Follow task order, write failing tests first, run typecheck + load-adjusted vitest after each task, update plan checkboxes. `.superpowers/sdd/` (gitignored) holds execution ledgers.

## Testing Guidelines

Vitest via `@cloudflare/vitest-pool-workers` + miniflare (real DO SQLite + WS hibernation). `test/helpers.ts`: `makeJwt`, `getNamedDo`. DO-to-DO: `stub.fetch(new Request("https://x/internal/...", {...}))`. Poll async outbox/alarm effects — avoid fixed sleeps under load.

## Commit & Pull Request Guidelines

Conventional Commits: `feat(scope): ...`, `fix(do): ...`, etc. PRs: problem, solution, verification, contract/migration impact. Squash merge only.

## Security & Configuration

Secrets in `.dev.vars` / `wrangler secret put`, not `wrangler.jsonc`. `src/env.ts` augments generated `Env`.
