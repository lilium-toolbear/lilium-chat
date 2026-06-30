# Lilium Chat API Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close P0/P1 API contract gaps on `master` (post PR #11, baseline `e6a3fca`) and deliver Bot channel-scoped image upload (selected P2). Mark remaining P2 items as deferred; explicitly exclude HTTP callback transport, signed attachment URL/proxy, and admin audit API.

**Architecture:** Extend existing ChatChannel read routes, replay projection, bot effect application, and UserDirectory-style S3 presign patterns. No new DO classes. Bot uploads store pending/finalized attachments in **ChatChannel** SQLite (`owner_bot_id` + `channel_id` scope). Stateful bots use existing `session.input` delivery (not passive `message_event` frames).

**Authority (normative, in order):**

1. `docs/api-contract.md` — §3.8, §6.1b, §6.6, §9.7–§9.9, §9.17, §10.3–§10.4
2. `docs/superpowers/specs/2026-06-28-lilium-chat-bot-spec-revised.md` §10.5 (`session.effects`)
3. `docs/superpowers/specs/2026-06-28-lilium-chat-bot-third-party-api-gaps.md` §4 (bot upload direction)

**Tech stack:** Cloudflare Workers + SQLite DOs, Hono, vitest-pool-workers, `aws4fetch` S3 presign (existing `src/s3/*`).

## Global Constraints

- Never call `ctx.storage.setAlarm` directly; use `scheduleNextAlarm` / `runDueJobs`.
- After `wrangler.jsonc` binding changes: `npm run cf-typegen && npm run typecheck`.
- Tests under load: `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`.
- Do NOT push or deploy unless explicitly asked.
- SQLite schema changes: new migration version in `src/do/migrations/chat-channel.ts`, never edit baseline.
- Bot message mutation stays on Bot Gateway WS (`delivery_result` / `session.effects`); upload HTTP only mints `attachment_id`.

## Scope Matrix

| ID | Item | Action |
|---|---|---|
| P0-1 | `GET .../messages/{message_id}/context` (§6.6) | **Implement** |
| P0-2 | `GET .../channels/{channel_id}/events` (§6.1b) | **Implement** |
| P0-3 | Bot Gateway `session.effects` / `session.effects_ack` | **Implement** |
| P1-1 | Bot `attachment_ids` on `send_message` / `update_message` | **Implement** (after P2 upload) |
| P1-2 | §3.8 component structural validation + stream `components` rejection | **Implement** |
| P1-3 | Stateful `listen_capability` → `session.input` for bot-originated messages | **Implement** |
| P1-4 | Public directory `last_message_preview=null` | **No work** — contract documents current behavior (§5.6) |
| P2-upload | Bot channel-scoped image upload HTTP | **Implement** |
| P2-machine | Machine Token on `/api/chat/bots*` | **Defer** |
| P2-read | Bot Token read HTTP/WS APIs | **Defer** |
| P2-callback | HTTP callback bot transport | **Will not implement** |
| P2-signed | Signed attachment URL / proxy | **Will not implement** |
| P2-audit | Admin audit API (deleted/recalled message原文) | **Defer** — PG archive (`lilium-ng` / dzmm_archive) retains authoritative message content for ops |
| P2-passive | Passive `message_event` delivery (`kind=message_event` outbox) | **Defer** — stateful bots use `session.input` per slash-command addendum; no passive producer in v1 |

**Baseline commit:** `e6a3fcac52538fa21231b7f8c05b96dfff2a4ff2` (`feat(bot): streaming gateway... #11`).

---

## Task 1: Per-channel events HTTP (`GET /api/chat/channels/{channel_id}/events`)

**Files:**

- Create: `src/routes/channel-events.ts`
- Modify: `src/chat/replay-projection.ts` — extend `buildReplayEventsResponse`
- Modify: `src/do/chat-channel/routes/read-routes.ts` — pass `limit` query param
- Modify: `src/index.ts` — register route **before** catch-all `app.all("/api/chat/*")`
- Test: `test/routes/channel-events.test.ts`

**Interfaces:**

- Consumes: existing `buildReplayEventsResponse` replay projection (§10.3 rules, all Browser-visible event types — not `TIMELINE_HISTORY_EVENT_TYPES` subset).
- Produces:
  - `export async function channelEventsHandler(c): Promise<Response>`
  - `buildReplayEventsResponse(opts: { sql, env, userId, after, limit })` returns JSON:
    ```json
    { "events": EventFrame[], "latest_event_id": string | null, "next_cursor": string | null }
    ```
  - `events[]` items are **parsed** `EventFrame` objects (same shape as WS / global events handler after JSON parse), not `{ event_id, event_json }` blobs.

**Wire contract (§6.1b):**

```http
GET /api/chat/channels/{channel_id}/events?after_event_id=<uuidv7>&limit=100
Authorization: Bearer <browser_jwt>
```

Response:

```json
{
  "events": [],
  "latest_event_id": "00000000-0000-7000-8000-000000000301",
  "next_cursor": null
}
```

- `after_event_id` omitted or empty → start from earliest visible event (same floor as today’s `/internal/replay`).
- `limit` default `100`, clamp `1..100`.
- `latest_event_id` = newest `event_id` in the returned page (or channel’s latest event if page empty).
- `next_cursor` = last `event_id` in page when more events remain after this page; else `null`.

**Implementation steps:**

- [ ] **Step 1:** Add failing test — member receives `message.created` + `member.joined` after `after_event_id`; non-member private channel → 403; response shape has parsed `events[]`, `latest_event_id`, `next_cursor`.
- [ ] **Step 2:** Extend `buildReplayEventsResponse` with `limit`, pagination (`LIMIT ?`), and direct `EventFrame[]` output.
- [ ] **Step 3:** Add `channelEventsHandler` mirroring `listMessagesHandler` auth + `CHAT_CHANNEL.getByName(channel_id)` + `/internal/replay?after=&limit=`.
- [ ] **Step 4:** Register `app.get("/api/chat/channels/:channel_id/events", channelEventsHandler)` in `src/index.ts`.
- [ ] **Step 5:** Run `npm run typecheck` + targeted vitest; commit `feat(routes): add per-channel events recovery endpoint`.

---

## Task 2: Message context HTTP (`GET .../messages/{message_id}/context`)

**Files:**

- Create: `src/chat/message-context.ts`
- Create: `src/routes/message-context.ts`
- Modify: `src/do/chat-channel/routes/read-routes.ts` — `/internal/message-context`
- Modify: `src/index.ts`
- Test: `test/routes/message-context.test.ts`, `test/chat/message-context.test.ts`

**Interfaces:**

- Produces:
  - `buildMessageContextPage(opts: { sql, env, userId, messageId, beforeCount, afterCount }): Promise<MessageContextPage | { forbidden } | { notFound }>`
  - `MessageContextPage = { anchor_message_id: string; items: EventFrame[] }`

**Wire contract (§6.6):**

```http
GET /api/chat/channels/{channel_id}/messages/{message_id}/context?before=30&after=30
```

- `before` / `after` = **event count** window (default `30`, max `50` each).
- `items[]` = timeline-visible `EventFrame[]` (same set as `GET .../messages` — `TIMELINE_HISTORY_EVENT_TYPES`), chronological ascending.
- Window centered on the anchor message’s `message.created` event (resolve `message_id` → `events` row where `event_type='message.created'` and payload references that `message_id`).
- Anchor deleted/recalled → `404 MESSAGE_NOT_FOUND` (message not in visible history).
- Non-member private channel → `403 FORBIDDEN`.

**Implementation steps:**

- [ ] **Step 1:** Unit test `buildMessageContextPage` with seeded events: anchor in middle, correct window size, excludes deleted anchor.
- [ ] **Step 2:** Implement SQL: find anchor `event_id`, select timeline events with `event_id` in `(anchor - before, anchor + after]` ordered ASC; reuse `projectTimelineRows` from `timeline-history.ts`.
- [ ] **Step 3:** Worker route + ChatChannel `/internal/message-context` internal route.
- [ ] **Step 4:** Register HTTP route; run tests; commit `feat(routes): add message context endpoint`.

---

## Task 3: `session.effects` / `session.effects_ack` (stateful Bot Gateway)

**Files:**

- Modify: `src/chat/bot-gateway-session.ts` — `parseSessionEffects`, `buildSessionEffectsAck`
- Modify: `src/contract/bot-gateway.ts` — frame types
- Modify: `src/do/bot-connection.ts` — WS branch for `session.effects`
- Create: `src/do/chat-channel/bot-session-effects-handlers.ts`
- Modify: `src/do/chat-channel.ts` — route `/internal/bot-session-effects`
- Modify: `src/do/chat-channel/bot-delivery-result-handlers.ts` — extract shared `applyValidatedEffects(...)` used by delivery_result and session.effects
- Test: `test/do/bot-connection-session-effects.test.ts`, `test/do/chat-channel-session-effects.test.ts`

**Interfaces:**

- Consumes: `validateMainGatewayEffects` / `validateEffectsForApply` from `src/chat/bot-effects.ts`; existing `stateful_command_sessions.effect_last_acked_seq`.
- Produces:
  - Inbound frame `SessionEffectsFrame { type: "session.effects", session_id, effect_seq, effects[] }`
  - Outbound `SessionEffectsAckFrame { type: "session.effects_ack", session_id, effect_seq, status: "applied" | "rejected", effect_results?, error? }`
  - ChatChannel handler `handleBotSessionEffects(host, { session_id, bot_id, effect_seq, effects })`

**Normative behavior (spec §10.5 + contract §9.8):**

1. `BotConnection` resolves `session_id` → active row in `active_stateful_session_refs` (same gate as `session.input_ack`).
2. Forward to owning `ChatChannel` with `X-Verified-Bot-Id`.
3. **Idempotency:** `effect_seq <= effect_last_acked_seq` → replay last ack without re-applying.
4. `effect_seq !== effect_last_acked_seq + 1` → reject with `BOT_EFFECT_INVALID` (gap).
5. Allowed effects: same set as `delivery_result` on main gateway (`send_message`, `update_message`, `disable_components`, `start_stream` only).
6. On success: bump `effect_last_acked_seq`, return `status=applied` + `effect_results[]` (mirror `delivery_ack`).

**Implementation steps:**

- [ ] **Step 1:** Protocol unit tests for parse/build frames.
- [ ] **Step 2:** Extract shared effect-apply function from `bot-delivery-result-handlers.ts` (no behavior change for `delivery_result` tests).
- [ ] **Step 3:** Implement `handleBotSessionEffects` with `effect_seq` checks.
- [ ] **Step 4:** Wire `bot-connection.ts` WS handler; integration test: stateful session active → `session.effects` `send_message` → channel `message.created` + ack.
- [ ] **Step 5:** Run `test/do/stateful-session.test.ts` + new tests; commit `feat(bot): implement session.effects on stateful gateway`.

---

## Task 4: §3.8 component validation + stream/components mutual exclusion

**Files:**

- Create: `src/chat/components.ts`
- Modify: `src/chat/bot-effects.ts` — call `validateComponents` in `parseMessageBody` / `validateEffectsForApply`
- Modify: `src/chat/stream-registry.ts` — reject non-empty `components` in `parseStartStreamMessageBody`
- Modify: `src/do/chat-channel/stream-registry-handlers.ts` — reject finalize `components.length > 0`
- Modify: `src/chat/replay-projection.ts` or `message-projection.ts` — force `components=[]` on stream messages (`stream_state !== 'none'`)
- Test: `test/chat/components.test.ts`, extend `test/chat/bot-effects.test.ts`, `test/do/bot-stream-finalize.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export type WireComponent = { /* discriminated union per §3.8 */ };
  export function validateComponents(raw: unknown): WireComponent[];
  export class ComponentValidationError extends Error { code: "BOT_EFFECT_INVALID" }
  ```

**Validation rules (§3.8 — implement all):**

| Check | Error |
|---|---|
| `kind` ∈ allowed enum | `BOT_EFFECT_INVALID` |
| `component_id` UUIDv7 string | `BOT_EFFECT_INVALID` |
| `custom_id` non-empty string | `BOT_EFFECT_INVALID` |
| `button` requires `style` + `label` | `BOT_EFFECT_INVALID` |
| `select`/`radio`/`checkbox_group` require `options[]` with `{value,label}` | `BOT_EFFECT_INVALID` |
| `checkbox_group` `min_selected` ≤ `max_selected` | `BOT_EFFECT_INVALID` |
| `text_input` `min_length` ≤ `max_length` | `BOT_EFFECT_INVALID` |
| `interaction_policy=targeted` requires `target_user_id` | `BOT_EFFECT_INVALID` |
| Unknown `interaction_policy` | `BOT_EFFECT_INVALID` |
| Duplicate `component_id` in one message | `BOT_EFFECT_INVALID` |
| `start_stream` / stream finalize with `components.length > 0` | `BOT_EFFECT_INVALID` |

**Implementation steps:**

- [ ] **Step 1:** Table-driven unit tests for each kind + policy edge cases.
- [ ] **Step 2:** Implement `validateComponents`; wire into bot effect parse path.
- [ ] **Step 3:** Add stream/start_stream rejection tests (flip existing test that allows non-empty components).
- [ ] **Step 4:** Projection guard: stream messages always emit `components=[]` to Browser.
- [ ] **Step 5:** Commit `feat(bot): enforce §3.8 component validation and stream exclusion`.

---

## Task 5: Bot channel-scoped image upload HTTP (P2)

**Files:**

- Create: `src/routes/bot-uploads.ts`
- Modify: `src/do/migrations/chat-channel.ts` — migration: `attachments.owner_bot_id TEXT`, `attachments.channel_id TEXT`, relax `owner_user_id` to nullable with CHECK `(owner_user_id IS NOT NULL OR owner_bot_id IS NOT NULL)`
- Modify: `src/do/chat-channel/routes/attachment-routes.ts` (or new `bot-attachment-routes.ts`) — `/internal/bot-attachment-presign`, `/internal/bot-attachment-finalize`
- Modify: `src/index.ts`
- Test: `test/routes/bot-uploads.test.ts`, `test/do/chat-channel-bot-attachments.test.ts`

**Wire contract (channel-scoped, §9.17):**

```http
POST /api/chat/bot/channels/{channel_id}/uploads/images/presign
Authorization: Bearer <bot_token>
Idempotency-Key: <uuid>
Content-Type: application/json

{ "filename": "a.png", "mime_type": "image/png", "size_bytes": 12345, "width": 512, "height": 512, "blurhash": "..." }
```

```http
POST /api/chat/bot/channels/{channel_id}/uploads/images/{attachment_id}/finalize
Authorization: Bearer <bot_token>

{ "etag": "\"abc\"" }
```

- Required scope: `chat:messages:write` (reuse existing bot scope gate via `getBotIdentity(c, "chat:messages:write")`).
- Bot must be **installed** on channel (`bot_installations` row active).
- Presign: insert `attachments` row `status=pending`, `owner_bot_id=bot_id`, `channel_id`, `kind=image`; return presigned PUT URL (reuse `presignPutUrl`).
- Finalize: HEAD S3, set `status=finalized` (same rules as user uploads: mime whitelist, size cap).
- **v1 rule:** attachment usable only in the same `channel_id` where presigned.

**Implementation steps:**

- [ ] **Step 1:** Migration + schema version bump test (`/schema-version` probe).
- [ ] **Step 2:** Internal presign/finalize handlers (mirror UserDirectory flow but rows in ChatChannel `attachments`).
- [ ] **Step 3:** HTTP routes with bot auth; presign/finalize integration test with fake S3 client.
- [ ] **Step 4:** Register routes; typecheck; commit `feat(bot): channel-scoped image upload presign and finalize`.

---

## Task 6: Bot `attachment_ids` on `send_message` / `update_message` (P1)

**Files:**

- Modify: `src/chat/bot-effects.ts` — remove "not supported yet" guard; allow `type: "image"` + non-empty `attachment_ids`
- Modify: `src/do/chat-channel/bot-delivery-result-handlers.ts` — `resolveBotAttachmentIds(botId, channelId, ids)` + INSERT `message_attachments`
- Test: extend `test/do/chat-channel-bot-delivery-result.test.ts`, `test/chat/bot-effects.test.ts`

**Interfaces:**

- Produces: `resolveBotAttachmentIds(sql, { botId, channelId, attachmentIds }): MessageImageAttachment[]` — each id must be `status=finalized`, `owner_bot_id=botId`, `channel_id` match, `kind=image`.

**Normative behavior:**

- `send_message` with `type: "text"` → `attachment_ids` must be `[]`.
- `send_message` with `type: "image"` → `attachment_ids.length >= 1`, all resolved.
- `update_message` may set `attachment_ids` (full replace of image attachments on bot-owned `stream_state=none` message).
- **Stream paths unchanged:** `start_stream` and Stream WS `finalize` continue to reject `attachment_ids` (contract §9.15.4 / §3.4).

**Implementation steps:**

- [ ] **Step 1:** Tests: bot presign+finalize+send_message image round-trip.
- [ ] **Step 2:** Implement resolver + link in `applySendMessageEffect` / `applyUpdateMessageEffect`.
- [ ] **Step 3:** Negative tests: wrong channel, user-owned attachment, pending attachment → `BOT_EFFECT_INVALID`.
- [ ] **Step 4:** Commit `feat(bot): support attachment_ids on non-stream message effects`.

---

## Task 7: Stateful `session.input` for bot-originated `message.created` (P1)

**Files:**

- Modify: `src/do/chat-channel/bot-delivery-result-handlers.ts` — after `send_message` / successful stream finalize canonical message
- Modify: `src/do/chat-channel/stream-registry-handlers.ts` — after stream finalize inserts `message.created`
- Test: extend `test/do/stateful-session.test.ts`

**Normative behavior:**

- Call `maybeEnqueueStatefulSessionInput` whenever a visible `message.created` is committed, including:
  - User `message.send` (already wired in `message-routes.ts`)
  - Bot `send_message` effect
  - Stream finalize → canonical `message.created`
- **Do not** implement passive `message_event` outbox producer (deferred).
- `listen_rules` filters apply (`include_bot_messages`, `include_own_messages`, etc.).

**Implementation steps:**

- [ ] **Step 1:** Test: active stateful session with `include_bot_messages: true` receives `session.input` when bot `send_message` fires.
- [ ] **Step 2:** Extract small helper `enqueueStatefulInputForMessageCreated(host, projection)` to avoid duplication; call from bot + stream paths.
- [ ] **Step 3:** Commit `feat(bot): fan-in bot messages to stateful session.input`.

---

## Task 8: Contract doc sync + defer ledger

**Files:**

- Modify: `docs/api-contract.md` — add implementation notes under §9.17 for bot upload paths; add **Deferred capabilities** subsection listing explicit non-goals
- Modify: `docs/superpowers/specs/2026-06-28-lilium-chat-bot-third-party-api-gaps.md` — mark §2–§4 items closed; add defer table

**Defer ledger (copy into contract addendum):**

| Capability | Status | Rationale |
|---|---|---|
| Machine Token on `/api/chat/bots*` | Deferred | Owner API stays Browser JWT (§9.17) |
| Bot read APIs (`chat:*:read` scopes) | Deferred | No product consumer yet |
| HTTP callback transport | **Will not implement** | WS delivery is the only bot transport |
| Signed attachment URL / read proxy | **Will not implement** | Public-read SeaweedFS URLs accepted risk |
| Admin audit API (deleted/recalled 原文) | Deferred | Ops uses PG archive / lilium-ng message store |
| Passive `message_event` delivery | Deferred | Stateful uses `session.input`; passive subscription API exists but delivery kind unused |
| `last_message_preview` text | Deferred | §5.6 already documents `null` |

- [ ] **Step 1:** Update docs after Tasks 1–7 merge.
- [ ] **Step 2:** Commit `docs: sync api gap closure status and defer ledger`.

---

## Validation (full phase gate)

```bash
cd lilium-chat
npm run typecheck
npx vitest run \
  test/routes/channel-events.test.ts \
  test/routes/message-context.test.ts \
  test/chat/components.test.ts \
  test/routes/bot-uploads.test.ts \
  test/do/bot-connection-session-effects.test.ts \
  test/do/chat-channel-session-effects.test.ts \
  test/do/chat-channel-bot-delivery-result.test.ts \
  test/do/stateful-session.test.ts \
  test/do/bot-stream-finalize.test.ts \
  --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
```

## Suggested PR breakdown

| PR | Tasks | Theme |
|---|---|---|
| PR-A | 1, 2 | Browser HTTP recovery (events + context) |
| PR-B | 3, 7 | Stateful bot gateway completion |
| PR-C | 4 | Component validation |
| PR-D | 5, 6, 8 | Bot image upload + attachment_ids + docs |

PR-A is independent. PR-B depends on nothing in PR-C/D. PR-D depends on PR-C only for validation overlap (can merge PR-C first). Task 6 hard-depends on Task 5.

## Self-review (spec coverage)

| Requirement | Task |
|---|---|
| §6.1b per-channel events | 1 |
| §6.6 message context | 2 |
| §9.8 stateful `session.effects` | 3 |
| §3.8 components + stream互斥 | 4 |
| §9.17 bot upload | 5 |
| Bot `attachment_ids` in effects | 6 |
| Stateful listen → `session.input` for bot messages | 7 |
| Defer / WNI documentation | 8 |

**Admin audit rationale:** Deleted/recalled messages keep content in PostgreSQL via archive ingestion (`ChatChannel` archive outbox → PG). Ops/debug queries run against archive DB, not a separate Chat Worker admin API.
