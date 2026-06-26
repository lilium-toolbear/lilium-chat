# Lilium Chat Phase 8 — Live Fanout Without WS Cursor Recovery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unsafe connect-time `registerOnlineOnConnect` + `ctx.waitUntil` with: thin WS connect, synchronous `session.live_start` (all active channels, no replay), `live_channel_leases` + `fanout_leases` with TTL and deliver stale cleanup. WS = best-effort live push; HTTP = authoritative recovery. Breaking subprotocol `lilium.chat.v1` → `lilium.chat.v2`.

**Design authority:** `docs/plans/2026-06-27-userconnection-live-subscription-redesign.md` (v1.1)

**Contract authority:** `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md` §v2.11 (`session.live_start`, `session.heartbeat`; no `channel.subscribe` in v1)

**Architecture:**

```
WS connect → live_sessions(open) + 101 only

WS open → session.live_start (sync command)
  → UserDirectory /my-channels
  → per channel: live_channel_leases + ChannelFanout /lease-upsert
  → live_sessions(live) + ack (NO replay)

New ChatChannel event → ChannelFanout fanout_queue
  → alarm → UserConnection /deliver → ws.send (best-effort)
  → stale reason → delete fanout_leases row

HTTP bootstrap / GET .../events → gap recovery (authoritative)
```

**Tech Stack:** Cloudflare Workers + DO SQLite, Hono, vitest-pool-workers. No new bindings.

## Global Constraints

- **No `ctx.waitUntil`** in `UserConnection` connect path (CI grep gate).
- **No WS replay** in UserConnection (connect or `session.live_start` or heartbeat).
- **No `channel.subscribe`** in Phase 8 v1.
- **Breaking:** `lilium.chat.v2` only; frontend ships in same window.
- **Do NOT push or deploy.**
- **Tests:** `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`

---

## Phase 1 — Thin WS connect

### Task P1-1: Remove connect `waitUntil` + replay/register

**Files:** `src/do/user-connection.ts`, `test/do/user-connection-connect.test.ts`

- [ ] Failing test: WS 101 without UserDirectory/ChannelFanout/ChatChannel side effects; no `ctx.waitUntil` on connect.
- [ ] Connect: `live_sessions(open)` + attachment `{user_id, session_id}` + 101.
- [ ] Remove `registerOnlineOnConnect` from connect path.
- [ ] Commit: `refactor(do): thin UserConnection WS connect`

---

## Phase 2 — UserConnection schema + close cleanup

### Task P2-1: Migrations `live_sessions` + `live_channel_leases`

**Files:** `src/do/migrations/user-connection.ts`, `src/do/user-connection.ts`

- [ ] Schema per design §3.
- [ ] Tests: open/close updates SQL rows.

### Task P2-2: Close/error from `live_channel_leases`

**Files:** `src/do/user-connection.ts`, `test/do/user-connection-close-race.test.ts`

- [ ] Failing test: leases exist in SQL but attachment empty → close still revokes fanout.
- [ ] Does not read `attachment.subscribed_channels`.

---

## Phase 3 — ChannelFanout leases + deliver cleanup

### Task P3-1: `fanout_leases` + lease APIs

**Files:** `src/do/migrations/channel-fanout.ts`, `src/do/channel-fanout.ts`, `test/do/channel-fanout-leases.test.ts`

- [ ] `/lease-upsert`, `/lease-revoke`, `/lease-revoke-session`
- [ ] `/register-online`, `/unregister-online` → 410
- [ ] `/fanout-enqueue` uses non-expired leases only

### Task P3-2: Alarm parses deliver JSON + deletes stale leases

**Files:** `src/do/channel-fanout.ts`, `src/do/user-connection.ts`

- [ ] Expired lease prune before deliver
- [ ] On stale reasons, DELETE fanout_leases
- [ ] `/deliver` extended request/response per design §6

### Task P3-3: Extend `/deliver` — membership gate (P0)

- [ ] Reject closed session / missing socket / expired lease / `live_channel_leases.status='closed'`
- [ ] If `membership_version_at_event > lease.membership_version`: **MUST** re-check membership before `ws.send`
- [ ] If not active: mark local lease `closed`, return `membership_not_active` (fanout deletes lease)
- [ ] If active but version stale: bump `live_channel_leases.membership_version`, then deliver
- [ ] Test: `test/do/user-connection-deliver-membership.test.ts`

---

## Phase 4 — `session.live_start` + `session.heartbeat`

### Task P4-1: Command handlers

**Files:** `src/do/user-connection.ts`, `src/ws/frames.ts`, `test/do/user-connection-live-start.test.ts`

- [ ] `session.live_start`: my-channels → leases (with `membership_version`) → fanout upsert → ack; **no replay**
- [ ] Idempotent retry: no duplicate `(session_id, channel_id)` leases
- [ ] `session.heartbeat`: reload my-channels; refresh only still-active leases; close + revoke non-active; **never** re-upsert `closed` leases; `SESSION_NOT_LIVE` if not started
- [ ] Synchronous handling (no `waitUntil`)
- [ ] Test: `test/do/user-connection-heartbeat-membership.test.ts` — removed member: heartbeat does not re-upsert fanout lease; local lease → `closed`; later event not delivered

### Task P4-2: Worker subprotocol v2

**Files:** `src/routes/ws.ts`, `test/routes/ws.test.ts`

- [ ] Accept `lilium.chat.v2` only; ignore/remove `?cursors=`

### Task P4-3: Errors

**Files:** `src/errors.ts`

- [ ] Add `SESSION_NOT_LIVE` if missing

---

## Phase 5 — Remove legacy + gates

### Task P5-1: Delete old paths

- [ ] Remove `registerOnlineOnConnect`, `getChannelReplayAfterCursor`, attachment `subscribed_channels` / `per_channel_cursors`
- [ ] Update integration tests to `session.live_start` flow
- [ ] CI grep gates per design §4.3 static checks

### Task P5-2: Observability

- [ ] `live_start_committed`, `fanout_lease_deleted`, `session_closed_cleanup` logs

---

## Acceptance (P0)

### Backend

- [ ] WS connect: no cross-DO I/O, no `waitUntil`
- [ ] `session.live_start`: N leases, no historical events
- [ ] `session.live_start` retry: no duplicate leases
- [ ] `session.heartbeat`: refresh only active memberships; no replay; no resurrect closed leases
- [ ] Removed member: heartbeat closes local lease, no fanout upsert, no deliver
- [ ] `/deliver` membership_not_active closes local lease; fanout deletes lease
- [ ] Close: SQL-based cleanup, not attachment
- [ ] Deliver stale → lease deleted
- [ ] Expired lease not delivered

### Frontend (dzmm_archive — track separately)

- [ ] WS open → auto `session.live_start`
- [ ] No `cursors` in WS URL
- [ ] Ack → bootstrap; active route → HTTP sync
- [ ] Inactive channel event → sidebar only
- [ ] Dedupe `(channel_id, event_id)`

### Production

- [ ] WS wall time down; GB-sec idle slope flat; leases converge

---

## File touch map

| File | Change |
|---|---|
| `src/do/user-connection.ts` | Major |
| `src/do/channel-fanout.ts` | Leases + cleanup |
| `src/do/migrations/user-connection.ts` | New |
| `src/do/migrations/channel-fanout.ts` | Bump |
| `src/routes/ws.ts` | v2 subprotocol |
| `src/ws/frames.ts` | live_start / heartbeat ack types |
| `src/errors.ts` | SESSION_NOT_LIVE |
| `test/do/user-connection-deliver-membership.test.ts` | New (P0) |
| `test/do/user-connection-heartbeat-membership.test.ts` | New (P0) |
| `test/integration/*.test.ts` | live_start flow |

**Out of scope:** `channel.subscribe`, `pending_live_events`, ChatChannel mutation paths, Bot WS.
