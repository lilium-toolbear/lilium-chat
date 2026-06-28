# Lilium Chat — Local PG Archive (Backend Runbook)

Phase A producer path: source DOs write `archive_outbox` in the same SQLite
transaction as business rows, then flush to Cloudflare Queue via per-DO alarms.

Phase B (local daemon + PG replay) is required for full feature acceptance. See
`docs/superpowers/specs/2026-06-28-lilium-chat-local-pg-archive-cf-queue.md`.

## Wrangler config split

| Component | Where configured |
|-----------|------------------|
| Queue producer (`CHAT_ARCHIVE_QUEUE`) | `wrangler.jsonc` / `wrangler.test.jsonc` → `queues.producers` |
| HTTP pull consumer | **Not** in wrangler config — operator CLI/dashboard only |

Do not add `queues.consumers` or legacy `type: "http_pull"` to wrangler JSONC.

## Operator queue setup

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

`1209600` = 14 days (max retention). Configure `--message-retries 100` to
maximize retry window before permanent deletion at `max_retries`.

## Plan B retention semantics

- `archive_outbox.pending` — not yet in Queue; source DO must retry flush
- `archive_outbox.queued` — Queue durably accepted; audit only, **no** source requeue
- `archive_outbox.failed` — producer-side deterministic failure (e.g. validation)

Queue retention covers daemon **full stop**. The daemon **must not pull** when
local PG is unhealthy — otherwise `max_retries` burns before retention (spec §8.5).

Daemon pull body field: `visibility_timeout` (milliseconds), not `visibility_timeout_ms`.

## Inspect source lag

Per source DO (via internal test route or DO SQL):

```sql
SELECT status, COUNT(*) FROM archive_outbox GROUP BY status;
SELECT COUNT(*) FROM archive_outbox WHERE status='pending';
```

## What is not archived

Runtime/projection state per spec §3.6: `projection_outbox`, `idempotency_keys`,
`rate_buckets`, `event_seq`, fanout tables, live sessions, `my_channels`, etc.

## Data flow

```text
Source DO business txn
  → archive_outbox (same txn)
Source DO alarm
  → flushArchiveOutboxToQueue → CHAT_ARCHIVE_QUEUE
Local daemon (Phase B)
  → HTTP pull → local PG → ack
```
