# Lilium Chat — PG Archive (Backend Runbook)

Phase A producer path: source DOs write `archive_outbox` in the same SQLite
transaction as business rows, then flush to Cloudflare Queue via per-DO alarms.

Phase B consumer: a dedicated Cloudflare Worker pulls from the Queue and writes
normalized `chat.events` rows into PostgreSQL via Hyperdrive.

## Wrangler config split

| Component | Where configured |
|-----------|------------------|
| Queue producer (`CHAT_ARCHIVE_QUEUE`) | `wrangler.jsonc` / `wrangler.test.jsonc` → `queues.producers` |
| Queue consumer (Worker push) | `wrangler.archive.jsonc` → `queues.consumers` |

Do **not** add `queues.consumers` to `wrangler.jsonc` (main chat Worker stays
producer-only). Do **not** run an HTTP pull consumer on the same queue while the
Worker consumer is attached.

## Operator queue setup

```bash
npx wrangler queues create lilium-chat-archive \
  --message-retention-period-secs 1209600

# If queue already exists:
npx wrangler queues update lilium-chat-archive \
  --message-retention-period-secs 1209600
```

`1209600` = 14 days (max retention). Consumer retry policy is configured in
`wrangler.archive.jsonc` (`max_retries: 100`).

### Migrate off HTTP pull (if previously enabled)

```bash
npx wrangler queues consumer http remove lilium-chat-archive
```

### Deploy archive consumer Worker

```bash
# once: apply PG schema (operator machine with DATABASE_URL)
DATABASE_URL=postgres://... npm run archive:migrate

# deploy consumer Worker (Hyperdrive binding in wrangler.archive.jsonc)
npm run archive:deploy
```

Worker entry: `src/archive-consumer/index.ts`. Config: `wrangler.archive.jsonc`.

## Plan B retention semantics

- `archive_outbox.pending` — not yet in Queue; source DO must retry flush
- `archive_outbox.queued` — Queue durably accepted; audit only, **no** source requeue
- `archive_outbox.failed` — producer-side deterministic failure (e.g. validation)

Queue retention covers consumer **full stop**. The consumer **must retry the
batch without ack** when Hyperdrive/PG is unhealthy — otherwise `max_retries`
burns before retention.

## Inspect source lag

Per source DO (via internal test route or DO SQL):

```sql
SELECT status, COUNT(*) FROM archive_outbox GROUP BY status;
SELECT COUNT(*) FROM archive_outbox WHERE status='pending';
```

## BotRegistry archive (slash catalog)

Spec §0.1 and plan `2026-06-28-lilium-chat-archive-backend.md` §6.4.

**PG migration:** `scripts/archive-local/migrations/006_slash_catalog_archive.sql` drops Phase-7 bot install/event tables, adds `chat.bot_command_names`, stateful session tables, and extends `chat.bot_tokens` (`name`, `expires_at`, `last_used_at`).

**Producer routes** on singleton `BotRegistry` (`source_key=registry`):

| Route | Normalized tables |
| --- | --- |
| `commands-sync` | `chat_bot_commands`, `chat_bot_command_aliases`, `chat_bot_command_names` |
| `seed-official-bot` | `chat_bot_apps`, `chat_bot_tokens` (hash only), catalog rows |
| `bots-create` | `chat_bot_apps`, optional `chat_bot_tokens` |
| `bots-token-create` | `chat_bot_tokens` |
| `bots-token-revoke` | `chat_bot_tokens` (`revoked_at`) |

Plaintext `lcbot_*` tokens must never appear in `archive_outbox.payload_json`.

## What is not archived

Runtime/projection state per spec §3.6: `projection_outbox`, `idempotency_keys`,
`rate_buckets`, `event_seq`, fanout tables, live sessions, `my_channels`, etc.

## Data flow

```text
Source DO business txn
  → archive_outbox (same txn)
Source DO alarm
  → flushArchiveOutboxToQueue → CHAT_ARCHIVE_QUEUE
lilium-chat-archive-consumer Worker
  → queue batch handler → chat.events (upsert) via LILIUM_DB Hyperdrive → ack
```

## PG schema

Normalized `chat.events` table (idempotent upsert on `event_id`):

```bash
DATABASE_URL=postgres://... npm run archive:migrate
```

Migration: `scripts/archive-local/migrations/001_chat_events.sql`.

## Backfill legacy raw events

If the old HTTP-pull daemon stored full `ArchiveRecord` JSON in `chat.events(payload)`
(raw schema: `id`, `payload`, `received_at`), run backfill after migrate:

```bash
DATABASE_URL=postgres://... npm run archive:backfill
```

The script will:

1. Rename `chat.events` → `chat.events_raw` when the raw schema is detected
2. Apply migrations `001`–`006` (normalized tables + `chat_archive_records` / watermarks; `006` = slash-catalog bot table realignment)
3. For each legacy raw row: `INSERT` into `chat_archive_records`, mark `chat.archive_backfill_applied`
4. Drain per-source watermarks into normalized tables (same path as queue consumer)
5. Final sweep loops until `chat_archive_records` has no pending rows

Replay applies **every** `changes[]` entry in each ArchiveRecord (all whitelisted
tables: channels, members, messages, events, bots, invites, …) — not only message tables.

Re-run from scratch:

```bash
BACKFILL_RESET=full DATABASE_URL=postgres://... npm run archive:backfill
```

Replay-only (raw log already ingested):

```bash
BACKFILL_RESET=replay BACKFILL_SKIP_INGEST=1 DATABASE_URL=postgres://... npm run archive:backfill
```

Dry run:

```bash
BACKFILL_DRY_RUN=1 DATABASE_URL=postgres://... npm run archive:backfill
```

## Legacy local HTTP-pull daemon (deprecated)

`scripts/archive-local/daemon.mjs` and `npm run archive:daemon` remain for
emergency local replay only. Production path is the archive consumer Worker.
