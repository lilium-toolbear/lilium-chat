# Unified Timeline History (messages + domain events)

**Date:** 2026-06-28  
**Status:** In progress

## Problem

Channel timeline mixes user messages and domain events (`member.joined`, `channel.updated`, …). Both are persisted in `ChatChannel.events` with monotonic per-channel `event_id`. Live WS delivery works, but HTTP recovery only reads the `messages` table, so domain events disappear on refresh.

## Decision

- **One HTTP surface:** keep `GET /api/chat/channels/{channel_id}/messages` (and bootstrap `messages` field).
- **Cursor param names unchanged:** `before` / `after` — semantics become `event_id` (not `message_id`).
- **Response items:** Browser-visible `EventEnvelope` frames (same shape as WS live events), chronological ascending within each page.
- **No `system.notice`:** domain events render directly; not in scope.
- **No separate `/channels/{id}/events`:** gap recovery uses `after` on the same endpoint.

## Timeline-visible event types

Included in history pages:

- `message.created` (skip when referenced message is deleted/recalled — same as replay)
- `DOMAIN_TIMELINE_EVENT_TYPES` from `src/contract/events.ts`

Excluded from history pages (state folded elsewhere or non-timeline):

- `message.updated` / `message.deleted` / `message.recalled` / stream events
- `read_state.updated`, command/interaction lifecycle events

## API

```http
GET /api/chat/channels/{channel_id}/messages?limit=50
GET /api/chat/channels/{channel_id}/messages?before={event_id}&limit=50
GET /api/chat/channels/{channel_id}/messages?after={event_id}&limit=100
```

Response:

```json
{
  "items": [ { "frame_type": "event", "event_id": "...", "type": "member.joined", ... } ],
  "next_cursor": "01J..."
}
```

- Latest page (no cursor): `next_cursor` = oldest `event_id` in page when more history exists, else `null`.
- `before` page (scroll up): same `next_cursor` semantics.
- `after` page (gap fill): `next_cursor` = newest `event_id` in page when more events exist, else `null`.

Bootstrap `messages` uses the same builder (latest page, default limit 50).

## Backend tasks

- [x] Plan doc (this file)
- [ ] `TIMELINE_HISTORY_EVENT_TYPES` in `src/contract/events.ts`
- [ ] `src/chat/timeline-history.ts` — query `events`, project via shared replay helpers
- [ ] Refactor `src/chat/replay-projection.ts` to export row projection helper
- [ ] Replace `/internal/messages` in `read-routes.ts`
- [ ] `src/routes/messages.ts` — pass `before` / `after`
- [ ] `src/routes/bootstrap.ts` — timeline frames in `messages.items`
- [ ] Tests: message + member.joined in same history page; bootstrap includes domain event

## Frontend tasks (worktree `chat-frontend-phase-a`)

- [ ] `ChatHistoryResponse.items` → `IncomingChatEventFrame[]`
- [ ] `useChatApi.getMessages` — add `after`; remove separate `getChannelEvents` usage
- [ ] `useChatStore` — `applyTimelineHistory` / bootstrap + prepend + gap fill via `applyHistoryEvent`
- [ ] `ChatSurface` — load older uses `historyCursor`; resync uses `after`
- [ ] Update fixtures/tests

## Validation

```bash
# backend
cd lilium-chat && npx vitest run test/routes/messages.test.ts test/routes/bootstrap.test.ts test/chat/timeline-history.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000

# frontend worktree
cd dzmm_archive/.worktrees/chat-frontend-phase-a/toolbear_ui/frontend && npm run test -- useChatStore.spec.ts useChatApi.spec.ts
```
