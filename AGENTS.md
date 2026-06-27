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

`docs/api-contract/` is authoritative when code and docs disagree. Read `CLAUDE.md` before changing cross-DO consistency, idempotency, scheduling, migrations, WebSocket routing, or Worker bindings. Do not call `ctx.storage.setAlarm` directly; use the shared scheduler. Add SQLite changes through new migration versions, not baseline edits. Regenerate, never hand-edit, `worker-configuration.d.ts`.

## Commit & Pull Request Guidelines

Recent commits use Conventional Commit prefixes, for example `feat(ws): ...`, `fix(do): ...`, and `test(dm): ...`. Keep commits scoped and describe behavior changes. Pull requests should include the problem, solution, verification commands, and any contract or migration impact.

## Security & Configuration Tips

Secrets stay out of `wrangler.jsonc`; use `.dev.vars` locally and `wrangler secret put` remotely. `src/env.ts` augments generated `Env` with secret fields.
