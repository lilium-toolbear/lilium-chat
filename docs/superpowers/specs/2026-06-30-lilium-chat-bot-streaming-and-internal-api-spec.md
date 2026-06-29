# Lilium Chat Bot Streaming + Internal API Spec Patch

状态：内部实现前 spec patch  
日期：2026-06-30  
对应 contract：`docs/api-contract.md` **§9.13–§9.16**（Bot streaming wire shape）与 **§12.4**（实现不变量）
基线：`docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md` v4.4 + Bot Phase 7/Stateful addenda

本 spec patch 把原讨论稿 `2026-06-28-lilium-chat-bot-third-party-api-gaps.md` 中可执行的架构决策收口为内部实现规范。第三方公开文档暂不更新；实现完成后再从生产可用能力整理外部说明。

**Normative contract:** 主 contract `docs/api-contract.md` §9.13–§9.16（wire shape）与 §12.4（不变量）。本文是后端实现视角的 spec patch。

## 1. Authority And Supersession

本文件覆盖以下旧设计点：

- Base contract §9.7.3 中 `append_stream` / `finalize_stream` 作为主 Bot Gateway effects 的设计作废（见主 contract §9.13–§9.16）。
- Phase 7 plan 中“主 WS 上 append_stream UPDATE messages.text”的路径作废。
- 流式进行中不写 `messages` / canonical `events`；只有 finalize 写 canonical message + event。
- `message.stream_started` / `message.stream_delta` / `message.stream_abandoned` 是 live-only stream frames。
- `message.stream_finalized` 是 canonical channel event；streamed bot message 不再额外发 `message.created`。

实现计划以本 spec patch 和内部 contract addendum 为准。原 gap 文档只保留 tracking / discussion 用途。

## 2. DO Ownership

| DO | Owns | Does not own |
|---|---|---|
| `BotConnection(bot_id)` | Bot main Gateway WS, delivery queue, `delivery_result` framing, online state | Stream text buffer, stream append/finalize, ChatChannel canonical writes |
| `ChatChannel(channel_id)` | Stream registry, effect idempotency, final canonical message/event write, channel permissions | Hot append buffer, per-delta stream fanout batching |
| `BotStreamConnection(channel_id#message_id)` | One active stream WS, authoritative in-progress text buffer, append seq/ack, live stream delta batching | Bot runtime delivery queue, channel membership source-of-truth |
| `ChannelFanout(channel_id)` | Best-effort delivery to Browser live sessions | Stream durability or history recovery |
| `BotRegistry` | Bot identity, token hash, command catalog | Stream sessions or per-channel stream state |

新增 DO 类：`BotStreamConnection`。

Wrangler bindings:

```jsonc
{
  "name": "BOT_STREAM_CONNECTION",
  "class_name": "BotStreamConnection"
}
```

Migration arrays in both `wrangler.jsonc` and `wrangler.test.jsonc` must include `BotStreamConnection`; run `npm run cf-typegen` after binding changes.

## 3. ChatChannel Schema Additions

`ChatChannel` gets a stream registry table. It is not the stream text buffer.

```sql
CREATE TABLE message_stream_registry (
  channel_id        TEXT NOT NULL,
  message_id        TEXT NOT NULL,
  bot_id            TEXT NOT NULL,
  client_effect_id  TEXT NOT NULL,
  status            TEXT NOT NULL, -- streaming | finalized | abandoned | expired
  sender_bot_display_name TEXT NOT NULL,
  sender_bot_avatar_url   TEXT,
  message_json      TEXT NOT NULL, -- sanitized start_stream message metadata: type/format/reply/components/attachment refs
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  finalized_at      TEXT,
  abandoned_at      TEXT,
  final_event_id    TEXT,
  final_text_hash   TEXT,
  finalized_response_json TEXT,
  PRIMARY KEY (channel_id, message_id)
);
CREATE INDEX idx_message_stream_registry_bot
  ON message_stream_registry(bot_id, status, expires_at);
CREATE INDEX idx_message_stream_registry_expiry
  ON message_stream_registry(status, expires_at);
```

`bot_effects_applied` remains the effect idempotency table. For `start_stream`, `response_json` must include at least:

```json
{
  "message_id": "...",
  "stream": {
    "channel_id": "...",
    "message_id": "...",
    "ws_url": "/api/chat/bot/channels/.../streams/.../ws",
    "expires_at": "..."
  }
}
```

A repeated identical `start_stream` effect returns the same registry entry and `ws_url`.

On successful finalize, ChatChannel persists `final_event_id`, `final_text_hash`, and `finalized_response_json` on the registry row before marking `status=finalized`. Repeated finalize with the same final text hash returns the stored response; different hash returns `BOT_STREAM_CONFLICT`.

## 4. BotStreamConnection Schema

`BotStreamConnection` owns in-progress stream text. It uses SQLite for durable flushed text and metadata; it must not write `ChatChannel` on every append.

```sql
CREATE TABLE stream_state (
  channel_id       TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  bot_id           TEXT NOT NULL,
  status           TEXT NOT NULL, -- streaming | finalizing | finalized | abandoned | expired
  ack_seq          INTEGER NOT NULL DEFAULT 0,
  flushed_text     TEXT NOT NULL DEFAULT '',
  pending_bytes    INTEGER NOT NULL DEFAULT 0,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_id)
);
```

**No `stream_append_hashes` table.** Unacked duplicate detection lives only in the active WS attachment in-memory map. After disconnect or DO rehydrate, `received_seq` resets to `ack_seq` and the map is cleared; the bot must resend from `ack_seq + 1`.

WebSocket attachment shape:

```ts
interface BotStreamConnectionAttachment {
  channel_id: string;
  message_id: string;
  bot_id: string;
  pending_text: string;
  pending_start_seq: number | null;
  pending_end_seq: number;
  received_seq: number;
  recent_unacked_hashes: Map<number, string>; // seq -> delta_hash, in-memory only
  fanout_pending_text: string;
  fanout_due_at_ms: number;
  expires_at: string;
}
```

## 5. Constants

```ts
export const WS_ATTACHMENT_MAX_BYTES = 16_384;
export const STREAM_PENDING_FLUSH_THRESHOLD_BYTES = 8_192;
export const STREAM_FANOUT_INTERVAL_MS = 100;
export const STREAM_FANOUT_MAX_PENDING_BYTES = 4_096;
export const STREAM_ACK_FLUSH_INTERVAL_MS = 250;
export const STREAM_DEFAULT_TTL_SECONDS = 300;
```

`STREAM_ACK_FLUSH_INTERVAL_MS` is the maximum time the server should hold accepted but unacknowledged append data before flushing it to durable state and advancing `ack_seq`.

## 6. Start Stream Flow

```text
Bot delivery_result/session.effects start_stream
  -> BotConnection validates frame shape only
  -> ChatChannel /internal/bot-delivery-result applies effect
  -> ChatChannel checks bot scope + channel status + effect idempotency
  -> ChatChannel inserts message_stream_registry(status=streaming)
  -> ChatChannel emits live-only message.stream_started stream frame
  -> ChatChannel stores bot_effects_applied response_json with stream ws_url
  -> BotConnection returns delivery_ack(effect_results[].stream)
```

Important details:

- `message_id` is generated during `start_stream` and reused at finalize.
- `created_at` for the final message is the stream start time.
- `message_json` stores the sanitized initial message metadata needed to build the final message.
- `start_stream.message.text` must be empty or ignored; final text comes from `BotStreamConnection` buffer.
- Start emits live-only provisional UI state, not canonical history.

## 7. Stream WS Upgrade

Worker route:

```text
GET /api/chat/bot/channels/:channel_id/streams/:message_id/ws
```

Flow:

```text
Worker
  -> verifyBotToken
  -> require chat:runtime:connect + chat:messages:write
  -> ChatChannel /internal/stream-registry-check {channel_id,message_id,bot_id}
  -> BOT_STREAM_CONNECTION.getByName(`${channel_id}#${message_id}`)
  -> BotStreamConnection acceptWebSocket
```

`/internal/stream-registry-check` must reject:

- missing registry row;
- row owned by another bot;
- row status not `streaming`;
- expired registry.

The route returns `BOT_STREAM_NOT_FOUND` or `BOT_STREAM_EXPIRED` without upgrading on failure.

## 8. Append And Ack Semantics

Append hot path:

```text
append(seq, delta)
  -> validate status=streaming and not expired
  -> validate seq relative to received_seq / ack_seq (gap uses received_seq + 1)
  -> if unacked duplicate (seq <= received_seq && seq > ack_seq): check attachment recent_unacked_hashes
  -> pending_text += delta; received_seq = seq
  -> record hash in attachment recent_unacked_hashes (in-memory only)
  -> fanout_pending_text += delta
  -> maybe fanout live stream_delta via ChannelFanout /internal/deliver-stream-frame
  -> maybe flush pending_text to SQLite
  -> only after durable flush, advance ack_seq, prune attachment hashes for seq <= ack_seq, send append_ack
```

Durability rule:

`append_ack.ack_seq` must never advance beyond text that is durably included in `stream_state.flushed_text`.

This means the implementation may accept and live-fanout data before acking it, but the bot must keep unacked deltas in its retry buffer. On the same active connection, bot may send `seq=1,2,3` while `ack_seq=0`; gap detection uses `received_seq`, not `ack_seq`. If the stream disconnects before an ack, the bot resends from `ready.ack_seq + 1` after reconnect.

Sequence rules:

- `seq <= ack_seq`: durable no-op; server may immediately send `append_ack { ack_seq }`.
- `seq == received_seq + 1`: accept into pending buffer; update `received_seq`.
- `seq <= received_seq` but `seq > ack_seq`: unacked duplicate on active connection; same hash in `recent_unacked_hashes` is no-op; different hash returns `BOT_STREAM_CONFLICT`.
- `seq > received_seq + 1`: return `BOT_STREAM_SEQUENCE_GAP`.

On WS disconnect or DO rehydrate:

- reset attachment `received_seq` to SQLite `ack_seq`;
- clear `recent_unacked_hashes` and in-memory `pending_text`;
- `ready` exposes only `ack_seq`; bot resumes from `ack_seq + 1`.

Flush triggers:

- `pending_text.length >= STREAM_PENDING_FLUSH_THRESHOLD_BYTES`;
- `Date.now() >= last_flush_at + STREAM_ACK_FLUSH_INTERVAL_MS`;
- attachment size estimate near `WS_ATTACHMENT_MAX_BYTES`;
- finalize;
- alarm/expiry cleanup before abandon.

Flush operation:

```text
UPDATE stream_state
SET flushed_text = flushed_text || pending_text,
    ack_seq = pending_end_seq,
    pending_bytes = 0,
    updated_at = now
```

After flush, clear `pending_text` from attachment, prune `recent_unacked_hashes` for `seq <= ack_seq`, and send `append_ack { ack_seq }`.

## 9. Live Stream Fanout

`BotStreamConnection` sends live-only stream frames through a dedicated internal path. These frames are not `ChatChannel.events` rows.

Internal endpoint:

```text
POST ChannelFanout /internal/deliver-stream-frame
```

Request body:

```json
{
  "channel_id": "...",
  "frame": {
    "frame_type": "stream_event",
    "api_version": "lilium.chat.stream.v1",
    "type": "message.stream_delta",
    "channel_id": "...",
    "message_id": "...",
    "stream_seq": 42,
    "delta": "hello"
  }
}
```

Rules:

- no `event_id` required;
- do not write `ChatChannel.events`;
- do not advance Browser HTTP/WS per-channel event cursors;
- `ChannelFanout` forwards best-effort to online `UserConnection`s with active leases;
- `UserConnection` re-checks membership + lease, then sends `frame_type="stream_event"` unchanged to the browser;
- **do not** reuse canonical `ChannelFanout /deliver`.

`message.stream_started` is emitted once by `ChatChannel` on `start_stream`. `message.stream_delta` and `message.stream_abandoned` are emitted by `BotStreamConnection` via the path above.

Live frame types:

- `message.stream_started`
- `message.stream_delta`
- `message.stream_abandoned`

Fanout batching:

- accumulate `fanout_pending_text`;
- fanout when `STREAM_FANOUT_INTERVAL_MS` elapsed or `fanout_pending_text.length >= STREAM_FANOUT_MAX_PENDING_BYTES`;
- include `stream_seq` equal to the highest accepted seq represented by the delta;
- before finalize or abandon, drain the final live delta.

Browser clients must treat stream frames as provisional. They do not update channel event cursors.

## 10. Finalize Flow

```text
BotStreamConnection finalize(final_seq, components?, attachment_ids?)
  -> validate final_seq <= received_seq or accept any prior pending frames in order
  -> flush pending_text, advancing ack_seq
  -> drain live fanout
  -> resolved_text = stream_state.flushed_text
  -> call ChatChannel /internal/stream-finalize
  -> ChatChannel transaction inserts final messages row + message.stream_finalized event
  -> ChatChannel deletes/marks registry finalized
  -> BotStreamConnection marks finalized + clears buffer
  -> send finalized_ack { message_id, event_id }
  -> close stream WS
```

`ChatChannel /internal/stream-finalize` behavior:

- `status=streaming`: execute canonical transaction; persist `final_event_id`, `final_text_hash`, `finalized_response_json`, `finalized_at`; mark registry `finalized`.
- `status=finalized` and same `bot_id` + same `final_text_hash`: return stored `finalized_response_json` (same `{ message_id, event_id }`).
- `status=finalized` and different `final_text_hash`: return `BOT_STREAM_CONFLICT`.
- `status=expired` / `abandoned`: return `BOT_STREAM_EXPIRED` or `BOT_STREAM_NOT_FOUND`.

Initial call validates:

- registry exists;
- `bot_id` owns the stream;
- channel is still writable;
- referenced attachments are finalized and owned by same bot/channel if attachment support is enabled;
- components pass `validateComponents`.

Canonical write:

- `messages.message_id = registry.message_id`;
- `sender_kind="bot"`, `sender_bot_id=registry.bot_id`;
- bot display/avatar snapshots come from registry;
- `text = resolved_text`;
- `stream_state="final"`;
- `created_at = registry.created_at`;
- `updated_at = finalized_at`;
- event type is `message.stream_finalized`;
- event payload is `{ channel_id, event_id, message }` using `projectMessageForBrowser`.

No `message.created` event is emitted for the final streamed message.

## 11. Abandon And Expiry

Expiry is driven by both `ChatChannel` and `BotStreamConnection` alarms:

- `ChatChannel` owns registry expiry and can mark stale streams `expired`/`abandoned`.
- `BotStreamConnection` owns buffer cleanup and live abandon fanout.

Policy:

- Stream WS close does not immediately abandon.
- Bot main WS close does not immediately abandon.
- Before `expires_at`, bot can reconnect and resume at `ready.ack_seq + 1`.
- After `expires_at`, no finalize is accepted.
- Expired streams are abandoned, not promoted.
- Abandon sends live-only `message.stream_abandoned` so online clients remove provisional UI.
- Offline clients simply never see the stream in history.

No partial text is written to `messages` unless the bot explicitly finalizes.

## 12. Idempotency And Conflicts

Main Gateway effects keep existing effect idempotency:

```text
(channel_id, bot_id, client_effect_id)
```

Rules:

- Same body returns cached `response_json`.
- Different body returns `BOT_EFFECT_CONFLICT`.
- `start_stream` response JSON includes `message_id`, `ws_url`, and `expires_at`.

Stream WS append idempotency is seq-based inside `BotStreamConnection` on the active connection:

```text
(channel_id, message_id, seq, delta_hash) // hash map in WS attachment only until ack_seq catches up
```

Rules:

- `seq <= ack_seq`: durable no-op.
- unacked duplicate seq with same hash on active connection: no-op.
- unacked duplicate seq with different hash on active connection: `BOT_STREAM_CONFLICT`.
- seq gap (`seq > received_seq + 1`): `BOT_STREAM_SEQUENCE_GAP`.
- after disconnect/rehydrate: only `ack_seq` is trusted; bot resends from `ack_seq + 1`.

Finalize is idempotent after canonical commit:

- repeated `finalize` after `finalized` returns stored `finalized_response_json` with same `{ message_id, event_id }` when `final_text_hash` matches;
- repeated `finalize` with different final text hash returns `BOT_STREAM_CONFLICT`;
- finalize after `abandoned`/`expired` returns `BOT_STREAM_EXPIRED` or `BOT_STREAM_NOT_FOUND`.

## 13. Read Scopes And Attachments

This spec does not add Bot read APIs. `chat:messages:read`, `chat:channels:read`, and `chat:members:read` remain scopes without endpoints until an explicit read grant model is designed.

Bot attachment upload is optional for the implementation phase. If implemented now:

- use channel-scoped upload routes from the internal contract addendum;
- require `chat:attachments:write`;
- model ownership as `owner_kind + owner_id` internally;
- scope finalized bot attachments to the same `{ bot_id, channel_id }` in v1;
- do not add cross-channel asset reuse without a separate `BotAssetDirectory` design.

## 14. Platform `/permission`

Platform `/permission` is implemented in `ChatChannel` alongside `/help`:

- append platform command to non-DM manifests when caller can manage commands;
- parse args `{ command?: string, action?: "on" | "off" }`;
- list mode returns a platform bot text message;
- mutation mode writes the same `channel_command_bindings` / `channel_command_names` rows as Browser command settings;
- emit `command.binding_updated` with `command_manifest_delta`;
- optionally emit `system.notice` for timeline visibility.

It must not create Bot Gateway deliveries and must not appear in third-party Bot runtime docs.

## 15. Implementation plan reference

具体 task 拆分、文件列表、测试要求见 **`docs/superpowers/plans/2026-06-30-lilium-chat-bot-streaming-internal-api-implementation.md`**。Plan 以本文 + 主 contract §9.13–§9.16 / §12.4 为 authority，**不**以 gap tracker 为 authority。

## 16. Required Tests

Focused tests must cover:

- `start_stream` returns `delivery_ack.effect_results[].stream` and creates registry only once under effect retry.
- Main Bot Gateway rejects `append_stream` / `finalize_stream` with `BOT_EFFECT_INVALID`.
- Stream WS upgrade rejects wrong bot, missing scopes, missing registry, expired registry.
- append seq happy path: `1..N` accepted, flushed, acked, live deltas batched.
- reconnect resume: bot receives `ready.ack_seq`, resends from `ack_seq + 1`, final text has no duplicates.
- seq gap returns `BOT_STREAM_SEQUENCE_GAP`.
- duplicate unacked seq different body returns `BOT_STREAM_CONFLICT`.
- finalize writes exactly one canonical `message.stream_finalized` event and no `message.created` event.
- history/events after finalize return final message projection; history during stream returns nothing.
- disconnect before expiry allows reconnect; expiry abandons without partial message.
- `message.stream_abandoned` is live-only and not returned by HTTP events.
- `projectMessageForBrowser` is shared for final stream message, history, event replay, and live event.
- `/permission` owner/admin succeeds, member fails, official command `on` returns `OFFICIAL_COMMAND_AUTO_ALLOWED`, DM unsupported.

Run at minimum:

```text
npm run typecheck
npx vitest run <focused stream tests> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
```
