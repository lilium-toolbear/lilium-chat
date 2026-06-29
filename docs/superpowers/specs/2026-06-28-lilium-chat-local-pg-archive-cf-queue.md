# Lilium Chat — Full Local PG Archive via Cloudflare Queue

## 0. Purpose

Implement full asynchronous archiving for Lilium Chat backend business data into a local PostgreSQL database.

This spec replaces the previous `ArchiveRelay DO` design with Cloudflare Queue HTTP pull consumers.

No backfill is required. Assume existing production data is empty or disposable. The archive system only needs to guarantee completeness for writes after this implementation is deployed.

This is a one-shot full implementation. Do not split into phases. Do not implement only message archive first.

### 0.1 Revision — slash catalog bot tables + developer API archive (2026-06-29)

Slash-command backend (`feat/bot-slash-command-backend`) realigns **bot-related normalized PG tables** and **BotRegistry producer paths**. Local PG applies `scripts/archive-local/migrations/006_slash_catalog_archive.sql` after `001`–`005`.

**Removed from replay** (Phase-7 installation / passive-event model; drop in `006`):

```text
chat_bot_installations
chat_bot_event_capabilities
chat_channel_command_names          # channel-scoped slash index (replaced by global bot_command_names)
chat_channel_bot_event_subscriptions
```

**Added / realigned:**

```text
chat_bot_command_names              # global slash namespace (BotRegistry)
chat_stateful_command_sessions      # ChatChannel
chat_stateful_session_inputs        # ChatChannel
```

**Column / PK changes (existing tables):**

| Table | Change |
| --- | --- |
| `chat.bot_apps` | add `description`, `visibility`; drop `callback_url` |
| `chat.bot_tokens` | add `name`, `expires_at`, `last_used_at`; archive payload field `scopes` (from DO `scopes_json`) |
| `chat.bot_commands` | add `execution_mode`, `stateful_config_json`, `status`; drop `enabled`, `default_enabled_on_install` |
| `chat.channel_command_bindings` | PK `(channel_id, bot_command_id)`; snapshot column `command_snapshot_json`; drop per-channel alias/options columns |

**BotRegistry archive producers** (`sourceKind=bot_registry`, `sourceKey=registry`):

| Internal route | Archive changes |
| --- | --- |
| `/internal/commands-sync` | `chat_bot_commands` upsert; `chat_bot_command_aliases` + `chat_bot_command_names` replace_scope per `bot_command_id` |
| `/internal/seed-official-bot` | `chat_bot_apps` upsert; `chat_bot_tokens` upsert (**hash only**); catalog rows as commands-sync |
| `/internal/bots-create` | `chat_bot_apps` upsert; optional `chat_bot_tokens` upsert when `issue_initial_token` |
| `/internal/bots-token-create` | `chat_bot_tokens` upsert |
| `/internal/bots-token-revoke` | `chat_bot_tokens` upsert with `revoked_at` (first revoke only; idempotent retry does not re-emit) |

Never archive plaintext `lcbot_*` tokens. `REPLAY_TABLES` / `ARCHIVE_TABLE_WHITELIST` must match exactly (`test/archive/drift.test.ts`).

## 1. Required architecture

### 1.1 Data flow

Required data flow:

```text
Source DO business transaction
  ├─ writes canonical DO SQLite business rows
  └─ writes source-local archive_outbox row in the same SQLite transaction

Source DO alarm
  └─ flushes pending archive_outbox rows to Cloudflare Queue

Cloudflare Queue
  └─ durably stores archive messages

Local archiver daemon
  └─ HTTP pull Queue messages
  └─ writes raw archive records into local PG
  └─ replays ready records into normalized PG tables in source_seq order
  └─ acknowledges Queue messages after PG commit
```

Expanded form:

```text
Source DO
  -> source DO archive_outbox
  -> Cloudflare Queue
  -> local daemon HTTP pull
  -> local PG chat_archive_records
  -> local PG normalized business tables
```

### 1.2 Consistency semantics

The archive system is eventually consistent.

Business write success means the source DO canonical SQLite transaction has committed.

Archive success means:

```text
source archive_outbox row committed
source alarm flushed archive_outbox message to Cloudflare Queue
local daemon pulled Queue message
local PG inserted chat_archive_records raw record
local PG replayed all ready per-source records into normalized tables
Queue message acknowledged
```

Temporary failure of Cloudflare Queue, local daemon, or local PG must not fail the chat business path.

Archive delivery is at-least-once. PG ingestion and replay must be idempotent.

### 1.3 Mandatory transactional outbox

Do not publish directly to Cloudflare Queue from business code after the business transaction without first writing source-local `archive_outbox`.

Reason:

```text
Business txn committed -> queue send fails/crashes = archive loss
Queue send succeeds -> business txn rolls back = false archive record
```

Therefore every source DO must write `archive_outbox` in the same SQLite transaction as its canonical business rows.

### 1.4 Explicit non-goals

Do not implement backfill.

Do not enumerate existing Durable Objects.

Do not archive runtime-only state.

Do not use a custom ArchiveRelay DO.

Do not make chat business requests synchronously depend on local PG.

Do not use Cloudflare Queue push consumers for the local PG path.

## 2. Cloudflare Queue configuration

### 2.1 Queue name

Create one queue:

```text
lilium-chat-archive
```

### 2.2 Worker producer binding

Add a queue producer binding to `wrangler.jsonc`:

```jsonc
{
  "queues": {
    "producers": [
      {
        "binding": "CHAT_ARCHIVE_QUEUE",
        "queue": "lilium-chat-archive"
      }
    ]
  }
}
```

If the current Wrangler JSONC schema requires array form, use the schema-compatible equivalent. The binding name must be exactly:

```text
CHAT_ARCHIVE_QUEUE
```

### 2.3 Env type

Add to `Env`:

```ts
interface Env {
  CHAT_ARCHIVE_QUEUE: Queue<ArchiveQueueMessage>;
}
```

### 2.4 Enable HTTP pull consumer

Enable HTTP pull for the queue out-of-band with Wrangler CLI or dashboard.

Required commands (create queue with max retention, then add pull consumer with
retry/visibility aligned to Plan B — see §2.6):

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

`1209600` seconds = 14 days (paid-plan maximum). `--message-retries 100` matches
Cloudflare Queue limits maximum; combined with `--visibility-timeout-secs 600`
this maximizes the retry window before messages are permanently deleted at
`max_retries`. The local daemon must still avoid burning retries while PG is
unhealthy (§8.5).

Do not configure a Worker push consumer for this queue.

Do not rely on Wrangler config to enable HTTP pull. Treat HTTP pull enablement as an operator step.

Do not add `queues.consumers` or legacy `type: "http_pull"` to `wrangler.jsonc`. Producer binding only:

```text
queues.producers → wrangler.jsonc
HTTP pull consumer → wrangler queues consumer http add (CLI) or dashboard
```

### 2.5 Queue limits and payload policy

Cloudflare Queue message constraints require a conservative archive message size policy.

Rules:

```text
One Cloudflare Queue message = one ArchiveRecord
Target ArchiveRecord serialized size <= 96 KiB
Hard fail appendArchiveRecordSync if serialized size > 120 KiB (business txn rolls back)
Do not call queue.send/sendBatch with a record > 120 KiB
sendBatch <= 100 messages; each entry is { body: ArchiveRecord, contentType: "json" }
sendBatch total payload <= 240 KiB target
```

The target is intentionally below Cloudflare’s hard 128 KB single message limit and 256 KB sendBatch limit to leave room for metadata and JSON overhead.

If an archive record exceeds 120 KiB, `appendArchiveRecordSync` must throw before the business transaction commits. Do not insert an `archive_outbox` row and do not mark a row `failed` at flush time — by then the business data is already committed and the archive fact would be permanently lost.

Do not split one business transaction into multiple archive records in the first implementation.

### 2.6 Queue message retention and retries (operational, Plan B)

Cloudflare Queues message retention is an **operational constraint**, not a
source-DO recovery mechanism. Maximum configurable retention is **14 days**
(`--message-retention-period-secs 1209600`); messages older than the configured
window are deleted.

**Retention is the recovery window only while messages are not being repeatedly
consumed and failed.** Cloudflare also enforces per-message `max_retries` (up to
100). When `attempts` reaches `max_retries`, the message is permanently deleted
from the Queue — potentially **before** retention expires. Pull responses include
an `attempts` field per leased message.

Therefore Plan B requires **two** operational guarantees:

```text
1. Retention sizing: configure retention to max acceptable outage (up to 14 days);
   daemon fully stopped must recover before retention expiry.
2. No retry burn: daemon must NOT call /messages/pull while downstream PG is
   unhealthy; tight pull → PG-fail → retry loops exhaust max_retries while source
   archive_outbox rows are already status='queued' (no requeue) → archive loss.
```

Operator requirements:

```text
create/update queue with --message-retention-period-secs 1209600
add HTTP pull consumer with --message-retries 100 --visibility-timeout-secs 600
document planned daemon full-stop downtime < retention
do not implement source-DO requeue from status='queued' rows (see §4.7)
daemon implements PG health gate before pull (§8.5)
```

Recovery from daemon **full stop**: restore before retention expiry. Recovery from
**PG outage while daemon runs**: stop pulling until PG healthy — do not rely on
retention alone.

## 3. Source of truth and archive scope

### 3.1 Source DOs

Only these DOs produce archive records:

```text
ChatChannel(channel_id)
UserDirectory(user_id)
DMDirectory(pair_key)
BotRegistry("registry")
```

### 3.2 ChatChannel archive scope

Archive these business tables or equivalent current row state:

```text
channel_meta
members
messages
message_edits
audit_logs
attachments
message_attachments
message_stickers
mentions
invites
events
channel_command_bindings
command_invocations
interactions
stateful_command_sessions
stateful_session_inputs
```

Removed from slash-catalog scope (see §0.1): `bot_installations`, `channel_command_names`, `channel_bot_event_subscriptions`.

Do not archive:

```text
idempotency_keys
projection_outbox
bot_delivery_outbox
bot_effects_applied
rate_buckets
event_seq
```

`bot_effects_applied` is idempotency/provenance state. Archive the resulting business effects: messages, interactions, invocations, events, and audit rows.

### 3.3 UserDirectory archive scope

Archive:

```text
finalized pending_attachments rows as chat_attachments
personal_stickers
```

Do not archive:

```text
my_channels
last_read_event_id
idempotency_keys
non-finalized transient upload rows
pending upload expiry jobs
```

`my_channels` is a projection; canonical membership is in ChatChannel. `last_read_event_id` is a user cursor and intentionally excluded.

### 3.4 DMDirectory archive scope

Archive:

```text
dm_pairs
```

### 3.5 BotRegistry archive scope

Archive:

```text
bot_apps
bot_tokens
bot_commands
bot_command_aliases
bot_command_names
```

Removed from slash-catalog scope (see §0.1): `bot_event_capabilities`.

Only token hashes may be archived. Never archive plaintext bot tokens. Token rows include metadata columns `name`, `expires_at`, `last_used_at`; payload uses `scopes` (stringified JSON), not `scopes_json`.

### 3.6 Runtime state that must never appear in archive payloads

Never archive:

```text
UserConnection.live_sessions
UserConnection.live_channel_leases
ChannelFanout.online_sessions
ChannelFanout.fanout_events
ChannelFanout.fanout_queue
ChannelFanout.fanout_leases
BotConnection.bot_connection_state
BotConnection.bot_deliveries
projection_outbox
bot_delivery_outbox
idempotency_keys
rate_buckets
event_seq
my_channels.last_read_event_id
```

## 4. Source-local archive_outbox

### 4.1 Add schema to all source DOs

Add the following tables to these DO migrations:

```text
ChatChannel
UserDirectory
DMDirectory
BotRegistry
```

Schema:

```sql
CREATE TABLE IF NOT EXISTS archive_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq INTEGER NOT NULL
);

INSERT OR IGNORE INTO archive_seq (id, last_seq) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS archive_outbox (
  archive_id       TEXT PRIMARY KEY,
  source_kind      TEXT NOT NULL,
  source_key       TEXT NOT NULL,
  source_seq       INTEGER NOT NULL,
  payload_json     TEXT NOT NULL,

  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 20,
  last_error       TEXT,
  next_attempt_at  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  UNIQUE(source_kind, source_key, source_seq)
);

CREATE INDEX IF NOT EXISTS idx_archive_outbox_due
  ON archive_outbox(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_archive_outbox_source_seq
  ON archive_outbox(source_kind, source_key, source_seq);
```

### 4.2 Add archive helper modules

Add:

```text
src/archive/payload.ts
src/archive/source-outbox.ts
src/archive/hash.ts
src/archive/queue-flush.ts
```

### 4.3 Archive payload types

`src/archive/payload.ts`:

```ts
export type ArchiveSourceKind =
  | "chat_channel"
  | "user_directory"
  | "dm_directory"
  | "bot_registry";

export type ArchiveChange =
  | {
      op: "upsert";
      table: string;
      pk: Record<string, string | number>;
      row_version: string;
      after: Record<string, unknown>;
    }
  | {
      op: "delete";
      table: string;
      pk: Record<string, string | number>;
      row_version: string;
    }
  | {
      op: "replace_scope";
      table: string;
      scope: Record<string, string | number>;
      row_version: string;
      rows: Array<Record<string, unknown>>;
    };

export interface ArchiveRecord {
  format: "lilium.chat.archive.record.v1";
  archive_id: string;
  source_kind: ArchiveSourceKind;
  source_key: string;
  source_seq: number;
  business_event_ids: string[];
  occurred_at: string;
  changes: ArchiveChange[];
}
```

### 4.4 Append helper

`appendArchiveRecordSync(ctx, input)` must be sync and safe to call inside `ctx.storage.transactionSync()` or inside the synchronous portion of `ctx.storage.transaction()`.

Signature:

```ts
appendArchiveRecordSync(ctx, {
  sourceKind,
  sourceKey,
  occurredAt,
  businessEventIds,
  buildChanges: (sourceSeq: number) => ArchiveChange[],
})
```

Rules:

* Read `archive_seq.last_seq`.
* Increment by one → `source_seq`.
* Update `archive_seq`.
* `changes = buildChanges(source_seq)` — callers set per-change `row_version` using `source_seq` or event ids per §5.3.
* Build `archive_id`:

```text
${source_kind}:${base64url(source_key)}:${source_seq}
```

`base64url` = standard base64url without padding. `source_key` retains its raw DO name (e.g. DM `pair_key` stays `user_low:user_high`). Never parse `archive_id` with naive `split(":")`.

* Build `ArchiveRecord`.
* Serialize canonical JSON.
* If canonical payload byte length > 120 KiB, throw `ARCHIVE_RECORD_TOO_LARGE` (rolls back the open business transaction).
* Insert pending `archive_outbox` row.
* `next_attempt_at = occurredAt`.

### 4.5 Source DO alarm flush

Each source DO alarm must flush archive outbox via a direct bounded call to `flushArchiveOutboxToQueue` (default `limit: 100`). Do **not** register `archive_outbox` in `runDueJobs` — that helper performs an unbounded `SELECT *` with no `LIMIT`. `scheduleNextAlarm` may include `archive_outbox` for `MIN(next_attempt_at)` scheduling only.

Existing alarm behavior must remain intact.

ChatChannel:

* Keep existing projection outbox/fanout alarm behavior.
* Add archive outbox flush.
* Archive failure must not prevent projection/fanout retry scheduling.

UserDirectory:

* Keep pending attachment cleanup alarm.
* Add archive outbox flush.

DMDirectory:

* Add alarm if absent.

BotRegistry:

* Replace no-op alarm with archive outbox flush.

### 4.6 Queue flush behavior

`flushArchiveOutboxToQueue(ctx, queue, opts?)`:

`queue` is `env.CHAT_ARCHIVE_QUEUE` at the DO call site; unit tests pass a fake
`Queue<ArchiveRecord>` for the same signature.

Query:

```sql
SELECT archive_id, source_kind, source_key, source_seq, payload_json
FROM archive_outbox
WHERE status='pending' AND next_attempt_at <= ?
ORDER BY source_seq ASC
LIMIT ?
```

Rules:

* Default limit: 100.
* Build `queue.sendBatch()` batches using `MessageSendRequest[]`:

```ts
records.map((record) => ({ body: record, contentType: "json" }))
```

* Never exceed 100 messages per sendBatch.
* Target total serialized message payload <= 240 KiB per sendBatch.
* Oversized records (> 120 KiB) cannot exist in `archive_outbox` — rejected at append time (§2.5).
* On queue send success:

  * mark rows `status='queued'`
  * keep rows for local inspection
* On queue send failure:

  * increment attempts
  * set exponential backoff `next_attempt_at`
  * keep `status='pending'`
  * if attempts >= max_attempts, mark `status='failed'` (use archive-specific retry helper; do not reuse `bumpQueueRetry` which writes `dead_letter`/`failed_at`)
* Schedule next alarm if any pending rows remain.

Use Cloudflare Queue message body as the parsed ArchiveRecord object, not a string, if supported by current Worker Queue API. Otherwise send canonical JSON string. The local daemon must accept both object and JSON-string body formats.

### 4.7 Source outbox status semantics and Queue retention

Do not delete source `archive_outbox` rows automatically. Each row's `status`
has a fixed meaning:

```text
pending  — not yet durably accepted by Cloudflare Queue; source DO alarm must retry flush
queued   — Queue has durably accepted the message; row kept for audit / manual inspection only
failed   — producer-side deterministic failure (e.g. ARCHIVE_RECORD_TOO_LARGE, max_attempts exhausted)
```

**`queued` does not bear recovery responsibility.** Once a row is `queued`, the
source DO's job is done. Do **not** implement automatic requeue from `queued`
rows back into the Queue. `payload_json` on `queued` rows is not a durable
recovery source for daemon/Queue outages.

**Queue retention is an operational constraint** (see §2.6). Retention protects
against daemon **full stop**, not against **retry exhaustion** while the daemon
keeps pulling with PG down.

Operators must:

```text
configure lilium-chat-archive retention to max acceptable full-stop window (up to 14 days)
configure HTTP pull consumer --message-retries 100 --visibility-timeout-secs 600
ensure daemon does not pull when PG unhealthy (§8.5)
monitor daemon + PG health; full-stop recovery = restore daemon before retention expiry
```

If daemon **full stop** exceeds Queue retention, messages are **lost** from the
Queue while source rows may remain `status='queued'`. That gap is accepted under
Plan B — prevention is operational (retention sizing + daemon uptime), not
source-DO requeue.

If daemon **runs** but PG is unavailable and the daemon keeps pulling, messages
can hit `max_retries` and be deleted **before** retention expires while source
rows are already `queued`. This is **not** acceptable — the daemon must gate
pull on PG health (§8.5, §10.3).

PG `chat_archive_records` is authoritative only for messages the daemon already
pulled and committed.

Retention policy for source rows:

```text
pending rows: never auto-deleted
queued rows: never auto-deleted (audit); no auto-compact in first implementation
failed rows: never auto-deleted
```

## 5. Archive payload construction rules

### 5.1 General rules

Archive payloads are declarative logical row changes.

Never send raw SQL.

Never rely on the local daemon to infer missing rows from events.

Every mutation must include enough row snapshots for PG to become correct after replay.

For updates, send full normalized row snapshot after mutation.

For soft delete, send `upsert` with `deleted_at`, `left_at`, `revoked_at`, `status`, or equivalent terminal field.

For hard delete or replace-current-set semantics, use `delete` or `replace_scope`.

### 5.2 Required `replace_scope`

Use `replace_scope` for source logic that deletes/rebuilds scoped child rows.

Required cases:

```text
BotRegistry command aliases after command sync:
  table = chat_bot_command_aliases
  scope = { bot_command_id }

BotRegistry global slash names after command sync:
  table = chat_bot_command_names
  scope = { bot_command_id }

ChatChannel command binding allow/block (slash catalog):
  table = chat_channel_command_bindings
  scope = { channel_id, bot_command_id }   # upsert per binding; no channel_command_names child table

Message child snapshots:
  table = chat_mentions
  scope = { message_id }

Message image attachments:
  table = chat_message_attachments
  scope = { message_id }

Message sticker snapshot:
  table = chat_message_stickers
  scope = { message_id }
```

### 5.3 Row version

`row_version` is set **per `ArchiveChange`**, not once per record.

* `chat_events` changes: use that change row's `event_id`.
* All other tables in a single-event ChatChannel mutation: use that mutation's `event_id`.
* All other tables in a multi-event ChatChannel mutation (e.g. `create-channel` with `channel.created` + `member.joined`): use `source_seq:<number>`.
* UserDirectory / DMDirectory / BotRegistry changes: always `source_seq:<number>`.

The PG per-source sequence replay order is authoritative.

### 5.4 Message payload rule

Do not rely on `chat_events.payload_json` for full message data.

Every message mutation archive record must include normalized changes for all relevant tables:

```text
chat_messages
chat_mentions
chat_attachments if applicable
chat_message_attachments if applicable
chat_message_stickers if applicable
chat_events
chat_message_edits if applicable
chat_audit_logs if applicable
```

## 6. Source mutation instrumentation

### 6.1 ChatChannel

Instrument every current business mutation path.

Required paths include:

```text
/internal/create-channel
/internal/create-dm
/internal/update-channel
/internal/dissolve-channel
/internal/join
/internal/invites-create
/internal/invites-accept
/internal/owner-transfer
/internal/members-add
/internal/members-remove
/internal/members-role-update
/internal/message-send
/internal/message-edit
/internal/message-recall
/internal/message-delete
/internal/bot-install
/internal/bot-install-update
/internal/command-binding-update
/internal/command-invoke          — required when route exists (not implemented today)
/internal/interaction-submit      — required when route exists (not implemented today)
bot effect application paths that create/update messages or interactions
```

`/internal/command-invoke` and `/internal/interaction-submit` are **not**
implemented as ChatChannel routes today (`UserConnection` returns unsupported).
Archive instrumentation for these paths is required **when the routes land**;
until then they are drift TODO/allowlist items and must not block Phase A/B
archive delivery. Do not fail integration or acceptance gates on missing
non-archive product features.

For each mutation, append the archive record in the same SQLite transaction as the canonical business rows.

#### create-channel

Archive:

```text
chat_channels upsert
chat_channel_members upsert for creator and initial members
chat_events upsert for channel.created and member.joined events
```

Do not archive ChannelDirectory projection separately.

#### create-dm

Archive:

```text
chat_channels upsert with kind='dm'
chat_channel_members upsert for both participants
chat_audit_logs upsert for channel.create_dm audit
chat_events upsert for channel.created
```

DM pair is archived by DMDirectory.

#### update-channel

Archive:

```text
chat_channels upsert
chat_events upsert channel.updated
chat_audit_logs upsert if audit is written
```

#### dissolve-channel

Archive:

```text
chat_channels upsert status='dissolved'
chat_channel_members upsert if mutated
chat_events upsert channel.dissolved
chat_audit_logs upsert if audit is written
```

#### join / invite accept / members add

Archive:

```text
chat_channels upsert with updated member_count and membership_version
chat_channel_members upsert
chat_invites upsert if used_count changes
chat_events upsert member.joined
```

#### leave / remove member

Archive:

```text
chat_channels upsert with updated member_count and membership_version
chat_channel_members upsert with left_at
chat_events upsert member.left
chat_audit_logs upsert if audit is written
```

#### role update / owner transfer

Archive:

```text
chat_channel_members upsert affected members
chat_channels upsert membership_version if changed
chat_events upsert member.role_updated
chat_audit_logs upsert if audit is written
```

#### invite create

Archive:

```text
chat_invites upsert
```

Also archive invite-related event/audit if current code writes it.

#### message send

Archive:

```text
chat_messages upsert
chat_mentions replace_scope { message_id }
chat_attachments upsert for image attachments copied into ChatChannel
chat_message_attachments replace_scope { message_id }
chat_message_stickers replace_scope { message_id }
chat_events upsert message.created
```

For sticker messages, archive `chat_message_stickers` snapshot so historical sticker messages remain stable after personal sticker deletion.

#### message edit

Archive:

```text
chat_messages upsert status/text/edited_at
chat_message_edits upsert
chat_mentions replace_scope { message_id } if current mention set is loaded
chat_events upsert message.updated
```

#### message recall/delete

Archive:

```text
chat_messages upsert status/recalled_at/deleted_at/deleted_by
chat_audit_logs upsert if written
chat_events upsert message.recalled or message.deleted
```

Do not delete archived attachments/stickers.

#### bot install

> **Obsolete (slash catalog):** installation model removed. Historical reference only.

Archive:

```text
chat_bot_installations upsert
chat_channel_command_bindings replace_scope { channel_id, bot_id }
chat_channel_command_names replace_scope { channel_id, bot_id }
chat_channel_bot_event_subscriptions replace_scope { channel_id, bot_id }
chat_events upsert bot.installed
```

Current model: `PATCH .../commands/{bot_command_id}` allow/block emits `chat_channel_command_bindings` upsert only (see §0.1).

#### bot install update

> **Obsolete (slash catalog).**

Archive:

```text
chat_bot_installations upsert
chat_channel_bot_event_subscriptions upsert or replace_scope if changed
chat_events upsert bot.updated
```

#### command binding update

Archive:

```text
chat_channel_command_bindings upsert
chat_channel_command_names replace_scope { channel_id, bot_command_id }
chat_events upsert command.binding_updated
```

#### command invoke

Archive:

```text
chat_command_invocations upsert
chat_interactions upsert if created
chat_events upsert if visible event is created
```

#### interaction submit

Archive:

```text
chat_interactions upsert
chat_command_invocations upsert if status changes
chat_messages upsert if bot effect updates message
chat_events upsert if visible event is created
```

### 6.2 UserDirectory

Instrument:

```text
/internal/attachment-finalize
/internal/sticker-save
/internal/sticker-delete
```

#### attachment-finalize

Only archive when attachment is finalized or already finalized and a canonical finalized row is returned.

Archive:

```text
chat_attachments upsert
```

Include:

```text
attachment_id
owner_user_id
kind
filename
mime_type
size_bytes
width
height
blurhash
storage_key
url
status
created_at
```

#### sticker-save

Archive:

```text
chat_personal_stickers upsert
```

If restoring a soft-deleted sticker, archive with `deleted_at = null`.

#### sticker-delete

Archive:

```text
chat_personal_stickers upsert with deleted_at
```

### 6.3 DMDirectory

Instrument:

```text
/internal/get-or-create-dm
/internal/complete-dm
```

#### get-or-create-dm

If inserting a new row, archive:

```text
chat_dm_pairs upsert status='creating'
```

If returning existing row without mutation, no archive record is required.

#### complete-dm

If changing status from `creating` to `active`, archive:

```text
chat_dm_pairs upsert status='active'
```

If already active, no archive record is required.

### 6.4 BotRegistry

Instrument:

```text
/internal/commands-sync
/internal/seed-official-bot
/internal/bots-create
/internal/bots-token-create
/internal/bots-token-revoke
```

(`/internal/token-verify` is read-only — no archive.)

#### commands-sync

Archive:

```text
chat_bot_commands upsert for each command in request
chat_bot_command_aliases replace_scope { bot_command_id } for each command in request
chat_bot_command_names replace_scope { bot_command_id } for each command in request
```

Disabled/deleted-by-sync semantics archive final row state via `status` / `deleted_at`.

#### seed-official-bot

Archive (same transaction as SQLite writes):

```text
chat_bot_apps upsert
chat_bot_tokens upsert when a new token row is inserted (token_hash only)
catalog rows as commands-sync
```

#### Browser bot developer API (internal)

`POST /internal/bots-create` — after insert:

```text
chat_bot_apps upsert
chat_bot_tokens upsert when issue_initial_token=true (token_hash, name, scopes, expires_at; never plaintext)
```

`POST /internal/bots-token-create`:

```text
chat_bot_tokens upsert
```

`POST /internal/bots-token-revoke` — on first revoke only:

```text
chat_bot_tokens upsert with revoked_at set
```

#### token paths (all routes)

Archive token hash rows only:

```text
chat_bot_tokens upsert
```

Never archive plaintext token.

## 7. Local PG schema

### 7.1 Local daemon migration directory

Add:

```text
scripts/archive-local/migrations/001_init.sql
```

### 7.2 Common archive metadata

Every normalized table must include:

```sql
archived_source_kind TEXT NOT NULL,
archived_source_key  TEXT NOT NULL,
archived_source_seq  BIGINT NOT NULL,
archived_at          TIMESTAMPTZ NOT NULL DEFAULT now()
```

Every normalized upsert must guard against old source sequence:

```sql
WHERE target.archived_source_seq <= EXCLUDED.archived_source_seq
```

### 7.3 Raw archive log

```sql
CREATE TABLE IF NOT EXISTS chat_archive_records (
  archive_id   TEXT PRIMARY KEY,
  source_kind  TEXT NOT NULL,
  source_key   TEXT NOT NULL,
  source_seq   BIGINT NOT NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at   TIMESTAMPTZ,
  apply_error  TEXT,

  UNIQUE(source_kind, source_key, source_seq)
);

CREATE INDEX IF NOT EXISTS idx_chat_archive_records_ready
  ON chat_archive_records(source_kind, source_key, source_seq)
  WHERE applied_at IS NULL;
```

### 7.4 Per-source replay watermarks

```sql
CREATE TABLE IF NOT EXISTS chat_archive_source_watermarks (
  source_kind      TEXT NOT NULL,
  source_key       TEXT NOT NULL,
  last_applied_seq BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY(source_kind, source_key)
);
```

### 7.5 Normalized business tables

Create all of the following normalized tables:

```text
chat_channels
chat_channel_members
chat_messages
chat_message_edits
chat_audit_logs
chat_events
chat_attachments
chat_message_attachments
chat_message_stickers
chat_mentions
chat_invites
chat_dm_pairs
chat_personal_stickers

chat_bot_apps
chat_bot_tokens
chat_bot_commands
chat_bot_command_aliases
chat_bot_command_names
chat_channel_command_bindings
chat_stateful_command_sessions
chat_stateful_session_inputs
chat_command_invocations
chat_interactions
```

Slash-catalog removals (see §0.1): `chat_bot_installations`, `chat_bot_event_capabilities`, `chat_channel_command_names`, `chat_channel_bot_event_subscriptions`.

Use the column shapes from current source DO schemas, with timestamp columns stored as `TIMESTAMPTZ` and JSON columns stored as `JSONB`.

Required primary keys:

```text
chat_channels: channel_id
chat_channel_members: (channel_id, user_id)
chat_messages: message_id
chat_message_edits: edit_id
chat_audit_logs: audit_id
chat_events: event_id
chat_attachments: attachment_id
chat_message_attachments: (message_id, attachment_id)
chat_message_stickers: message_id
chat_mentions: (message_id, start_index, end_index)
chat_invites: invite_code
chat_dm_pairs: pair_key
chat_personal_stickers: sticker_id, plus UNIQUE(user_id, attachment_id)

chat_bot_apps: bot_id
chat_bot_tokens: token_id, plus UNIQUE(token_hash)
chat_bot_commands: bot_command_id, plus UNIQUE(bot_id, name)
chat_bot_command_aliases: (bot_command_id, alias)
chat_bot_command_names: slash_token (PK)
chat_channel_command_bindings: (channel_id, bot_command_id)
chat_stateful_command_sessions: session_id
chat_stateful_session_inputs: (session_id, seq)
chat_command_invocations: invocation_id, plus UNIQUE(channel_id, invoker_user_id, command_id)
chat_interactions: interaction_id
```

## 8. Local archiver daemon

### 8.1 Add package

Add:

```text
scripts/archive-local/package.json
scripts/archive-local/tsconfig.json
scripts/archive-local/src/index.ts
scripts/archive-local/src/queue-client.ts
scripts/archive-local/src/pg.ts
scripts/archive-local/src/replay.ts
scripts/archive-local/src/drain.ts
scripts/archive-local/migrations/001_init.sql
```

Use Node.js TypeScript.

Required dependency:

```text
pg
```

Do not depend on Cloudflare Worker runtime inside local daemon.

### 8.2 Environment variables

```text
CF_ACCOUNT_ID=<account id>
CF_QUEUE_ID=<queue id>
CF_QUEUES_TOKEN=<api token with queues read/write>
DATABASE_URL=postgres://...
QUEUE_PULL_BATCH_SIZE=100
QUEUE_VISIBILITY_TIMEOUT_MS=600000   # maps to pull body field visibility_timeout (ms)
POLL_INTERVAL_MS=1000
MAX_DRAIN_RECORDS_PER_SOURCE=1000
```

### 8.3 Queue pull API

The daemon must call:

```text
POST https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/queues/${CF_QUEUE_ID}/messages/pull
```

Body (field names per Cloudflare pull consumer API — use `visibility_timeout`, not
`visibility_timeout_ms`):

```json
{
  "visibility_timeout": 600000,
  "batch_size": 100
}
```

Daemon construction:

```ts
const body = {
  visibility_timeout: Number(process.env.QUEUE_VISIBILITY_TIMEOUT_MS ?? 600000),
  batch_size: Number(process.env.QUEUE_PULL_BATCH_SIZE ?? 100),
};
```

`visibility_timeout` is the HTTP JSON field name. `QUEUE_VISIBILITY_TIMEOUT_MS`
is the local env var name only.

Cloudflare docs may show inconsistent examples (`visibility_timeout_ms` in some
code blocks); use `visibility_timeout`. Phase B includes a live Queue pull smoke
test to verify the API accepts the chosen field name (§12.1).

Headers:

```http
Authorization: Bearer ${CF_QUEUES_TOKEN}
Content-Type: application/json
```

### 8.4 Queue ack/retry API

The daemon must call:

```text
POST https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/queues/${CF_QUEUE_ID}/messages/ack
```

Successful messages:

```json
{
  "acks": [{ "lease_id": "..." }],
  "retries": []
}
```

Failed retryable messages:

```json
{
  "acks": [],
  "retries": [{ "lease_id": "...", "delay_seconds": 60 }]
}
```

Only ack a Queue message after its raw record has been committed to PG.

Pulled messages include `lease_id` and `attempts` (current delivery attempt count
toward `max_retries`). Track `attempts` in structured logs; rising `attempts`
while PG is unhealthy indicates retry-burn risk.

### 8.5 PG health gate (required before pull)

The daemon **must** verify PG connectivity before every `/messages/pull` call
(e.g. lightweight `SELECT 1` or pool health check on `DATABASE_URL`).

If PG is unavailable:

```text
do NOT call /messages/pull
sleep with backoff (POLL_INTERVAL_MS or longer)
do not consume Queue message attempts
```

This is load-bearing under Plan B: source rows may already be `status='queued'`
with no requeue path; burning `max_retries` via pull-fail loops causes permanent
archive loss before retention expiry.

### 8.6 Daemon algorithm

Loop:

```text
if PG health check fails:
  sleep/backoff
  continue loop (no pull)

pull messages from Cloudflare Queue
if no messages:
  sleep POLL_INTERVAL_MS
else:
  BEGIN PG
    for each message:
      parse ArchiveRecord
      INSERT INTO chat_archive_records ON CONFLICT DO NOTHING
  COMMIT

  if PG batch failed (connection error, commit failed):
    do NOT ack any message in the batch
    do NOT pull additional messages in this iteration
    for leased messages: either
      (A) omit ack/retry and let visibility_timeout expire, then stop pulling until PG healthy, or
      (B) call /messages/ack with retries:[{ lease_id, delay_seconds: long }] once, then stop pulling
    do NOT run a tight pull-fail-retry loop
    goto PG health gate (sleep until PG healthy)

  for each affected (source_kind, source_key):
    drain ready records in source_seq order into normalized tables

  ack messages whose raw record insert succeeded or already existed
  for validation failures on individual messages (poison / schema mismatch):
    retry with delay only if PG is healthy and error may be transient deployment mismatch
    do not tight-loop retries across the whole batch
```

Important:

* Queue delivery order is not the replay order source of truth.
* PG raw log stores out-of-order records.
* PG replay applies only contiguous per-source records.
* A Queue message with `source_seq=5` may be acked before `source_seq=4` arrives, as long as record 5 is durably stored in `chat_archive_records`.
* Replay of record 5 waits until source watermark reaches 4.
* This avoids holding Queue messages hostage for missing earlier source_seq records.

### 8.7 Ordered drain algorithm

For each affected source:

```text
BEGIN PG transaction
  SELECT last_applied_seq
    FROM chat_archive_source_watermarks
    WHERE source_kind=? AND source_key=?
    FOR UPDATE

  if no watermark:
    INSERT watermark last_applied_seq=0
    lock it

  loop:
    SELECT record
      FROM chat_archive_records
      WHERE source_kind=? AND source_key=?
        AND source_seq = last_applied_seq + 1
        AND applied_at IS NULL

    if no record:
      break

    replay record.changes into normalized tables
    UPDATE chat_archive_records SET applied_at=now(), apply_error=NULL WHERE archive_id=?
    UPDATE chat_archive_source_watermarks SET last_applied_seq=record.source_seq, updated_at=now()
    last_applied_seq = record.source_seq

COMMIT
```

If replay fails:

```text
ROLLBACK
UPDATE chat_archive_records SET apply_error = error WHERE archive_id = failing_archive_id
do not ack only if raw record insertion failed
if raw record was already inserted, the Queue message may still be acked; replay repair is driven by PG raw log
```

Policy:

* Queue ack means "raw log persisted", not "normalized replay completed".
* Normalized replay is driven by PG.
* If replay fails due to code/schema bug, the raw record remains in PG with `apply_error`.
* After fixing code/schema, rerun daemon or a replay command to drain unapplied records.

### 8.8 Replay command

Add a manual command:

```bash
npm run archive:replay
```

It drains unapplied `chat_archive_records` from PG without pulling Queue messages.

This is required for recovery after replay bugs.

### 8.9 Replay implementation

Implement a whitelist of table-specific replayers.

Do not dynamically generate SQL from arbitrary payload table names.

Example:

```ts
const TABLE_REPLAYERS = {
  chat_channels: replayChatChannels,
  chat_channel_members: replayChatChannelMembers,
  chat_messages: replayChatMessages,
  ...
} as const;
```

Supported operations:

```text
upsert
delete
replace_scope
```

#### upsert

Use table-specific `INSERT ... ON CONFLICT ... DO UPDATE`.

All upserts must include archive metadata.

All updates must be guarded by `archived_source_seq`.

#### delete

Use only for hard-deleted projection-like join rows.

Protect against old records deleting newer rows:

```sql
DELETE FROM target
WHERE pk = ...
  AND archived_source_seq <= $incoming_source_seq
```

#### replace_scope

Algorithm:

```text
DELETE FROM target_table
WHERE scope columns match
  AND archived_source_seq <= incoming_source_seq

INSERT incoming rows with archive metadata
```

Do not use replace_scope for tables where source uses soft delete.

## 9. Queue message validation

The local daemon must validate every pulled message.

Required validation:

```text
body is ArchiveRecord object or JSON string
format == "lilium.chat.archive.record.v1"
archive_id equals encodeArchiveId(source_kind, source_key, source_seq)
  where encodeArchiveId builds `${source_kind}:${base64url(source_key)}:${source_seq}`
  — never validate by splitting archive_id on ":"
source_kind is one of allowed source kinds
source_key is non-empty
source_seq is positive integer
occurred_at is valid timestamp
changes is non-empty array
each table is whitelisted
each op is allowed
required pk/scope fields are present
```

Invalid messages:

* Insert no raw record.
* Only retry (via `/messages/ack` `retries`) when PG is healthy and the error may
  be a transient deployment mismatch.
* If PG is unhealthy, do not pull — do not burn retries on validation paths (§8.5).
* If clearly unrecoverable poison, log and surface via metrics; do not ack-drop by
  default unless operator policy explicitly allows.

## 10. Failure semantics

### 10.1 Source DO to Queue failure

If queue send fails:

```text
archive_outbox remains pending
attempts increments
next_attempt_at uses exponential backoff
business write remains successful
```

### 10.2 Local daemon down

If daemon is down:

```text
Queue backlog grows
chat business path unaffected
source DO eventually marks archive_outbox queued once Queue accepted
```

If downtime exceeds configured Cloudflare Queue message retention (max 14 days),
Queue messages are **deleted** while source rows may remain `status='queued'`.
There is no source-DO requeue recovery (§4.7 Plan B). Prevention: configure Queue
retention to the max acceptable outage window and restore the daemon before
retention expiry. Rows already in PG `chat_archive_records` are unaffected.

### 10.3 PG unavailable

If PG is unavailable:

```text
daemon PG health check fails
daemon does NOT call /messages/pull (no new leases, no attempt consumption)
daemon sleeps/backoff until PG healthy
already-leased messages from a prior partial batch:
  do not ack
  let visibility_timeout expire OR single long-delay retry via /messages/ack, then stop pulling
  do NOT continue polling more messages
  do NOT run tight pull-fail-retry loops
```

**Failure mode to prevent:** daemon running + PG down + repeated pull → insert
fail → retry/timeout → `attempts` reaches `max_retries` → message deleted while
source `archive_outbox` is already `queued` with no requeue (Plan B). Retention
does not protect against this; only the PG health gate does.

Once PG recovers, normal pull/drain resumes. Messages not yet at `max_retries`
become visible again after `visibility_timeout`.

### 10.4 Replay bug

If raw insert succeeds but normalized replay fails:

```text
Queue message may be acked because raw record is durable
chat_archive_records.apply_error stores the error
archive:replay can repair later
normalized tables may lag raw log
```

### 10.5 Duplicate delivery

Duplicates are expected.

Idempotency layers:

```text
source archive_outbox UNIQUE(source_kind, source_key, source_seq)
Queue at-least-once delivery tolerated
PG chat_archive_records PRIMARY KEY(archive_id)
PG chat_archive_records UNIQUE(source_kind, source_key, source_seq)
PG normalized tables use source_seq guards
```

### 10.6 Out-of-order delivery

Out-of-order Queue delivery is expected.

Policy:

```text
raw log may store out-of-order source_seq
normalized replay is strictly ordered by (source_kind, source_key, source_seq)
watermark controls applied order
```

## 11. Security

### 11.1 Cloudflare API token

Local daemon uses a Cloudflare API token with Queue read/write permissions.

Store in:

```text
CF_QUEUES_TOKEN
```

Never log the token.

### 11.2 Secrets never logged

Never log:

```text
CF_QUEUES_TOKEN
DATABASE_URL
bot token plaintext
S3 secrets
JWT secret
```

Bot token hashes may be archived.

### 11.3 Payload safety

Archive payloads are internal, but daemon must still treat them as untrusted for SQL generation.

Only whitelist replay handlers may execute.

Unknown table/op must fail validation.

## 12. Tests

### 12.1 Unit tests

Add tests for:

```text
archive source_seq monotonic
archive_id deterministic
archive_outbox append in same transaction
archive_outbox oversized payload throws before commit (business txn rolls back)
archive_outbox queue flush success -> status queued
archive_outbox queue send failure -> status pending with backoff
sendBatch uses MessageSendRequest { body, contentType: "json" }[]
sendBatch respects 100 message limit
sendBatch respects 240 KiB target
ArchiveRecord validation
PG raw insert idempotency
PG source watermark initialization
PG ordered drain applies contiguous records only
PG out-of-order raw insert waits for missing seq
PG upsert source_seq guard
PG replace_scope source_seq guard
duplicate Queue delivery does not duplicate normalized rows
daemon skips /messages/pull when PG health check fails
queue pull smoke test: API accepts visibility_timeout body field
unknown table/op rejected
runtime table names rejected
```

### 12.2 Integration tests

From empty DO + empty PG test database, run full business flow and drain archive to PG.

Required coverage:

```text
create channel
update channel
create DM
open existing DM
send text message
send image message
save personal sticker
send sticker message
edit message
recall message
delete message
create invite
accept invite
public join
member role update
owner transfer
member remove/leave
bot command sync
bot install
bot install update
command binding update
command invoke                    — when /internal/command-invoke route exists
interaction submit                — when /internal/interaction-submit route exists
bot effect that updates/creates message
```

Routes not yet implemented (command invoke, interaction submit) are excluded
from the required integration matrix until the product routes land; archive
drift tests use an explicit allowlist (see backend plan §6.1).

After daemon drain/replay, assert normalized PG tables contain expected rows for
each covered flow.

### 12.3 Resilience tests

```text
Queue send failure does not fail business mutation
Queue duplicate delivery does not duplicate PG rows
Queue delivers seq=2 before seq=1; raw stores both, replay waits, then applies 1 and 2
PG unavailable: daemon does not call /messages/pull; no tight retry-burn loop
PG unavailable mid-batch: no ack; stop pulling until PG healthy
Replay failure after raw insert can be repaired by archive:replay
Local daemon stopped; business writes continue and Queue backlog grows
Runtime tables never appear in archive payload
```

### 12.4 Drift/static tests

Add static coverage checks:

```text
No archive payload table name starts with or equals:
  live_sessions
  live_channel_leases
  online_sessions
  fanout_events
  fanout_queue
  fanout_leases
  bot_connection_state
  bot_deliveries
  projection_outbox
  bot_delivery_outbox
  idempotency_keys
  rate_buckets
  event_seq

All current ChatChannel business tables are either archived or explicitly excluded with reason.
All current UserDirectory business tables are either archived or explicitly excluded with reason.
All current DMDirectory tables are archived or excluded with reason.
All current BotRegistry business tables are archived or excluded with reason.
```

## 13. Operational commands

Add root package scripts if appropriate:

```json
{
  "archive:local": "tsx scripts/archive-local/src/index.ts",
  "archive:replay": "tsx scripts/archive-local/src/replay.ts",
  "archive:migrate": "psql \"$DATABASE_URL\" -f scripts/archive-local/migrations/001_init.sql"
}
```

Operator setup:

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

wrangler deploy
DATABASE_URL=... npm run archive:migrate
CF_ACCOUNT_ID=... CF_QUEUE_ID=... CF_QUEUES_TOKEN=... DATABASE_URL=... npm run archive:local
```

## 14. Documentation

Add:

```text
docs/superpowers/specs/2026-06-28-lilium-chat-local-pg-archive-cf-queue.md
```

Document:

```text
architecture diagram
source DO -> archive_outbox -> CF Queue -> local daemon -> PG flow
why source-local outbox is required
why ArchiveRelay DO is not used
queue setup
local daemon setup
PG migration
how ordered replay works
how to inspect lag
how to recover replay errors
Queue retention + consumer retry/visibility (§2.6, Plan B); PG health gate (§8.5)
what is intentionally not archived
```

## 15. Acceptance criteria

Implementation is accepted only if all of the following are true:

1. No ArchiveRelay DO exists.
2. Cloudflare Queue producer binding exists.
3. HTTP pull consumer setup documented with retention/retry/visibility flags (§2.4, §13).
4. Source DOs write `archive_outbox` in the same transaction as business rows.
5. Source DO alarms flush archive_outbox to Cloudflare Queue.
6. Business writes do not synchronously depend on PG.
7. Local daemon can pull Queue messages over HTTP (`visibility_timeout` body verified).
8. Local daemon does **not** call `/messages/pull` when PG health check fails (§8.5).
9. Local daemon commits raw `chat_archive_records` before Queue ack.
10. Local daemon can replay normalized PG state in strict per-source `source_seq` order.
11. Queue duplicate delivery is safe.
12. Queue out-of-order delivery is safe.
13. PG replay failure is repairable from raw log.
14. Runtime state is never archived.
15. All listed business mutation paths that **exist in code** are instrumented;
    `command-invoke` / `interaction-submit` are allowlisted TODOs until routes land.
16. Full integration flow drains into PG and normalized tables match expected
    business state for implemented mutation paths.
17. Full test suite and typecheck pass.

## 16. Implementation checklist

Complete all items in one branch:

```text
[ ] Add Cloudflare Queue producer binding `CHAT_ARCHIVE_QUEUE`.
[ ] Add Queue Env type.
[ ] Document wrangler queue create/update + consumer http add with retention/retry flags (§2.4, §13).
[ ] Add archive payload/hash/source-outbox/queue-flush helpers.
[ ] Add archive_seq/archive_outbox migrations to ChatChannel.
[ ] Add archive_seq/archive_outbox migrations to UserDirectory.
[ ] Add archive_seq/archive_outbox migrations to DMDirectory.
[ ] Add archive_seq/archive_outbox migrations to BotRegistry.
[ ] Add archive flush to ChatChannel alarm without breaking projection_outbox.
[ ] Add archive flush to UserDirectory alarm without breaking pending attachment cleanup.
[ ] Add archive flush to DMDirectory alarm.
[ ] Add archive flush to BotRegistry alarm.
[ ] Instrument every ChatChannel mutation listed in this spec.
[ ] Instrument UserDirectory attachment/sticker mutations.
[ ] Instrument DMDirectory mutations.
[ ] Instrument BotRegistry command/token/app mutations.
[ ] Add local archiver daemon (PG health gate before pull per §8.5).
[ ] Add queue pull API smoke test: verify pull body accepts `visibility_timeout` (not `_ms`) against live/dev Queue.
[ ] Add local PG migration.
[ ] Add raw record insert.
[ ] Add source watermark ordered drain.
[ ] Add table-specific replay handlers.
[ ] Add manual archive:replay command.
[ ] Add unit tests.
[ ] Add integration tests.
[ ] Add resilience tests.
[ ] Add drift/static tests.
[ ] Add docs/runbook.
[ ] Run typecheck.
[ ] Run full test suite.
```

Do not mark complete until the full flow works from empty DO + empty PG through Cloudflare Queue HTTP pull into local PG normalized tables.
