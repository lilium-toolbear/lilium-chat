# lilium-chat

Chat **backend** for the ToolBear platform — a Cloudflare Worker (Hono) fronting
Durable Objects with SQLite storage. Serves `chat.kuma.homes` and is called
cross-origin by the ToolBear SPA at `lilium.kuma.homes`. There is no frontend in
this repo.

Auth is ToolBear-issued JWTs (HS256, verified with [`jose`](https://github.com/panva/jose)).
User profiles are read live from ToolBear's Postgres via Hyperdrive — the chat
backend stores no profile data. Attachments live in a self-hosted
S3-compatible store (SeaweedFS at `s3.kuma.homes`).

## Prerequisites

- Node.js (see `engines` / `.nvmrc` if present) and `npm`
- A Cloudflare account with Workers + Durable Objects enabled
- A Hyperdrive config pointing at ToolBear Postgres (create with
  `wrangler hyperdrive create`, then paste the returned `id` into
  `wrangler.jsonc` under `hyperdrive[].id` — the binding name is `LILIUM_DB`)
- An S3-compatible bucket for attachments (endpoint, bucket, keys)

## Setup

```bash
npm install
npm run cf-typegen      # generates worker-configuration.d.ts (gitignored)
```

`worker-configuration.d.ts` is generated from `wrangler.jsonc` and declares the
global `interface Env` (all DO bindings, `LILIUM_DB`, vars). Re-run
`npm run cf-typegen` whenever you change bindings or vars in `wrangler.jsonc`.

### Secrets

Secrets are never written to `wrangler.jsonc`. Set them locally via
`.dev.vars` (gitignored) for `wrangler dev`:

```bash
# .dev.vars
JWT_SECRET=<hs256-secret>
S3_ACCESS_KEY_ID=<key>
S3_SECRET_ACCESS_KEY=<secret>
SENTRY_DSN=<sentry-dsn>          # optional; skips Sentry upload if absent
```

For production / CI, set the same with `wrangler secret put <NAME>`.
`src/env.ts` augments the generated `interface Env` with these four secret
fields.

## Development

```bash
npm run dev            # wrangler dev (local worker + DOs + Hyperdrive local)
npm run typecheck      # tsc --noEmit
npm run test           # vitest (watch)
npm run test:once      # vitest run
```

Tests run on `@cloudflare/vitest-pool-workers` against miniflare (real DO
SQLite + WebSocket hibernation, not mocks), using `wrangler.test.jsonc`.

**Under high machine load** (this host frequently sits at load 30+), the
default 5s test timeout produces false `timed out` /
`EnvironmentTeardownError` failures that are not code regressions. Run with:

```bash
npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
# single file:
npx vitest run path/to/file.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
```

## Deploy

```bash
npm run deploy         # scripts/deploy.mjs: cf-typegen → typecheck → vitest → wrangler deploy
```

`scripts/deploy.mjs` loads `.env` (without overriding existing process env) so
Sentry sourcemap upload picks up `SENTRY_AUTH_TOKEN`, `SENTRY_DSN`,
`SENTRY_ORG`, `SENTRY_PROJECT`. Sourcemap upload is skipped (warned, not
failed) when `./dist` is absent or Sentry env is unset.

## Architecture

A thin Hono Worker authenticates JWTs and proxies to Durable Objects by name.
WebSocket upgrades verify the JWT, extract `user_id`, and forward it to a
`UserConnection` DO named by `user_id`.

Eight Durable Object classes (all SQLite-backed):

| DO | Named by | Role |
|---|---|---|
| `ChatChannel` | `channel_id` | Auth source-of-truth. Owns members, messages, event log, audit logs, attachments, outbox. |
| `UserDirectory` | `user_id` | Repairable projection of memberships (`my_channels`), read-state floor, personal stickers, attachment ownership. |
| `UserConnection` | `user_id` | WebSocket hibernation + per-channel cursors; routes WS commands to `ChatChannel`. |
| `ChannelFanout` | `channel_id` | Holds online sessions per channel; delivers events to online connections. |
| `ChannelDirectory` | `shared` | Public channel directory read model. |
| `InviteDirectory` | `shared` | invite-code → channel_id global index. |
| `BotRegistry` | `shared` | Global bot identity + token hash store. |
| `SchedulerProbe` | — | Test-only (declared in `wrangler.test.jsonc`). |

### Key design invariants

- **No cross-DO two-phase commit.** CF has no such API. Cross-DO consistency
  uses a durable outbox: a source DO writes a business row + a
  `projection_outbox` row in one SQLite transaction, then a per-DO alarm
  flushes the outbox to the target DO, which writes idempotently. Exhausted
  retries go to a `dead_letter` table.
- **Per-channel cursor + per-channel monotonic UUIDv7** `event_id`s. There is
  no global event cursor; clients hold a per-channel `last_read_event_id`.
- **WebSocket commands are routed by `UserConnection`**, not the Worker —
  hibernation requires the message handler on the DO. HTTP mutations are
  routed by the Worker.
- **Idempotency via `command_id`** (= durable operation id = idempotency key).
  Dedup is namespaced by `dedupe_principal_key` so different principals never
  collide on the same client-supplied id.
- **Replay re-projects against current state.** Event payloads store only
  stable ids, never display names/avatars; deleted/recalled messages don't
  leak their original payload on replay. UserSummaries are resolved live via
  Hyperdrive.
- **Channel-scoped message locators.** Mutations always address
  `{channel_id, message_id}` — there is no message-id-only routing.

### SQLite migrations

Each DO has a migration module in `src/do/migrations/<do-name>.ts`. The
runner (`src/do/sql-migrations.ts`) runs in the DO constructor: stamps a
baseline schema on a fresh DB, then applies versioned migrations. Add
columns/indexes via a new migration with an incremented
`*_CURRENT_SCHEMA_VERSION` rather than editing the baseline.

## Documentation

- [`docs/api-contract.md`](docs/api-contract.md) — **authoritative** Browser/Bot API
  contract (single source of truth). When code and contract disagree, the contract
  wins. All API changes must update this file and add a revision-record entry.
  **Do not** retroactively update historical docs (`docs/api-contract/*` addenda,
  phase plans, gap trackers) when the API spec changes.
- `docs/api-contract/` — dated patches, discussion drafts, and changelog stubs
  only; **not** authoritative. See [`docs/api-contract/README.md`](docs/api-contract/README.md).
- `docs/superpowers/specs/` — backend design spec (with a layered revision
  history documenting why each platform-impossible pattern was rejected).
- `docs/superpowers/plans/` — per-phase implementation plans.

See `CLAUDE.md` for agent-oriented guidance (toolchain gotchas, invariants,
and testing conventions in detail).