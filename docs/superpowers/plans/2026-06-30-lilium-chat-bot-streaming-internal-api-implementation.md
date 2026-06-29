# Lilium Chat Bot Streaming + Internal API Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Checkboxes track progress.

**Goal:** Implement Bot effect application pipeline, dual-WebSocket streaming (`start_stream` on main Gateway + append/finalize on Stream WS), live stream frames, and canonical `message.stream_finalized` — per contract §9.13–§9.16 / §12.4 and backend spec.

**Authority (normative, in order):**

1. `docs/api-contract.md` §9.13–§9.16（Bot streaming wire shape）与 §12.4（实现不变量）
2. `docs/superpowers/specs/2026-06-30-lilium-chat-bot-streaming-and-internal-api-spec.md`
3. `docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md` v4.4 + existing Phase 7 slash addenda

**Not authority:** `docs/superpowers/specs/2026-06-28-lilium-chat-bot-third-party-api-gaps.md` (discussion tracker only)

**Explicitly out of scope (future / open — do not implement in this plan):**

- Machine Token owner-management API (`/api/chat/bots*` with `lilium_machine_token`)
- Bot Token read endpoints (`chat:messages:read`, `chat:channels:read`, `chat:members:read`)
- Bot attachment upload (`POST .../bot/channels/.../uploads/...`)
- Third-party public API docs (`lilium-openapi`, `docs/bot-developer-guide.md` major rewrite)
- HTTP callback bot transport

**Tech stack:** Cloudflare Workers + SQLite DOs, Hono, vitest-pool-workers, existing scheduler/outbox/idempotency patterns.

**Global constraints:**

- Never call `ctx.storage.setAlarm` directly; use `scheduleNextAlarm` / `runDueJobs`.
- After `wrangler.jsonc` binding changes: `npm run cf-typegen && npm run typecheck`.
- Tests under load: `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`.
- Do NOT push or deploy unless explicitly asked.

---

## Task 1: Contract types, error codes, protocol frames

**目标：** 让 TypeScript 类型、错误码、Bot Gateway / Stream WS 帧解析与 §9.13–§9.16 wire shape 对齐。

**可能修改的文件：**

- `src/contract/bot-gateway.ts` — `delivery_ack.effect_results`, reject `append_stream`/`finalize_stream` on main gateway parser
- `src/contract/bot-stream.ts`（新建）— Stream WS frame types
- `src/contract/events.ts` — `message.stream_abandoned`, live `stream_event` frame types
- `src/errors.ts` — `BOT_STREAM_*`, `BOT_SCOPE_DENIED`, `COMMAND_PERMISSION_DENIED`
- `src/chat/bot-gateway-protocol.ts` — effect result builders/parsers
- `test/errors.test.ts`, `test/chat/bot-gateway-protocol.test.ts`

**实现要点：**

- Add `EffectResult` discriminated union with `start_stream` carrying `{ message_id, stream: { channel_id, message_id, ws_url, expires_at } }`.
- Add `BotStreamFrame` types: `hello`, `ready`, `append`, `append_ack`, `finalize`, `finalized_ack`, `stream_error`.
- Add `StreamEventFrame` for Browser live delivery (`frame_type: "stream_event"`).
- Register new error codes in `HTTP_STATUS_BY_CODE` and `RETRYABLE_CODES` per §9.13–§9.16 / §11.

**不变量：**

- Main gateway effect parser rejects `append_stream` / `finalize_stream` at validation layer (before DO).
- `api_version` strings: `lilium.chat.bot.v1` (gateway), `lilium.chat.bot.stream.v1` (stream), `lilium.chat.stream.v1` (browser stream frames).

**测试要求：**

- Unit tests for frame parse/serialize round-trip.
- Error code mapping tests for new codes.

**回滚 / 兼容风险：**

- Low — types-only until Task 3+ wire up behavior. Old stub paths unchanged until effect pipeline lands.

---

## Task 2: `BotStreamConnection` DO + Wrangler bindings

**目标：** 新增 `BotStreamConnection` DO 类、SQLite schema、hibernation WS skeleton。

**可能修改的文件：**

- `src/do/bot-stream-connection.ts`（新建）
- `src/do/migrations/bot-stream-connection.ts`（新建）— `stream_state` only（无 `stream_append_hashes`）
- `src/index.ts` — export DO class
- `wrangler.jsonc`, `wrangler.test.jsonc` — `BOT_STREAM_CONNECTION` binding + `migrations[].new_sqlite_classes`
- `npm run cf-typegen` → gitignored `worker-configuration.d.ts`

**实现要点：**

- DO name: `` `${channel_id}#${message_id}` `` via `idFromName` / `getByName`.
- Baseline schema per backend spec §4; `BOT_STREAM_CONNECTION_CURRENT_SCHEMA_VERSION = 1`.
- Constructor runs `migrateSqlite`; `/schema-version` probe.
- `fetch` routes: WS upgrade (stub), internal debug routes behind test flags only.
- WS attachment shape per spec §4 (`pending_text`, `received_seq`, `recent_unacked_hashes`, `fanout_pending_text`, etc.).

**不变量：**

- `BotStreamConnection` must not write `ChatChannel` tables on append hot path.
- Test worker declares same DO class as prod (`SchedulerProbe exception only in test config).

**测试要求：**

- Migration test: fresh DO creates tables.
- Schema version endpoint returns expected version.

**回滚 / 兼容风险：**

- Wrangler migration adds new SQLite class — deploy requires migration tag; no data loss (greenfield table). Rollback = don't route traffic to stream WS until ready.

---

## Task 3: `ChatChannel` stream registry + internal routes

**目标：** `message_stream_registry` 表、`/internal/stream-registry-check`、`/internal/stream-finalize` 骨架。

**可能修改的文件：**

- `src/do/migrations/chat-channel.ts` — `message_stream_registry` table + indexes
- `src/do/chat-channel.ts` — registry CRUD, internal route handlers
- `src/do/chat-channel/routes/internal-routes.ts`（或现有 internal 路由模块）
- `src/chat/stream-registry.ts`（新建，pure helpers）

**实现要点：**

- Registry PK `(channel_id, message_id)`; status enum `streaming | finalized | abandoned | expired`.
- Finalize persistence fields: `final_event_id`, `final_text_hash`, `finalized_response_json`, `finalized_at`.
- `stream-registry-check`: validate bot ownership, status, expiry.
- `stream-finalize`: transactional insert `messages` + `events` (`message.stream_finalized`) + registry finalize + persist finalize response; idempotent replay when `status=finalized` and same hash.
- Extend `bot_effects_applied.response_json` shape for `start_stream` idempotency cache.

**不变量：**

- Registry is not the text buffer — text lives in `BotStreamConnection`.
- `message_id` generated at `start_stream`, reused at finalize.
- Final `created_at` = registry `created_at` (stream start time).

**测试要求：**

- Registry insert/check/finalize unit tests via DO fetch internal routes.
- Idempotent `start_stream` returns same `message_id` + `ws_url`.

**回滚 / 兼容风险：**

- ChatChannel schema version bump — existing channels get migration on next wake. No breaking change to existing message paths.

---

## Task 4: Bot effect application pipeline (non-stream)

**目标：** 主 Gateway `delivery_result` / `session.effects` 应用 `send_message`, `update_message`, `disable_components`；拒绝 `append_stream`/`finalize_stream`。

**可能修改的文件：**

- `src/do/bot-connection.ts` — route `delivery_result` to ChatChannel (remove stub `BOT_EFFECT_INVALID`)
- `src/do/chat-channel.ts` — `/internal/bot-delivery-result` effect applier
- `src/chat/bot-effects.ts`（新建或扩展）— validate + apply non-stream effects
- `src/chat/message-projection.ts` — ensure bot sender projection
- `test/do/bot-connection-delivery-result.test.ts`, `test/do/bot-effects.test.ts`

**实现要点：**

- Keep existing effect idempotency `(channel_id, bot_id, client_effect_id)`.
- `send_message` → insert `messages` + `message.created` event + fanout.
- `update_message` / `disable_components` → ownership check (bot's own messages).
- Rejected stream effects → `delivery_ack.status=failed`, `BOT_EFFECT_INVALID`.
- Return `effect_results` with `{ message_id, event_id }` where applicable.

**不变量：**

- ChatChannel is source-of-truth for canonical writes; BotConnection holds queue only.
- Bot messages use `sender_kind=bot`, snapshot display name/avatar at write time per existing patterns.
- DM channels: reject bot effects with `UNSUPPORTED_CHANNEL_KIND`.

**测试要求：**

- Happy path: delivery → effect → ack with `effect_results`.
- Idempotent replay same `client_effect_id`.
- Conflict different body → `BOT_EFFECT_CONFLICT`.
- `append_stream` on main gateway → `BOT_EFFECT_INVALID`.

**回滚 / 兼容风险：**

- Medium — changes bot runtime from stub to live. Feature-flag not required if tests gate merge; bot SDKs expecting stub will start receiving real messages.

---

## Task 5: `start_stream` effect + live `message.stream_started`

**目标：** 主 Gateway 接受 `start_stream`；创建 registry；emit live-only started frame；返回 Stream WS URL in `delivery_ack`.

**可能修改的文件：**

- `src/chat/bot-effects.ts` — `start_stream` handler
- `src/chat/stream-live-delivery.ts`（新建）— fanout stream_event frames to ChannelFanout
- `src/do/chat-channel.ts` — integrate start_stream in effect applier
- `src/routes/bot-stream.ts`（新建，Worker 路由占位）
- `test/do/bot-start-stream.test.ts`

**实现要点：**

- `start_stream.message.text` empty/ignored; store sanitized metadata in registry `message_json`.
- Generate `message_id` (uuidv7 monotonic within channel).
- Set `expires_at = now + STREAM_DEFAULT_TTL_SECONDS`.
- Emit `message.stream_started` as `frame_type=stream_event` (not channel event).
- Build `ws_url` path per §9.15.1.

**不变量：**

- No canonical `messages` row until finalize.
- No `message.created` at start.
- Repeated identical `start_stream` effect returns cached `effect_results`.

**测试要求：**

- `start_stream` → registry row + ack with `stream.ws_url`.
- HTTP history during streaming: message absent.
- Live frame received on Browser WS test harness (poll ChannelFanout dump if needed).

**回滚 / 兼容 risk：**

- Low if Task 4 already merged — additive effect type.

---

## Task 6: Stream WS Worker route + upgrade

**目标：** Worker 路由 `GET /api/chat/bot/channels/:channel_id/streams/:message_id/ws`；鉴权；registry check；upgrade 到 `BotStreamConnection`.

**可能修改的文件：**

- `src/routes/bot-stream-ws.ts`（新建）
- `src/index.ts` — mount route
- `src/auth/bot-token.ts` — scope check `chat:runtime:connect` + `chat:messages:write`
- `src/do/bot-stream-connection.ts` — `webSocketMessage` dispatcher skeleton
- `test/routes/bot-stream-ws.test.ts`

**实现要点：**

- Pre-upgrade: call ChatChannel `/internal/stream-registry-check`.
- Fail closed: `BOT_STREAM_NOT_FOUND`, `BOT_STREAM_EXPIRED`, `BOT_SCOPE_DENIED` without WS upgrade.
- Subprotocol: `lilium.chat.bot.stream.v1`.
- On accept: send `ready { channel_id, message_id, expires_at, ack_seq }`.

**不变量：**

- `channel_id` + `message_id` both validated against registry; no message-id-only routing.
- Wrong bot → 404/403 before upgrade.

**测试要求：**

- Upgrade happy path after `start_stream`.
- Reject: wrong bot, missing scopes, missing registry, expired registry.

**回滚 / 兼容风险：**

- New route only — no impact until bots connect stream WS.

---

## Task 7: Append, ack, buffer flush, live delta fanout

**目标：** Stream WS `append` seq/ack 语义、durable buffer、batched `message.stream_delta` live frames。

**可能修改的文件：**

- `src/do/bot-stream-connection.ts` — append handler, flush, fanout batching, alarm
- `src/do/channel-fanout.ts` — `/internal/deliver-stream-frame`（live-only path）
- `src/chat/stream-seq.ts`（新建）— seq validation, delta hash
- `src/do/scheduler.ts` — register stream flush/expiry due tables if needed
- `test/do/bot-stream-append.test.ts`

**实现要点：**

- Constants from spec §5 (`STREAM_PENDING_FLUSH_THRESHOLD_BYTES`, etc.).
- `append_ack` only after durable flush to `stream_state.flushed_text`.
- Fanout batching via `ChannelFanout /internal/deliver-stream-frame`（**不**走 canonical `/deliver`）。
- Unacked duplicate hash map in WS attachment only（**不**持久化 SQLite）。
- Alarm-driven flush + expiry cleanup.

**不变量：**

- `ack_seq` never exceeds durable flushed text coverage.
- Gap detection: `seq > received_seq + 1` → `BOT_STREAM_SEQUENCE_GAP`（**不是** `ack_seq + 1`）。
- `seq <= ack_seq` → durable no-op (still eventually ack).
- Unacked duplicate (same connection, `seq > ack_seq`): same hash no-op / different hash → `BOT_STREAM_CONFLICT`.
- Reconnect/rehydrate: `received_seq` resets to `ack_seq`; bot resumes from `ack_seq + 1`.
- Append hot path: no ChatChannel SQLite writes.

**测试要求：**

- Seq 1..N happy path with acks.
- Reconnect: new WS, `ready.ack_seq`, resume from `ack_seq+1`, no duplicate text in buffer.
- Gap / conflict error codes.
- Live delta frames batched (poll fanout).

**回滚 / 兼容风险：**

- Stream WS behavior only; main gateway unaffected.

---

## Task 8: Finalize + canonical `message.stream_finalized`

**目标：** Stream WS `finalize` → ChatChannel canonical write；`finalized_ack`；close stream WS；history/replay projection。

**可能修改的文件：**

- `src/do/bot-stream-connection.ts` — finalize handler
- `src/do/chat-channel.ts` — `/internal/stream-finalize` full implementation
- `src/chat/message-projection.ts` — `projectMessageForBrowser` for stream final message
- `src/contract/events.ts` — `message.stream_finalized` payload shape
- `test/do/bot-stream-finalize.test.ts`, `test/do/bot-stream-history.test.ts`

**实现要点：**

- Drain pending fanout before finalize transaction.
- `resolved_text = stream_state.flushed_text`.
- Optional `components` / `attachment_ids` on finalize (validate if attachment task not done: reject unknown attachments).
- Insert `messages.stream_state=final`; event type `message.stream_finalized` only — **no** `message.created`.
- Persist registry `final_event_id`, `final_text_hash`, `finalized_response_json` on first commit.
- Idempotent finalize: `status=finalized` + same hash → return stored response; different hash → `BOT_STREAM_CONFLICT`.

**不变量：**

- Exactly one canonical event per finalized stream.
- `projectMessageForBrowser` shared for history, HTTP events, live event, and finalize ack projection.
- HTTP `GET .../messages` and `GET .../events` return final message after finalize only.

**测试要求：**

- Finalize → one `message.stream_finalized` in events; assert no `message.created`.
- History after finalize contains full text.
- Replay projection matches live event payload.
- Repeated finalize → same ack (idempotent).

**回滚 / 兼容 risk：**

- Medium — changes Browser timeline semantics for streamed bot messages. Frontend must handle `message.stream_finalized` (may already have types).

---

## Task 9: Expiry, abandon, reconnect policy

**目标：** Registry + stream DO expiry alarms；abandon 不发 partial message；live `message.stream_abandoned`.

**可能修改的文件：**

- `src/do/chat-channel.ts` — registry expiry alarm, mark `expired`/`abandoned`
- `src/do/bot-stream-connection.ts` — buffer cleanup, abandon fanout
- `test/do/bot-stream-expiry.test.ts`

**实现要点：**

- Both ChatChannel and BotStreamConnection participate in expiry (spec §11).
- WS disconnect alone does not abandon — wait until `expires_at`.
- After expiry: reject append/finalize with `BOT_STREAM_EXPIRED`.
- Emit live-only `message.stream_abandoned`; delete registry + buffer.
- Reconnect before expiry: resume at `ready.ack_seq + 1`.

**不变量：**

- No partial text promoted on abandon/expiry.
- Offline clients never see abandoned streams in HTTP history.

**测试要求：**

- Disconnect + reconnect before expiry → resume works.
- Expiry without finalize → abandon frame, no history row.
- Finalize after expiry → `BOT_STREAM_EXPIRED`.

**回滚 / 兼容风险：**

- Low — tightens stream lifecycle; bots must finalize before TTL (documented in §9.15).

---

## Task 10: Platform `/permission` command (internal)

**目标：** 实现 platform bot `/permission` 内联命令（非 Bot Gateway delivery）。

**可能修改的文件：**

- `src/chat/platform-commands.ts` — add `/permission` handler
- `src/do/chat-channel.ts` — invoke routing, binding writes
- `src/chat/command-manifest.ts` — manifest entry for platform `/permission`
- `test/do/platform-permission.test.ts`

**实现要点：**

- Parse `/permission`, `/permission <name> on|off`.
- Require channel owner/admin; DM → `UNSUPPORTED_CHANNEL_KIND`.
- Official command `on` → `OFFICIAL_COMMAND_AUTO_ALLOWED`.
- Write same binding rows as Browser PATCH command settings.
- Emit `command.binding_updated` + optional `system.notice`.

**不变量：**

- No Bot Gateway delivery for platform commands.
- Not part of third-party Bot runtime public docs.

**测试要求：**

- Owner/admin success; member → `COMMAND_PERMISSION_DENIED`.
- List mode returns text message.
- Binding mutation emits manifest delta event.

**回滚 / 兼容 risk：**

- Low — additive platform command; no breaking API change.

**Note:** If product deprioritizes `/permission`, this task may ship after Tasks 1–9 without blocking streaming.

---

## Task 11: Rich UI `interaction.submit` (if not already landed)

**目标：** 实现 WS `interaction.submit` 路由、policy  enforcement、`message_interaction` delivery — per contract §9.6 / §3.8 v2.18.

**可能修改的文件：**

- `src/do/user-connection.ts` — wire `interaction.submit` (currently unsupported)
- `src/do/chat-channel.ts` — interaction persistence, policy checks
- `src/chat/interaction-policy.ts`（新建）
- `test/do/interaction-submit.test.ts`

**实现要点：**

- Platform enforces `interaction_policy` in submit transaction (`exclusive` atomic disable).
- Bot receives `message_interaction` delivery on main Gateway WS.
- See contract §9.6 for value types and delivery ordering.

**不变量：**

- Same-channel interaction delivery order matches committed interaction order.
- `exclusive` component lock is platform-enforced, not bot-only.

**测试要求：**

- Policy matrix: `multi`, `per_user_once`, `exclusive`, `targeted`.
- Error codes: `COMPONENT_ALREADY_USED`, `INTERACTION_ALREADY_SUBMITTED`, `INTERACTION_FORBIDDEN_TARGET`.

**回滚 / 兼容 risk：**

- Medium — new user-facing interaction path. Can ship after streaming if needed; listed here because contract §9.6 is part of internal addendum scope but separate from stream WS.

**Note:** Confirm with product whether Task 11 is same PR series or follow-up. Streaming Tasks 1–9 do not depend on Task 11.

---

## Deferred tasks (document only — do not implement)

| Item | Reason |
|---|---|
| Machine Token `/api/chat/bots*` | §9.17 D2 — needs actor/audit model |
| Bot read API | §9.17 D8 — needs read grant design |
| Bot attachment upload | §9.17 — optional; channel-scoped v1 spec exists but not streaming blocker |
| Public Bot developer docs | After deploy verification |
| `docs/bot-developer-guide.md` major update | After public API extraction |

---

## Verification checklist (before merge)

```bash
npm run typecheck
npx vitest run test/do/bot-start-stream.test.ts test/do/bot-stream-append.test.ts test/do/bot-stream-finalize.test.ts test/do/bot-stream-expiry.test.ts test/do/bot-effects.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
git diff --check
```

Manual review:

- Markdown code fences balanced in all touched docs.
- No third-party public API doc written as deliverable.
- Gap tracker header points to §9.13–§9.16 + §12.4 + backend spec + this plan.
- Plan does not treat Machine Token / Bot read / Bot upload as current scope.

---

## Suggested execution order

```
Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 9
                                    ↘ Task 10 (parallel after Task 4)
                                    ↘ Task 11 (optional parallel track)
```

Tasks 1–3 can partially parallelize after Task 1 types land. Task 4 blocks Task 5. Tasks 6–9 are sequential on stream path.
