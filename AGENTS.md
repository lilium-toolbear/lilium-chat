# Repository Guidelines

## Project Structure & Module Organization

`lilium-chat` is a backend-only Cloudflare Worker using Hono and SQLite-backed Durable Objects. Runtime code lives in `src/`: routes in `src/routes/`, Durable Objects in `src/do/`, shared chat logic in `src/chat/`, auth in `src/auth/`, profiles in `src/profile/`, and S3 helpers in `src/s3/`. Tests live beside code as `src/**/*.test.ts` and under `test/`. Contracts and phase plans are in `docs/`; deployment tooling is in `scripts/`.

## Build, Test, and Development Commands

- `npm run dev` starts `wrangler dev` for local Worker and Durable Object testing.
- `npm run typecheck` runs `tsc --noEmit`.
- `npm run test` starts Vitest watch mode.
- `npm run test:once` runs the full Vitest suite once.
- `npm run cf-typegen` regenerates Worker types after `wrangler.jsonc` changes.
- `npm run deploy` runs `scripts/deploy.mjs`: type generation, typecheck, tests, then Wrangler deploy. Do not deploy unless explicitly asked.

Under heavy local load, prefer:

```bash
npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
```

## Coding Style & Naming Conventions

Use TypeScript ES modules, strict typing, and two-space indentation. Keep route handlers, Durable Object methods, and projection/idempotency logic in existing module families. File names use kebab case such as `channel-events.ts`; tests end in `.test.ts`. Avoid `Record<string, unknown>` for domain data; model payloads, rows, events, and route bodies with explicit types or discriminated unions.

## Testing Guidelines

Vitest runs through `@cloudflare/vitest-pool-workers` with `wrangler.test.jsonc`, so tests exercise Miniflare Durable Objects and SQLite. Add focused tests in the nearest existing suite. Avoid brittle assertions on incidental wording or constants. For async outbox or alarm behavior, poll for state instead of sleeping.

## Architecture & Workflow Notes

### API contract (source of truth)

- **Authoritative contract:** [`docs/api-contract.md`](docs/api-contract.md) — the single Browser/Bot API source of truth. When code and this file disagree, the contract wins and code changes.
- **All API wire-shape changes** must update `docs/api-contract.md` and append an entry to its in-document **修订记录** (revision record) with version, date, and delta summary.
- **Do not retroactively edit historical docs** for API contract changes. Only `docs/api-contract.md` needs updating — leave `docs/api-contract/*` addenda, `docs/superpowers/plans/*`, gap trackers, and other archived specs/plans unchanged unless you are deliberately starting a new discussion draft.
- **`docs/api-contract/`** is for dated patches, discussion drafts, and changelog/redirect stubs only — **not** normative. After a patch is merged into `docs/api-contract.md`, keep the addendum file as historical trace or replace it with a redirect stub. See [`docs/api-contract/README.md`](docs/api-contract/README.md).

Read `CLAUDE.md` before changing cross-DO consistency, idempotency, scheduling, migrations, WebSocket routing, or Worker bindings. Do not call `ctx.storage.setAlarm` directly; use the shared scheduler. Add SQLite changes through new migration versions, not baseline edits. Regenerate, never hand-edit, `worker-configuration.d.ts`.

### DO SQLite migrations and PG archive parity (required)

Any change to DO SQLite schema (`src/do/migrations/<do>.ts` — new table/column/index, renamed field, dropped column) **must** keep the local PG archive path in sync in the **same change set**. The archive consumer replays upserts using every key in the payload; a missing PG column fails replay.

Checklist when DO schema changes:

1. **Archive producer** — tables under `src/archive/payload.ts` `ARCHIVE_TABLE_WHITELIST` must emit the new/changed fields from the mutating DO (`appendArchiveRecordSync` / `archiveUpsert` / `archiveReplaceScope` in `src/do/*.ts` or `src/archive/`).
2. **PG migration** — add `scripts/archive-local/migrations/00N_<topic>.sql` (append-only; do not edit migrations already applied in prod).
3. **Migration runners** — register the new file in `scripts/archive-local/migrate.mjs` and `scripts/archive-local/backfill-raw.ts`.
4. **Replay config** — update `src/archive-consumer/replay-tables.ts` when PK, `jsonColumns`, `scopeReplace`, or `softDeleteColumn` changes.
5. **Drift tests** — `test/archive/drift.test.ts` must stay aligned with `ARCHIVE_TABLE_WHITELIST`.
6. **Docs** — for non-trivial archive shape changes, update `docs/superpowers/specs/2026-06-28-lilium-chat-local-pg-archive-cf-queue.md` §0.1 and `docs/superpowers/runbooks/2026-06-28-lilium-chat-archive-backend.md`.

Operator apply after merge: `DATABASE_URL=... npm run archive:migrate` on the archive PG host (see archive runbook).

## Commit & Pull Request Guidelines

Recent commits use Conventional Commit prefixes, for example `feat(ws): ...`, `fix(do): ...`, and `test(dm): ...`. Keep commits scoped and describe behavior changes. Pull requests should include the problem, solution, verification commands, and any contract or migration impact.

## Security & Configuration Tips

Secrets stay out of `wrangler.jsonc`; use `.dev.vars` locally and `wrangler secret put` remotely. `src/env.ts` augments generated `Env` with secret fields.
