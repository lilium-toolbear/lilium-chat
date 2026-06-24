# Lilium Chat Phase 3.5 (v4.0 Reconciliation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the as-shipped Phase 0/2/3 code to the v4.0 spec (design v4.0 + contract v2.6 + the committed_ack addendum): delete `MessageIndex`; rename `client_message_id` → `command_id`; rename the idempotency column to `operation_id` (HTTP `Idempotency-Key` ≡ WS `command_id`); move read-state from the `POST /channels/{id}/read-state` HTTP route to the WS `channel.mark_read` command (dropping the `read_state.updated` channel event); and make `message.send`'s `command_ack` carry the canonical Browser-visible message projection via a shared `projectMessageForBrowser` builder (with `message.created` event consistency).

**Architecture:** Pure refactoring of already-shipped code, no new business features. `MessageIndex` DO + `message_index` outbox target are removed entirely (Browser message APIs are channel-scoped — no `message_id → channel_id` route index). The `messages.client_message_id` column becomes `command_id` (client-generated durable operation id, = the WS `command_id`). The `idempotency_keys.idempotency_key` column becomes `operation_id` (transport-neutral: HTTP `Idempotency-Key` and WS `command_id` both normalize to it). The read-state HTTP route + its `read_state.updated` channel-event path (Phase 3 Task 11) are removed; `channel.mark_read` becomes a WS command handled by `UserConnection` → `UserDirectory` floor; multi-session sync uses a user-local `read_state_updated` WS frame (NOT a channel event, NOT persisted). `message.send` ack moves from the flat `{message_id, event_id}` shape to a payload-bearing `{channel_id, event_id, message}` where `message` is the full Browser projection built by a single shared `projectMessageForBrowser`; the `message.created` event payload is rewritten to carry the same projection. `message.edit`/`recall`/`delete` are NOT built here — they are Phase 4 (unwritten); they will use the v4.0 ack shape from day one.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), Hono, vitest-pool-workers, jose. No new bindings — `MESSAGE_INDEX` binding is REMOVED from both wrangler configs.

## Global Constraints

(All Phase 0/1/2/3 constraints carry forward. This section lists the ones most load-bearing for v4.0 reconciliation.)

- **This is a refactor of shipped, green code.** Baseline is `e4754ea`-ish (Phase 3 complete: 180 tests passing, typecheck clean). Every task must keep `npm run typecheck` + the suite green. Do NOT re-derive existing behavior.
- **Old Phase 0/2/3 plans are the historical record and are NOT touched** — this plan is the sole carrier of the v4.0 code delta. If a shipped test asserts the OLD behavior (e.g. asserts an HTTP `POST /read-state` route, asserts `client_message_id` in a payload, asserts a flat ack), UPDATE that test to the v4.0 shape within the task that changes the behavior (same commit).
- **`MessageIndex` is fully removed:** the DO file `src/do/message-index.ts`, the `MESSAGE_INDEX` binding + `MessageIndex` migration in BOTH `wrangler.jsonc` and `wrangler.test.jsonc`, the `export { MessageIndex }` in `src/index.ts`, every `message_index` `projection_outbox` write (message-send), the `message_index` branch in `ChatChannel.alarm()` + the `/outbox-flush` handler, and the `MessageIndex` shell-test binding list entry. SQLite tables are created with `CREATE TABLE IF NOT EXISTS` at DO constructor time — there is no migration system, so REMOVING a table from the SCHEMA array is sufficient (existing dev storages are ephemeral; do NOT write a DROP migration).
- **`command_id` IS the durable operation id.** WS `command_id` (top-level frame field) and HTTP `Idempotency-Key` (header) both normalize to the internal `operation_id`. The `CommandFrame` already has `command_id` and a residual `idempotency_key?: string` field — the `idempotency_key` field on the frame is REMOVED (it was never wired). `CommandAckFrame` already uses `command_id`.
- **No cross-DO 2PC.** Read-state floor commits in `UserDirectory` (SoT); the user-local `read_state_updated` frame to other sessions is best-effort (UserConnection fanout to same-user sessions; a missed frame is repaired by reconnect-time cursor replay). Read-state writes NO `ChatChannel.events` row and NO `projection_outbox` row.
- **`projectMessageForBrowser` is the ONE shared Browser message projection.** Used by history pagination, `message.send` ack, `message.created` event, and (future) edit/recall/delete acks/events + context read. Deleted/recalled filtering (`text: null`, empty attachments/components/mentions) lives IN the builder. UserSummary is NOT persisted in DO event payload — the persisted `events.payload_json` stores sender `_user_id` refs; the LIVE ack/event projection resolves `display_name`/`avatar_url` via `resolveUserSummaries` at output time. (Already the Phase 2 pattern for `message.created` — extend it to the ack.)
- **Idempotency `response_json` stores the FULL committed ack payload** (addendum K), not just `{message_id, event_id}`. A duplicate `operation_id` + same `request_hash` returns the cached ack payload exactly (stale `display_name` acceptable).
- **Git identity is `kuma`.** `git -c user.name=kuma -c user.email=kuma@kuma.homes commit ...`. **Do NOT push or deploy.**
- **Test config:** `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000` (high local load makes the 5s default flake). Typecheck: `npm run typecheck` (`tsc --noEmit`). Tests use `env` from `cloudflare:workers`, `getNamedDo`/`makeJwt`/`TEST_SECRET` from `test/helpers.ts`, with the `env.<BINDING> as unknown as Parameters<typeof getNamedDo>[0]` cast convention.
- **Out of scope (Phase 4+):** `message.edit` / `message.recall` / `message.delete` commands + their acks/events; `command.invoke` / `interaction.submit`; Queue/archive/compaction.

---

## File Structure

**Create:**
- `src/chat/message-projection.ts` — `projectMessageForBrowser(row, { senderSummary?, resolveMentions? }): Record<string, unknown>` and `projectMessageRowForPersistence` helpers. Pure; takes a `MessageRow` (+ optional resolved UserSummary) and returns the full Browser-visible projection (nulls text/attachments/components/mentions for deleted/recalled). Unit-tested.
- `test/chat/message-projection.test.ts` — projection builder unit tests (normal/edited/recalled/deleted).
- `test/do/user-connection-mark-read.test.ts` — `channel.mark_read` WS command handling + user-local `read_state_updated` frame to other sessions.

**Modify:**
- `src/ws/frames.ts` — drop `CommandFrame.idempotency_key?` (unused residue); add a `ReadStateUpdatedFrame` type (`frame_type: "read_state_updated"`, `channel_id`, `last_read_event_id`, `unread_count`) for the user-local multi-session frame.
- `src/chat/chat-channel.ts` (`src/do/chat-channel.ts`):
  - `messages` schema: `client_message_id` column → `command_id`; UNIQUE → `(channel_id, dedupe_principal_key, command_id)`.
  - `idempotency_keys` schema: `idempotency_key` column → `operation_id`; PK → `(principal_kind, principal_id, operation, operation_id)`. (Both ChatChannel and UserDirectory tables — same rename.)
  - `MessageRow` interface: `client_message_id` → `command_id`.
  - message-send handler: accept `command_id` (rename `b.client_message_id` → `b.command_id`), store `command_id` on the row, look up `/idempotency_keys ... operation_id=?`, store the FULL ack payload in `response_json`, return `{channel_id, event_id, message}` (message via `projectMessageForBrowser` with live-resolved sender).
  - `message.created` persisted payload: use `buildMessageCreatedPayload` storing `command_id` + full projection refs (sender as ref). The LIVE event frame (outbox) + replay already resolve sender — extend to carry the full projection.
  - history pagination (`/internal/messages`): project via `projectMessageForBrowser`.
  - Remove `message_index` outbox writes (message-send) + the `message_index` branch in `alarm()` + `/outbox-flush`.
  - Remove the `read-state-event` + `unread-count` handlers? — KEEP `unread-count` (still needed for the mark_read ack); REMOVE `read-state-event` (no channel event).
- `src/do/user-directory.ts`: `idempotency_keys` column rename (`operation_id`); keep `/internal/read-state` (3-state floor, returns `{stored, advanced, emit}` — but `emit` is now unused for a channel event; the UserConnection broadcast for multi-session is driven differently — see Task 4). Keep `/internal/channel-create-coordinate`.
- `src/do/user-connection.ts`: add `channel.mark_read` command routing (parse → `UserDirectory` floor → broadcast user-local `read_state_updated` to other same-user sessions → ack payload `{channel_id, last_read_event_id, unread_count}` via `ChatChannel /internal/unread-count`). Remove nothing message-send-related (keep it).
- `src/routes/channel-mutations.ts`: REMOVE `readStateHandler` (the HTTP route is gone). Keep the other 8 handlers.
- `src/index.ts`: remove `app.post("/api/chat/channels/:channel_id/read-state", ...)` + the `readStateHandler` import; remove `export { MessageIndex }`.
- `wrangler.jsonc` + `wrangler.test.jsonc`: remove the `MESSAGE_INDEX` binding + `MessageIndex` from the `new_sqlite_classes` migration.
- `src/do/message-index.ts`: **DELETE** the file.

**Do NOT touch:** `src/do/channel-fanout.ts`, `src/auth/jwt.ts`, `src/ids/uuidv7.ts`, `src/profile/resolve.ts`, `src/routes/ws.ts` (upgrade proxy), `src/routes/events.ts`, the historical Phase 0/2/3 plan files, wrangler test config DO bindings other than removing MESSAGE_INDEX.

---

## Task 0: Verify baseline is green + de-risk the rename

**Files:**
- Test: (none — runs existing suite)

**Interfaces:**
- Consumes: shipped Phase 0/2/3 code as-is.
- Produces: a green baseline; the rename mapping documented for later tasks.

- [ ] **Step 1: Run typecheck + full test suite, confirm green**

Run:
```bash
npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
```
Expected: `tsc --noEmit` exits 0; ~180 tests passing. If red, STOP — Phase 3.5 must build on green.

- [ ] **Step 2: Record the rename scope (informational)**

Run:
```bash
grep -rn "client_message_id\|idempotency_key" src/ | wc -l
grep -rn "MessageIndex\|message_index" src/ wrangler.jsonc wrangler.test.jsonc | wc -l
```
Expected: counts. These are the sites later tasks touch. Note them; do NOT edit yet.

- [ ] **Step 3: Record HEAD**

Run: `git rev-parse --short HEAD`
Expected: the Phase 3 close SHA (post `e4754ea` likely `97fc499`-ish if docs committed after). Note it.

---

## Task 1: Shared `projectMessageForBrowser` builder + test (pure unit)

**Files:**
- Create: `src/chat/message-projection.ts`
- Test: `test/chat/message-projection.test.ts`

**Interfaces:**
- Consumes: `MessageRow` shape (mirrored from `src/do/chat-channel.ts` `MessageRow`) — `{message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at}`. `resolveUserSummaries` injected for testability (same pattern as `event-broadcast.ts`).
- Produces:
  - `projectMessageForBrowser(row: MessageRow, opts?: { senderSummary?: UserSummary | null }): Record<string, unknown>` → full Browser projection. `sender` = `{kind, user: UserSummary}` when `sender_kind==='user'` and a summary is provided (else fallback `user-<shortid>`), `{kind:'bot', bot_id}` passthrough, `{kind:'system'}` minimal. **Safety filtering:** when `status==='deleted'` or `status==='recalled'`, set `text: null`, `attachments: []`, `components: []`, `mentions: []` (so the original content/mentions never leak). `reply_snapshot` parsed from `reply_snapshot_json` (best-effort; `null` on parse failure). For Phase 3.5 `attachments: []` and `components: []` are always empty (attachments are Phase 5, components are Phase 7).

- [ ] **Step 1: Write failing test**

`test/chat/message-projection.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { projectMessageForBrowser } from "../../src/chat/message-projection";
import type { MessageRow } from "../../src/do/chat-channel";

const baseRow = (over: Partial<MessageRow> = {}): MessageRow => ({
  message_id: "m1", command_id: "cmd1", channel_id: "c1",
  sender_kind: "user", sender_user_id: "u1", sender_bot_id: null,
  type: "text", format: "plain", status: "normal", text: "hi",
  reply_to: null, reply_snapshot_json: null, stream_state: "none",
  created_at: "2026-06-24T10:00:00Z", updated_at: "2026-06-24T10:00:00Z",
  edited_at: null, deleted_at: null, deleted_by: null, recalled_at: null,
  ...over,
});

describe("projectMessageForBrowser", () => {
  it("projects a normal user message with sender UserSummary", () => {
    const p = projectMessageForBrowser(baseRow(), { senderSummary: { user_id: "u1", display_name: "alice", avatar_url: null } });
    expect(p.message_id).toBe("m1");
    expect(p.command_id).toBe("cmd1");
    expect(p.channel_id).toBe("c1");
    expect(p.status).toBe("normal");
    expect(p.text).toBe("hi");
    expect((p as any).sender).toEqual({ kind: "user", user: { user_id: "u1", display_name: "alice", avatar_url: null } });
    expect(p).toHaveProperty("attachments");
    expect(p).toHaveProperty("components");
    expect(p).toHaveProperty("mentions");
  });

  it("recalled projection hides original text/attachments/mentions", () => {
    const p = projectMessageForBrowser(baseRow({ status: "recalled", recalled_at: "2026-06-24T10:02:00Z", text: "secret" }), { senderSummary: { user_id: "u1", display_name: "alice", avatar_url: null } });
    expect(p.status).toBe("recalled");
    expect(p.text).toBeNull();
    expect(p.attachments).toEqual([]);
    expect(p.mentions).toEqual([]);
    expect(p.recalled_at).toBe("2026-06-24T10:02:00Z");
  });

  it("deleted projection hides original text/attachments/mentions", () => {
    const p = projectMessageForBrowser(baseRow({ status: "deleted", deleted_at: "2026-06-24T10:03:00Z", deleted_by: "u-admin", text: "secret" }), { senderSummary: { user_id: "u1", display_name: "alice", avatar_url: null } });
    expect(p.status).toBe("deleted");
    expect(p.text).toBeNull();
    expect(p.attachments).toEqual([]);
    expect(p.mentions).toEqual([]);
  });

  it("edited projection keeps edited text + edited_at", () => {
    const p = projectMessageForBrowser(baseRow({ status: "edited", text: "new text", edited_at: "2026-06-24T10:01:00Z" }), { senderSummary: { user_id: "u1", display_name: "alice", avatar_url: null } });
    expect(p.status).toBe("edited");
    expect(p.text).toBe("new text");
    expect(p.edited_at).toBe("2026-06-24T10:01:00Z");
  });

  it("falls back to user-<shortid> when no summary provided", () => {
    const p = projectMessageForBrowser(baseRow());
    expect((p as any).sender.user.display_name).toBe("user-u1");
  });
});
```

> **Note on `MessageRow` import:** `src/do/chat-channel.ts` declares `interface MessageRow { ... }` but does NOT export it. Step 3 adds `export` to it. The test imports it from there.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/message-projection.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — `Cannot find module '../../src/chat/message-projection'` + `MessageRow` is not exported.

- [ ] **Step 3: Export `MessageRow` + implement `src/chat/message-projection.ts`**

In `src/do/chat-channel.ts`, change `interface MessageRow {` to `export interface MessageRow {`.

`src/chat/message-projection.ts`:
```typescript
import type { MessageRow } from "../do/chat-channel";
import type { UserSummary } from "./event-broadcast";

// The ONE shared Browser-visible message projection (v4.0 addendum J).
// Used by history pagination, message.send ack, message.created event,
// and (Phase 4) edit/recall/delete acks/events + context read.
// Deleted/recalled safety filtering lives HERE — callers must not re-filter.
export function projectMessageForBrowser(
  row: MessageRow,
  opts: { senderSummary?: UserSummary | null } = {},
): Record<string, unknown> {
  const hidden = row.status === "deleted" || row.status === "recalled";

  let replySnapshot: unknown = null;
  if (row.reply_snapshot_json) {
    try { replySnapshot = JSON.parse(row.reply_snapshot_json); } catch { replySnapshot = null; }
  }

  // Sender projection. Persisted payloads store sender as a ref (_user_id); the live
  // ack/event projection resolves UserSummary at output time (design §3.5).
  let sender: Record<string, unknown>;
  if (row.sender_kind === "user" && row.sender_user_id) {
    const u = opts.senderSummary ?? {
      user_id: row.sender_user_id,
      display_name: `user-${row.sender_user_id.slice(0, 8)}`,
      avatar_url: null,
    };
    sender = { kind: "user", user: u };
  } else if (row.sender_kind === "bot") {
    sender = { kind: "bot", bot_id: row.sender_bot_id };
  } else {
    sender = { kind: row.sender_kind };
  }

  return {
    message_id: row.message_id,
    command_id: row.command_id,
    channel_id: row.channel_id,
    sender,
    type: row.type,
    format: row.format,
    status: row.status,
    stream_state: row.stream_state,
    text: hidden ? null : row.text,
    reply_to: row.reply_to,
    reply_snapshot: replySnapshot,
    attachments: [],   // Phase 5
    components: [],   // Phase 7
    mentions: hidden ? [] : [],  // mentions resolved per-message at the call site (Phase 2 reads them separately); hidden => []
    created_at: row.created_at,
    updated_at: row.updated_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
    recalled_at: row.recalled_at,
  };
}
```

> **Mentions note:** the shipped `rowToMessage` returns `mentions: []` always (mention rows are read separately by the history path). The projection mirrors that — `mentions: []` (or the caller injects them). Hidden status forces `[]`. If a later task wires real mentions, they go through this builder. Do NOT add a mentions-lookup here (keep the builder pure / single-row).

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `npx vitest run test/chat/message-projection.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: 5 PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/chat/message-projection.ts test/chat/message-projection.test.ts src/do/chat-channel.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(chat): shared projectMessageForBrowser builder (v4.0 ack/event projection)"
```

---

## Task 2: `messages.client_message_id` → `command_id` (schema + message-send)

**Files:**
- Modify: `src/do/chat-channel.ts` (schema, `MessageRow`, message-send handler, history SELECTs, `rowToMessage`)
- Modify: `src/chat/command.ts` (`ParsedMessageSend.client_message_id` → `command_id`)
- Modify: `src/do/user-connection.ts` (passes `command_id` not `client_message_id`)
- Test: update `test/chat/command.test.ts`, `test/do/chat-channel-message-send.test.ts`, `test/do/user-connection.test.ts`, `test/integration/message-send.test.ts`, `test/routes/events.test.ts` to the `command_id` shape.

**Interfaces:**
- Consumes: `projectMessageForBrowser` (Task 1).
- Produces: `message.send` WS command flow uses `command_id` throughout; `messages` table column is `command_id`.

- [ ] **Step 1: Rename the schema column + MessageRow + history SELECTs**

In `src/do/chat-channel.ts`:
- SCHEMA `messages` definition: `client_message_id TEXT NOT NULL,` → `command_id TEXT NOT NULL,`; `UNIQUE (channel_id, dedupe_principal_key, client_message_id)` → `UNIQUE (channel_id, dedupe_principal_key, command_id)`.
- `interface MessageRow`: `client_message_id: string;` → `command_id: string;`.
- `rowToMessage(r)`: replace the `client_message_id: r.client_message_id,` line with `command_id: r.command_id,`. (Note: Task 5 replaces `rowToMessage` callers with `projectMessageForBrowser`; keep `rowToMessage` correct here in case any path still uses it transiently.)
- Both history SELECTs (the `before=...` and not): replace `client_message_id` in the column list with `command_id`.
- The `/spike-create` handler's INSERT uses the old `'c'` literal for that column — update the column name in that INSERT (keep the spike working).

- [ ] **Step 2: Rename in `src/chat/command.ts`**

`ParsedMessageSend.client_message_id` → `command_id`. In `parseMessageSendCommand`: the `client_message_id` local + the read from `p.client_message_id` + the `INVALID_MESSAGE` "client_message_id is required" message → `command_id` + "command_id is required". The returned `command: { command_id, type, ... }`.

- [ ] **Step 3: Rename in `src/do/user-connection.ts` message-send dispatch**

In the message-send `fetch` body: `client_message_id: parsed.command.client_message_id,` → `command_id: parsed.command.command_id,`.

- [ ] **Step 4: Rename in the ChatChannel `/internal/message-send` handler**

In `src/do/chat-channel.ts` message-send: the body type `client_message_id: string;` → `command_id: string;`; every `b.client_message_id` → `b.command_id`; the INSERT column list `message_id, client_message_id, dedupe_principal_key, ...` → `message_id, command_id, dedupe_principal_key, ...` (and the bound value); the idempotency SELECT/INSERT `AND idempotency_key=?` and the `idempotency_key` column/bound — leave those for Task 3 (operation_id rename) UNLESS doing both at once is cleaner; here keep `idempotency_key` column name but pass `b.command_id` as its value (this is the de-facto mapping already). The error message `"client_message_id reused with different body"` → `"command_id reused with different body"`.

> **Keep this task focused on the `client_message_id`→`command_id` rename only.** The `idempotency_key` column → `operation_id` rename is Task 3. They touch overlapping lines but are separable; do the column rename in Task 3 so this task's diff is reviewable. Pass `b.command_id` as the `idempotency_key` bound value here (already the intent).

- [ ] **Step 5: Update the idempotency response shape (prepare for Task 5, but minimal here)**

For now, the message-send `response_json` stays `{ message_id, event_id }` (Task 5 changes it to the full ack). Just ensure the names are consistent after the rename. (No payload change in this task.)

- [ ] **Step 6: Update tests to the `command_id` shape**

- `test/chat/command.test.ts`: every `client_message_id: "..."` in test inputs → `command_id: "..."`; the assertion `r.command.client_message_id` → `r.command.command_id`; the error-code expectations stay `INVALID_MESSAGE`.
- `test/do/chat-channel-message-send.test.ts`: the message-send body uses `client_message_id` → `command_id`.
- `test/do/user-connection.test.ts`: the WS command frames use `client_message_id` in payload → `command_id` (or rely on the frame-level `command_id`; confirm the test's `message.send` payload doesn't set `client_message_id` — if it does, drop it; the v4.0 payload has NO `client_message_id`).
- `test/integration/message-send.test.ts` + `test/routes/events.test.ts`: same — drop `client_message_id` from message.send payloads, use frame `command_id`.
- Any assertion on `client_message_id` in a response/event → `command_id`.

- [ ] **Step 7: Run the affected tests + typecheck**

Run: `npx vitest run test/chat/command.test.ts test/do/chat-channel-message-send.test.ts test/do/user-connection.test.ts test/integration/message-send.test.ts test/routes/events.test.ts --no-file-parallelism --test-timeout=60000`
Expected: all PASS (after the test updates). Then `npm run typecheck` — clean.

- [ ] **Step 8: Run the FULL suite (catch any other test asserting client_message_id)**

Run: `npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`
Expected: green. If a spike test (e.g. `test/spikes/*`) asserts `client_message_id`, update it in this commit.

- [ ] **Step 9: Commit**

```bash
git add src/do/chat-channel.ts src/chat/command.ts src/do/user-connection.ts test/
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "refactor: client_message_id -> command_id (v4.0 durable operation id)"
```

---

## Task 3: `idempotency_keys.idempotency_key` → `operation_id` (transport-neutral)

**Files:**
- Modify: `src/do/chat-channel.ts` (schema + all idempotency SELECT/INSERT: message-send, channel.update, channel.dissolve, members.add/role/remove, read-state-event[removed in Task 4])
- Modify: `src/do/user-directory.ts` (idempotency_keys schema + channel-create-coordinate, read-state)
- Test: none new (existing idempotency tests assert behavior, not the column name; if any introspects the column, update it).

**Interfaces:**
- Consumes: shipped idempotency behavior.
- Produces: the column is `operation_id`; the code passes the operation id (WS `command_id`, HTTP `Idempotency-Key` → forwarded value) as `operation_id`.

- [ ] **Step 1: Rename the column + PK in both DOs**

In `src/do/chat-channel.ts` SCHEMA `idempotency_keys`: `idempotency_key TEXT NOT NULL,` → `operation_id TEXT NOT NULL,`; `PRIMARY KEY (principal_kind, principal_id, operation, idempotency_key)` → `PRIMARY KEY (principal_kind, principal_id, operation, operation_id)`. Add comment `-- HTTP Idempotency-Key or WS command_id`.
In `src/do/user-directory.ts` SCHEMA `idempotency_keys`: same rename (it has its own copy for channel-create-coordinate).

- [ ] **Step 2: Rename every idempotency SELECT/INSERT bound column name**

Across `src/do/chat-channel.ts` + `src/do/user-directory.ts`: replace `AND idempotency_key=?` → `AND operation_id=?`; `INSERT INTO idempotency_keys (principal_kind, principal_id, operation, idempotency_key, ...)` → `..., operation_id, ...`; the bound value stays whatever the handler already passed (the operation id). Use Grep to find all `idempotency_key` SQL references and rename the COLUMN to `operation_id` in SQL text only (the bound TS variable names can stay, e.g. `b.idempotency_key` in the dissolve handler is the HTTP-header value — that's fine, it's the operation_id value).

> **Do NOT rename the TS body field `b.idempotency_key`** (that's the incoming HTTP `Idempotency-Key` value forwarded by the route — it IS the operation_id value). Only rename the SQL column + the `WHERE ... AND operation_id=?` + `INSERT (... operation_id ...)`.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000 && npm run typecheck`
Expected: green (the behavior is unchanged; only the column name moved). The `idempotency_keys` tests (create-coordinate cached/conflict, message-send idempotent, dissolve idempotent) still pass because they assert behavior.

- [ ] **Step 4: Commit**

```bash
git add src/do/chat-channel.ts src/do/user-directory.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "refactor: idempotency_keys.idempotency_key -> operation_id (transport-neutral; HTTP Idempotency-Key ≡ WS command_id)"
```

---

## Task 4: read-state HTTP → WS `channel.mark_read`; drop the channel event; user-local `read_state_updated` frame

**Files:**
- Modify: `src/do/user-connection.ts` (add `channel.mark_read` command routing + multi-session broadcast)
- Modify: `src/ws/frames.ts` (drop `CommandFrame.idempotency_key`; add `ReadStateUpdatedFrame`)
- Modify: `src/do/chat-channel.ts` (REMOVE the `/internal/read-state-event` handler; KEEP `/internal/unread-count`)
- Modify: `src/do/user-directory.ts` (`/internal/read-state`: drive the Floor only; the `emit` field is no longer "emit a channel event" — Task 4 redefines it as "broadcast a user-local frame"; keep the floor 3-state logic, return `{stored, advanced}`)
- Modify: `src/routes/channel-mutations.ts` (REMOVE `readStateHandler`)
- Modify: `src/index.ts` (remove the read-state HTTP route + `readStateHandler` import)
- Create: `test/do/user-connection-mark-read.test.ts`

**Interfaces:**
- Consumes: shipped `UserDirectory /internal/read-state` floor (3-state, returns stored floor), `ChatChannel /internal/unread-count`, `UserConnection` command-routing infra (`sendCommandError`, attachment, `findSocketBySession`).
- Produces:
  - `channel.mark_read` WS command: `UserConnection` validates `command_id` + `channel_id` + `payload.last_read_event_id`; calls `UserDirectory(user_id) /internal/read-state`; if member, advances floor (monotonic); fetches `unread_count` from `ChatChannel(channel_id) /internal/unread-count`; broadcasts a `read_state_updated` frame to the user's OTHER live sessions (best-effort); acks `{command_id, status:"committed", payload:{channel_id, last_read_event_id, unread_count}}` (NO `event_id`).
  - `ReadStateUpdatedFrame`: `{frame_type:"read_state_updated", channel_id, last_read_event_id, unread_count}` — a non-timeline user-local frame, NOT persisted to `ChatChannel.events`, NOT in the event replay.
  - `UserDirectory /internal/read-state`: STILL 3-state floor, returns `{channel_id, last_read_event_id (stored), advanced}`. Drop the `emit` field (the channel event is gone; the user-local broadcast is the UserConnection's job, driven by `advanced`).

- [ ] **Step 1: Update `src/ws/frames.ts`**

Remove `idempotency_key?: string;` from `CommandFrame`. Add:
```typescript
export interface ReadStateUpdatedFrame {
  frame_type: "read_state_updated";
  channel_id: string;
  last_read_event_id: string;
  unread_count: number;
}
```
Add `ReadStateUpdatedFrame` to the `Frame` union.

- [ ] **Step 2: Write failing test**

`test/do/user-connection-mark-read.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

async function setupChannelAndJoin(userId: string, channelId: string) {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
  await stub.fetch(new Request("https://x/internal/create-channel", {
    method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: channelId, creator_user_id: userId, title: "M", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }),
  }));
  // flush the join outbox so my_channels is populated before WS upgrade
  const { runDurableObjectAlarm } = await import("cloudflare:test") as any;
  await runDurableObjectAlarm(stub);
  return stub;
}

async function upgrade(userId: string) {
  const stub = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
  const res = await stub.fetch(new Request("https://x/ws", { headers: { Upgrade: "websocket", "X-Verified-User-Id": userId } }));
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return { ws, stub };
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    ws.addEventListener("message", (ev) => { clearTimeout(t); resolve(typeof ev.data === "string" ? ev.data : ""); }, { once: true });
  });
}

describe("UserConnection channel.mark_read", () => {
  it("advances floor and acks {channel_id, last_read_event_id, unread_count} with no event_id", async () => {
    const userId = "u-mr-1";
    const cid = "01970001-0000-7000-8000-000000000011";
    await setupChannelAndJoin(userId, cid);
    const { ws } = await upgrade(userId);
    ws.send(JSON.stringify({
      frame_type: "command", command: "channel.mark_read", command_id: "cmd-mr-1", channel_id: cid,
      payload: { last_read_event_id: "01J00000000000000000000000" },
    }));
    const ackRaw = await nextMessage(ws);
    const ack = JSON.parse(ackRaw);
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.command_id).toBe("cmd-mr-1");
    expect(ack.status).toBe("committed");
    expect(ack.payload.channel_id).toBe(cid);
    expect(ack.payload.last_read_event_id).toBe("01J00000000000000000000000");
    expect(ack.payload.unread_count).toBe(0);
    expect(ack.payload.event_id).toBeUndefined();
    ws.close();
  });

  it("broadcasts a read_state_updated frame to the user's other session", async () => {
    const userId = "u-mr-2";
    const cid = "01970002-0000-7000-8000-000000000011";
    await setupChannelAndJoin(userId, cid);
    // two sessions for the same user
    const { ws: wsA } = await upgrade(userId);
    const { ws: wsB } = await upgrade(userId);
    // wsA sends mark_read; wsB should receive a read_state_updated frame (best-effort)
    wsA.send(JSON.stringify({
      frame_type: "command", command: "channel.mark_read", command_id: "cmd-mr-2", channel_id: cid,
      payload: { last_read_event_id: "01J00000000000000000000010" },
    }));
    // drain wsA's ack
    await nextMessage(wsA);
    // wsB: receive either the read_state_updated frame (first message might be replay events; poll)
    let got = "";
    try { got = await nextMessage(wsB, 3000); } catch { got = ""; }
    // wsB may have received replay frames on connect first; keep polling until read_state_updated or timeout
    for (let i = 0; i < 20 && !got.includes("read_state_updated"); i++) {
      try { got = await nextMessage(wsB, 500); } catch { break; }
    }
    expect(got).toContain("read_state_updated");
    wsA.close(); wsB.close();
  });

  it("is monotonic: stale cursor returns the stored floor, not the request cursor", async () => {
    const userId = "u-mr-3";
    const cid = "01970003-0000-7000-8000-000000000011";
    await setupChannelAndJoin(userId, cid);
    const { ws } = await upgrade(userId);
    ws.send(JSON.stringify({ frame_type: "command", command: "channel.mark_read", command_id: "cmd-mr-3a", channel_id: cid, payload: { last_read_event_id: "01Jzzzzzzzzzzzzzzzzzzzzzz" } }));
    await nextMessage(ws);
    ws.send(JSON.stringify({ frame_type: "command", command: "channel.mark_read", command_id: "cmd-mr-3b", channel_id: cid, payload: { last_read_event_id: "01Jaaaaaaaaaaaaaaaaaaaaaaa" } }));
    const ackRaw2 = await nextMessage(ws);
    const ack2 = JSON.parse(ackRaw2);
    expect(ack2.payload.last_read_event_id).toBe("01Jzzzzzzzzzzzzzzzzzzzzzz");
    ws.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/do/user-connection-mark-read.test.ts --no-file-parallelism --test-timeout=60000`
Expected: FAIL — `channel.mark_read` is not routed (current `webSocketMessage` only handles `message.send`).

- [ ] **Step 4: Update `UserDirectory /internal/read-state` to drop `emit`**

In `src/do/user-directory.ts`, simplify the `/internal/read-state` floor result: return `{ channel_id, last_read_event_id (stored), advanced }` (drop `emit`; 3-state still, always returns stored). Remove any reference to calling ChatChannel for read-state events (there is none in UserDirectory — the emit was driven by the Worker route, which Task 4 Step 6 removes).

- [ ] **Step 5: Remove the `read-state-event` handler + the HTTP route**

In `src/do/chat-channel.ts`: DELETE the `if (url.pathname === "/internal/read-state-event") { ... }` handler block entirely (the `read_state.updated` channel event is gone per v4.0). KEEP `/internal/unread-count`.
In `src/routes/channel-mutations.ts`: DELETE the `readStateHandler` function.
In `src/index.ts`: remove `readStateHandler` from the import + remove `app.post("/api/chat/channels/:channel_id/read-state", (c) => readStateHandler(c));`.

- [ ] **Step 6: Implement `channel.mark_read` routing in `UserConnection`**

In `src/do/user-connection.ts` `webSocketMessage`: extend the command switch. After the `message.send` block (keep it), add a `channel.mark_read` branch. The current structure `if (frame.command !== "message.send")` becomes a switch or a check that accepts `message.send` OR `channel.mark_read`. Add:
```typescript
if (frame.command === "channel.mark_read") {
  const channelId = frame.channel_id ?? "";
  if (!channelId) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "missing channel_id")); return; }
  const payload = (frame as { payload?: { last_read_event_id?: string } }).payload ?? {};
  const lastReadEventId = typeof payload.last_read_event_id === "string" ? payload.last_read_event_id : "";
  if (!lastReadEventId) { sendCommandError(ws, frame.command_id, responseError("INVALID_MESSAGE", "last_read_event_id required")); return; }
  // floor in UserDirectory
  const dir = this.env.USER_DIRECTORY.getByName(attachment.user_id);
  const rsRes = await dir.fetch(new Request("https://x/internal/read-state", {
    method: "POST", headers: { "X-Verified-User-Id": attachment.user_id, "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: channelId, last_read_event_id: lastReadEventId }),
  }));
  if (rsRes.status === 403) { sendCommandError(ws, frame.command_id, responseError("FORBIDDEN", "not an active member")); return; }
  if (!rsRes.ok) { sendCommandError(ws, frame.command_id, responseError("CHAT_WORKER_UNAVAILABLE", "read-state failed")); return; }
  const floor = (await rsRes.json()) as { last_read_event_id: string; advanced: boolean };
  // unread count from ChatChannel (best-effort)
  const routeName = await channelRouteNameFor(this.env, attachment.user_id, channelId);
  if (routeName === null) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found")); return; }
  const chStub = this.env.CHAT_CHANNEL.getByName(routeName);
  const ucRes = await chStub.fetch(new Request(`https://x/internal/unread-count?after=${encodeURIComponent(floor.last_read_event_id)}`, { headers: { "X-Verified-User-Id": attachment.user_id } }));
  const unreadCount = ucRes.ok ? ((await ucRes.json()) as { unread_count: number }).unread_count : 0;
  // ack (NO event_id)
  ws.send(JSON.stringify({ frame_type: "command_ack", command_id: frame.command_id, status: "committed", payload: { channel_id: channelId, last_read_event_id: floor.last_read_event_id, unread_count: unreadCount } }));
  // best-effort broadcast a user-local read_state_updated frame to the user's OTHER sessions
  if (floor.advanced) {
    for (const other of this.ctx.getWebSockets(`user-conn:${attachment.user_id}`)) {
      if (other === ws) continue;
      try {
        other.send(JSON.stringify({ frame_type: "read_state_updated", channel_id: channelId, last_read_event_id: floor.last_read_event_id, unread_count: unreadCount }));
      } catch { /* session gone */ }
    }
  }
  return;
}
```
> **`getWebSockets(tag)` note:** the shipped `acceptWebSocket(server, [`user-conn:${userId}`])` tags sessions by user; `this.ctx.getWebSockets(`user-conn:${userId}`)` returns all the user's live sessions. Broadcast to all except the sender. Best-effort.

- [ ] **Step 7: Run the mark_read test + typecheck**

Run: `npx vitest run test/do/user-connection-mark-read.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: 3 PASS; typecheck clean.

- [ ] **Step 8: Run the full suite (the read-state HTTP route test is gone — confirm no leftover asserts it)**

Run: `npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`
Expected: green. The old `test/routes/channel-mutations.test.ts` `POST /api/chat/channels/:id/read-state` describe block (from Phase 3 Task 11) must be REMOVED in this commit (it asserted the removed HTTP route). Delete that describe block.

- [ ] **Step 9: Commit**

```bash
git add src/do/user-connection.ts src/ws/frames.ts src/do/chat-channel.ts src/do/user-directory.ts src/routes/channel-mutations.ts src/index.ts test/do/user-connection-mark-read.test.ts test/routes/channel-mutations.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat: read-state WS channel.mark_read (drop HTTP route + read_state.updated channel event; user-local read_state_updated frame)"
```

---

## Task 5: `message.send` ack carries canonical projection; `message.created` event consistency; full ack in idempotency cache

**Files:**
- Modify: `src/do/chat-channel.ts` (message-send: build + return `{channel_id, event_id, message}`; store full ack in `response_json`; `message.created` persisted payload + live frame use `projectMessageForBrowser`)
- Modify: `src/do/user-connection.ts` (ack shape: payload-bearing, no flat `message_id`/`event_id`)
- Test: `test/do/chat-channel-message-send.test.ts`, `test/do/user-connection.test.ts`, `test/integration/message-send.test.ts` update ack assertions.

**Interfaces:**
- Consumes: `projectMessageForBrowser` (Task 1), `resolveUserSummaries` (live sender resolution for the ack/event).
- Produces: `message.send` `command_ack` = `{frame_type:"command_ack", command, command_id, status:"committed", payload:{channel_id, event_id, message: <full projection>}}`; the `message.created` event `payload.message` = the same projection; `idempotency_keys.response_json` = the full ack payload.

- [ ] **Step 1: Update `ChatChannel /internal/message-send` to return the projection**

In `src/do/chat-channel.ts` message-send handler: after the transaction (created or cached), resolve the sender UserSummary live (`resolveUserSummaries([userId], this.env)` → fallback handled by the projection), build the `message` projection via `projectMessageForBrowser(messageRow, { senderSummary })`. The transaction's `response_json` must store the FULL ack payload (addendum K): `JSON.stringify({frame_type:"command_ack", command:"message.send", command_id: b.command_id, status:"committed", payload:{channel_id, event_id, message}})`. Return from the handler: `Response.json({ channel_id, event_id, message })` (the UserConnection wraps it into the ack frame — see Step 3).

> The `message.created` PERSISTED payload (`buildMessageCreatedPayload`) currently stores a thin `{message:{message_id, client_message_id→command_id, channel_id, sender:{kind,user_id,bot_id}, type, format, status, created_at}}`. Per addendum J, the persisted event may store refs (sender as ref) — KEEP the persisted payload as refs (the live projection is resolved at output). The LIVE event frame (the `channel_fanout` outbox `event_json`) and the replay output must use `projectMessageForBrowser` (already resolved for sender in Phase 2's `resolveSenderForLiveBroadcast` — but that produced a thin projection; here we want the FULL projection). Update `persistEventAndFanout` / the message.created live-frame build to produce the full projection.

- [ ] **Step 2: Update the `message.created` live event frame to the full projection**

In `src/do/chat-channel.ts`: where the live `message.created` event frame is built for the `channel_fanout` outbox (inside `persistEventAndFanout` or the message-send path), the payload's `.message` should be the full `projectMessageForBrowser` projection (with live-resolved sender). The persisted `events.payload_json` keeps refs (sender_user_id) — unchanged. `resolveSenderForLiveBroadcast` (Phase 2) already injects the resolved sender into the persisted ref payload; here, instead of the thin projection, build the full projection from the resolved sender + the row. If `resolveSenderForLiveBroadcast` returns a thin `{message:{...sender:{kind,user}}}`, replace that message object with the full `projectMessageForBrowser(messageRow, {senderSummary})` output.

> **Keep replay consistent (Task 4b already did mgmt-event actor resolution):** the `/internal/replay` message.created/updated branch must also emit the full projection. It currently calls `resolveSenderForLiveBroadcast` on the persisted payload. Update it to build the full projection from the resolved sender. (If the persisted message.created payload is refs-only, the replay needs the `messages` row to build the full projection — re-read the row by `message_id` in replay for message.* events, then project. This mirrors the Phase 2 spike-replay status-filter pattern.)

- [ ] **Step 3: Update `UserConnection.message.send` ack construction**

In `src/do/user-connection.ts` message-send branch: the `ChatChannel /internal/message-send` now returns `{channel_id, event_id, message}`. Build the ack:
```typescript
const out = (await res.json()) as { channel_id: string; event_id: string; message: Record<string, unknown> };
ws.send(JSON.stringify({
  frame_type: "command_ack", command: "message.send", command_id: frame.command_id, status: "committed",
  payload: { channel_id: out.channel_id, event_id: out.event_id, message: out.message },
}));
```
Remove the old flat `{channel_id, message_id, event_id}` ack.

- [ ] **Step 4: Update tests**

- `test/do/chat-channel-message-send.test.ts`: assert the `/internal/message-send` response is `{channel_id, event_id, message}` and `message.message_id`/`message.command_id`/`message.sender.user.display_name` are present.
- `test/do/user-connection.test.ts` + `test/integration/message-send.test.ts`: assert the ack is `payload`-bearing: `ack.payload.message.message_id`, `ack.payload.event_id`, no top-level `ack.message_id`.
- `test/routes/events.test.ts`: the replayed `message.created` event payload — assert `payload.message` is the full projection (has `sender.user`, `text`, etc.).

- [ ] **Step 5: Run affected tests + typecheck**

Run: `npx vitest run test/do/chat-channel-message-send.test.ts test/do/user-connection.test.ts test/integration/message-send.test.ts test/routes/events.test.ts test/do/chat-channel-replay-projection.test.ts --no-file-parallelism --test-timeout=60000 && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Run full suite**

Run: `npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/do/chat-channel.ts src/do/user-connection.ts test/
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat: message.send ack + message.created event carry full Browser projection (v4.0 addendum); idempotency caches full ack"
```

---

## Task 6: Delete `MessageIndex` DO + binding + outbox writes + alarm branch

**Files:**
- Delete: `src/do/message-index.ts`
- Modify: `wrangler.jsonc` + `wrangler.test.jsonc` (remove `MESSAGE_INDEX` binding + `MessageIndex` from `new_sqlite_classes`)
- Modify: `src/index.ts` (remove `export { MessageIndex }`)
- Modify: `src/do/chat-channel.ts` (remove `message_index` outbox writes in message-send + the `message_index` branch in `alarm()` + the `/outbox-flush` message_index path if any)
- Modify: `src/do/chat-channel.ts` (the `/outbox-flush` ad-hoc handler + the `message_index` target in alarm)
- Test: remove/adjust any `MessageIndex`-binding assertion in a Phase 0 shell test + the spike `message-index-routing.test.ts` if present.

**Interfaces:**
- Consumes: shipped message-send (Task 2-5 already reworked it to drop or keep the message_index outbox — confirm here).
- Produces: no `MessageIndex` DO, no `message_index` outbox target, no `MessageIndex` binding.

- [ ] **Step 1: Remove the `message_index` outbox writes + alarm branch**

In `src/do/chat-channel.ts`:
- message-send: DELETE the `INSERT INTO projection_outbox ... target_kind='message_index' ...` block (the one with `outbox_id = message_index:${messageId}`).
- `alarm()`: DELETE the `if (r.target_kind === "message_index") { ... }` branch.
- `/outbox-flush` handler (if it references message_index): that handler is a Phase-1 spike helper (`/outbox-insert` + `/outbox-flush` route to `MESSAGE_INDEX`); check `git grep "message_index\|MESSAGE_INDEX" src/do/chat-channel.ts` and remove all. If `/outbox-flush` becomes unused, leave the handler (harmless) but remove its message_index writes.

Run `grep -n "message_index\|MESSAGE_INDEX" src/do/chat-channel.ts` to confirm zero remaining hits (except possibly a comment).

- [ ] **Step 2: Delete the DO file + remove exports + bindings**

```bash
rm src/do/message-index.ts
```
In `src/index.ts`: remove `export { MessageIndex } from "./do/message-index";`.
In `wrangler.jsonc`: remove `{ "name": "MESSAGE_INDEX", "class_name": "MessageIndex" },` AND remove `MessageIndex` from the `new_sqlite_classes` migration array.
In `wrangler.test.jsonc`: same two removals.

- [ ] **Step 3: Update the Phase 0 shell test (DO_BINDINGS list) if it asserts MESSAGE_INDEX**

Run: `grep -rn "MESSAGE_INDEX\|MessageIndex" test/`
If a test (likely `test/do/shell-*.test.ts` or a Phase 0 binding list) asserts `["MESSAGE_INDEX", "MessageIndex"]`, remove that entry from the expected list. If `test/spikes/message-index-routing.test.ts` exists, delete it (`rm`).

- [ ] **Step 4: Run full suite + typecheck**

Run: `npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000 && npm run typecheck`
Expected: green; typecheck clean (no dangling MessageIndex import).

- [ ] **Step 5: Grep-assert the removal is complete**

Run:
```bash
grep -rn "MessageIndex\|message_index\|MESSAGE_INDEX" src/ wrangler.jsonc wrangler.test.jsonc
```
Expected: zero hits (or only a historical comment if any).

- [ ] **Step 6: Commit**

```bash
git add -A src/ wrangler.jsonc wrangler.test.jsonc test/
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "refactor: remove MessageIndex DO + binding + message_index outbox (v4.0 channel-scoped message APIs)"
```

---

## Task 7: Full-suite green + typecheck + v4.0 invariants self-review

**Files:**
- Test: (none new — runs everything)

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: a green v4.0-reconciled baseline.

- [ ] **Step 1: Full suite + typecheck**

Run:
```bash
npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000
```
Expected: clean + green. (The test count will be ~180 minus the removed read-state HTTP route test + the removed message-index spike, plus the new mark_read + projection tests.)

- [ ] **Step 2: Grep-assert v4.0 terms are gone from src**

Run:
```bash
grep -rnE "client_message_id|client_mutation_id|client_invocation_id|client_interaction_id|MessageIndex|message_index|ROUTE_INDEX_PENDING" src/
```
Expected: zero hits (MessageIndex fully gone; client_*_id renamed to command_id). `ROUTE_INDEX_PENDING` may remain in `src/errors.ts` (the code is still defined — invite-code routing, Phase 6, may use it) — that's fine; it must not be returned by any message operation.

- [ ] **Step 3: Spec coverage self-review**

- MessageIndex removed → Task 6. ✅
- client_message_id → command_id → Task 2. ✅
- operation_id (HTTP Idempotency-Key ≡ WS command_id) → Task 3. ✅
- read-state WS channel.mark_read + no channel event + user-local read_state_updated → Task 4. ✅
- message.send ack payload {channel_id, event_id, message} full projection + message.created event consistency + idempotency caches full ack → Task 5. ✅
- shared projectMessageForBrowser → Task 1. ✅
- channel.mark_read ack {channel_id, last_read_event_id, unread_count} no event_id → Task 4. ✅
- NOT in scope (Phase 4): message.edit/recall/delete acks — confirmed not built; they will use the v4.0 shape when Phase 4 is written.

- [ ] **Step 4: Report**

Report `npm run typecheck` clean + full suite green + the grep results + the new HEAD SHA.

---

## Notes for the executor

- **Task order is mostly sequential but Task 2/3/5 all touch `src/do/chat-channel.ts` message-send** — do them in order (2 then 3 then 5) so each builds on the prior. A subagent per task works; each ends in a green commit.
- **The `messages` / `idempotency_keys` column renames are schema-only strings** — SQLite here is `CREATE TABLE IF NOT EXISTS` at constructor time with no migration system. Renaming the column in the SCHEMA array is the whole change; existing dev-storage is recreated fresh per `vitest` run (ephemeral miniflare state). No DROP/ALTER needed.
- **Do NOT ship `message.edit`/`recall`/`delete` here** — they are Phase 4 (unwritten). The v4.0 ack shape for them is defined in the docs for when Phase 4 is planned.
- **Do NOT push or deploy.** Git identity `kuma`. Operator deploys.
