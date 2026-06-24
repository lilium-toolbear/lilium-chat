# Lilium Chat Phase 4 + 6 Implementation Plan (message lifecycle + owner transfer + invites)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the message-lifecycle WS commands (`message.edit` / `message.recall` / `message.delete`), atomic channel owner-transfer, and the invite HTTP surface (create / accept / preview), all on the v4.0 base (channel-scoped message APIs, `command_id`/`operation_id` idempotency, payload-bearing acks via `projectMessageForBrowser`).

**Architecture:** Sections A/B/C are independently reviewable. **A (message lifecycle):** `message.edit`/`recall`/`delete` are WS commands routed `Browser → UserConnection DO → ChatChannel DO /internal/message-edit|recall|delete`, mirroring the shipped `message.send` (idempotency pre-check → txn → full ack payload cached in `idempotency_keys.response_json` → `channel_fanout` outbox). `projectMessageForBrowser` already supports the statuses. **B (owner transfer):** `POST /channels/{id}/owner-transfer` → ChatChannel `/internal/owner-transfer`, one atomic txn swapping owner + previous-owner role, emitting `member.role_updated` ×2 + `system.notice`. **C (invites):** `POST /channels/{id}/invites` (create) + `POST /invites/{code}/accept` + `GET /invites/{code}` (preview) — ChatChannel owns invite rows + InviteDirectory index via the existing `projection_outbox(target_kind=invite_directory)`; accept mutates membership (reuses Phase 3 join path) and bumps `used_count`.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), Hono, vitest-pool-workers, jose. No new bindings — `CHAT_CHANNEL`, `USER_DIRECTORY`, `USER_CONNECTION`, `CHANNEL_FANOUT`, `INVITE_DIRECTORY` all exist.

## Global Constraints

(Phase 0–3.5 + v4.0 constraints carry forward. Load-bearing ones for this plan:)

- **No cross-DO 2PC.** Source DO writes business + `projection_outbox` row co-atomically; alarm flushes to target DO; target writes idempotent; exhausted retries → `dead_letter`. Invite create writes the `invite_directory` outbox row in the same ChatChannel txn that writes the `invites` row.
- **WS `command_id` = durable operation id = the `operation_id` idempotency key.** `message.edit`/`recall`/`delete` WS commands carry top-level `command_id`; the ChatChannel handler stores `idempotency_keys(operation='message.edit'|'message.recall'|'message.delete', operation_id=<command_id>)`. HTTP `Idempotency-Key` (owner-transfer, invite create/accept) maps to `operation_id` the same way. Duplicate same-operation_id+same-body → cached full ack; different body → `409 IDEMPOTENCY_CONFLICT`.
- **`message.*` acks are payload-bearing** (v4.0 addendum): `{frame_type:"command_ack", command, command_id, status:"committed", payload:{channel_id, event_id, message}}` where `message` is the full `projectMessageForBrowser` projection. The idempotency `response_json` stores the FULL ack payload, written co-atomically with the business rows (no crash window — resolve sender BEFORE the txn). `message.command_id` on a message row stays the ORIGINAL `message.send` command_id; the edit/recall/delete ack's top-level `command_id` is THAT operation's id (distinct, intentional).
- **`CHANNEL_DISSOLVED` write-gate** applies to edit/recall/delete + owner-transfer + invite create/accept (every write into ChatChannel).
- **owner single-owner invariant:** exactly one active owner (`channel_meta.created_by`, role `owner`). Owner-transfer swaps atomically; the dissolved-channel / self-leave / self-demote guards from Phase 3 remain.
- **`projectMessageForBrowser`** is the ONE message serializer (history/replay/ack/event). edit/recall/delete acks + `message.updated`/`recalled`/`deleted` events + history all use it. Deleted/recalled → `text:null`, `attachments:[]`, `components:[]`, `mentions:[]`, `sticker:null` (when stickers land). Edit recap: `message_edits` table already exists — append a row per edit for audit; the Browser projection exposes only current `status='edited'` + `edited_at`, NOT edit history.
- **Git identity `kuma`.** `git -c user.name=kuma -c user.email=kuma@kuma.homes commit ...`. **Do NOT push or deploy.**
- **Test config:** `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000` (high local load makes the 5s default flake). Typecheck: `npm run typecheck` (`tsc --noEmit`). Tests use `env` from `cloudflare:workers`, `getNamedDo`/`makeJwt`/`TEST_SECRET` from `test/helpers.ts`, with the `env.<BINDING> as unknown as Parameters<typeof getNamedDo>[0]` cast. WS-command e2e tests use the `nextAck` helper that skips replay frames (see `test/do/user-connection.test.ts`).
- **Existing endpoints are stable.** ChatChannel keeps all `/internal/*` handlers; this plan ADDS `/internal/message-edit`, `/internal/message-recall`, `/internal/message-delete`, `/internal/owner-transfer`, `/internal/invites-create`, `/internal/invites-accept`, `/internal/invites-get`, `/internal/invites-consume`. It does NOT rewrite existing handlers except to thread the new commands through `UserConnection.webSocketMessage`.

---

## File Structure

**Create:**
- `test/do/chat-channel-message-lifecycle.test.ts` — edit/recall/delete DO internals + idempotency + dissolve-gate + projection.
- `test/do/user-connection-message-lifecycle.test.ts` — WS command e2e (command_id / ack shape / not-owner rejection / idempotent retry).
- `test/routes/channel-owner-transfer.test.ts` — owner-transfer HTTP route.
- `test/routes/invites.test.ts` — invite create / accept / preview HTTP routes.
- `test/do/invite-directory.test.ts` — InviteDirectory index upsert/get semantics.

**Modify:**
- `src/chat/command.ts` — add `parseMessageEditCommand` / `parseMessageRecallCommand` / `parseMessageDeleteCommand` (top-level `command_id`, no payload client ids).
- `src/do/chat-channel.ts` — add `/internal/message-edit`, `/internal/message-recall`, `/internal/message-delete`, `/internal/owner-transfer`, `/internal/invites-create`, `/internal/invites-accept`, `/internal/invites-get`, `/internal/invites-consume` handlers. Add `sticker`-null passthrough to `projectMessageForBrowser`-fed rows is N/A (stickers are Phase 5/E batch — not here). Extend `projectMessageForBrowser`? NO — it already handles `status` correctly; recall sets `status='recalled'`/`recalled_at`, delete sets `status='deleted'`/`deleted_at`, edit bumps `text`/`edited_at`/`status='edited'`. The builder already nulls text/attachments/components/mentions for deleted/recalled. Confirm only.
- `src/do/user-connection.ts` — extend `webSocketMessage` with `message.edit` / `message.recall` / `message.delete` routing (mirror the `message.send` block).
- `src/ws/frames.ts` — extend `CommandAckFrame`? NO — the union already includes `message.send|message.edit|message.recall|message.delete` payloads (added in v4.0 P1). Confirm.
- `src/errors.ts` — add `INVALID_MEMBER_ROLE` (422) if not present (owner-transfer / invite accept may use it). `INVITE_NOT_FOUND` (404) already exists. `ROUTE_INDEX_PENDING` (409) already exists.
- `src/routes/channel-mutations.ts` — add `ownerTransferHandler`, `createInviteHandler`, `acceptInviteHandler`, `previewInviteHandler`.
- `src/index.ts` — register `POST /channels/:id/owner-transfer`, `POST /channels/:id/invites`, `POST /invites/:code/accept`, `GET /invites/:code`.
- `src/do/invite-directory.ts` — extend `/upsert` to accept `expires_at` / `revoked_at` / `status` / `created_by`-less (invite index stores code→channel+status+expires+revoked); add `/preview` returning the index row; keep `/get`. (The shell hardcodes `2999-01-01` expiry — fix to pass through real `expires_at`.)

**Do NOT touch:** `src/do/channel-fanout.ts`, `src/do/user-directory.ts` (read-state floor stays), `src/auth/jwt.ts`, `src/ids/uuidv7.ts`, `src/profile/resolve.ts`, `src/routes/messages.ts`/`bootstrap.ts`, wrangler configs.

---

## Section A — Message lifecycle (edit / recall / delete)

These three commands share a near-identical structure (idempotency pre-check → resolve sender → txn: load message, apply mutation, write `message.*` event + fanout outbox + `idempotency_keys.response_json`=full ack → return). To avoid 3× duplication in the plan, Task A2 defines a **shared internal helper** `applyMessageMutation(...)` that the three handlers delegate to; each handler only specifies its permission check + row update + event type.

### Task A0: Baseline green

**Files:** (none — runs existing suite)

- [ ] **Step 1:** Run `npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Expected: clean + green (~189 passed). Record HEAD (`git rev-parse --short HEAD`).

---

### Task A1: `parseMessageEdit/Recall/DeleteCommand` parsers + tests

**Files:**
- Modify: `src/chat/command.ts`
- Test: `test/chat/command.test.ts` (append)

**Interfaces:**
- Consumes: `CommandFrame` (top-level `command_id`, `channel_id`, `payload: Record<string,unknown>`).
- Produces:
  - `parseMessageEditCommand(frame): ParseResult<{ message_id: string; text: string }>` — requires top-level `command_id`; payload has `message_id` (non-empty) + `text` (non-empty after trim, for edit). Rejects `attachment_ids`/`reply_to_message_id`/`mentions` changes on edit (Phase 4 is text-edit only; mention re-resolution is out of scope — keep existing mentions).
  - `parseMessageRecallCommand(frame): ParseResult<{ message_id: string }>` — requires `command_id`; payload `message_id` non-empty.
  - `parseMessageDeleteCommand(frame): ParseResult<{ message_id: string; reason: string | null }>` — requires `command_id`; payload `message_id` non-empty, optional `reason` (string or null).

- [ ] **Step 1: Write failing tests** (append to `test/chat/command.test.ts`):
```typescript
import { parseMessageEditCommand, parseMessageRecallCommand, parseMessageDeleteCommand } from "../../src/chat/command";

describe("parseMessageEditCommand", () => {
  const ok = { frame_type: "command" as const, command: "message.edit", command_id: "op-e1", channel_id: "ch1", payload: { message_id: "m1", text: "new" } };
  it("parses edit (command_id top-level, message_id + text in payload)", () => {
    const r = parseMessageEditCommand(ok as any);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.command.message_id).toBe("m1"); expect(r.command.text).toBe("new"); }
  });
  it("rejects missing message_id", () => {
    const r = parseMessageEditCommand({ ...ok, payload: { text: "x" } } as any);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
  it("rejects empty text", () => {
    const r = parseMessageEditCommand({ ...ok, payload: { message_id: "m1", text: "  " } } as any);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
  it("rejects missing top-level command_id", () => {
    const r = parseMessageEditCommand({ ...ok, command_id: "" } as any);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
});

describe("parseMessageRecallCommand", () => {
  it("parses recall", () => {
    const r = parseMessageRecallCommand({ frame_type: "command", command: "message.recall", command_id: "op-r1", channel_id: "ch1", payload: { message_id: "m1" } } as any);
    expect(r.ok).toBe(true); if (r.ok) expect(r.command.message_id).toBe("m1");
  });
  it("rejects missing message_id", () => {
    const r = parseMessageRecallCommand({ frame_type: "command", command: "message.recall", command_id: "op-r1", channel_id: "ch1", payload: {} } as any);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
});

describe("parseMessageDeleteCommand", () => {
  it("parses delete with optional reason", () => {
    const r = parseMessageDeleteCommand({ frame_type: "command", command: "message.delete", command_id: "op-d1", channel_id: "ch1", payload: { message_id: "m1", reason: "spam" } } as any);
    expect(r.ok).toBe(true); if (r.ok) { expect(r.command.message_id).toBe("m1"); expect(r.command.reason).toBe("spam"); }
  });
  it("parses delete without reason (null ok)", () => {
    const r = parseMessageDeleteCommand({ frame_type: "command", command: "message.delete", command_id: "op-d2", channel_id: "ch1", payload: { message_id: "m1" } } as any);
    expect(r.ok).toBe(true); if (r.ok) expect(r.command.reason).toBeNull();
  });
  it("rejects missing message_id", () => {
    const r = parseMessageDeleteCommand({ frame_type: "command", command: "message.delete", command_id: "op-d3", channel_id: "ch1", payload: { reason: "x" } } as any);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
});
```

- [ ] **Step 2:** Run `npx vitest run test/chat/command.test.ts --no-file-parallelism --test-timeout=60000`. Expected: FAIL (exports don't exist).

- [ ] **Step 3:** Implement in `src/chat/command.ts` (append after `parseMessageSendCommand`):
```typescript
export interface ParsedMessageEdit { message_id: string; text: string; }
export interface ParsedMessageRecall { message_id: string; }
export interface ParsedMessageDelete { message_id: string; reason: string | null; }

function requireCommandId(frame: CommandFrame): string | null {
  return typeof frame.command_id === "string" && frame.command_id ? frame.command_id : null;
}
function requireChannelId(frame: CommandFrame): string | null {
  return typeof frame.channel_id === "string" && frame.channel_id ? frame.channel_id : null;
}

export function parseMessageEditCommand(frame: CommandFrame): ParseResult<ParsedMessageEdit> {
  if (frame.command !== "message.edit") return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  if (!requireCommandId(frame)) return { ok: false, error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false } };
  if (!requireChannelId(frame)) return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  const p = frame.payload as Record<string, unknown>;
  const message_id = typeof p.message_id === "string" ? p.message_id : "";
  if (!message_id) return { ok: false, error: { code: "INVALID_MESSAGE", message: "message_id is required", retryable: false } };
  const text = typeof p.text === "string" ? p.text : "";
  if (text.trim() === "") return { ok: false, error: { code: "INVALID_MESSAGE", message: "message text is empty", retryable: false } };
  return { ok: true, command: { message_id, text } };
}

export function parseMessageRecallCommand(frame: CommandFrame): ParseResult<ParsedMessageRecall> {
  if (frame.command !== "message.recall") return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  if (!requireCommandId(frame)) return { ok: false, error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false } };
  if (!requireChannelId(frame)) return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  const p = frame.payload as Record<string, unknown>;
  const message_id = typeof p.message_id === "string" ? p.message_id : "";
  if (!message_id) return { ok: false, error: { code: "INVALID_MESSAGE", message: "message_id is required", retryable: false } };
  return { ok: true, command: { message_id } };
}

export function parseMessageDeleteCommand(frame: CommandFrame): ParseResult<ParsedMessageDelete> {
  if (frame.command !== "message.delete") return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  if (!requireCommandId(frame)) return { ok: false, error: { code: "INVALID_MESSAGE", message: "command_id is required", retryable: false } };
  if (!requireChannelId(frame)) return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  const p = frame.payload as Record<string, unknown>;
  const message_id = typeof p.message_id === "string" ? p.message_id : "";
  if (!message_id) return { ok: false, error: { code: "INVALID_MESSAGE", message: "message_id is required", retryable: false } };
  const reasonRaw = p.reason;
  const reason = typeof reasonRaw === "string" ? reasonRaw : null;
  return { ok: true, command: { message_id, reason } };
}
```
> `ParseResult` is the existing generic `type ParseResult<T> = { ok: true; command: T } | { ok: false; error: {...} }` — confirm it's generic in `command.ts`; if it's currently `{ ok: true; command: ParsedMessageSend }`, generalize it to `ParseResult<T>`.

- [ ] **Step 4:** Run the test (PASS) + `npm run typecheck`.

- [ ] **Step 5:** Commit:
```bash
git add src/chat/command.ts test/chat/command.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(chat): parse message.edit/recall/delete commands (v4.0 WS lifecycle)"
```

---

### Task A2: ChatChannel shared `applyMessageMutation` + the three handlers

**Files:**
- Modify: `src/do/chat-channel.ts`
- Test: `test/do/chat-channel-message-lifecycle.test.ts` (create)

**Interfaces:**
- Consumes: `projectMessageForBrowser` (Task 1 of Phase 3.5), `persistEventAndFanout`, `resolveActorMap`, `resolveUserSummaries`, `insertOutboxRowForFanout`, `cachedResponse` (Phase 3 helpers). The message-send handler's idempotency pre-check + full-ack-in-txn pattern (lines ~810-998) as the structural template.
- Produces: `/internal/message-edit` / `/internal/message-recall` / `/internal/message-delete` handlers. Each returns the full ack payload `{channel_id, event_id, message}` (the `message` is the post-mutation `projectMessageForBrowser` projection).

- [ ] **Step 1: Write failing tests** (`test/do/chat-channel-message-lifecycle.test.ts`). Use the `setupSystemAndJoin` style from `test/do/chat-channel-message-send.test.ts` (system channel + join + flush). Send a text message first, then mutate.
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

async function setupAndSend(userId: string, channelId: string, text: string, cmdId: string): Promise<{ stub: DurableObjectStub; messageId: string; eventId: string }> {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], channelId);
  await stub.fetch(new Request("https://x/internal/create-channel", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: channelId, creator_user_id: userId, title: "LC", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }) }));
  const send = await (await stub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ command_id: cmdId, dedupe_principal_key: `user:${userId}`, type: "text", text, reply_to: null, mentions: [], channel_id: channelId }) }))).json() as { message: { message_id: string }; event_id: string };
  return { stub, messageId: send.message.message_id, eventId: send.event_id };
}

describe("ChatChannel message lifecycle", () => {
  it("edit: owner edits own text -> status edited, text updated, event message.updated", async () => {
    const { stub, messageId } = await setupAndSend("u-lc-1", "01a40001-0000-7000-8000-000000000001", "orig", "cmd-send-1");
    const res = await stub.fetch(new Request("https://x/internal/message-edit", {
      method: "POST", headers: { "X-Verified-User-Id": "u-lc-1", "Content-Type": "application/json" },
      body: JSON.stringify({ operation_id: "cmd-edit-1", message_id: messageId, text: "edited" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { event_id: string; message: { status: string; text: string; edited_at: string | null } };
    expect(body.message.status).toBe("edited");
    expect(body.message.text).toBe("edited");
    expect(body.message.edited_at).not.toBeNull();
    expect(body.event_id).toBeTruthy();
  });

  it("edit: non-owner editing another's message -> 403", async () => {
    const { stub, messageId } = await setupAndSend("u-lc-2", "01a40002-0000-7000-8000-000000000001", "orig", "cmd-send-2");
    // join a second user
    await stub.fetch(new Request("https://x/internal/members-add", { method: "POST", headers: { "X-Verified-User-Id": "u-lc-2", "Content-Type": "application/json" }, body: JSON.stringify({ operation_id: "cmd-add-2", channel_id: "01a40002-0000-7000-8000-000000000001", user_id: "u-lc-2b", role: "member" }) }));
    const res = await stub.fetch(new Request("https://x/internal/message-edit", { method: "POST", headers: { "X-Verified-User-Id": "u-lc-2b", "Content-Type": "application/json" }, body: JSON.stringify({ operation_id: "cmd-edit-2", message_id: messageId, text: "hijack" }) }));
    expect(res.status).toBe(403);
  });

  it("edit: idempotent retry returns same ack", async () => {
    const { stub, messageId } = await setupAndSend("u-lc-3", "01a40003-0000-7000-8000-000000000001", "orig", "cmd-send-3");
    const b = { operation_id: "cmd-edit-3", message_id: messageId, text: "edited" };
    const r1 = await (await stub.fetch(new Request("https://x/internal/message-edit", { method: "POST", headers: { "X-Verified-User-Id": "u-lc-3", "Content-Type": "application/json" }, body: JSON.stringify(b) }))).json();
    const r2 = await (await stub.fetch(new Request("https://x/internal/message-edit", { method: "POST", headers: { "X-Verified-User-Id": "u-lc-3", "Content-Type": "application/json" }, body: JSON.stringify(b) }))).json();
    expect((r2 as { event_id: string }).event_id).toBe((r1 as { event_id: string }).event_id);
  });

  it("recall: owner recalls own message -> status recalled, text null in projection", async () => {
    const { stub, messageId } = await setupAndSend("u-lc-4", "01a40004-0000-7000-8000-000000000001", "secret", "cmd-send-4");
    const res = await stub.fetch(new Request("https://x/internal/message-recall", { method: "POST", headers: { "X-Verified-User-Id": "u-lc-4", "Content-Type": "application/json" }, body: JSON.stringify({ operation_id: "cmd-recall-4", message_id: messageId }) }));
    expect(res.status).toBe(200);
    const body = await res.json() as { message: { status: string; text: string | null; recalled_at: string | null; mentions: unknown[] } };
    expect(body.message.status).toBe("recalled");
    expect(body.message.text).toBeNull();
    expect(body.message.mentions).toEqual([]);
    expect(body.message.recalled_at).not.toBeNull();
  });

  it("delete: owner (admin) deletes another's message -> status deleted, audit_logs row", async () => {
    const cid = "01a40005-0000-7000-8000-000000000001";
    const { stub, messageId } = await setupAndSend("u-lc-5", cid, "spammy", "cmd-send-5");
    // u-lc-5 is owner; delete their own message as an admin-delete path test
    const res = await stub.fetch(new Request("https://x/internal/message-delete", { method: "POST", headers: { "X-Verified-User-Id": "u-lc-5", "Content-Type": "application/json" }, body: JSON.stringify({ operation_id: "cmd-delete-5", message_id: messageId, reason: "spam" }) }));
    expect(res.status).toBe(200);
    const body = await res.json() as { message: { status: string; text: string | null; deleted_at: string | null } };
    expect(body.message.status).toBe("deleted");
    expect(body.message.text).toBeNull();
    expect(body.message.deleted_at).not.toBeNull();
  });

  it("dissolve-gate: edit on a dissolved channel -> 409 CHANNEL_DISSOLVED", async () => {
    const cid = "01a40006-0000-7000-8000-000000000001";
    const { stub, messageId } = await setupAndSend("u-lc-6", cid, "orig", "cmd-send-6");
    await stub.fetch(new Request("https://x/internal/dissolve", { method: "POST", headers: { "X-Verified-User-Id": "u-lc-6", "Content-Type": "application/json" }, body: JSON.stringify({ operation_id: "cmd-dissolve-6", channel_id: cid }) }));
    const res = await stub.fetch(new Request("https://x/internal/message-edit", { method: "POST", headers: { "X-Verified-User-Id": "u-lc-6", "Content-Type": "application/json" }, body: JSON.stringify({ operation_id: "cmd-edit-6", message_id: messageId, text: "x" }) }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CHANNEL_DISSOLVED");
  });
});
```

- [ ] **Step 2:** Run `npx vitest run test/do/chat-channel-message-lifecycle.test.ts --no-file-parallelism --test-timeout=60000`. Expected: FAIL (handlers 404).

- [ ] **Step 3:** Implement the shared helper + three handlers in `src/do/chat-channel.ts`. Add the helper near `persistEventAndFanout`:
```typescript
// Shared core for message.edit / recall / delete (v4.0 lifecycle). Mirrors message.send's
// idempotency-in-txn + full-ack-cached + fanout-outbox pattern. `mutate` is the per-command
// row update + event metadata; it runs INSIDE the transaction.
private async applyMessageMutation(input: {
  userId: string;
  operationId: string;
  channelId: string;
  messageId: string;
  operation: "message.edit" | "message.recall" | "message.delete";
  requestHash: string;
  // returns { eventType, mutatedRowFields: Partial<MessageRow> } applied to the loaded row
  mutate: (row: MessageRow) => { eventType: "message.updated" | "message.recalled" | "message.deleted"; fields: Partial<MessageRow> };
}): Promise<Response> {
  const now = this.nowIso();
  const nowMs = Date.parse(now);

  // cheap pre-check (cached retry returns without resolving sender)
  const preCheck = this.ctx.storage.sql
    .exec("SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''", input.userId, input.operation, input.operationId, input.requestHash)
    .toArray()[0] as { response_json: string } | undefined;
  if (preCheck) {
    const cached = JSON.parse(preCheck.response_json) as { payload?: { channel_id?: string; event_id?: string; message?: Record<string, unknown> | null } };
    if (cached.payload && cached.payload.event_id && cached.payload.message) {
      return Response.json({ channel_id: cached.payload.channel_id ?? input.channelId, event_id: cached.payload.event_id, message: cached.payload.message });
    }
  }

  // resolve sender BEFORE the txn (for the live projection)
  const actorMap = await this.resolveActorMap([input.userId]);

  const eventId = this.nextEventId(nowMs);
  const txResult = await this.ctx.storage.transaction(async (): Promise<
    | { kind: "conflict" }
    | { kind: "error"; j: string }
    | { kind: "ok"; responseJson: string }
  > => {
    const statusRow = this.ctx.storage.sql.exec("SELECT status FROM channel_meta WHERE channel_id=?", input.channelId).toArray()[0] as { status: string } | undefined;
    if (!statusRow) return { kind: "error", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
    if (statusRow.status === "dissolved") return { kind: "error", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };

    const idem = this.ctx.storage.sql.exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation=? AND operation_id=?", input.userId, input.operation, input.operationId).toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
    if (idem) {
      if (idem.request_hash !== input.requestHash) return { kind: "conflict" };
      return { kind: "ok", responseJson: idem.response_json ?? "" };
    }

    // load message row
    const row = this.ctx.storage.sql.exec("SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE message_id=? AND channel_id=?", input.messageId, input.channelId).toArray()[0] as MessageRow | undefined;
    if (!row) return { kind: "error", j: JSON.stringify({ error: { code: "MESSAGE_NOT_FOUND", message: "message not found", retryable: false } }) };
    if (row.status === "deleted") return { kind: "error", j: JSON.stringify({ error: { code: "MESSAGE_NOT_EDITABLE", message: "message is deleted", retryable: false } }) };

    // permission: edit/recall = sender only; delete = sender OR owner/admin
    const isSender = row.sender_kind === "user" && row.sender_user_id === input.userId;
    const callerRole = this.activeRole(input.channelId, input.userId);
    if (input.operation === "message.delete") {
      if (!isSender && callerRole !== "owner" && callerRole !== "admin") {
        return { kind: "error", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only sender or owner/admin may delete", retryable: false } }) };
      }
    } else {
      if (!isSender) {
        return { kind: "error", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only the sender may edit/recall their message", retryable: false } }) };
      }
    }

    const { eventType, fields } = input.mutate(row);
    const updatedRow: MessageRow = { ...row, ...fields, updated_at: now };

    // apply row update
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=?`); args.push(v); }
    sets.push("updated_at=?"); args.push(now);
    args.push(input.messageId); args.push(input.channelId);
    this.ctx.storage.sql.exec(`UPDATE messages SET ${sets.join(", ")} WHERE message_id=? AND channel_id=?`, ...args);

    // persisted event payload: store refs (use buildMessageCreatedPayload-equivalent? NO — lifecycle
    // events store the full projection WITH sender as ref; the live frame resolves). For simplicity
    // store the mutated projection-with-ref (sender as {kind,user_id,bot_id} ref) — the replay path
    // re-reads the row + resolves. Persist the same shape message.send persists.
    const persistedPayload = {
      message_id: updatedRow.message_id,
      command_id: updatedRow.command_id,
      channel_id: updatedRow.channel_id,
      sender: { kind: updatedRow.sender_kind, user_id: updatedRow.sender_user_id, bot_id: updatedRow.sender_bot_id },
      type: updatedRow.type, format: updatedRow.format, status: updatedRow.status, stream_state: updatedRow.stream_state,
      text: updatedRow.text, reply_to: updatedRow.reply_to, reply_snapshot: null,
      attachments: [], components: [], mentions: [],
      created_at: updatedRow.created_at, updated_at: updatedRow.updated_at, edited_at: updatedRow.edited_at,
      deleted_at: updatedRow.deleted_at, deleted_by: updatedRow.deleted_by, recalled_at: updatedRow.recalled_at,
    };
    const mvRow = this.ctx.storage.sql.exec("SELECT membership_version FROM channel_meta WHERE channel_id=?", input.channelId).toArray()[0] as { membership_version: number };
    const mv = mvRow.membership_version;
    this.ctx.storage.sql.exec("INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)", eventId, eventType, input.channelId, input.userId, JSON.stringify(persistedPayload), mv, now);

    // audit log for delete (admin action) / recall — record actor + reason where present
    // (edit audit is optional; keep it for completeness via message_edits for edits)
    if (input.operation === "message.edit") {
      this.ctx.storage.sql.exec("INSERT INTO message_edits (edit_id, message_id, old_text, new_text, editor_user_id, request_id, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?)", `edit:${eventId}`, input.messageId, row.text ?? "", updatedRow.text ?? "", input.userId, input.operationId, now);
    }

    // live event frame (sender-resolved) + full ack — both written in-txn
    const liveMessage = projectMessageForBrowser(updatedRow, { senderSummary: actorMap.get(input.userId) ?? null });
    const liveFrame = buildEventFrame({ event_id: eventId, type: eventType, channel_id: input.channelId, occurred_at: now, payload: { message: liveMessage } });
    this.insertOutboxRowForFanout(input.channelId, eventId, JSON.stringify(liveFrame), mv, now);
    const fullAckJson = JSON.stringify({ frame_type: "command_ack", command: input.operation, command_id: input.operationId, status: "committed", payload: { channel_id: input.channelId, event_id: eventId, message: liveMessage } });
    this.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, ?, ?, ?, ?, 'completed', ?, ?)", input.userId, input.operation, input.operationId, input.requestHash, fullAckJson, now, new Date(nowMs + 24*60*60*1000).toISOString());
    return { kind: "ok", responseJson: fullAckJson };
  });

  if (txResult.kind === "conflict") return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } }, { status: 409 });
  if (txResult.kind === "error") return this.cachedResponse(txResult.j);
  const ack = JSON.parse(txResult.responseJson) as { payload: { channel_id: string; event_id: string; message: Record<string, unknown> } };
  await this.scheduleOutboxAlarm(now);
  return Response.json(ack.payload);
}
```

Then the three handlers (before the final 404 in `ChatChannel.fetch`):
```typescript
if (url.pathname === "/internal/message-edit") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  if (!userId) return new Response("missing verified user", { status: 401 });
  const b = (await request.json()) as { operation_id: string; message_id: string; text: string; channel_id: string };
  const requestHash = JSON.stringify({ message_id: b.message_id, text: b.text });
  return this.applyMessageMutation({ userId, operationId: b.operation_id, channelId: b.channel_id, messageId: b.message_id, operation: "message.edit", requestHash, mutate: (row) => ({ eventType: "message.updated", fields: { text: b.text, status: "edited", edited_at: this.nowIso() } }) });
}

if (url.pathname === "/internal/message-recall") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  if (!userId) return new Response("missing verified user", { status: 401 });
  const b = (await request.json()) as { operation_id: string; message_id: string; channel_id: string };
  const requestHash = JSON.stringify({ message_id: b.message_id });
  const now = this.nowIso();
  return this.applyMessageMutation({ userId, operationId: b.operation_id, channelId: b.channel_id, messageId: b.message_id, operation: "message.recall", requestHash, mutate: () => ({ eventType: "message.recalled", fields: { status: "recalled", recalled_at: now, text: null } }) });
}

if (url.pathname === "/internal/message-delete") {
  const userId = request.headers.get("X-Verified-User-Id") ?? "";
  if (!userId) return new Response("missing verified user", { status: 401 });
  const b = (await request.json()) as { operation_id: string; message_id: string; reason: string | null; channel_id: string };
  const requestHash = JSON.stringify({ message_id: b.message_id, reason: b.reason ?? null });
  const now = this.nowIso();
  return this.applyMessageMutation({ userId, operationId: b.operation_id, channelId: b.channel_id, messageId: b.message_id, operation: "message.delete", requestHash, mutate: () => ({ eventType: "message.deleted", fields: { status: "deleted", deleted_at: now, deleted_by: userId, text: null } }) });
}
```
> Recall sets `text: null` on the row so the persisted projection is safe (and `projectMessageForBrowser` nulls it for hidden status anyway — belt + suspenders). Delete similarly. `MESSAGE_NOT_EDITABLE` (409) — add to `src/errors.ts` if missing (it likely is; add `MESSAGE_NOT_EDITABLE: 409`).

- [ ] **Step 4:** Run `npx vitest run test/do/chat-channel-message-lifecycle.test.ts --no-file-parallelism --test-timeout=60000` + `npm run typecheck`. Expected: 6 PASS; typecheck clean.

- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts src/errors.ts test/do/chat-channel-message-lifecycle.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(do): message.edit/recall/delete ChatChannel handlers (v4.0 WS lifecycle)"
```

---

### Task A3: UserConnection routes `message.edit/recall/delete` + e2e tests

**Files:**
- Modify: `src/do/user-connection.ts`
- Test: `test/do/user-connection-message-lifecycle.test.ts` (create)

**Interfaces:**
- Consumes: `parseMessageEditCommand` / `parseMessageRecallCommand` / `parseMessageDeleteCommand` (Task A1), the `nextAck` helper pattern from `test/do/user-connection.test.ts`.
- Produces: WS `message.edit` / `message.recall` / `message.delete` command handling in `webSocketMessage` (route to ChatChannel `/internal/message-edit|recall|delete`, forward `command_id` as `operation_id`, build payload-bearing ack).

- [ ] **Step 1: Write failing tests** (`test/do/user-connection-message-lifecycle.test.ts`). Reuse the system-channel setup + `nextAck` from `test/do/user-connection.test.ts` (copy the helpers `upgradeUserConnection` / `nextMessage` / `nextAck` / `setupSystemAndSend` — or import them; they're not exported, so copy a minimal `setupSystemAndSend` + `upgrade` + `nextAck`).
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, makeJwt, TEST_SECRET } from "../helpers";

// minimal helpers (copy from user-connection.test.ts pattern)
async function upgrade(userId: string) {
  const stub = getNamedDo(env.USER_CONNECTION as unknown as Parameters<typeof getNamedDo>[0], userId);
  const res = await stub.fetch(new Request("https://x/ws", { headers: { Upgrade: "websocket", "X-Verified-User-Id": userId } }));
  const ws = res.webSocket as WebSocket; ws.accept(); return { ws, stub };
}
function nextAck(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const h = (ev: MessageEvent) => { try { const f = JSON.parse(typeof ev.data === "string" ? ev.data : ""); if (f.frame_type === "command_ack" || f.frame_type === "command_error") { clearTimeout(t); ws.removeEventListener("message", h); resolve(typeof ev.data === "string" ? ev.data : ""); } } catch {} };
    ws.addEventListener("message", h as EventListener);
  });
}

describe("UserConnection message lifecycle WS", () => {
  it("edit: sender edits own message -> payload-bearing ack with edited projection", async () => {
    const userId = "u-ws-e1";
    const cid = "01a40010-0000-7000-8000-000000000001";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], cid);
    await sysStub.fetch(new Request("https://x/internal/create-channel", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: cid, creator_user_id: userId, title: "WS", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }) }));
    const send = await (await sysStub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ command_id: "cmd-send-ws-e1", dedupe_principal_key: `user:${userId}`, type: "text", text: "orig", reply_to: null, mentions: [], channel_id: cid }) }))).json() as { message: { message_id: string } };
    const { ws } = await upgrade(userId);
    ws.send(JSON.stringify({ frame_type: "command", command: "message.edit", command_id: "cmd-edit-ws-e1", channel_id: cid, payload: { message_id: send.message.message_id, text: "edited" } }));
    const ackRaw = await nextAck(ws);
    const ack = JSON.parse(ackRaw);
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.command).toBe("message.edit");
    expect(ack.command_id).toBe("cmd-edit-ws-e1");
    expect(ack.payload.message.status).toBe("edited");
    ws.close();
  });

  it("recall: sender recalls -> ack status recalled, text null", async () => {
    const userId = "u-ws-r1";
    const cid = "01a40020-0000-7000-8000-000000000001";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], cid);
    await sysStub.fetch(new Request("https://x/internal/create-channel", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: cid, creator_user_id: userId, title: "WS", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }) }));
    const send = await (await sysStub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ command_id: "cmd-send-ws-r1", dedupe_principal_key: `user:${userId}`, type: "text", text: "secret", reply_to: null, mentions: [], channel_id: cid }) }))).json() as { message: { message_id: string } };
    const { ws } = await upgrade(userId);
    ws.send(JSON.stringify({ frame_type: "command", command: "message.recall", command_id: "cmd-recall-ws-r1", channel_id: cid, payload: { message_id: send.message.message_id } }));
    const ack = JSON.parse(await nextAck(ws));
    expect(ack.command).toBe("message.recall");
    expect(ack.payload.message.status).toBe("recalled");
    expect(ack.payload.message.text).toBeNull();
    ws.close();
  });

  it("delete: owner deletes own message -> ack status deleted", async () => {
    const userId = "u-ws-d1";
    const cid = "01a40030-0000-7000-8000-000000000001";
    const sysStub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], cid);
    await sysStub.fetch(new Request("https://x/internal/create-channel", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: cid, creator_user_id: userId, title: "WS", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }) }));
    const send = await (await sysStub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ command_id: "cmd-send-ws-d1", dedupe_principal_key: `user:${userId}`, type: "text", text: "bye", reply_to: null, mentions: [], channel_id: cid }) }))).json() as { message: { message_id: string } };
    const { ws } = await upgrade(userId);
    ws.send(JSON.stringify({ frame_type: "command", command: "message.delete", command_id: "cmd-delete-ws-d1", channel_id: cid, payload: { message_id: send.message.message_id, reason: "spam" } }));
    const ack = JSON.parse(await nextAck(ws));
    expect(ack.command).toBe("message.delete");
    expect(ack.payload.message.status).toBe("deleted");
    ws.close();
  });
});
```

- [ ] **Step 2:** Run the test. Expected: FAIL (commands not routed).

- [ ] **Step 3:** Extend `webSocketMessage` in `src/do/user-connection.ts`. After the `channel.mark_read` block and before the `if (frame.command !== "message.send")` fallback, add routing for the three lifecycle commands. They share a dispatch shape:
```typescript
if (frame.command === "message.edit" || frame.command === "message.recall" || frame.command === "message.delete") {
  const channelId = frame.channel_id ?? "";
  if (!channelId) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "missing channel_id")); return; }
  let parsed: { ok: true; command: { message_id: string; text?: string; reason?: string | null } } | { ok: false; error: { code: string; message: string; retryable: boolean } };
  if (frame.command === "message.edit") parsed = parseMessageEditCommand(frame);
  else if (frame.command === "message.recall") parsed = parseMessageRecallCommand(frame);
  else parsed = parseMessageDeleteCommand(frame);
  if (!parsed.ok) { sendCommandError(ws, frame.command_id, parsed.error); return; }
  const routeName = await channelRouteNameFor(this.env, attachment.user_id, channelId);
  if (routeName === null) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found")); return; }
  const subscribed = await this.ensureSubscribed(attachment, ws, channelId);
  if (!subscribed) { sendCommandError(ws, frame.command_id, responseError("CHANNEL_NOT_FOUND", "channel not found or not a member")); return; }
  try {
    const stub = this.env.CHAT_CHANNEL.getByName(routeName);
    const endpoint = frame.command === "message.edit" ? "/internal/message-edit" : frame.command === "message.recall" ? "/internal/message-recall" : "/internal/message-delete";
    const body: Record<string, unknown> = { operation_id: frame.command_id, message_id: parsed.command.message_id, channel_id: channelId };
    if (frame.command === "message.edit") body.text = parsed.command.text;
    if (frame.command === "message.delete") body.reason = parsed.command.reason ?? null;
    const res = await stub.fetch(new Request(`https://x${endpoint}`, { method: "POST", headers: { "X-Verified-User-Id": attachment.user_id, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    if (!res.ok) { const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } }; sendCommandError(ws, frame.command_id, responseError(e.error?.code ?? "CHAT_WORKER_UNAVAILABLE", e.error?.message ?? "mutation failed")); return; }
    const out = await res.json() as { channel_id: string; event_id: string; message: Record<string, unknown> };
    ws.send(JSON.stringify({ frame_type: "command_ack", command: frame.command, command_id: frame.command_id, status: "committed", payload: { channel_id: out.channel_id, event_id: out.event_id, message: out.message } }));
  } catch (err) {
    sendCommandError(ws, frame.command_id, responseError("CHAT_WORKER_UNAVAILABLE", err instanceof Error ? err.message : "mutation failed"));
  }
  return;
}
```
> `responseError` + `sendCommandError` already exist in `user-connection.ts`. Add the imports for the three parsers.

- [ ] **Step 4:** Run the test (PASS) + `npm run typecheck` + full suite (no regression in send/mark_read).

- [ ] **Step 5:** Commit:
```bash
git add src/do/user-connection.ts test/do/user-connection-message-lifecycle.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(ws): route message.edit/recall/delete commands (v4.0 lifecycle e2e)"
```

---

## Section B — Owner transfer

### Task B1: ChatChannel `/internal/owner-transfer` + tests

**Files:**
- Modify: `src/do/chat-channel.ts`
- Test: `test/routes/channel-owner-transfer.test.ts` (create, covers DO + route together to keep it one test cycle)

**Interfaces:**
- Consumes: `activeRole`, `assertNotDissolved`, `persistEventAndFanout`, `resolveActorMap`, `cachedResponse`, the Phase 3 idempotency pattern.
- Produces: `/internal/owner-transfer` handler. One txn: caller must be active owner; target must be active member (role member/admin, not owner); channel active; `previous_owner_role` ∈ {admin, member}; atomically set `members.role` of old owner → `previous_owner_role`, target → `owner`, update `channel_meta.created_by` = target; bump `membership_version` ×2 (one per role change); emit `member.role_updated` ×2 + `system.notice` (notice_kind=`member.role_updated`); cache full ack `{channel_id, previous_owner:{user_id,role}, new_owner:{user_id,role}}` in `idempotency_keys(operation='channel.owner_transfer')`.

- [ ] **Step 1: Write failing test** (`test/routes/channel-owner-transfer.test.ts`). HTTP-level (authed) — creates a channel, adds a target member, transfers.
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../helpers";

const SELF = (await import("../../src/index")).default as { fetch: (r: Request, env?: unknown, ctx?: unknown) => Promise<Response> | Response };

async fn authedReq(userId: string, method: string, path: string, body?: unknown, idemKey?: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await makeJwt({ sub: userId }, TEST_SECRET)}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  return SELF.fetch(new Request(`https://chat.kuma.homes${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

describe("POST /api/chat/channels/:id/owner-transfer", () => {
  it("owner transfers to an active member; previous owner becomes admin", async () => {
    const create = await authedReq("u-ot-1", "POST", "/api/chat/channels", { title: "OT", visibility: "private", initial_members: [] }, "ck-create-ot1");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    await authedReq("u-ot-1", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-ot-2", role: "member" }, "ck-add-ot1");
    const res = await authedReq("u-ot-1", "POST", `/api/chat/channels/${cid}/owner-transfer`, { target_user_id: "u-ot-2", previous_owner_role: "admin" }, "ck-transfer-ot1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { previous_owner: { user_id: string; role: string }; new_owner: { user_id: string; role: string } };
    expect(body.previous_owner).toEqual({ user_id: "u-ot-1", role: "admin" });
    expect(body.new_owner).toEqual({ user_id: "u-ot-2", role: "owner" });
  });

  it("non-owner cannot transfer (403)", async () => {
    const create = await authedReq("u-ot-3", "POST", "/api/chat/channels", { title: "OT2", visibility: "private", initial_members: [] }, "ck-create-ot2");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    await authedReq("u-ot-3", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-ot-4", role: "member" }, "ck-add-ot2");
    const res = await authedReq("u-ot-4", "POST", `/api/chat/channels/${cid}/owner-transfer`, { target_user_id: "u-ot-3", previous_owner_role: "admin" }, "ck-transfer-ot2");
    expect(res.status).toBe(403);
  });

  it("idempotent retry returns the same result", async () => {
    const create = await authedReq("u-ot-5", "POST", "/api/chat/channels", { title: "OT3", visibility: "private", initial_members: [] }, "ck-create-ot3");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    await authedReq("u-ot-5", "POST", `/api/chat/channels/${cid}/members`, { user_id: "u-ot-6", role: "member" }, "ck-add-ot3");
    const b = { target_user_id: "u-ot-6", previous_owner_role: "admin" };
    const r1 = await authedReq("u-ot-5", "POST", `/api/chat/channels/${cid}/owner-transfer`, b, "ck-transfer-ot3");
    const r2 = await authedReq("u-ot-5", "POST", `/api/chat/channels/${cid}/owner-transfer`, b, "ck-transfer-ot3");
    expect(r1.status).toBe(200); expect(r2.status).toBe(200);
    expect(((await r1.json()) as { new_owner: { user_id: string } }).new_owner.user_id).toBe(((await r2.json()) as { new_owner: { user_id: string } }).new_owner.user_id);
  });
});
```
> Fix typo: `async fn` → `async function`.

- [ ] **Step 2:** Run test, observe FAIL (route 404).

- [ ] **Step 3:** Implement `/internal/owner-transfer` in `src/do/chat-channel.ts` (before the final 404). Pattern: idempotency pre-check (operation=`channel.owner_transfer`); txn: load meta (dissolve-gate, channel-gone→404); caller must be active owner (`activeRole==='owner'` AND `meta.created_by===userId`); target must be active member with role ∈ {member,admin} (not owner — target is not `meta.created_by`); `previous_owner_role` ∈ {admin,member}; UPDATE old owner role → previous_owner_role; UPDATE target role → owner; UPDATE channel_meta.created_by = target + membership_version bump ×2; build `member.role_updated` ×2 (actor=user=caller, target_user=old/new owner) + `system.notice`; cache ack `{channel_id, previous_owner:{user_id,role}, new_owner:{user_id,role}}` in response_json. Use the existing `persistEventAndFanout` + `resolveActorMap`. Return the ack payload.

- [ ] **Step 4:** Add `ownerTransferHandler` to `src/routes/channel-mutations.ts` + register `app.post("/api/chat/channels/:channel_id/owner-transfer", (c) => ownerTransferHandler(c))` in `src/index.ts`. The handler: auth → route via `channelRouteNameFor` → forward to `/internal/owner-transfer` with `{operation_id: Idempotency-Key, target_user_id, previous_owner_role}` → map errors → return `{channel_id, previous_owner, new_owner}`.

- [ ] **Step 5:** Run the test (PASS) + typecheck + full suite.

- [ ] **Step 6:** Commit:
```bash
git add src/do/chat-channel.ts src/routes/channel-mutations.ts src/index.ts test/routes/channel-owner-transfer.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat: POST /channels/{id}/owner-transfer (atomic single-owner swap)"
```

---

## Section C — Invites (create / accept / preview)

### Task C1: InviteDirectory `/upsert` passthrough + `/preview` + tests

**Files:**
- Modify: `src/do/invite-directory.ts`
- Test: `test/do/invite-directory.test.ts` (create)

**Interfaces:**
- Consumes: nothing external. `execSchema` from `./sql`.
- Produces:
  - `/upsert` fixed to accept `expires_at` / `revoked_at` / `status` / `channel_id` / `invite_code` (no more hardcoded `2999`).
  - `/preview?code=` returns `{invite_code, channel_id, status, expires_at, revoked_at}` (or 404).

- [ ] **Step 1: Write failing test** (`test/do/invite-directory.test.ts`):
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

describe("InviteDirectory", () => {
  it("/upsert stores real expires_at + status; /preview returns the row", async () => {
    const stub = getNamedDo(env.INVITE_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], "shared");
    await stub.fetch(new Request("https://x/upsert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invite_code: "code-1", channel_id: "ch-1", status: "active", expires_at: "2026-06-30T00:00:00Z", revoked_at: null }) }));
    const res = await stub.fetch(new Request("https://x/preview?code=code-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invite_code: string; channel_id: string; status: string; expires_at: string };
    expect(body.invite_code).toBe("code-1");
    expect(body.channel_id).toBe("ch-1");
    expect(body.status).toBe("active");
    expect(body.expires_at).toBe("2026-06-30T00:00:00Z");
  });
  it("/preview 404 for unknown code", async () => {
    const stub = getNamedDo(env.INVITE_DIRECTORY as unknown as Parameters<typeof getNamedDo>[0], "shared");
    const res = await stub.fetch(new Request("https://x/preview?code=nope"));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2:** Run test, observe FAIL (shell hardcodes `2999` + no `/preview`).

- [ ] **Step 3:** Rewrite `src/do/invite-directory.ts`: extend the SCHEMA `invite_index` to include `expires_at`, `revoked_at`, `status`, `updated_at` (it already has them); fix `/upsert` to read them from the body; add `/preview`. Keep `/get` (used by accept lookup). The DO is keyed globally (not by invite_code — it's `INVITE_DIRECTORY` sharded; the shipped `/upsert`/`/get` use a global name `invites` is NOT sharded by code — actually `getByName("shared")` or similar). Confirm the DO is accessed by a fixed name in the route; the shell's existing `/get`-by-code works because the DO stores ALL invites in one instance. Keep that.

- [ ] **Step 4:** Run test (PASS) + typecheck.

- [ ] **Step 5:** Commit:
```bash
git add src/do/invite-directory.ts test/do/invite-directory.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(do): InviteDirectory /upsert passthrough + /preview"
```

---

### Task C2: ChatChannel `/internal/invites-create` + `POST /channels/{id}/invites` route + tests

**Files:**
- Modify: `src/do/chat-channel.ts`
- Modify: `src/routes/channel-mutations.ts` + `src/index.ts`
- Test: `test/routes/invites.test.ts` (create, covers create in this task)

**Interfaces:**
- Consumes: `InviteDirectory /upsert` (Task C1); the `projection_outbox(target_kind=invite_directory)` target already in the alarm flush (confirm — it's in the v4.0 allowed target kinds).
- Produces: `/internal/invites-create` — owner/admin creates an invite: mint `invite_code` (random opaque, e.g. 12-char base32), INSERT `invites` row (`created_by`, `expires_at` = now+TTL, `max_uses` nullable, `used_count=0`), write `projection_outbox(target_kind=invite_directory, target_key=invite_code)` row in the same txn, cache ack. Returns `{invite_code, expires_at, invite_url}`.

- [ ] **Step 1: Write failing test** (`test/routes/invites.test.ts`, create case):
```typescript
// (helpers: SELF, authedReq as in Task B1)
describe("POST /api/chat/channels/:id/invites", () => {
  it("owner creates an invite -> 200 {invite_code, expires_at}", async () => {
    const create = await authedReq("u-iv-1", "POST", "/api/chat/channels", { title: "IV", visibility: "private", initial_members: [] }, "ck-create-iv1");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const res = await authedReq("u-iv-1", "POST", `/api/chat/channels/${cid}/invites`, { max_uses: null }, "ck-invite-iv1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invite_code: string; expires_at: string };
    expect(body.invite_code).toBeTruthy();
    expect(body.expires_at).toBeTruthy();
  });
});
```

- [ ] **Step 2:** Run, observe FAIL.

- [ ] **Step 3:** Implement `/internal/invites-create` in ChatChannel (owner/admin gate, dissolve-gate, idempotency operation=`channel.invite_create`, mint code, INSERT invites, outbox invite_directory, cache ack). Add `createInviteHandler` route → register.

- [ ] **Step 4:** Run test (PASS) + typecheck.

- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts src/routes/channel-mutations.ts src/index.ts test/routes/invites.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat: POST /channels/{id}/invites (create invite)"
```

---

### Task C3: `GET /invites/{code}` preview + tests

**Files:**
- Modify: `src/routes/channel-mutations.ts` + `src/index.ts`
- Modify: `src/do/chat-channel.ts` (`/internal/invites-get` — returns channel summary + inviter + sample_members for preview)
- Test: `test/routes/invites.test.ts` (append preview cases)

- [ ] **Step 1: Write failing test** (append):
```typescript
describe("GET /api/chat/invites/:code", () => {
  it("preview returns channel + inviter + my_membership, no join side effect", async () => {
    const create = await authedReq("u-iv-2", "POST", "/api/chat/channels", { title: "Preview", visibility: "private", initial_members: [] }, "ck-create-iv2");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const inv = await authedReq("u-iv-2", "POST", `/api/chat/channels/${cid}/invites`, { max_uses: null }, "ck-invite-iv2");
    const { invite_code } = (await inv.json()) as { invite_code: string };
    // flush the invite_directory outbox so the index is populated before preview
    // (the route's GET goes via InviteDirectory /preview + ChatChannel /internal/invites-get for channel detail)
    const res = await authedReq("u-iv-3", "GET", `/api/chat/invites/${invite_code}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invite: { invite_code: string }; channel: { channel_id: string }; inviter: { user_id: string }; my_membership: { status: string } };
    expect(body.invite.invite_code).toBe(invite_code);
    expect(body.channel.channel_id).toBe(cid);
    expect(body.inviter.user_id).toBe("u-iv-2");
    expect(body.my_membership.status).toBe("not_joined");
  });
  it("404 for unknown invite", async () => {
    const res = await authedReq("u-iv-4", "GET", `/api/chat/invites/nonexistent-code`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2:** Run, observe FAIL.

- [ ] **Step 3:** Implement `previewInviteHandler`: route → InviteDirectory `/preview?code=` (get channel_id + status; 404 INVITE_NOT_FOUND if missing/expired/revoked) → if `ROUTE_INDEX_PENDING` (index lag, i.e. the invite was just created and the outbox hasn't flushed) return 409 ROUTE_INDEX_PENDING → ChatChannel `/internal/invites-get?invite_code=&created_by=` (returns channel summary + inviter UserSummary + sample_members + my_membership). Add `/internal/invites-get` to ChatChannel. Register `app.get("/api/chat/invites/:invite_code", ...)`.

> For the index-lag 409: InviteDirectory `/preview` returns 404 when the row isn't there yet. Distinguish "truly not found" from "index lag" — the route can re-flush the ChatChannel alarm then retry, OR return 409 ROUTE_INDEX_PENDING. Simplest: if `/preview` 404s, the route fetches the creating ChatChannel? Can't (no channel_id). So: the create route should flush the invite_directory outbox before returning (run the ChatChannel alarm once). Then preview is reliable. Do that in Task C2 Step 3 (flush after commit) so Task C3 doesn't need the 409 path for the happy case; keep 409 for genuine lag under load.

- [ ] **Step 4:** Run test (PASS — may need the test to flush the alarm; if flaky, add a `runDurableObjectAlarm` flush in the test after create). + typecheck.

- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts src/routes/channel-mutations.ts src/index.ts test/routes/invites.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat: GET /invites/{code} invite preview (read-only)"
```

---

### Task C4: `POST /invites/{code}/accept` + tests

**Files:**
- Modify: `src/do/chat-channel.ts` (`/internal/invites-accept`)
- Modify: `src/routes/channel-mutations.ts` + `src/index.ts`
- Test: `test/routes/invites.test.ts` (append accept cases)

- [ ] **Step 1: Write failing test** (append):
```typescript
describe("POST /api/chat/invites/:code/accept", () => {
  it("accept joins the channel; my_membership becomes active", async () => {
    const create = await authedReq("u-iv-5", "POST", "/api/chat/channels", { title: "Accept", visibility: "private", initial_members: [] }, "ck-create-iv3");
    const cid = ((await create.json()) as { channel: { channel_id: string } }).channel.channel_id;
    const inv = await authedReq("u-iv-5", "POST", `/api/chat/channels/${cid}/invites`, { max_uses: null }, "ck-invite-iv3");
    const { invite_code } = (await inv.json()) as { invite_code: string };
    const res = await authedReq("u-iv-6", "POST", `/api/chat/invites/${invite_code}/accept`, {}, "ck-accept-iv3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel_id: string; membership: { status: string } };
    expect(body.channel_id).toBe(cid);
    expect(body.membership.status).toBe("active");
  });
  it("404 for unknown invite", async () => {
    const res = await authedReq("u-iv-7", "POST", `/api/chat/invites/nope/accept`, {}, "ck-accept-iv4");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2:** Run, observe FAIL.

- [ ] **Step 3:** Implement `acceptInviteHandler`: route → InviteDirectory `/preview?code=` (resolve channel_id; 404 INVITE_NOT_FOUND; 409 ROUTE_INDEX_PENDING if lag) → ChatChannel `/internal/invites-accept` (idempotency operation=`channel.invite_accept`; txn: validate invite (`expires_at` not past, `revoked_at` null, `used_count < max_uses` if set) — reuses the Phase 3 join path: INSERT/reactivate `members`, bump `membership_version`/`member_count`, `member.joined` event + `system.notice`, WRITE `projection_outbox(target_kind=user_directory)` join, UPDATE `invites.used_count += 1`; cache ack `{channel_id, membership:{status:active, role, joined_at}}`). Register route.

- [ ] **Step 4:** Run test (PASS) + typecheck + full suite.

- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts src/routes/channel-mutations.ts src/index.ts test/routes/invites.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat: POST /invites/{code}/accept (join via invite)"
```

---

### Task C5: Full-suite green + Section A/B/C self-review

- [ ] **Step 1:** `npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Expected: clean + green (prior count + new tests).
- [ ] **Step 2:** Spec coverage: message.edit/recall/delete (A2/A3) ✅; owner-transfer (B1) ✅; invite create (C2) / preview (C3) / accept (C4) ✅; InviteDirectory passthrough (C1) ✅. Out-of-scope (Phase 5 + E stickers): confirmed not built.
- [ ] **Step 3:** Placeholder scan + type-consistency review. Report.

---

## Notes for the executor

- **Task dependency order:** A0 → A1 → A2 → A3 → B1 → C1 → C2 → C3 → C4 → C5 (C1 before C2; C2 before C3/C4). Section B is independent of A. A subagent per task; each ends in a green commit.
- **The `applyMessageMutation` helper (A2) is the keystone** — edit/recall/delete share it. Get its idempotency-in-txn + full-ack + fanout pattern right once.
- **Invite index lag:** Task C2's create route should flush the ChatChannel alarm (invite_directory outbox) before returning so preview (C3) is reliable; keep `ROUTE_INDEX_PENDING` 409 as the load-path fallback.
- **`MESSAGE_NOT_EDITABLE`** (409) — add to `src/errors.ts` (A2 Step 3).
- **Do NOT push or deploy.** Git identity `kuma`.
