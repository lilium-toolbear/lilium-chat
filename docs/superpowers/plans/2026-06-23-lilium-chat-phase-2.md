# Lilium Chat Phase 2 (WebSocket command/event) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the real-time WebSocket path — `message.send` command → `committed_ack` → `message.created` event broadcast (including sender) — over a hibernating `UserConnection` DO, with implicit per-channel subscription, `ChannelFanout` DO fanout, per-channel event replay on connect, and `GET /api/chat/events` HTTP replay.

**Architecture:** Worker only does JWT + Origin validation and upgrade-proxies to `UserConnection` DO (by `user_id`). The `UserConnection` DO owns the hibernating socket: on connect it reads `UserDirectory.my_channels` and registers online with each channel's `ChannelFanout` DO, then replays per-channel events using the `cursors` param. `webSocketMessage` parses command frames and routes `message.send` to the `ChatChannel` DO, which in one transaction writes the message + `message.created` event (monotonic `event_id`) + a `channel_fanout` outbox row, and returns `{ message_id, event_id }` for a `committed_ack`. The `ChatChannel` alarm flushes the outbox to `ChannelFanout`, which fans the event out to each online session's `UserConnection.deliver`, which sends the event frame and advances the per-channel cursor. `member.left` writes a `channel_fanout` outbox row that causes `ChannelFanout` to drop the user's sessions and pending queue rows.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), DO WebSocket Hibernation (`ctx.acceptWebSocket` + `webSocketMessage`/`webSocketClose`/`webSocketError` + `serializeAttachment`/`deserializeAttachment`), Hono, vitest-pool-workers, jose.

## Global Constraints

(All Phase 0/1 constraints carry forward. This section lists the ones most load-bearing for Phase 2.)

- **No cross-DO transactions exist.** Source DO writes business + `projection_outbox` row co-atomically; alarm flushes to target DO; target writes are idempotent; exhausted retries → `dead_letter`. Do NOT invent 2PC.
- **Single alarm per DO, earliest-wins.** Use the existing `scheduleOutboxAlarm(nowIso)` / `bumpOutboxRetry` pattern on `ChatChannel`. Add an analogous scheduler to `ChannelFanout` for its `fanout_queue`. Never call `setAlarm` blindly last-write-wins.
- **Per-channel monotonic UUIDv7 `event_id`.** Use the existing `ChatChannel.nextEventId(nowMs)` / `monotonicUuidV7`. Client dedups per-channel by string lexicographic order. No global cursor.
- **WebSocket command idempotency = `idempotency_keys` keyed by `client_message_id` (namespaced by user).** `message.send` only requires `client_message_id`; the server writes an `idempotency_keys` row `(principal_kind='user', principal_id=userId, operation='message.send', idempotency_key=client_message_id)` with a `request_hash` of the mutable body, co-atomic with the message insert. Same key+body → cached response; same key+different body → `409 IDEMPOTENCY_CONFLICT`. The `messages UNIQUE(channel_id, dedupe_principal_key, client_message_id)` is the secondary guard. Do NOT add a separate mandatory `idempotency_key` field to the command.
- **Phase 2 is text-only.** `message.send` accepts ONLY `type:"text"`, `reply_to_message_id===null`, `attachment_ids.length===0`. image (Phase 5) and reply (Phase 4) are rejected with `INVALID_MESSAGE` so no incomplete rows are persisted.
- **Worker never holds WS state.** No in-Worker connection set, no ack, no fanout. WS lives in the `UserConnection` DO. Worker only validates + proxies.
- **Persisted event payloads store actor references; the WIRE projection resolves UserSummary.** `events.payload_json` stores `sender_user_id` / `actor_kind`+`actor_id` (a ref). The live broadcast frame (in the `channel_fanout` outbox) and the replay output both run `resolveSenderForLiveBroadcast` → `resolveUserSummaries` so the client receives `sender.user.{display_name, avatar_url}`, never a bare user_id. Bot actor resolution is deferred to Phase 7 (passthrough ref). Hyperdrive IS on the broadcast + replay paths — this is spec-required (design §3.5), not deferred.
- **Sender self-receive must not depend on connect-time registration timing.** `UserConnection.webSocketMessage` calls `ensureSubscribed(channel_id)` synchronously before routing `message.send`, so a client that sends immediately on `open` still gets its own `message.created`. The `waitUntil(registerOnlineOnConnect)` is a best-effort bulk register + replay, not a correctness dependency.
- **Deliver gate is two-layer (design §3.3).** `member.left` writes a `channel_fanout` `unregister-user` outbox row (flush drops the session), AND `UserConnection /deliver` compares `event.membership_version_at_event` to the subscription snapshot — if the event version exceeds the subscription version, it re-checks active membership in ChatChannel and drops the event if the user is no longer a member. This catches the race where leave committed but the unregister outbox hasn't flushed.
- **Outbox helpers that run inside a transaction MUST be synchronous.** `insertOutboxRowForFanout` is `void` (not `async`); a `sql.exec` failure throws and rolls back the message + event writes. Never write a fanout/message_index outbox row with an un-awaited `async` helper inside `ctx.storage.transaction` — that swallows insert failures and drops real-time events.
- **Git identity is `kuma`.** `git -c user.name=kuma -c user.email=kuma@kuma.homes commit ...` if not already configured globally. **Do NOT push or deploy.** Implementation only; operator deploys.
- **Test config:** `vitest run` (alias `npm run test:once`). Typecheck: `npm run typecheck` (`tsc --noEmit`). Tests use `env` from `cloudflare:workers`, `runInDurableObject` from `cloudflare:test`, and `getNamedDo`/`makeJwt`/`TEST_SECRET` from `test/helpers.ts`. The prod `getByName` mapping does not exist in tests — tests use `idFromName` via `getNamedDo`.
- **Existing endpoints are stable.** `ChatChannel` keeps all `/internal/*`, `/spike-*`, `/outbox-*` routes and its `alarm()`. Phase 2 ADDS `/internal/message-send` + `/internal/replay` + a `channel_fanout` outbox target kind + rewrites `/internal/test-leave` to use the shared `markMemberLeftAndEnqueueFanoutUnregister` (co-atomic leave + unregister outbox). It does NOT otherwise rewrite existing handlers.
- **No rate limiting or observability in Phase 2.** Design §6.7/§6.8 are out of scope. Phase 2 is NOT production-ready; do not open to real clients without rate limiting. The `rate_buckets` table is unused.

---

## File Structure

**Create:**
- `src/chat/command.ts` — pure helpers: `parseMessageSendCommand(frame, senderUserId)` → validated `{ client_message_id, type:"text", text, reply_to:null, attachment_ids:[], mentions } | ValidationError`. **Phase 2 rejects `type!=text`, `reply_to_message_id`, non-empty `attachment_ids`.** Builds `dedupe_principal_key` (`user:<uid>`). No DO access. Unit-tested in isolation.
- `src/chat/event-broadcast.ts` — `buildEventFrame` (contract §10.4 envelope), `buildMessageCreatedPayload` (PERSISTED payload, sender as ref), and `resolveSenderForLiveBroadcast(payload, resolveUserSummaries)` (WIRE projection: replaces sender ref with resolved `{kind:'user', user: UserSummary}`, fallback `user-<shortid>`). Unit-tested with an injected resolver (no Hyperdrive in the unit test).
- `test/chat/command.test.ts` — unit tests for `parseMessageSendCommand`.
- `test/chat/event-broadcast.test.ts` — unit tests for `buildEventFrame` / `buildMessageCreatedPayload`.
- `src/do/fanout-scheduler.ts` — extracted reusable scheduler helpers for the `ChannelFanout` `fanout_queue` (mirrors `ChatChannel`'s outbox scheduler): `scheduleFanoutAlarm(ctx, nowIso)`, `bumpFanoutRetry(ctx, row, nowIso, error)`. Pure functions taking `ctx` + SQL.
- `test/do/channel-fanout.test.ts` — `ChannelFanout` register/unregister/deliver/drop-on-leave.
- `test/do/user-connection.test.ts` — `UserConnection` hibernation handlers (command routing, deliver, replay, close).
- `test/routes/events.test.ts` — `GET /api/chat/events` replay route.
- `test/integration/message-send.test.ts` — end-to-end: WS upgrade → `message.send` → `committed_ack` → `message.created` event to self.

**Modify:**
- `src/do/chat-channel.ts` — add `/internal/message-send` (transaction: membership check + `idempotency_keys` conflict/cached-response + insert message + insert `message.created` event [persisted ref payload] + insert `channel_fanout` outbox row [sender-resolved live frame] + insert `message_index` outbox row; return `{ message_id, event_id }`) and `/internal/replay` (status-filtered, sender-resolved at read time). Add synchronous `insertOutboxRowForFanout` helper. Add shared `markMemberLeftAndEnqueueFanoutUnregister` (co-atomic `UPDATE members` + membership_version bump + `channel_fanout` unregister outbox). Extend `alarm()` to flush `channel_fanout` (action-dispatched: `fanout` vs `unregister-user`) and `message_index` rows. Rewrite `/internal/test-leave` to call the shared method.
- `src/do/channel-fanout.ts` — implement `/register-online`, `/unregister-online`, `/fanout-enqueue` (write `fanout_events` + expand `fanout_queue` per online session, idempotent on `event_id`), `/unregister-user` (member.left: drop sessions + fail pending queue), `alarm()` (flush `fanout_queue` to `UserConnection /deliver` passing `membership_version_at_event`), and a `/dump` test helper. Add `target_user_id` column to `fanout_queue` (needed to route deliver by user_id).
- `src/do/user-connection.ts` — fill `webSocketMessage` (parse + `ensureSubscribed(channel_id)` synchronously, THEN route `message.send` to ChatChannel, send `committed_ack`/`command_error`), `webSocketClose`/`webSocketError` (unregister all this session's channels from ChannelFanout), and add a `/deliver` HTTP endpoint (membership_version gate → send event frame + advance cursor in attachment). Attachment stores `subscribed_channels: Record<channel_id, membership_version>`. `registerOnlineOnConnect` runs in `waitUntil` (bulk register + replay).
- `src/routes/events.ts` — NEW route handler for `GET /api/chat/events` (single-channel `channel_id`+`after_event_id`, and multi-channel `cursors`). Registered in `src/index.ts`.
- `src/index.ts` — register `app.get("/api/chat/events", eventsHandler)`.
- `test/types/miniflare-spikes.d.ts` — (no change expected; only if a new cloudflare:test helper is needed — none anticipated).

**Do NOT touch:** `src/routes/ws.ts` (upgrade proxy already correct), `src/auth/jwt.ts`, `src/ids/uuidv7.ts`, `src/do/user-directory.ts` (its `/my-channels` already returns what Phase 2 needs), `src/do/message-index.ts` (upsert already idempotent), `src/routes/bootstrap.ts` / `channels.ts` / `messages.ts`, wrangler configs (all DO bindings present).

---

## Task 0: Verify Phase 1 baseline is green before starting

**Files:**
- Test: (none — runs existing suite)

**Interfaces:**
- Consumes: Phase 0/1 code as-is.
- Produces: a green baseline commit baseline (`git rev-parse HEAD`) recorded mentally; every later task must keep `npm run typecheck` + `vitest run` green.

- [ ] **Step 1: Run typecheck + full test suite, confirm green**

Run:
```bash
npm run typecheck && npm run test:once
```
Expected: `tsc --noEmit` exits 0; vitest reports all tests passing (74 tests as of Phase 1 close). If anything is red, STOP and report — Phase 2 must build on green.

- [ ] **Step 2: Record the baseline HEAD (no commit — informational only)**

Run:
```bash
git rev-parse --short HEAD
```
Expected: a short SHA (was `a7d4cb0` at Phase 1 close). Note it; subsequent task commits build on top.

---

## Task 1: Command parsing + event frame builders (pure units)

**Files:**
- Create: `src/chat/command.ts`
- Create: `src/chat/event-broadcast.ts`
- Test: `test/chat/command.test.ts`
- Test: `test/chat/event-broadcast.test.ts`

**Interfaces:**
- Consumes: `CommandFrame` from `src/ws/frames.ts`; `EventFrame` from `src/ws/frames.ts`; `resolveUserSummaries` from `src/profile/resolve.ts` (only used by the live-broadcast resolver, injected for testability).
- Produces:
  - `parseMessageSendCommand(frame: CommandFrame, senderUserId: string): { ok: true; command: ParsedMessageSend } | { ok: false; error: { code: string; message: string; retryable: boolean } }` where `ParsedMessageSend = { client_message_id: string; type: "text"; text: string; reply_to: string | null; attachment_ids: string[]; mentions: Array<{ user_id: string; start: number; end: number }> }`. **Phase 2 accepts ONLY `type:"text"` with `reply_to===null` and `attachment_ids.length===0`**; image (Phase 5) and reply (Phase 4) are rejected with `INVALID_MESSAGE` so we never persist incomplete rows.
  - `dedupePrincipalKeyForUser(userId: string): string` → `"user:" + userId`.
  - `buildEventFrame(args: { event_id: string; type: string; channel_id: string; occurred_at: string; payload: Record<string, unknown> }): EventFrame`.
  - `buildMessageCreatedPayload(raw: ...): Record<string, unknown>` → the **persisted** `message.created` payload. Sender is a REFERENCE `{ kind, user_id, bot_id }` — NOT a UserSummary (design §3.5: `events.payload_json` stores actor refs). This is what gets written to `events.payload_json` and what `/internal/replay` reads back.
  - `resolveSenderForLiveBroadcast(payload, resolveUserSummaries): Promise<Record<string, unknown>>` → takes the persisted payload and returns a NEW payload where `sender` is replaced by `{ kind:'user', user: UserSummary }` (or `{ kind:'bot', bot_id }` passthrough until Phase 7). This is the **live wire** projection. Falls back to `user-<shortid>` display_name when pg has no row. `resolveUserSummaries` is injected so the module is unit-testable without Hyperdrive.

  > **Rationale (record in a comment in `event-broadcast.ts`):** Design spec §3.5 distinguishes the *persisted* payload (actor refs only, no UserSummary — keeps profile out of the event log) from the *live broadcast* projection (UserSummary resolved at output time by UserConnection/Worker). Phase 2 honors both: `events.payload_json` stores `buildMessageCreatedPayload` (ref); the `channel_fanout` outbox carries a frame built from `resolveSenderForLiveBroadcast(...)` so the wire event the client receives already has `sender.user.display_name`/`avatar_url`. Replay (`/internal/replay` + `GET /events`) re-resolves the sender at read time (see Task 4/6) so historical events also show display names, not bare ids. This puts Hyperdrive on the broadcast + replay paths, which the spec explicitly requires; it is NOT deferred.

- [ ] **Step 1: Write failing test for `parseMessageSendCommand` valid input**

`test/chat/command.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { parseMessageSendCommand, dedupePrincipalKeyForUser } from "../../src/chat/command";

describe("parseMessageSendCommand", () => {
  it("parses a valid text message.send", () => {
    const r = parseMessageSendCommand(
      {
        frame_type: "command",
        command: "message.send",
        command_id: "cmd-1",
        channel_id: "ch-1",
        payload: {
          client_message_id: "cm-1",
          type: "text",
          text: "hello",
          reply_to_message_id: null,
          attachment_ids: [],
          mentions: [],
        },
      },
      "u-1",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.client_message_id).toBe("cm-1");
      expect(r.command.type).toBe("text");
      expect(r.command.text).toBe("hello");
      expect(r.command.reply_to).toBe(null);
      expect(r.command.attachment_ids).toEqual([]);
      expect(r.command.mentions).toEqual([]);
    }
  });

  it("rejects wrong command name", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "channel.update", command_id: "cmd-1", channel_id: "ch-1", payload: {} },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_COMMAND");
  });

  it("rejects missing client_message_id", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { type: "text", text: "hi" } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects empty text for type=text", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { client_message_id: "cm-1", type: "text", text: "  " } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects missing channel_id", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", payload: { client_message_id: "cm-1", type: "text", text: "hi" } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CHANNEL_NOT_FOUND");
  });

  it("rejects image type (Phase 2 is text-only; images are Phase 5)", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { client_message_id: "cm-1", type: "image", text: "", attachment_ids: ["a-1"] } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects reply_to_message_id (Phase 2 has no reply snapshot; replies are Phase 4)", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { client_message_id: "cm-1", type: "text", text: "hi", reply_to_message_id: "m-1" } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });

  it("rejects non-empty attachment_ids (Phase 2 is text-only)", () => {
    const r = parseMessageSendCommand(
      { frame_type: "command", command: "message.send", command_id: "cmd-1", channel_id: "ch-1", payload: { client_message_id: "cm-1", type: "text", text: "hi", attachment_ids: ["a-1"] } },
      "u-1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_MESSAGE");
  });
});

describe("dedupePrincipalKeyForUser", () => {
  it("namespaces by user id", () => {
    expect(dedupePrincipalKeyForUser("u-1")).toBe("user:u-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:once -- test/chat/command.test.ts`
Expected: FAIL — `Cannot find module '../../src/chat/command'`.

- [ ] **Step 3: Implement `src/chat/command.ts`**

```typescript
import type { CommandFrame } from "../ws/frames";

export interface ParsedMessageSend {
  client_message_id: string;
  type: "text";
  text: string;
  reply_to: string | null;
  attachment_ids: string[];
  mentions: Array<{ user_id: string; start: number; end: number }>;
}

export type ParseResult =
  | { ok: true; command: ParsedMessageSend }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

export function dedupePrincipalKeyForUser(userId: string): string {
  return `user:${userId}`;
}

export function parseMessageSendCommand(frame: CommandFrame, senderUserId: string): ParseResult {
  if (frame.command !== "message.send") {
    return { ok: false, error: { code: "INVALID_COMMAND", message: `unsupported command: ${frame.command}`, retryable: false } };
  }
  if (!frame.channel_id) {
    return { ok: false, error: { code: "CHANNEL_NOT_FOUND", message: "missing channel_id", retryable: false } };
  }
  const p = frame.payload as Record<string, unknown>;
  const client_message_id = typeof p.client_message_id === "string" ? p.client_message_id : "";
  if (!client_message_id) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "client_message_id is required", retryable: false } };
  }
  // Phase 2 is text-only. image messages (Phase 5) and reply_to (Phase 4) are rejected here
  // so we never persist incomplete rows (no reply_snapshot_json, no attachment owner/finalized check).
  const type = typeof p.type === "string" ? p.type : "text";
  if (type !== "text") {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: `unsupported type: ${type} (Phase 2 supports text only)`, retryable: false } };
  }
  const text = typeof p.text === "string" ? p.text : "";
  if (text.trim() === "") {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "message text is empty", retryable: false } };
  }
  const reply_to_message_id = p.reply_to_message_id;
  if (typeof reply_to_message_id === "string" && reply_to_message_id.length > 0) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "reply_to_message_id not supported in Phase 2", retryable: false } };
  }
  const attachment_ids = Array.isArray(p.attachment_ids) ? p.attachment_ids.filter((a): a is string => typeof a === "string") : [];
  if (attachment_ids.length > 0) {
    return { ok: false, error: { code: "INVALID_MESSAGE", message: "attachment_ids not supported in Phase 2 (text only)", retryable: false } };
  }
  const mentionsRaw = Array.isArray(p.mentions) ? p.mentions : [];
  const mentions = mentionsRaw
    .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
    .map((m) => ({
      user_id: typeof m.user_id === "string" ? m.user_id : "",
      start: typeof m.start === "number" ? m.start : 0,
      end: typeof m.end === "number" ? m.end : 0,
    }))
    .filter((m) => m.user_id);

  void senderUserId; // sender identity comes from the authenticated socket, not the payload
  return { ok: true, command: { client_message_id, type: "text", text, reply_to: null, attachment_ids: [], mentions } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:once -- test/chat/command.test.ts`
Expected: PASS (all 9: valid, wrong-command, missing client_message_id, empty text, missing channel_id, reject image, reject reply_to, reject attachment_ids, dedupe key).

- [ ] **Step 5: Write failing test for event frame builders**

`test/chat/event-broadcast.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { buildEventFrame, buildMessageCreatedPayload } from "../../src/chat/event-broadcast";

describe("buildEventFrame", () => {
  it("produces the contract §10.4 envelope shape", () => {
    const f = buildEventFrame({
      event_id: "01J...",
      type: "message.created",
      channel_id: "ch-1",
      occurred_at: "2026-06-21T05:30:00Z",
      payload: { message: { message_id: "m-1" } },
    });
    expect(f).toEqual({
      frame_type: "event",
      api_version: "lilium.chat.v1",
      event_id: "01J...",
      type: "message.created",
      channel_id: "ch-1",
      occurred_at: "2026-06-21T05:30:00Z",
      payload: { message: { message_id: "m-1" } },
    });
  });
});

describe("buildMessageCreatedPayload", () => {
  it("projects sender as a reference, not a UserSummary (persisted shape)", () => {
    const p = buildMessageCreatedPayload({
      message_id: "m-1",
      client_message_id: "cm-1",
      channel_id: "ch-1",
      sender_kind: "user",
      sender_user_id: "u-1",
      sender_bot_id: null,
      status: "normal",
      created_at: "2026-06-21T05:30:00Z",
      type: "text",
      format: "plain",
      text: "hello",
    });
    expect(p.message).toMatchObject({
      message_id: "m-1",
      client_message_id: "cm-1",
      channel_id: "ch-1",
      status: "normal",
      created_at: "2026-06-21T05:30:00Z",
      type: "text",
    });
    // PERSISTED payload: sender is a ref, NOT a resolved UserSummary
    expect(p.message).toHaveProperty("sender");
    expect((p.message as Record<string, unknown>).sender).toEqual({ kind: "user", user_id: "u-1", bot_id: null });
    // no display_name / avatar_url in the persisted payload
    expect(JSON.stringify(p)).not.toContain("display_name");
  });
});

describe("resolveSenderForLiveBroadcast", () => {
  it("replaces the sender ref with a resolved UserSummary on the live broadcast payload", async () => {
    // We test against a fake env whose TOOLBEAR_DB resolve returns a known summary.
    // resolveUserSummaries is sourced from src/profile/resolve; in this unit test we
    // inject a stub by calling resolveSenderForLiveBroadcast with a resolver function.
    const persisted = buildMessageCreatedPayload({
      message_id: "m-1", client_message_id: "cm-1", channel_id: "ch-1",
      sender_kind: "user", sender_user_id: "u-1", sender_bot_id: null,
      status: "normal", created_at: "2026-06-21T05:30:00Z", type: "text", format: "plain", text: "hello",
    });
    const live = await resolveSenderForLiveBroadcast(
      persisted,
      async () => new Map([["u-1", { user_id: "u-1", display_name: "Alice", avatar_url: "https://x/a.png" }]]),
    );
    const sender = (live.message as Record<string, unknown>).sender as Record<string, unknown>;
    expect(sender.kind).toBe("user");
    expect(sender).toHaveProperty("user");
    expect((sender.user as Record<string, unknown>).display_name).toBe("Alice");
    expect((sender.user as Record<string, unknown>).avatar_url).toBe("https://x/a.png");
  });

  it("falls back to a user-<shortid> summary when the sender is not in pg", async () => {
    const persisted = buildMessageCreatedPayload({
      message_id: "m-2", client_message_id: "cm-2", channel_id: "ch-1",
      sender_kind: "user", sender_user_id: "u-ghost", sender_bot_id: null,
      status: "normal", created_at: "2026-06-21T05:30:00Z", type: "text", format: "plain", text: "hi",
    });
    const live = await resolveSenderForLiveBroadcast(
      persisted,
      async () => new Map(), // nothing resolved
    );
    const sender = (live.message as Record<string, unknown>).sender as Record<string, unknown>;
    expect((sender.user as Record<string, unknown>).display_name).toBe("user-u-ghost");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm run test:once -- test/chat/event-broadcast.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `src/chat/event-broadcast.ts`**

```typescript
import type { EventFrame } from "../ws/frames";

export function buildEventFrame(args: {
  event_id: string;
  type: string;
  channel_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}): EventFrame {
  return {
    frame_type: "event",
    api_version: "lilium.chat.v1",
    event_id: args.event_id,
    type: args.type,
    channel_id: args.channel_id,
    occurred_at: args.occurred_at,
    payload: args.payload,
  };
}

// Per design spec §3.5: PERSISTED event payloads store actor REFERENCES, not UserSummary.
// (events.payload_json stores the shape produced below — sender as {kind, user_id, bot_id}.)
export function buildMessageCreatedPayload(raw: {
  message_id: string;
  client_message_id: string;
  channel_id: string;
  sender_kind: string;
  sender_user_id: string | null;
  sender_bot_id: string | null;
  status: string;
  created_at: string;
  type: string;
  format: string;
  text: string | null;
}): Record<string, unknown> {
  return {
    message: {
      message_id: raw.message_id,
      client_message_id: raw.client_message_id,
      channel_id: raw.channel_id,
      sender: {
        kind: raw.sender_kind,
        user_id: raw.sender_user_id,
        bot_id: raw.sender_bot_id,
      },
      type: raw.type,
      format: raw.format,
      status: raw.status,
      text: raw.text,
      created_at: raw.created_at,
    },
  };
}

// Per design spec §3.5: the LIVE broadcast (wire) projection resolves UserSummary at output
// time. The persisted payload keeps the sender ref; this function takes that persisted payload
// and returns a NEW payload with sender replaced by { kind:'user', user: UserSummary } so the
// client never has to render a bare user_id. (For bot senders, resolution is deferred to Phase 7;
// the bot ref is passed through unchanged here.)
//
// `resolveUserSummaries` is injected so this module stays unit-testable without Hyperdrive.
export interface UserSummary {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
}
export type ResolveUserSummaries = (userIds: string[]) => Promise<Map<string, UserSummary>>;

export async function resolveSenderForLiveBroadcast(
  payload: Record<string, unknown>,
  resolveUserSummaries: ResolveUserSummaries,
): Promise<Record<string, unknown>> {
  const message = (payload.message as { sender?: { kind?: string; user_id?: string | null; bot_id?: string | null } } | undefined);
  const sender = message?.sender;
  let resolvedSender: Record<string, unknown>;
  if (sender?.kind === "user" && sender.user_id) {
    const map = await resolveUserSummaries([sender.user_id]);
    const u = map.get(sender.user_id) ?? {
      user_id: sender.user_id,
      display_name: `user-${sender.user_id.slice(0, 8)}`,
      avatar_url: null,
    };
    resolvedSender = { kind: "user", user: u };
  } else if (sender?.kind === "bot") {
    // Phase 7 will resolve bot display_name/avatar from BotRegistry. Pass through for now.
    resolvedSender = { kind: "bot", bot_id: sender.bot_id };
  } else {
    resolvedSender = (sender as Record<string, unknown>) ?? {};
  }
  const baseMessage = (payload.message as Record<string, unknown> | undefined) ?? {};
  return {
    message: { ...baseMessage, sender: resolvedSender },
  };
}
```

- [ ] **Step 8: Run tests to verify pass + typecheck**

Run: `npm run test:once -- test/chat/command.test.ts test/chat/event-broadcast.test.ts && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add src/chat/command.ts src/chat/event-broadcast.ts test/chat/command.test.ts test/chat/event-broadcast.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(chat): message.send command parser + event frame builders"
```

---

## Task 2: `ChannelFanout` DO — register/unregister/enqueue/deliver + alarm

**Files:**
- Modify: `src/do/channel-fanout.ts`
- Create: `src/do/fanout-scheduler.ts`
- Test: `test/do/channel-fanout.test.ts`

**Interfaces:**
- Consumes: `Env` (`USER_CONNECTION` binding), `execSchema` from `./sql`, `buildEventFrame`/`buildMessageCreatedPayload` are NOT used here (ChannelFanout stores/forwards opaque `event_json`; the ChatChannel already builds the frame when enqueuing). Actually — to keep the event frame built once and cached, **ChatChannel builds the event frame JSON and passes it in the outbox payload**; ChannelFanout stores it verbatim in `fanout_events.event_json` and forwards it to `UserConnection.deliver`. So ChannelFanout does not call the builders. (Confirm: the deliver payload is the already-serialized `EventFrame` JSON string.)
- Produces:
  - `POST /register-online` body `{ user_id, session_id, membership_version }` → inserts/updates `online_sessions` row keyed `(channel_id, session_id)` where `channel_id` = this DO's name (passed via `X-Channel-Id` header by ChatChannel/UserConnection). Idempotent (INSERT OR REPLACE).
  - `POST /unregister-online` body `{ session_id }` → deletes `online_sessions` row for this session. Idempotent.
  - `POST /unregister-user` body `{ user_id }` → deletes ALL `online_sessions` rows for this user in this channel AND marks their pending `fanout_queue` rows `failed` (member.left). Idempotent.
  - `POST /fanout-enqueue` body `{ event_id, event_json, membership_version_at_event }` → writes one `fanout_events` row, then expands into one `fanout_queue` row per active `online_sessions` row (status `pending`), skipping sessions whose user was the *only* intended recipient differently — NO, all online sessions including the sender receive the event (contract: broadcast includes sender). Then schedules the alarm. Idempotent on `event_id` (INSERT OR IGNORE into `fanout_events`; re-expanding queue must be idempotent — use `INSERT OR IGNORE` with a deterministic `queue_id` = `${event_id}:${session_id}`).
  - `alarm()` — flush due `fanout_queue` rows: for each, read `fanout_events.event_json` by `(channel_id, event_id)`, `fetch` `UserConnection.deliver` with body `{ user_id, session_id, event_json }`; on success mark `delivered`; on failure `bumpFanoutRetry` (dead-letter at `max_attempts`).
  - `GET /dump` (test helper) → `{ sessions: [...], events: [...], queue: [...] }`.
  - `fanout_queue` gains a `target_user_id TEXT NOT NULL` column (needed because deliver routes to `USER_CONNECTION.getByName(user_id)`).

- [ ] **Step 1: Write failing test for register + enqueue + deliver-to-UserConnection**

`test/do/channel-fanout.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

// ChannelFanout DO is named by channel_id. We register a fake online session,
// enqueue an event, then drive the alarm and assert a UserConnection DO received
// a /deliver call. To observe /deliver we point fanout at a real UserConnection DO
// (named by user_id) and check its stored "last delivered event" via a test probe.

describe("ChannelFanout DO", () => {
  it("registers online, enqueues an event, and delivers to UserConnection on alarm", async () => {
    const channelId = "ch-fanout-1";
    const userId = "u-fanout-1";
    const sessionId = "s-fanout-1";
    const fanout = getNamedDo(env.CHANNEL_FANOUT, channelId);

    // register online
    const reg = await fanout.fetch(new Request("https://x/register-online", {
      method: "POST",
      headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, session_id: sessionId, membership_version: 3 }),
    }));
    expect(reg.status).toBe(200);

    // enqueue an event
    const evt = JSON.stringify({ frame_type: "event", api_version: "lilium.chat.v1", event_id: "e-1", type: "message.created", channel_id: channelId, occurred_at: "2026-06-23T00:00:00Z", payload: {} });
    const enq = await fanout.fetch(new Request("https://x/fanout-enqueue", {
      method: "POST",
      headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: "e-1", event_json: evt, membership_version_at_event: 3 }),
    }));
    expect(enq.status).toBe(200);

    // dump before alarm: one pending queue row
    const dump1 = await (await fanout.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": channelId } }))).json() as any;
    expect(dump1.queue.length).toBe(1);
    expect(dump1.queue[0].status).toBe("pending");

    // fire the alarm (runDurableObjectAlarm)
    const { runDurableObjectAlarm } = await import("cloudflare:test") as any;
    await runDurableObjectAlarm(fanout);

    // after alarm: queue row delivered; UserConnection DO recorded the deliver
    const dump2 = await (await fanout.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": channelId } }))).json() as any;
    expect(dump2.queue[0].status).toBe("delivered");

    const uc = getNamedDo(env.USER_CONNECTION, userId);
    const probe = await (await uc.fetch(new Request("https://x/test-last-deliver", { headers: { "X-Channel-Id": channelId } }))).json() as any;
    expect(probe.event_json).toContain('"event_id":"e-1"');
  });

  it("unregister-user drops sessions and fails their pending queue rows (member.left)", async () => {
    const channelId = "ch-fanout-2";
    const userId = "u-fanout-2";
    const fanout = getNamedDo(env.CHANNEL_FANOUT, channelId);
    await fanout.fetch(new Request("https://x/register-online", {
      method: "POST", headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, session_id: "s-2", membership_version: 1 }),
    }));
    await fanout.fetch(new Request("https://x/fanout-enqueue", {
      method: "POST", headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: "e-2", event_json: "{}", membership_version_at_event: 1 }),
    }));
    const drop = await fanout.fetch(new Request("https://x/unregister-user", {
      method: "POST", headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));
    expect(drop.status).toBe(200);

    const dump = await (await fanout.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": channelId } }))).json() as any;
    expect(dump.sessions.filter((s: any) => s.user_id === userId)).toEqual([]);
    expect(dump.queue.filter((q: any) => q.target_user_id === userId && q.status === "pending")).toEqual([]);
  });

  it("fanout-enqueue is idempotent on event_id (second enqueue does not double the queue)", async () => {
    const channelId = "ch-fanout-3";
    const fanout = getNamedDo(env.CHANNEL_FANOUT, channelId);
    await fanout.fetch(new Request("https://x/register-online", {
      method: "POST", headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "u-3", session_id: "s-3", membership_version: 0 }),
    }));
    for (let i = 0; i < 2; i++) {
      await fanout.fetch(new Request("https://x/fanout-enqueue", {
        method: "POST", headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: "e-3", event_json: "{}", membership_version_at_event: 0 }),
      }));
    }
    const dump = await (await fanout.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": channelId } }))).json() as any;
    expect(dump.queue.filter((q: any) => q.event_id === "e-3").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:once -- test/do/channel-fanout.test.ts`
Expected: FAIL — `/register-online` returns 404 (not implemented).

- [ ] **Step 3: Create `src/do/fanout-scheduler.ts`**

```typescript
// Earliest-wins alarm scheduler + retry/backoff for the ChannelFanout fanout_queue.
// Mirrors ChatChannel's outbox scheduler (src/do/chat-channel.ts scheduleOutboxAlarm/bumpOutboxRetry).

export function scheduleFanoutAlarm(ctx: DurableObjectState, nowIso: string): Promise<void> {
  return (async () => {
    const row = ctx.storage.sql
      .exec("SELECT MIN(next_attempt_at) AS due FROM fanout_queue WHERE status='pending'")
      .toArray()[0] as { due: string | null } | undefined;
    const due = row?.due ?? null;
    if (due === null) {
      await ctx.storage.deleteAlarm();
      return;
    }
    const dueMs = Date.parse(due);
    if (Number.isNaN(dueMs)) {
      await ctx.storage.deleteAlarm();
      return;
    }
    const current = await ctx.storage.getAlarm();
    if (current === null || dueMs < current) {
      await ctx.storage.setAlarm(dueMs);
      return;
    }
    void nowIso;
  })();
}

export function bumpFanoutRetry(
  ctx: DurableObjectState,
  queueId: string,
  nowIso: string,
  error: string,
): void {
  const row = ctx.storage.sql
    .exec("SELECT attempts, max_attempts FROM fanout_queue WHERE queue_id=?", queueId)
    .toArray()[0] as { attempts: number | null; max_attempts: number | null } | undefined;
  const attempts = row?.attempts ?? 0;
  const maxAttempts = row?.max_attempts ?? 5;
  const next = attempts + 1;
  if (next >= maxAttempts) {
    ctx.storage.sql.exec(
      "UPDATE fanout_queue SET status='dead_letter', attempts=?, last_error=?, failed_at=? WHERE queue_id=?",
      next, error, nowIso, queueId,
    );
    return;
  }
  const backoffMs = 1000 * Math.pow(2, attempts);
  ctx.storage.sql.exec(
    "UPDATE fanout_queue SET status='pending', attempts=?, last_error=?, next_attempt_at=? WHERE queue_id=?",
    next, error, new Date(Date.parse(nowIso) + backoffMs).toISOString(), queueId,
  );
}
```

> **Note:** `ChannelFanout` already imports `execSchema` from `./sql`; it does NOT import the `ChatChannel` scheduler (those operate on `projection_outbox`, a different table). The fanout scheduler is table-specific to `fanout_queue`.

- [ ] **Step 4: Rewrite `src/do/channel-fanout.ts` with full implementation**

Replace the entire file content with:
```typescript
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { execSchema } from "./sql";
import { scheduleFanoutAlarm, bumpFanoutRetry } from "./fanout-scheduler";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS online_sessions (
    channel_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
    membership_version INTEGER NOT NULL, registered_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, session_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_online_user ON online_sessions(channel_id, user_id)`,
  `CREATE TABLE IF NOT EXISTS fanout_events (
    channel_id TEXT NOT NULL, event_id TEXT NOT NULL, event_json TEXT NOT NULL,
    membership_version_at_event INTEGER NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, event_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fanout_events_cleanup ON fanout_events(created_at)`,
  `CREATE TABLE IF NOT EXISTS fanout_queue (
    queue_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, event_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL, target_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error TEXT, failed_at TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fanout_due ON fanout_queue(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_fanout_event ON fanout_queue(channel_id, event_id)`,
];

function nowIso(): string {
  return new Date().toISOString();
}

export class ChannelFanout extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    execSchema(this.ctx, SCHEMA);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    // channel_id is passed by the caller (ChatChannel/UserConnection) via header,
    // because the DO is addressed by name but the name is not in the URL path.
    const channelId = request.headers.get("X-Channel-Id") ?? "";

    if (url.pathname === "/register-online") {
      if (!channelId) return new Response("missing X-Channel-Id", { status: 400 });
      const b = (await request.json()) as { user_id: string; session_id: string; membership_version: number };
      if (!b.user_id || !b.session_id) return new Response("missing user_id/session_id", { status: 400 });
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO online_sessions (channel_id, user_id, session_id, membership_version, registered_at) VALUES (?, ?, ?, ?, ?)",
        channelId, b.user_id, b.session_id, b.membership_version ?? 0, nowIso(),
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/unregister-online") {
      if (!channelId) return new Response("missing X-Channel-Id", { status: 400 });
      const b = (await request.json()) as { session_id: string };
      this.ctx.storage.sql.exec(
        "DELETE FROM online_sessions WHERE channel_id=? AND session_id=?",
        channelId, b.session_id ?? "",
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/unregister-user") {
      // member.left: drop all this user's sessions in this channel + fail their pending queue rows.
      if (!channelId) return new Response("missing X-Channel-Id", { status: 400 });
      const b = (await request.json()) as { user_id: string };
      this.ctx.storage.sql.exec(
        "DELETE FROM online_sessions WHERE channel_id=? AND user_id=?",
        channelId, b.user_id ?? "",
      );
      this.ctx.storage.sql.exec(
        "UPDATE fanout_queue SET status='failed', last_error='member_left' WHERE channel_id=? AND target_user_id=? AND status='pending'",
        channelId, b.user_id ?? "",
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/fanout-enqueue") {
      if (!channelId) return new Response("missing X-Channel-Id", { status: 400 });
      const b = (await request.json()) as { event_id: string; event_json: string; membership_version_at_event: number };
      if (!b.event_id || !b.event_json) return new Response("missing event_id/event_json", { status: 400 });
      const ts = nowIso();
      // cache the event payload (idempotent)
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fanout_events (channel_id, event_id, event_json, membership_version_at_event, created_at) VALUES (?, ?, ?, ?, ?)",
        channelId, b.event_id, b.event_json, b.membership_version_at_event ?? 0, ts,
      );
      // expand queue rows for each active session (idempotent via deterministic queue_id)
      const sessions = this.ctx.storage.sql.exec(
        "SELECT user_id, session_id FROM online_sessions WHERE channel_id=?",
        channelId,
      ).toArray() as Array<{ user_id: string; session_id: string }>;
      for (const s of sessions) {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO fanout_queue (queue_id, channel_id, event_id, target_session_id, target_user_id, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
          `${b.event_id}:${s.session_id}`, channelId, b.event_id, s.session_id, s.user_id, ts, ts,
        );
      }
      await scheduleFanoutAlarm(this.ctx, ts);
      return Response.json({ ok: true, delivered_to: sessions.length });
    }

    if (url.pathname === "/dump") {
      const sessions = this.ctx.storage.sql.exec("SELECT * FROM online_sessions WHERE channel_id=?", channelId).toArray();
      const events = this.ctx.storage.sql.exec("SELECT * FROM fanout_events WHERE channel_id=?", channelId).toArray();
      const queue = this.ctx.storage.sql.exec("SELECT * FROM fanout_queue WHERE channel_id=?", channelId).toArray();
      return Response.json({ sessions, events, queue });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const ts = nowIso();
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT queue_id, channel_id, event_id, target_session_id, target_user_id FROM fanout_queue WHERE status='pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC",
        ts,
      )
      .toArray() as Array<{ queue_id: string; channel_id: string; event_id: string; target_session_id: string; target_user_id: string }>;

    for (const r of rows) {
      const evRow = this.ctx.storage.sql
        .exec("SELECT event_json, membership_version_at_event FROM fanout_events WHERE channel_id=? AND event_id=?", r.channel_id, r.event_id)
        .toArray()[0] as { event_json: string; membership_version_at_event: number } | undefined;
      if (!evRow) {
        bumpFanoutRetry(this.ctx, r.queue_id, ts, "event_json missing");
        continue;
      }
      const uc = this.env.USER_CONNECTION.getByName(r.target_user_id);
      try {
        const res = await uc.fetch(new Request("https://x/deliver", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Channel-Id": r.channel_id },
          body: JSON.stringify({ session_id: r.target_session_id, event_json: evRow.event_json, membership_version_at_event: evRow.membership_version_at_event }),
        }));
        if (!res.ok) {
          const text = await res.text();
          bumpFanoutRetry(this.ctx, r.queue_id, ts, `${res.status}: ${text}`);
          continue;
        }
        // 200 with {delivered:false} (session gone OR dropped as not-a-member) → mark delivered,
        // do NOT retry. The dropped-not-member case is the intended outcome of the deliver gate
        // (design §3.3); the repair path for a rejoined member is replay, not re-delivery.
        this.ctx.storage.sql.exec(
          "UPDATE fanout_queue SET status='delivered', attempts=attempts+1, last_error=NULL WHERE queue_id=?",
          r.queue_id,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bumpFanoutRetry(this.ctx, r.queue_id, ts, msg);
      }
    }
    await scheduleFanoutAlarm(this.ctx, ts);
  }
}
```

- [ ] **Step 5: Add the `runDurableObjectAlarm` type to `test/types/miniflare-spikes.d.ts`**

The existing `declare module "cloudflare:test"` block only declares `runInDurableObject`. Add `runDurableObjectAlarm`. Replace the existing `declare module "cloudflare:test"` block (lines ~9-13 of the file) with:
```typescript
declare module "cloudflare:test" {
  export function runInDurableObject(
    stub: unknown,
    callback: (instance: unknown, state: { getWebSockets: () => WebSocket[] }) => Promise<void>,
  ): Promise<void>;
  export function runDurableObjectAlarm(stub: unknown): Promise<void>;
}
```

- [ ] **Step 6: Run the ChannelFanout tests**

The first test asserts a `UserConnection.test-last-deliver` probe and a `/deliver` endpoint that don't exist yet. Those are implemented in Task 3. So this test will partially fail until Task 3. **Run it now to confirm ChannelFanout-only parts (register, enqueue, dump, unregister-user, queue idempotence) are correct** and the only failures are the UserConnection probe:

Run: `npm run test:once -- test/do/channel-fanout.test.ts`
Expected: the `unregister-user` and `fanout-enqueue idempotent` tests PASS; the `delivers to UserConnection on alarm` test FAILS only at the `probe.event_json` assertion (because `/deliver` + `/test-last-deliver` don't exist yet in UserConnection). The `dump2.queue[0].status` should be `delivered` if the alarm ran (it will be `dead_letter` or still `pending` because UserConnection returned 404 → bumpFanoutRetry). **This is expected — Task 3 completes it.** Do NOT commit until Task 3 makes it green.

> **If the alarm-driven `delivered`/`dead_letter` assertion is confusing here:** the key Phase-2-correct behaviors to confirm NOW are: register inserts a session row, enqueue creates exactly one pending queue row per session, enqueue is idempotent, unregister-user drops sessions + fails pending rows. The end-to-end deliver-to-UserConnection is validated green in Task 3.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Hold commit until Task 3 green**

Do not commit yet — the `delivers to UserConnection on alarm` test is the integration gate for Tasks 2+3 together. Commit at the end of Task 3.

---

## Task 3: `UserConnection` DO — hibernation handlers, deliver, register-on-connect, replay

**Files:**
- Modify: `src/do/user-connection.ts`
- Test: `test/do/user-connection.test.ts`
- Test: (completes) `test/do/channel-fanout.test.ts`

**Interfaces:**
- Consumes: `Env` (`CHAT_CHANNEL`, `CHANNEL_FANOUT`, `USER_DIRECTORY`), `parseFrame` + frame types from `../ws/frames`, `parseMessageSendCommand` + `dedupePrincipalKeyForUser` from `../chat/command`, `buildEventFrame` from `../chat/event-broadcast`, `channelRouteNameFor` from `../chat/system-channel`.
- Produces:
  - `fetch` upgrade path: after `acceptWebSocket` + `serializeAttachment`, ALSO call `registerOnlineOnConnect(ws, userId, sessionId, per_channel_cursors)` — reads `UserDirectory.my_channels`, for each channel resolves the route name (system channel → `system-general`; Phase 2 only supports the system channel, so non-system channels are skipped), fetches the channel's current `membership_version` from `ChatChannel /internal/summary` (it returns `my_role` but not membership_version — **see Step 1: we add `membership_version` to the summary**, OR we read it via a new lightweight field). For Phase 2 simplicity, `register-online` is called with `membership_version` from the `my_channels` row's `membership_version` (UserDirectory already stores it). Then trigger per-channel replay (call `ChatChannel /internal/replay?after=<cursor>` and send each event frame on `ws`).
  - `webSocketMessage(ws, message)`: parse frame; if `command` + `message.send` → route to ChatChannel `/internal/message-send`, send `committed_ack` or `command_error` back on `ws`. Unknown frame → `command_error INVALID_COMMAND`.
  - `webSocketClose(ws, ...)` / `webSocketError(ws, ...)`: for each channel this session was registered for, call `ChannelFanout /unregister-online`. (We need the set of channels — store it in the attachment as `subscribed_channels: string[]` updated during register.)
  - `POST /deliver` body `{ session_id, event_json }` → find the live `WebSocket` by `session_id` (via `ctx.getWebSockets()` + `deserializeAttachment`), send `event_json` on it, advance `per_channel_cursors[channel_id]` in the attachment. Also store a `last_deliver` probe for tests. Returns 200 if the socket is live, 200 with `{ delivered: false }` if not found (so ChannelFanout marks delivered and stops retrying — the session is gone; replay is the repair path).
  - `GET /test-last-deliver` (test probe) → `{ event_json }`.

- [ ] **Step 1: Decide membership_version source for register-online**

The `UserDirectory.my_channels` row already carries `membership_version` (the version at join time, updated on join/leave). That is the correct subscription snapshot version per design §3.3 ("订阅时记录 `membership_version`"). So `registerOnlineOnConnect` uses `my_channels[].membership_version` directly — NO change to `ChatChannel /internal/summary` needed. Confirm by re-reading `src/do/user-directory.ts` `/my-channels` SELECT (it selects `membership_version`). ✅. No schema change here.

- [ ] **Step 2: Add `membership_version` passthrough — verify UserDirectory returns it**

`src/do/user-directory.ts` `/my-channels` already returns `{ channel_id, kind, last_read_event_id, membership_version }`. No change needed. (This is a verification step, not an edit.)

- [ ] **Step 3: Write failing test for deliver + replay + close**

`test/do/user-connection.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

// We exercise the UserConnection DO directly (bypassing the Worker upgrade proxy,
// which is already tested in src/routes/ws.test.ts). We feed X-Verified-User-Id
// and Upgrade: websocket to get a 101 + a client socket, then drive frames.

async function upgradeUserConnection(userId: string, cursors?: string): Promise<{ ws: WebSocket; stub: DurableObjectStub }> {
  const stub = getNamedDo(env.USER_CONNECTION, userId);
  const qs = cursors ? `?cursors=${cursors}` : "";
  const res = await stub.fetch(new Request(`https://x/ws${qs}`, {
    headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
  }));
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return { ws, stub };
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for ws message")), timeoutMs);
    ws.addEventListener("message", (ev) => { clearTimeout(t); resolve(typeof ev.data === "string" ? ev.data : ""); }, { once: true });
  });
}

describe("UserConnection DO", () => {
  it("/deliver sends an event frame on the live socket and stores a probe", async () => {
    const userId = "u-uc-deliver";
    const { ws, stub } = await upgradeUserConnection(userId);
    const eventJson = JSON.stringify({ frame_type: "event", api_version: "lilium.chat.v1", event_id: "e-d1", type: "message.created", channel_id: "ch-d1", occurred_at: "2026-06-23T00:00:00Z", payload: {} });

    // We don't know the session_id from outside; /deliver should match by live socket.
    // ChannelFanout passes session_id, but for this direct test we pass session_id matching
    // the socket's attachment. We instead call /deliver without session_id matching by reading
    // the live socket. Simpler: the DO's /deliver, when session_id is empty, delivers to the
    // first live socket for this user. (ChannelFanout always passes a real session_id.)
    const { runInDurableObject } = await import("cloudflare:test") as any;
    let sessionId = "";
    await runInDurableObject(stub, async (_inst: unknown, state: { getWebSockets: () => WebSocket[] }) => {
      const att = (state.getWebSockets()[0] as WebSocket).deserializeAttachment() as any;
      sessionId = att.session_id;
    });

    const deliverRes = await stub.fetch(new Request("https://x/deliver", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Channel-Id": "ch-d1" },
      body: JSON.stringify({ session_id: sessionId, event_json: eventJson }),
    }));
    expect(deliverRes.status).toBe(200);

    const received = await nextMessage(ws);
    expect(JSON.parse(received).event_id).toBe("e-d1");

    const probe = await (await stub.fetch(new Request("https://x/test-last-deliver", { headers: { "X-Channel-Id": "ch-d1" } }))).json() as any;
    expect(probe.event_json).toContain('"event_id":"e-d1"');
    ws.close();
  });

  it("webSocketMessage routes message.send to ChatChannel and returns committed_ack", async () => {
    const userId = "u-uc-send";
    // ensure the user is joined to the system channel first (so message.send has a valid channel)
    const sysStub = getNamedDo(env.CHAT_CHANNEL, "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    await sysStub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    // learn the system channel_id
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as any).channel_id;

    const { ws } = await upgradeUserConnection(userId);
    const cmd = JSON.stringify({
      frame_type: "command", command: "message.send", command_id: "cmd-uc-1", channel_id: sysId,
      payload: { client_message_id: "cm-uc-1", type: "text", text: "hi from uc", reply_to_message_id: null, attachment_ids: [], mentions: [] },
    });
    ws.send(cmd);

    const ackRaw = await nextMessage(ws);
    const ack = JSON.parse(ackRaw);
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.status).toBe("committed");
    expect(ack.command_id).toBe("cmd-uc-1");
    expect(ack.channel_id).toBe(sysId);
    expect(ack.message_id).toBeTruthy();
    expect(ack.event_id).toBeTruthy();
    ws.close();
  });

  it("webSocketMessage returns command_error for invalid message (empty text)", async () => {
    const userId = "u-uc-err";
    const sysStub = getNamedDo(env.CHAT_CHANNEL, "system-general");
    await sysStub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as any).channel_id;

    const { ws } = await upgradeUserConnection(userId);
    ws.send(JSON.stringify({
      frame_type: "command", command: "message.send", command_id: "cmd-uc-2", channel_id: sysId,
      payload: { client_message_id: "cm-uc-2", type: "text", text: "   " },
    }));
    const errRaw = await nextMessage(ws);
    const err = JSON.parse(errRaw);
    expect(err.frame_type).toBe("command_error");
    expect(err.error.code).toBe("INVALID_MESSAGE");
    ws.close();
  });

  it("idempotent: same client_message_id twice → same message_id in both acks", async () => {
    const userId = "u-uc-idem";
    const sysStub = getNamedDo(env.CHAT_CHANNEL, "system-general");
    await sysStub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as any).channel_id;
    const { ws } = await upgradeUserConnection(userId);
    const base = { frame_type: "command", command: "message.send", channel_id: sysId, payload: { client_message_id: "cm-idem", type: "text", text: "dup", reply_to_message_id: null, attachment_ids: [], mentions: [] } };
    ws.send(JSON.stringify({ ...base, command_id: "c-1" }));
    const ack1 = JSON.parse(await nextMessage(ws));
    ws.send(JSON.stringify({ ...base, command_id: "c-2" }));
    const ack2 = JSON.parse(await nextMessage(ws));
    expect(ack1.message_id).toBe(ack2.message_id);
    ws.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test:once -- test/do/user-connection.test.ts`
Expected: FAIL — `/deliver` returns 404; `webSocketMessage` is a no-op stub so no ack arrives (timeout).

- [ ] **Step 5: Implement the full `UserConnection` DO**

Replace `src/do/user-connection.ts` entirely with:
```typescript
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { parseFrame, type CommandFrame, type CommandAckFrame, type CommandErrorFrame } from "../ws/frames";
import { parseMessageSendCommand, dedupePrincipalKeyForUser } from "../chat/command";
import { channelRouteNameFor } from "../chat/system-channel";

export interface ConnectionAttachment {
  user_id: string;
  session_id: string;
  per_channel_cursors: Record<string, string>;
  // channelId → membership_version snapshot at subscription time (design §3.3). Used by
  // /deliver as the cheap gate: an event whose membership_version_at_event > the subscription
  // version means a member change happened between subscription and the event → re-check
  // active membership before delivering (design §2.4 / §3.3 two-layer guarantee).
  subscribed_channels: Record<string, number>;
  last_deliver?: string;
}

function parsePerChannelCursors(searchParams: string): Record<string, string> {
  const cursorsParam = searchParams;
  if (!cursorsParam) return {};
  try {
    const normalized = `${cursorsParam.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (cursorsParam.length % 4)) % 4)}`;
    return JSON.parse(atob(normalized)) as Record<string, string>;
  } catch {
    return {};
  }
}

export class UserConnection extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private findSocketBySession(sessionId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as ConnectionAttachment | null;
      if (att && att.session_id === sessionId) return ws;
    }
    return null;
  }

  private async registerChannelOnline(userId: string, sessionId: string, channelId: string, membershipVersion: number): Promise<void> {
    const fanout = this.env.CHANNEL_FANOUT.getByName(channelId);
    await fanout.fetch(new Request("https://x/register-online", {
      method: "POST",
      headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, session_id: sessionId, membership_version: membershipVersion }),
    }));
    const ws = this.findSocketBySession(sessionId);
    if (ws) {
      const att = ws.deserializeAttachment() as ConnectionAttachment | null;
      if (att) ws.serializeAttachment({ ...att, subscribed_channels: { ...att.subscribed_channels, [channelId]: membershipVersion } });
    }
  }

  // P0-1: ensure this session is subscribed to the channel BEFORE processing a command.
  // A real client may send message.send immediately on open, before the waitUntil
  // registerOnlineOnConnect finishes; without this, the sender's own message.created
  // event would be enqueued to ChannelFanout before the session is registered → the
  // sender never receives their own event. This method is idempotent: if already
  // subscribed (recorded in the attachment), it's a no-op; otherwise it resolves the
  // current membership_version from UserDirectory and registers now.
  private async ensureSubscribed(att: ConnectionAttachment, ws: WebSocket, channelId: string): Promise<boolean> {
    if (att.subscribed_channels[channelId] !== undefined) return true;
    const routeName = await channelRouteNameFor(this.env, att.user_id, channelId);
    if (routeName === null) return false;
    // read the membership_version snapshot from UserDirectory (my_channels carries it)
    const dir = this.env.USER_DIRECTORY.getByName(att.user_id);
    const dirRes = await dir.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": att.user_id } }));
    if (!dirRes.ok) return false;
    const myChannels = ((await dirRes.json()) as { items: Array<{ channel_id: string; membership_version: number }> }).items;
    const mc = myChannels.find((m) => m.channel_id === channelId);
    if (!mc) return false; // not a member → caller will get FORBIDDEN from ChatChannel
    await this.registerChannelOnline(att.user_id, att.session_id, channelId, mc.membership_version ?? 0);
    return true;
  }

  // Read my_channels, register online with each resolvable channel's ChannelFanout,
  // and replay per-channel events after the stored cursor. Phase 2 only resolves
  // the system channel (channelRouteNameFor returns null for others).
  private async registerOnlineOnConnect(userId: string, sessionId: string, perChannelCursors: Record<string, string>): Promise<Record<string, number>> {
    const dir = this.env.USER_DIRECTORY.getByName(userId);
    const dirRes = await dir.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const myChannels = dirRes.ok
      ? ((await dirRes.json()) as { items: Array<{ channel_id: string; kind: string; membership_version: number }> }).items
      : [];
    const subscribed: Record<string, number> = {};
    for (const mc of myChannels) {
      const routeName = await channelRouteNameFor(this.env, userId, mc.channel_id);
      if (routeName === null) continue; // Phase 2: only system channel resolves
      const fanout = this.env.CHANNEL_FANOUT.getByName(mc.channel_id);
      await fanout.fetch(new Request("https://x/register-online", {
        method: "POST",
        headers: { "X-Channel-Id": mc.channel_id, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, session_id: sessionId, membership_version: mc.membership_version ?? 0 }),
      }));
      subscribed[mc.channel_id] = mc.membership_version ?? 0;
      // replay events after the cursor
      const after = perChannelCursors[mc.channel_id] ?? "";
      const chStub = this.env.CHAT_CHANNEL.getByName(routeName);
      const replayRes = await chStub.fetch(new Request(`https://x/internal/replay?after=${encodeURIComponent(after)}`, {
        headers: { "X-Verified-User-Id": userId },
      }));
      if (replayRes.ok) {
        const body = (await replayRes.json()) as { events: Array<{ event_json: string }> };
        for (const ev of body.events) {
          this.sendToSession(sessionId, ev.event_json);
        }
      }
    }
    return subscribed;
  }

  private sendToSession(sessionId: string, text: string): boolean {
    const ws = this.findSocketBySession(sessionId);
    if (ws) { ws.send(text); return true; }
    return false;
  }

  // P0-4: cheap membership-version gate. Returns true if the event should be delivered.
  // - event.membership_version_at_event <= subscription version → deliver (no ChatChannel round-trip).
  // - event.membership_version_at_event > subscription version → a member change happened after
  //   subscription; re-check active membership in ChatChannel. If still a member, deliver (and
  //   bump the subscription version). If not, drop (member.left — repair path is replay).
  private async deliverAllowed(att: ConnectionAttachment, ws: WebSocket, channelId: string, eventMembershipVersion: number): Promise<boolean> {
    const subVersion = att.subscribed_channels[channelId];
    if (subVersion === undefined) return true; // not tracked via fanout (e.g. direct replay) → allow
    if (eventMembershipVersion <= subVersion) return true;
    // membership changed since subscription → confirm active membership in ChatChannel
    const routeName = await channelRouteNameFor(this.env, att.user_id, channelId);
    if (routeName === null) return false;
    const chStub = this.env.CHAT_CHANNEL.getByName(routeName);
    const res = await chStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": att.user_id } }));
    if (!res.ok) return false;
    const s = (await res.json()) as { my_role: string | null };
    if (s.my_role === null) return false; // no longer a member → drop
    // refresh subscription version upward so subsequent same-version events don't re-query
    ws.serializeAttachment({ ...att, subscribed_channels: { ...att.subscribed_channels, [channelId]: eventMembershipVersion } });
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (url.pathname === "/test-last-deliver") {
      const ch = request.headers.get("X-Channel-Id") ?? "";
      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as ConnectionAttachment | null;
        if (att && att.last_deliver) {
          return Response.json({ event_json: att.last_deliver, channel_id: ch });
        }
      }
      return Response.json({ event_json: null });
    }

    if (url.pathname === "/deliver") {
      const b = (await request.json()) as { session_id: string; event_json: string; membership_version_at_event?: number };
      const ws = this.findSocketBySession(b.session_id);
      if (!ws) return Response.json({ ok: true, delivered: false }); // session gone → stop retrying; replay is repair
      const att = ws.deserializeAttachment() as ConnectionAttachment | null;
      if (!att) return Response.json({ ok: true, delivered: false });
      let channelId = "";
      let eventId = "";
      try {
        const fr = JSON.parse(b.event_json) as { event_id?: string; channel_id?: string };
        channelId = fr.channel_id ?? "";
        eventId = fr.event_id ?? "";
      } catch { /* malformed */ }
      // P0-4: gate on membership_version before sending.
      const allowed = await this.deliverAllowed(att, ws, channelId, b.membership_version_at_event ?? 0);
      if (!allowed) return Response.json({ ok: true, delivered: false, dropped: "not_member" });
      ws.send(b.event_json);
      const nextAtt: ConnectionAttachment = { ...att, last_deliver: b.event_json };
      if (eventId && channelId) {
        nextAtt.per_channel_cursors = { ...att.per_channel_cursors, [channelId]: eventId };
      }
      ws.serializeAttachment(nextAtt);
      return Response.json({ ok: true, delivered: true });
    }

    // upgrade path
    const userId = request.headers.get("X-Verified-User-Id");
    if (!userId) return new Response("missing verified user", { status: 401 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const sessionId = crypto.randomUUID();
    const per_channel_cursors = parsePerChannelCursors(url.searchParams.get("cursors") ?? "");
    const pair = new WebSocketPair();
    const [client, server] = pair as unknown as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [`user-conn:${userId}`]);
    server.serializeAttachment({ user_id: userId, session_id, per_channel_cursors, subscribed_channels: {} } satisfies ConnectionAttachment);
    // register online + replay AFTER returning would block the upgrade; do it fire-and-forget
    // so the 101 returns promptly. The socket is already accepted; late frames are fine.
    // P0-1: webSocketMessage ALSO calls ensureSubscribed per-channel before any command, so a
    // client that sends immediately on open is still covered (does not depend on this waitUntil).
    this.ctx.waitUntil((async () => {
      const subscribed = await this.registerOnlineOnConnect(userId, sessionId, per_channel_cursors);
      const ws = this.findSocketBySession(sessionId);
      if (ws) {
        const att = ws.deserializeAttachment() as ConnectionAttachment | null;
        if (att) ws.serializeAttachment({ ...att, subscribed_channels: { ...att.subscribed_channels, ...subscribed } });
      }
    })());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (!att) return;
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let frame: CommandFrame;
    try {
      frame = parseFrame(text) as CommandFrame;
    } catch {
      ws.send(JSON.stringify({ frame_type: "command_error", command_id: "", error: { code: "INVALID_COMMAND", message: "malformed frame", retryable: false } } satisfies CommandErrorFrame));
      return;
    }
    if (frame.frame_type !== "command" || frame.command !== "message.send") {
      ws.send(JSON.stringify({ frame_type: "command_error", command_id: frame.command_id ?? "", error: { code: "INVALID_COMMAND", message: `unsupported command: ${(frame as { command?: string }).command ?? "?"}`, retryable: false } } satisfies CommandErrorFrame));
      return;
    }
    const parsed = parseMessageSendCommand(frame, att.user_id);
    if (!parsed.ok) {
      ws.send(JSON.stringify({ frame_type: "command_error", command_id: frame.command_id, error: parsed.error } satisfies CommandErrorFrame));
      return;
    }
    const channelId = frame.channel_id ?? "";
    // P0-1: ensure subscribed to this channel before sending, so the sender receives their own
    // message.created event. (Idempotent no-op if already registered by registerOnlineOnConnect.)
    const subscribed = await this.ensureSubscribed(att, ws, channelId);
    if (!subscribed) {
      ws.send(JSON.stringify({ frame_type: "command_error", command_id: frame.command_id, error: { code: "CHANNEL_NOT_FOUND", message: "channel not found or not a member", retryable: false } } satisfies CommandErrorFrame));
      return;
    }
    const routeName = await channelRouteNameFor(this.env, att.user_id, channelId);
    if (routeName === null) {
      ws.send(JSON.stringify({ frame_type: "command_error", command_id: frame.command_id, error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } } satisfies CommandErrorFrame));
      return;
    }
    const chStub = this.env.CHAT_CHANNEL.getByName(routeName);
    const res = await chStub.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": att.user_id, "Content-Type": "application/json" },
      body: JSON.stringify({
        client_message_id: parsed.command.client_message_id,
        dedupe_principal_key: dedupePrincipalKeyForUser(att.user_id),
        type: parsed.command.type,
        text: parsed.command.text,
        reply_to: parsed.command.reply_to,
        mentions: parsed.command.mentions,
        channel_id: channelId,
      }),
    }));
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      ws.send(JSON.stringify({ frame_type: "command_error", command_id: frame.command_id, error: { code: body.error?.code ?? "CHAT_WORKER_UNAVAILABLE", message: body.error?.message ?? "send failed", retryable: body.error?.code === "IDEMPOTENCY_CONFLICT" ? false : true } } satisfies CommandErrorFrame));
      return;
    }
    const out = (await res.json()) as { message_id: string; event_id: string };
    const ack: CommandAckFrame = {
      frame_type: "command_ack",
      command_id: frame.command_id,
      status: "committed",
      channel_id: channelId,
      message_id: out.message_id,
      event_id: out.event_id,
    };
    ws.send(JSON.stringify(ack));
  }

  private async unregisterAll(att: ConnectionAttachment): Promise<void> {
    for (const channelId of Object.keys(att.subscribed_channels)) {
      const fanout = this.env.CHANNEL_FANOUT.getByName(channelId);
      await fanout.fetch(new Request("https://x/unregister-online", {
        method: "POST",
        headers: { "X-Channel-Id": channelId, "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: att.session_id }),
      })).catch(() => undefined);
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const att = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (att) await this.unregisterAll(att);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const att = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (att) await this.unregisterAll(att);
  }

  async alarm(): Promise<void> {}
}
```

- [ ] **Step 6: Run UserConnection tests**

Run: `npm run test:once -- test/do/user-connection.test.ts`
Expected: the `/deliver` test PASSES; the `message.send` ack tests FAIL because `ChatChannel /internal/message-send` does not exist yet (Task 4). The `command_error` empty-text test should PASS (parse happens in UserConnection before hitting ChatChannel).

- [ ] **Step 7: Run ChannelFanout tests again (should now be fully green)**

Run: `npm run test:once -- test/do/channel-fanout.test.ts`
Expected: all 3 PASS now (UserConnection `/deliver` + `/test-last-deliver` exist).

> **If the "delivers to UserConnection on alarm" test still fails at `dump2.queue[0].status === 'delivered'`:** the alarm calls `/deliver` which returns 200 `{ delivered: true }` → `res.ok` is true → status set `delivered`. If it's `dead_letter`, the `/deliver` call threw or returned non-2xx — check that `sendToSession` found the live socket (the socket must still be open in the test when `runDurableObjectAlarm` fires). The test holds `ws` open (doesn't close before the alarm), so this should pass.

- [ ] **Step 8: Hold commit until Task 4 (message-send ack tests need ChatChannel endpoint)**

The two `message.send` ack tests fail pending Task 4. Commit at end of Task 4.

---

## Task 4: `ChatChannel` `/internal/message-send` + `channel_fanout` outbox flush

**Files:**
- Modify: `src/do/chat-channel.ts`
- Test: (completes) `test/do/user-connection.test.ts`
- Test: `test/do/chat-channel-message-send.test.ts`

**Interfaces:**
- Consumes: existing `ChatChannel` schema (`messages`, `events`, `event_seq`, `projection_outbox`, `members`), `nextEventId`, `insertOutboxRow`, `scheduleOutboxAlarm`, `buildEventFrame` + `buildMessageCreatedPayload` from `../chat/event-broadcast`.
- Produces:
  - `POST /internal/message-send` (header `X-Verified-User-Id`, body `{ client_message_id, dedupe_principal_key, type, text, reply_to, mentions, channel_id }`) → in ONE transaction: (a) membership check (must be an active member, else `FORBIDDEN`); (b) idempotency via `idempotency_keys` — compute `request_hash = JSON.stringify({ type, text, reply_to, mentions })`, look up `(principal_kind='user', principal_id=userId, operation='message.send', idempotency_key=client_message_id)`; if hit and `request_hash` matches → return cached `response_json={message_id,event_id}`; if hit and `request_hash` differs → `409 IDEMPOTENCY_CONFLICT` (see Step 1); (c) else `INSERT messages` with `message_id = uuidv7()`, `sender_kind='user'`, `sender_user_id=<X-Verified-User-Id>`, `status='normal'`, `created_at=updated_at=now`; (d) `event_id = nextEventId(nowMs)`, `INSERT events` with `event_type='message.created'`, `membership_version_at_event` = current `channel_meta.membership_version`, `payload_json` = JSON of the `message.created` **payload** built by `buildMessageCreatedPayload` (store the PAYLOAD object — sender as ref — NOT the full EventFrame; this matches the existing `/internal/join` which stores a plain payload object; the EventFrame envelope is built at the broadcast/replay boundary); (e) build the full `EventFrame` once via `buildEventFrame` (using the **live-resolved** payload from `resolveSenderForLiveBroadcast`) and serialize it into the `channel_fanout` outbox payload as `event_json` (so ChannelFanout forwards the complete frame verbatim without rebuilding); write the `channel_fanout` outbox row via the **synchronous** `insertOutboxRowForFanout(...)`; (f) write the `message_index` outbox row (inline sync SQL); (g) `INSERT idempotency_keys (..., request_hash, response_json={message_id,event_id}, status='completed', expires_at=now+24h)` co-atomic with the business write; (h) `scheduleOutboxAlarm(now)`. Return `{ message_id, event_id }`. The `messages UNIQUE(channel_id, dedupe_principal_key, client_message_id)` is a secondary guard only; it does NOT serve the idempotency response.
  - `alarm()` extended: besides `target_kind='user_directory'` (existing), also flush `target_kind='channel_fanout'` rows → `ChannelFanout /fanout-enqueue` with `X-Channel-Id: <target_key>` and body `{ event_id, event_json, membership_version_at_event }` parsed from `payload_json`. And `target_kind='message_index'` → `MessageIndex /upsert` (this generalizes the existing `/outbox-flush` ad-hoc path; keep `/outbox-flush` for backward compat with the Phase-1 spike test but route real writes through `alarm()`).
  - `GET /internal/replay?after=<event_id>` (header `X-Verified-User-Id`) → returns `{ events: Array<{ event_id, event_json }> }` filtered by current message status (content-bearing events for deleted/recalled messages are skipped — reuse the `/spike-replay` filter logic generalized to all event types). This is what `UserConnection.registerOnlineOnConnect` calls.

- [ ] **Step 1: Idempotency is served from `idempotency_keys`, NOT by scanning `events`**

`message.send` idempotency uses the unified `idempotency_keys` table (design §3.6). Do NOT scan `events.payload_json` with `LIKE`, and do NOT add a `messages.created_event_id` column — the `idempotency_keys` row already carries the cached response.

- On the first successful send, the ChatChannel transaction writes `idempotency_keys (principal_kind='user', principal_id=userId, operation='message.send', idempotency_key=client_message_id, request_hash=<hash of mutable body>, response_json={message_id,event_id}, status='completed', expires_at=now+24h)` co-atomic with the `messages` + `events` + outbox writes.
- On retry with the same `client_message_id`:
  - same `request_hash` → return the cached `response_json` (`{message_id, event_id}`) — no new rows, no scan.
  - different `request_hash` → `409 IDEMPOTENCY_CONFLICT`.
- `messages UNIQUE(channel_id, dedupe_principal_key, client_message_id)` remains only a **secondary guard** (defends against a missed `idempotency_keys` write); it is not the idempotency response path.

The `request_hash` covers the mutable fields the client could legitimately change on a retry: `JSON.stringify({ type, text, reply_to, mentions })`. (`client_message_id` is the key itself, so it is not in the hash; `channel_id`/`dedupe_principal_key` are part of the key namespace, also not in the hash.)

This is the exact mechanism implemented in Step 4 below.

- [ ] **Step 2: Write failing test for `/internal/message-send`**

`test/do/chat-channel-message-send.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

async function setupSystemAndJoin(userId: string): Promise<{ stub: DurableObjectStub; channelId: string }> {
  const stub = getNamedDo(env.CHAT_CHANNEL, "system-general");
  await stub.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
  await stub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
  const channelId = (await (await stub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as any).channel_id;
  return { stub, channelId };
}

describe("ChatChannel /internal/message-send", () => {
  it("writes a message + event + outbox rows and returns message_id + event_id", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-1");
    const res = await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-ms-1", "Content-Type": "application/json" },
      body: JSON.stringify({ client_message_id: "cm-1", dedupe_principal_key: "user:u-ms-1", type: "text", text: "hello", reply_to: null, mentions: [], channel_id: channelId }),
    }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { message_id: string; event_id: string };
    expect(out.message_id).toBeTruthy();
    expect(out.event_id).toBeTruthy();
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-2");
    const res = await stub.fetch(new Request("https://x/internal/message-send", {
      method: "POST",
      headers: { "X-Verified-User-Id": "u-stranger", "Content-Type": "application/json" },
      body: JSON.stringify({ client_message_id: "cm-x", dedupe_principal_key: "user:u-stranger", type: "text", text: "hi", reply_to: null, mentions: [], channel_id: channelId }),
    }));
    expect(res.status).toBe(403);
  });

  it("is idempotent on (dedupe_principal_key, client_message_id): same message_id + event_id", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-3");
    const body = { dedupe_principal_key: "user:u-ms-3", type: "text", text: "dup", reply_to: null, mentions: [], channel_id: channelId };
    const a = await (await stub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": "u-ms-3", "Content-Type": "application/json" }, body: JSON.stringify({ ...body, client_message_id: "cm-dup" }) }))).json() as any;
    const b = await (await stub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": "u-ms-3", "Content-Type": "application/json" }, body: JSON.stringify({ ...body, client_message_id: "cm-dup" }) }))).json() as any;
    expect(a.message_id).toBe(b.message_id);
    expect(a.event_id).toBe(b.event_id);
  });

  it("returns IDEMPOTENCY_CONFLICT (409) when same client_message_id but different body", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-7");
    const base = { dedupe_principal_key: "user:u-ms-7", type: "text", reply_to: null, mentions: [], channel_id: channelId };
    const a = await stub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": "u-ms-7", "Content-Type": "application/json" }, body: JSON.stringify({ ...base, client_message_id: "cm-conflict", text: "first" }) }));
    expect(a.status).toBe(200);
    const b = await stub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": "u-ms-7", "Content-Type": "application/json" }, body: JSON.stringify({ ...base, client_message_id: "cm-conflict", text: "different" }) }));
    expect(b.status).toBe(409);
    const bb = (await b.json()) as any;
    expect(bb.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("different users, same client_message_id → different messages (namespacing)", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-4");
    await stub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": "u-ms-5", "Content-Type": "application/json" }, body: JSON.stringify({ user_id: "u-ms-5" }) }));
    const a = await (await stub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": "u-ms-4", "Content-Type": "application/json" }, body: JSON.stringify({ client_message_id: "shared", dedupe_principal_key: "user:u-ms-4", type: "text", text: "a", reply_to: null, mentions: [], channel_id: channelId }) }))).json() as any;
    const b = await (await stub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": "u-ms-5", "Content-Type": "application/json" }, body: JSON.stringify({ client_message_id: "shared", dedupe_principal_key: "user:u-ms-5", type: "text", text: "b", reply_to: null, mentions: [], channel_id: channelId }) }))).json() as any;
    expect(a.message_id).not.toBe(b.message_id);
  });

  it("/internal/replay returns the message.created event_json after creation, filtered by status", async () => {
    const { stub, channelId } = await setupSystemAndJoin("u-ms-6");
    const send = await (await stub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": "u-ms-6", "Content-Type": "application/json" }, body: JSON.stringify({ client_message_id: "cm-r", dedupe_principal_key: "user:u-ms-6", type: "text", text: "replay me", reply_to: null, mentions: [], channel_id: channelId }) }))).json() as any;
    const replay = await (await stub.fetch(new Request(`https://x/internal/replay?after=`, { headers: { "X-Verified-User-Id": "u-ms-6" } }))).json() as any;
    const found = replay.events.find((e: any) => e.event_id === send.event_id);
    expect(found).toBeDefined();
    expect(found.event_json).toContain('"message.created"');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:once -- test/do/chat-channel-message-send.test.ts`
Expected: FAIL — `/internal/message-send` returns 404.

- [ ] **Step 4: Implement `/internal/message-send` + `/internal/replay` in `ChatChannel`**

Add imports at the top of `src/do/chat-channel.ts`:
```typescript
import { buildEventFrame, buildMessageCreatedPayload, resolveSenderForLiveBroadcast } from "../chat/event-broadcast";
import { resolveUserSummaries } from "../profile/resolve";
```

Add these two endpoints inside `fetch`, just before the `return new Response("not found", ...)` at the end of `fetch` (after the `/spike-*` blocks):

```typescript
    if (url.pathname === "/internal/message-send") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      if (!userId) return new Response("missing verified user", { status: 401 });
      const b = (await request.json()) as {
        client_message_id: string; dedupe_principal_key: string; type: string;
        text: string; reply_to: string | null; mentions: Array<{ user_id: string; start: number; end: number }>;
        channel_id: string;
      };
      const now = this.nowIso();
      const nowMs = Date.parse(now);

      const meta = this.ctx.storage.sql.exec("SELECT channel_id, membership_version FROM channel_meta LIMIT 1").toArray()[0] as
        | { channel_id: string; membership_version: number } | undefined;
      if (meta === undefined) return new Response("channel not created", { status: 409 });
      const channelId = meta.channel_id;

      const member = this.ctx.storage.sql
        .exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, userId)
        .toArray()[0] as { x: number } | undefined;
      if (!member) return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "not a member" } }), { status: 403, headers: { "Content-Type": "application/json" } });

      // Idempotency via idempotency_keys (design §3.6). The client_message_id doubles as the
      // idempotency_key (operation='message.send', principal_kind='user', principal_id=userId).
      // request_hash covers the mutable body fields so a same-key/different-body collision
      // returns IDEMPOTENCY_CONFLICT instead of silently returning the old message.
      const requestHash = JSON.stringify({ type: b.type, text: b.text, reply_to: b.reply_to, mentions: b.mentions ?? [] });
      const idemRow = this.ctx.storage.sql
        .exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='message.send' AND idempotency_key=?", userId, b.client_message_id)
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idemRow) {
        if (idemRow.request_hash !== requestHash) {
          return new Response(JSON.stringify({ error: { code: "IDEMPOTENCY_CONFLICT", message: "client_message_id reused with different body", retryable: false } }), { status: 409, headers: { "Content-Type": "application/json" } });
        }
        // exact same key + body → return cached response (carries message_id + event_id)
        const cached = idemRow.response_json ? (JSON.parse(idemRow.response_json) as { message_id: string; event_id: string }) : { message_id: "", event_id: "" };
        return Response.json(cached);
      }

      const messageId = uuidv7(nowMs);
      const eventId = this.nextEventId(nowMs);
      const mv = meta.membership_version;
      const persistedPayload = buildMessageCreatedPayload({
        message_id: messageId, client_message_id: b.client_message_id, channel_id: channelId,
        sender_kind: "user", sender_user_id: userId, sender_bot_id: null,
        status: "normal", created_at: now, type: b.type, format: "plain", text: b.text,
      });
      const payloadJson = JSON.stringify(persistedPayload);

      // Live broadcast frame: resolve the sender UserSummary NOW (design §3.5: the wire
      // projection resolves at output time). The persisted payload stays a ref; the outbox
      // carries the resolved frame so ChannelFanout forwards display_name/avatar to clients.
      const livePayload = await resolveSenderForLiveBroadcast(
        persistedPayload,
        (userIds: string[]) => resolveUserSummaries(userIds, this.env),
      );
      const eventFrame = buildEventFrame({ event_id: eventId, type: "message.created", channel_id: channelId, occurred_at: now, payload: livePayload });
      const eventFrameJson = JSON.stringify(eventFrame);

      const responseJson = JSON.stringify({ message_id: messageId, event_id: eventId });
      const idemExpiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(); // 24h

      await this.ctx.storage.transaction(async () => {
        this.ctx.storage.sql.exec(
          `INSERT INTO messages (message_id, client_message_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id, type, format, status, text, reply_to, stream_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', ?, ?, 'plain', 'normal', ?, ?, 'none', ?, ?)`,
          messageId, b.client_message_id, b.dedupe_principal_key, channelId, userId, b.type, b.text, b.reply_to, now, now,
        );
        if (Array.isArray(b.mentions) && b.mentions.length > 0) {
          for (const m of b.mentions) {
            this.ctx.storage.sql.exec(
              "INSERT OR IGNORE INTO mentions (message_id, user_id, start, end_) VALUES (?, ?, ?, ?)",
              messageId, m.user_id, m.start, m.end,
            );
          }
        }
        this.ctx.storage.sql.exec(
          "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'message.created', ?, 'user', ?, ?, ?, ?)",
          eventId, channelId, userId, payloadJson, mv, now,
        );
        // idempotency_keys row co-atomic with the business write (status 'completed').
        this.ctx.storage.sql.exec(
          "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, idempotency_key, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'message.send', ?, ?, ?, 'completed', ?, ?)",
          userId, b.client_message_id, requestHash, responseJson, now, idemExpiresAt,
        );
        // fanout outbox: ChannelFanout enqueues the event to all online sessions. SYNC helper —
        // a sql.exec failure here throws synchronously and aborts the transaction (message NOT committed).
        this.insertOutboxRowForFanout(channelId, eventId, eventFrameJson, mv, now);
        // message_index outbox: route /messages/{id} → channel.
        this.ctx.storage.sql.exec(
          "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'message_index', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
          `message_index:${messageId}`,
          messageId,
          JSON.stringify({ message_id: messageId, channel_id: channelId }),
          now, now, now,
        );
      });

      await this.scheduleOutboxAlarm(now);
      return Response.json({ message_id: messageId, event_id: eventId });
    }
```

> **Why the `message_index` outbox insert is now inline SQL (not `this.insertOutboxRow(...)`):** the existing `insertOutboxRow` is an `async` method called without `await` inside the transaction — a latent swallowed-error bug (P0-3). For Phase 2 we make the fanout helper **synchronous** (below) and write the `message_index` row with inline synchronous SQL so any insert failure throws and rolls the whole transaction back. (The legacy `insertOutboxRow` stays as-is to avoid touching the Phase-1 `/internal/join` path in this task; a later cleanup task can convert it too. The `/internal/join` path is lower-risk because a missed `user_directory` projection is repairable, whereas a missed `channel_fanout` row drops a real-time event.)

      await this.scheduleOutboxAlarm(now);
      return Response.json({ message_id: messageId, event_id: eventId });
    }

    if (url.pathname === "/internal/replay") {
      const userId = request.headers.get("X-Verified-User-Id") ?? "";
      const after = url.searchParams.get("after") ?? "";
      const meta = this.ctx.storage.sql.exec("SELECT channel_id, visibility FROM channel_meta LIMIT 1").toArray()[0] as
        | { channel_id: string; visibility: string } | undefined;
      if (meta === undefined) return Response.json({ events: [] });
      const member = userId
        ? (this.ctx.storage.sql.exec("SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", meta.channel_id, userId).toArray()[0] as { x: number } | undefined)
        : undefined;
      if (!member && meta.visibility === "private") return new Response("forbidden", { status: 403 });

      const rows = this.ctx.storage.sql.exec(
        "SELECT event_id, event_type, payload_json, occurred_at FROM events WHERE channel_id=? AND event_id > ? ORDER BY event_id",
        meta.channel_id, after,
      ).toArray() as Array<{ event_id: string; event_type: string; payload_json: string; occurred_at: string }>;
      // Batch-resolve all sender user_ids in the replay window ONCE (design §3.5: replay output
      // resolves UserSummary at read time). Avoids a Hyperdrive round-trip per event.
      const allSenderIds: string[] = [];
      for (const r of rows) {
        try {
          const p = JSON.parse(r.payload_json) as { message?: { sender?: { kind?: string; user_id?: string | null } } };
          if (p.message?.sender?.kind === "user" && p.message.sender.user_id) allSenderIds.push(p.message.sender.user_id);
        } catch { /* skip */ }
      }
      const senderMap = await resolveUserSummaries(allSenderIds, this.env);
      const resolveFn = async (userIds: string[]) => senderMap; // reuse the pre-fetched batch

      const out: Array<{ event_id: string; event_json: string }> = [];
      for (const r of rows) {
        // content-bearing events: skip if the referenced message is deleted/recalled.
        if (r.event_type === "message.created" || r.event_type === "message.updated") {
          try {
            const p = JSON.parse(r.payload_json) as { message?: { message_id?: string } };
            const mid = p.message?.message_id;
            if (mid) {
              const st = this.ctx.storage.sql.exec("SELECT status FROM messages WHERE message_id=?", mid).toArray()[0] as { status: string } | undefined;
              if (st && (st.status === "deleted" || st.status === "recalled")) continue;
            }
          } catch { /* skip malformed */ }
        }
        // events.payload_json stores the PAYLOAD object (sender as ref). Rebuild the full
        // EventFrame envelope at the replay boundary, resolving the sender UserSummary so the
        // replayed wire event matches the live broadcast (display_name/avatar, not bare id).
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(r.payload_json) as Record<string, unknown>;
        } catch { /* leave empty payload */ }
        let wirePayload = payload;
        if (r.event_type === "message.created" || r.event_type === "message.updated") {
          try {
            wirePayload = await resolveSenderForLiveBroadcast(
              payload,
              resolveFn,
            );
          } catch { /* keep ref-only payload on resolve failure */ }
        }
        const eventJson = JSON.stringify(buildEventFrame({
          event_id: r.event_id, type: r.event_type, channel_id: meta.channel_id,
          occurred_at: r.occurred_at, payload: wirePayload,
        }));
        out.push({ event_id: r.event_id, event_json: eventJson });
      }
      return Response.json({ events: out });
    }
```

Add the `insertOutboxRowForFanout` helper method to the `ChatChannel` class (near `insertOutboxRow`). **It MUST be synchronous** (P0-3): a `sql.exec` failure must throw synchronously so the surrounding `ctx.storage.transaction` rolls back the message + event writes — otherwise a dropped fanout outbox row would silently lose the real-time broadcast while the message stays committed.
```typescript
  private insertOutboxRowForFanout(
    channelId: string,
    eventId: string,
    eventFrameJson: string,
    membershipVersionAtEvent: number,
    nowIso: string,
  ): void {
    // target_key = channelId (ChannelFanout DO is named by channel_id).
    // payload carries the already-built (sender-resolved) EventFrame JSON so ChannelFanout
    // forwards it verbatim to UserConnection.deliver.
    const payload = {
      action: "fanout",
      channel_id: channelId,
      event_id: eventId,
      event_json: eventFrameJson,
      membership_version_at_event: membershipVersionAtEvent,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'channel_fanout', ?, ?, ?, 'pending', ?, ?, ?, 0, 5)",
      `channel_fanout:${channelId}:${eventId}`,
      channelId,
      eventId,
      JSON.stringify(payload),
      nowIso,
      nowIso,
      nowIso,
    );
  }
```

- [ ] **Step 5: Extend `alarm()` to flush `channel_fanout` and `message_index` rows**

In the `alarm()` method, the existing loop only handles `target_kind='user_directory'`. Generalize it. Replace the body of `alarm()` (the `for (const r of rows)` loop and the `target_kind` dispatch) with:

```typescript
  async alarm(): Promise<void> {
    const nowIso = this.nowIso();
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT outbox_id, target_kind, target_key, payload_json FROM projection_outbox WHERE status='pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC",
        nowIso,
      )
      .toArray() as unknown as Array<OutboxRow>;

    for (const r of rows) {
      if (r.target_kind === "user_directory") {
        const req = new Request("https://x/internal/upsert-channel", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Verified-User-Id": r.target_key },
          body: r.payload_json,
        });
        const target = this.env.USER_DIRECTORY.getByName(r.target_key);
        try {
          const res = await target.fetch(req);
          if (!res.ok) {
            const text = await res.text();
            await this.bumpOutboxRetry(r.outbox_id, nowIso, `${res.status}: ${text}`);
            continue;
          }
          this.ctx.storage.sql.exec("UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?", nowIso, r.outbox_id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
        }
        continue;
      }

      if (r.target_kind === "channel_fanout") {
        const payload = JSON.parse(r.payload_json) as { channel_id: string; event_id: string; event_json: string; membership_version_at_event: number };
        const target = this.env.CHANNEL_FANOUT.getByName(r.target_key);
        try {
          const res = await target.fetch(new Request("https://x/fanout-enqueue", {
            method: "POST",
            headers: { "X-Channel-Id": r.target_key, "Content-Type": "application/json" },
            body: JSON.stringify({ event_id: payload.event_id, event_json: payload.event_json, membership_version_at_event: payload.membership_version_at_event }),
          }));
          if (!res.ok) {
            const text = await res.text();
            await this.bumpOutboxRetry(r.outbox_id, nowIso, `${res.status}: ${text}`);
            continue;
          }
          this.ctx.storage.sql.exec("UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?", nowIso, r.outbox_id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
        }
        continue;
      }

      if (r.target_kind === "message_index") {
        const payload = JSON.parse(r.payload_json) as { message_id: string; channel_id: string };
        const target = this.env.MESSAGE_INDEX.getByName(r.target_key);
        try {
          const res = await target.fetch(new Request("https://x/upsert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
          if (!res.ok) {
            const text = await res.text();
            await this.bumpOutboxRetry(r.outbox_id, nowIso, `${res.status}: ${text}`);
            continue;
          }
          this.ctx.storage.sql.exec("UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?", nowIso, r.outbox_id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
        }
        continue;
      }

      await this.bumpOutboxRetry(r.outbox_id, nowIso, `unsupported target_kind=${r.target_kind}`);
    }

    await this.scheduleOutboxAlarm(nowIso);
  }
```

> **Note on the existing `/outbox-flush` endpoint and the Phase-1 spike test `test/spikes/outbox-flush.test.ts`:** that test inserts a row with `target_kind='message_index'` via `/outbox-insert` and calls `/outbox-flush`. The `/outbox-flush` ad-hoc handler remains untouched (still works for that spike). Real Phase-2 writes go through `alarm()`, which now also handles `message_index`. Both paths converge on the same idempotent `MessageIndex /upsert`. No conflict.

- [ ] **Step 6: Run the message-send tests**

Run: `npm run test:once -- test/do/chat-channel-message-send.test.ts`
Expected: all 6 PASS (write, FORBIDDEN, idempotent same-key+body, IDEMPOTENCY_CONFLICT same-key+different-body, namespacing, replay).

- [ ] **Step 7: Run the UserConnection ack tests (should now pass)**

Run: `npm run test:once -- test/do/user-connection.test.ts`
Expected: all 4 PASS.

- [ ] **Step 8: Run the full suite + typecheck**

Run: `npm run test:once && npm run typecheck`
Expected: all green (Phase 0/1 tests still pass; new Phase 2 tests pass); typecheck clean.

- [ ] **Step 9: Commit Tasks 2+3+4 together**

```bash
git add src/do/channel-fanout.ts src/do/fanout-scheduler.ts src/do/user-connection.ts src/do/chat-channel.ts test/do/channel-fanout.test.ts test/do/user-connection.test.ts test/do/chat-channel-message-send.test.ts test/types/miniflare-spikes.d.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(do): message.send transaction + ChannelFanout fanout + UserConnection hibernation handlers"
```

---

## Task 5: End-to-end integration test (WS → ack → self-receive event)

**Files:**
- Test: `test/integration/message-send.test.ts`

**Interfaces:**
- Consumes: `wsUpgradeHandler` (via the Worker `app`), `makeJwt`/`TEST_SECRET`/`getNamedDo`, the `ChannelFanout` alarm, the `ChatChannel` alarm. To drive the WS through the real Worker upgrade in a vitest-pool-workers test we use the `env` entry fetch (the Worker's default export). Actually — the simplest, most robust approach in vitest-pool-workers is to upgrade through the `UserConnection` DO directly with `X-Verified-User-Id` (as `test/do/user-connection.test.ts` does), OR through the Worker `fetch`. We go through the **Worker** to also exercise the upgrade proxy + JWT path once end-to-end.

- [ ] **Step 1: Write the end-to-end test**

`test/integration/message-send.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:workers";
import { makeJwt, TEST_SECRET, getNamedDo } from "../helpers";

// Drive the full path: browser JWT → Worker upgrade proxy → UserConnection DO
// → webSocketMessage → ChatChannel message-send → committed_ack on the socket.
// Then fire ChatChannel alarm (flush fanout outbox) + ChannelFanout alarm
// (deliver to UserConnection) and assert the message.created event frame
// arrives on the SAME socket (broadcast includes sender).

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    ws.addEventListener("message", (ev) => { clearTimeout(t); resolve(typeof ev.data === "string" ? ev.data : ""); }, { once: true });
  });
}

describe("e2e: message.send → committed_ack → message.created self-receive", () => {
  it("delivers ack then event to the sender over WS", async () => {
    const userId = "u-e2e-1";
    const token = await makeJwt({ sub: userId });

    // ensure joined to system channel (so register-online + send work)
    const sysStub = getNamedDo(env.CHAT_CHANNEL, "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    await sysStub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as any).channel_id;

    // upgrade through the Worker (real JWT + Origin + subprotocol path)
    const res = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/ws", {
      headers: {
        Upgrade: "websocket",
        Origin: "https://lilium.kuma.homes",
        "Sec-WebSocket-Protocol": `lilium.chat.v1, bearer.${token}`,
      },
    }));
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();

    // registerOnlineOnConnect runs in ctx.waitUntil after the 101. Poll ChannelFanout
    // until the session appears BEFORE sending, so the fanout-enqueue expansion will
    // include this session (else the event never reaches this socket).
    const fanoutStub = getNamedDo(env.CHANNEL_FANOUT, sysId);
    for (let i = 0; i < 40; i++) {
      const dump = await (await fanoutStub.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": sysId } }))).json() as any;
      if (dump.sessions.some((s: any) => s.user_id === userId)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    ws.send(JSON.stringify({
      frame_type: "command", command: "message.send", command_id: "cmd-e2e-1", channel_id: sysId,
      payload: { client_message_id: "cm-e2e-1", type: "text", text: "hello e2e", reply_to_message_id: null, attachment_ids: [], mentions: [] },
    }));

    const ackRaw = await nextMessage(ws);
    const ack = JSON.parse(ackRaw);
    expect(ack.frame_type).toBe("command_ack");
    expect(ack.status).toBe("committed");
    expect(ack.message_id).toBeTruthy();
    const eventId = ack.event_id;
    expect(eventId).toBeTruthy();

    // flush ChatChannel outbox → ChannelFanout, then ChannelFanout → UserConnection
    const { runDurableObjectAlarm } = await import("cloudflare:test") as any;
    await runDurableObjectAlarm(sysStub);
    await runDurableObjectAlarm(fanoutStub);

    const evRaw = await nextMessage(ws);
    const ev = JSON.parse(evRaw);
    expect(ev.frame_type).toBe("event");
    expect(ev.type).toBe("message.created");
    expect(ev.event_id).toBe(eventId);
    expect(ev.channel_id).toBe(sysId);
    ws.close();
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `npm run test:once -- test/integration/message-send.test.ts`
Expected: PASS. The poll-before-send pattern in Step 1 makes this deterministic — `registerOnlineOnConnect`'s `waitUntil` registration is observed via `ChannelFanout /dump` before the command is sent, so the subsequent `fanout-enqueue` expansion includes this session.

If the event frame still doesn't arrive within the timeout, the cause is NOT registration timing (the poll guarantees it). Check instead that the `ChatChannel` alarm flushed the `channel_fanout` outbox row to `ChannelFanout /fanout-enqueue` (assert `projection_outbox` has no `pending` `channel_fanout` rows after `runDurableObjectAlarm(sysStub)`), and that the `ChannelFanout` alarm delivered to `UserConnection /deliver` (assert `fanout_queue` row status `delivered`).

- [ ] **Step 3: Commit**

```bash
git add test/integration/message-send.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "test(integration): e2e message.send committed_ack + self-receive message.created"
```

---

## Task 6: `GET /api/chat/events` HTTP replay route

**Files:**
- Create: `src/routes/events.ts`
- Modify: `src/index.ts`
- Test: `test/routes/events.test.ts`

**Interfaces:**
- Consumes: `verifyBrowserJwt`, `channelRouteNameFor`, `ensureSystemJoined`, `ChatChannel /internal/replay`, `UserDirectory /my-channels`.
- Produces: `GET /api/chat/events?channel_id=X&after_event_id=Y` (single channel) OR `GET /api/chat/events?cursors=<base64url-json>` (multi-channel: read `my_channels`, parallel-replay each, merge). Response `{ items: EventFrame[], next_cursor: null, last_event_id_per_channel: { channel_id: last_event_id } }`. The `items` are the parsed `event_json` frames (already EventFrame-shaped from `/internal/replay`).

- [ ] **Step 1: Write failing test**

`test/routes/events.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:workers";
import { makeJwt, TEST_SECRET, getNamedDo } from "../helpers";

async function authedEventsReq(userId: string, token: string, qs: string): Promise<Response> {
  return SELF.fetch(new Request(`https://chat.kuma.homes/api/chat/events?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  }));
}

describe("GET /api/chat/events", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch(new Request("https://chat.kuma.homes/api/chat/events"));
    expect(res.status).toBe(401);
  });

  it("replays a single channel by channel_id + after_event_id", async () => {
    const userId = "u-ev-1";
    const token = await makeJwt({ sub: userId });
    // join + send a message directly via the DO to seed an event
    const sysStub = getNamedDo(env.CHAT_CHANNEL, "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    await sysStub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as any).channel_id;
    const send = await (await sysStub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ client_message_id: "cm-ev-1", dedupe_principal_key: `user:${userId}`, type: "text", text: "hi", reply_to: null, mentions: [], channel_id: sysId }) }))).json() as any;

    const res = await authedEventsReq(userId, token, `channel_id=${sysId}&after_event_id=`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const found = body.items.find((e: any) => e.event_id === send.event_id);
    expect(found).toBeDefined();
    expect(found.type).toBe("message.created");
    expect(body.last_event_id_per_channel[sysId]).toBeTruthy();
  });

  it("replays all my channels via cursors (multi-channel merge)", async () => {
    const userId = "u-ev-2";
    const token = await makeJwt({ sub: userId });
    const sysStub = getNamedDo(env.CHAT_CHANNEL, "system-general");
    await sysStub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as any).channel_id;
    await sysStub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ client_message_id: "cm-ev-2", dedupe_principal_key: `user:${userId}`, type: "text", text: "yo", reply_to: null, mentions: [], channel_id: sysId }) })));

    const cursors = btoa("{}").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await authedEventsReq(userId, token, `cursors=${cursors}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.last_event_id_per_channel[sysId]).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:once -- test/routes/events.test.ts`
Expected: FAIL — `/api/chat/events` hits the catch-all `app.all("/api/chat/*")` → 404 CHANNEL_NOT_FOUND.

- [ ] **Step 3: Implement `src/routes/events.ts`**

```typescript
import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { channelRouteNameFor, ensureSystemJoined } from "../chat/system-channel";

function decodeCursors(param: string | null): Record<string, string> {
  if (!param) return {};
  try {
    const normalized = `${param.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (param.length % 4)) % 4)}`;
    return JSON.parse(atob(normalized)) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function eventsHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");
  const { user_id: userId } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  await ensureSystemJoined(c.env, userId);
  const url = new URL(c.req.url);
  const channelIdParam = url.searchParams.get("channel_id");
  const afterEventId = url.searchParams.get("after_event_id") ?? "";
  const cursorsParam = url.searchParams.get("cursors");

  let targets: Array<{ channel_id: string; after: string }>;
  if (channelIdParam) {
    targets = [{ channel_id: channelIdParam, after: afterEventId }];
  } else {
    const cursors = decodeCursors(cursorsParam);
    const dirStub = c.env.USER_DIRECTORY.getByName(userId);
    const dirRes = await dirStub.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    const myChannels = dirRes.ok ? ((await dirRes.json()) as { items: Array<{ channel_id: string }> }).items : [];
    targets = myChannels.map((mc) => ({ channel_id: mc.channel_id, after: cursors[mc.channel_id] ?? "" }));
  }

  const results = await Promise.all(
    targets.map(async (t) => {
      const routeName = await channelRouteNameFor(c.env, userId, t.channel_id);
      if (routeName === null) return null;
      const stub = c.env.CHAT_CHANNEL.getByName(routeName);
      const res = await stub.fetch(new Request(`https://x/internal/replay?after=${encodeURIComponent(t.after)}`, { headers: { "X-Verified-User-Id": userId } }));
      if (!res.ok) return null;
      const body = (await res.json()) as { events: Array<{ event_id: string; event_json: string }> };
      const items = body.events.map((e) => JSON.parse(e.event_json) as Record<string, unknown>);
      const lastEventId = body.events.length > 0 ? body.events[body.events.length - 1]!.event_id : (t.after || null);
      return { channel_id: t.channel_id, items, lastEventId };
    }),
  );

  const merged = results.filter((r): r is { channel_id: string; items: Record<string, unknown>[]; lastEventId: string | null } => r !== null);
  // merge all items; ordering across channels is not causal — sort by event_id within channel,
  // but keep channels grouped. For simplicity return concatenated (each channel already sorted ASC).
  const allItems = merged.flatMap((m) => m.items);
  const lastPerChannel: Record<string, string> = {};
  for (const m of merged) {
    if (m.lastEventId) lastPerChannel[m.channel_id] = m.lastEventId;
  }
  return c.json({ items: allItems, next_cursor: null, last_event_id_per_channel: lastPerChannel }, 200, { "X-Request-Id": c.get("requestId") });
}
```

- [ ] **Step 4: Register the route in `src/index.ts`**

Add the import with the other route imports:
```typescript
import { eventsHandler } from "./routes/events";
```
Add the route registration before the `app.all("/api/chat/*", ...)` catch-all (e.g., right after the `channels/:channel_id` route):
```typescript
app.get("/api/chat/events", (c) => eventsHandler(c));
```

- [ ] **Step 5: Run the events tests**

Run: `npm run test:once -- test/routes/events.test.ts`
Expected: all 3 PASS.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm run test:once && npm run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/routes/events.ts src/index.ts test/routes/events.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(routes): GET /api/chat/events per-channel replay"
```

---

## Task 7: Hibernation wake restores cursors + replay (acceptance spike)

**Files:**
- Test: `test/integration/hibernation-wake.test.ts`

**Interfaces:**
- Consumes: `runInDurableObject` (to force hibernation/eviction simulation), `getNamedDo`, the `UserConnection` attachment. This validates the contract §12.3 + design §3.2 acceptance: "hibernation wake 后 reconnect + replay 不丢事件". In vitest-pool-workers there is no first-class "evict the DO" API, but hibernation's correctness property is that `serializeAttachment`/`deserializeAttachment` round-trips through eviction. We simulate by: (1) connect + register + send a message (seeds an event), (2) read the attachment's `per_channel_cursors` via `runInDurableObject`, (3) construct a NEW upgrade request with `cursors` = the serialized cursor map (simulating a reconnect after eviction), (4) assert replay delivers the events that occurred after that cursor.

- [ ] **Step 1: Write the hibernation-wake test**

`test/integration/hibernation-wake.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

// Simulate the hibernation-wake reconnect: a socket's per_channel_cursors are
// persisted in serializeAttachment; on a reconnect (new socket) the client passes
// those cursors and the DO replays events after them. We assert the DO replays
// the message.created event that was committed BEFORE the reconnect but AFTER
// the cursor we hand it.

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    ws.addEventListener("message", (ev) => { clearTimeout(t); resolve(typeof ev.data === "string" ? ev.data : ""); }, { once: true });
  });
}

function encodeCursors(map: Record<string, string>): string {
  return btoa(JSON.stringify(map)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("hibernation wake: cursors restore + replay", () => {
  it("reconnecting with a stale cursor replays events after it", async () => {
    const userId = "u-hib-1";
    const sysStub = getNamedDo(env.CHAT_CHANNEL, "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    await sysStub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as any).channel_id;

    // seed an event with a known event_id by sending directly
    const send = await (await sysStub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ client_message_id: "cm-hib-1", dedupe_principal_key: `user:${userId}`, type: "text", text: "before reconnect", reply_to: null, mentions: [], channel_id: sysId }) }))).json() as any;
    const seededEventId = send.event_id;

    // reconnect with a cursor BEFORE the seeded event (empty string → replay all)
    const uc = getNamedDo(env.USER_CONNECTION, userId);
    const res = await uc.fetch(new Request(`https://x/ws?cursors=${encodeCursors({ [sysId]: "" })}`, {
      headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
    }));
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();

    // registerOnlineOnConnect replays after the cursor; the seeded event should arrive
    const evRaw = await nextMessage(ws);
    const ev = JSON.parse(evRaw);
    expect(ev.frame_type).toBe("event");
    expect(ev.event_id).toBe(seededEventId);
    ws.close();
  });

  it("serializeAttachment round-trips per_channel_cursors (the eviction safety property)", async () => {
    const userId = "u-hib-2";
    const uc = getNamedDo(env.USER_CONNECTION, userId);
    const cursors = encodeCursors({ "ch-x": "01JCURSOR" });
    const res = await uc.fetch(new Request(`https://x/ws?cursors=${cursors}`, {
      headers: { Upgrade: "websocket", "X-Verified-User-Id": userId },
    }));
    expect(res.status).toBe(101);

    const { runInDurableObject } = await import("cloudflare:test") as any;
    await runInDurableObject(uc, async (_inst: unknown, state: { getWebSockets: () => WebSocket[] }) => {
      const att = (state.getWebSockets()[0] as WebSocket).deserializeAttachment() as any;
      expect(att.per_channel_cursors["ch-x"]).toBe("01JCURSOR");
    });
    (res.webSocket as WebSocket).accept();
    (res.webSocket as WebSocket).close();
  });
});
```

- [ ] **Step 2: Run the hibernation-wake test**

Run: `npm run test:once -- test/integration/hibernation-wake.test.ts`
Expected: both PASS. The first test proves `registerOnlineOnConnect` replays after the `cursors` param. The second proves the attachment round-trips the cursor map (the core hibernation safety property — `deserializeAttachment` restores what `serializeAttachment` stored, which is exactly what happens when the runtime recreates the DO after eviction).

- [ ] **Step 3: Commit**

```bash
git add test/integration/hibernation-wake.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "test(integration): hibernation wake restores cursors + replays missed events"
```

---

## Task 8: member.left triggers ChannelFanout drop (acceptance)

**Files:**
- Test: `test/integration/member-left-unsubscribe.test.ts`
- (No production change expected — `ChatChannel` leave already writes a `user_directory` outbox row in Phase 1; Phase 2 adds that leave ALSO writes a `channel_fanout` `unregister-user` outbox row. **This requires a small production edit** to the Phase-1 `/internal/test-leave` path OR a new `/internal/leave` endpoint. Per the design, `member.left` is a Phase-3 feature (channel/member management), but the *unsubscribe-on-leave* wiring is a Phase-2 acceptance per design §3.3. For Phase 2 we wire it through the existing test-leave path so the acceptance test passes; Phase 3 will add the real HTTP leave endpoint.)

**Interfaces:**
- Consumes: `ChatChannel /internal/test-leave` (header `X-Test-Only:1`), `ChannelFanout /unregister-user`, `ChatChannel` alarm, `UserConnection /deliver` (for the gate test).
- Produces:
  - A shared `ChatChannel` private method `markMemberLeftAndEnqueueFanoutUnregister(channelId: string, userId: string, nowIso: string): Promise<void>` that runs **in a single `ctx.storage.transaction`**: `UPDATE members SET left_at=...` AND inserts the `channel_fanout` outbox row with `{ action: "unregister-user", channel_id, user_id }`. Both writes are co-atomic — a leave that doesn't enqueue the unregister is impossible. The real Phase-3 leave endpoint will call this same method (P1-3: don't bury the logic in a test-only path).
  - `ChatChannel /internal/test-leave` calls `markMemberLeftAndEnqueueFanoutUnregister` then `scheduleOutboxAlarm`.
  - The alarm's `channel_fanout` branch dispatches on `payload.action` (`unregister-user` vs `fanout`) — this replaces the Task-4 simple `channel_fanout` block.

- [ ] **Step 1: Write failing tests (drop-sessions + deliver-gate)**

`test/integration/member-left-unsubscribe.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";

describe("member.left → ChannelFanout drops the user", () => {
  it("after leave + alarm, ChannelFanout has no session for the user", async () => {
    const userId = "u-leave-1";
    const sysStub = getNamedDo(env.CHAT_CHANNEL, "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    await sysStub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as any).channel_id;

    // register online directly (simulating a live session)
    const fanout = getNamedDo(env.CHANNEL_FANOUT, sysId);
    await fanout.fetch(new Request("https://x/register-online", {
      method: "POST", headers: { "X-Channel-Id": sysId, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, session_id: "s-leave-1", membership_version: 1 }),
    }));

    // leave via the test-leave path (UPDATE members + channel_fanout unregister outbox, one txn)
    await sysStub.fetch(new Request("https://x/internal/test-leave", {
      method: "POST", headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));

    // flush the channel_fanout unregister outbox
    const { runDurableObjectAlarm } = await import("cloudflare:test") as any;
    await runDurableObjectAlarm(sysStub);

    const dump = await (await fanout.fetch(new Request("https://x/dump", { headers: { "X-Channel-Id": sysId } }))).json() as any;
    expect(dump.sessions.filter((s: any) => s.user_id === userId)).toEqual([]);
  });

  // P0-4: the deliver gate must drop an event when the user has left but the
  // channel_fanout unregister outbox has NOT been flushed yet (the race window).
  // Two-layer guarantee: even if the session is still in online_sessions, the
  // UserConnection /deliver membership_version gate refuses the event.
  it("deliver gate drops an event for a user who left, even before unregister outbox flushes", async () => {
    const userId = "u-leave-2";
    const sysStub = getNamedDo(env.CHAT_CHANNEL, "system-general");
    await sysStub.fetch(new Request("https://x/internal/maybe-create-system", { method: "POST", body: JSON.stringify({ title: "Lilium" }) }));
    await sysStub.fetch(new Request("https://x/internal/join", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) }));
    const sysId = (await (await sysStub.fetch(new Request("https://x/internal/summary", { headers: { "X-Verified-User-Id": userId } }))).json() as any).channel_id;

    // open a real WS so the UserConnection DO has a live socket + subscribed_channels entry
    const uc = getNamedDo(env.USER_CONNECTION, userId);
    const up = await uc.fetch(new Request("https://x/ws", { headers: { Upgrade: "websocket", "X-Verified-User-Id": userId } }));
    const ws = up.webSocket as WebSocket;
    ws.accept();

    // wait for registerOnlineOnConnect to record the subscription (membership_version = join version)
    const { runInDurableObject } = await import("cloudflare:test") as any;
    let subVersion = -1;
    for (let i = 0; i < 40; i++) {
      await runInDurableObject(uc, async (_inst: unknown, state: { getWebSockets: () => WebSocket[] }) => {
        const att = (state.getWebSockets()[0] as WebSocket).deserializeAttachment() as any;
        subVersion = att?.subscribed_channels?.[sysId] ?? -1;
      });
      if (subVersion >= 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(subVersion).toBeGreaterThanOrEqual(0);

    // leave — this bumps channel membership_version (join wrote mv=1; leave → mv=2 via the
    // test-leave path which we make also bump membership_version; see Step 3). We do NOT flush
    // the unregister outbox, so the session is still in ChannelFanout online_sessions.
    await sysStub.fetch(new Request("https://x/internal/test-leave", {
      method: "POST", headers: { "X-Test-Only": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    }));

    // a later event arrives with membership_version_at_event > subscription version.
    // Deliver directly to UserConnection (bypassing ChannelFanout) to isolate the gate.
    const laterEvent = JSON.stringify({ frame_type: "event", api_version: "lilium.chat.v1", event_id: "e-after-leave", type: "message.created", channel_id: sysId, occurred_at: "2026-06-23T00:00:00Z", payload: {} });
    let sessionId = "";
    await runInDurableObject(uc, async (_inst: unknown, state: { getWebSockets: () => WebSocket[] }) => {
      sessionId = ((state.getWebSockets()[0] as WebSocket).deserializeAttachment() as any).session_id;
    });
    const deliverRes = await uc.fetch(new Request("https://x/deliver", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Channel-Id": sysId },
      body: JSON.stringify({ session_id: sessionId, event_json: laterEvent, membership_version_at_event: subVersion + 10 }),
    }));
    expect(deliverRes.status).toBe(200);
    const db = (await deliverRes.json()) as any;
    expect(db.delivered).toBe(false);
    expect(db.dropped).toBe("not_member");

    // confirm nothing was sent on the socket: wait a short beat, then check the probe.
    // (The gate returned delivered:false WITHOUT calling ws.send, so last_deliver is not set
    // to this event — it still holds whatever registerOnlineOnConnect replay delivered, or null.)
    await new Promise((r) => setTimeout(r, 150));
    const probe = await (await uc.fetch(new Request("https://x/test-last-deliver", { headers: { "X-Channel-Id": sysId } }))).json() as any;
    expect(probe.event_json ?? "").not.toContain('"e-after-leave"');
    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:once -- test/integration/member-left-unsubscribe.test.ts`
Expected: FAIL — after leave + alarm, the session still exists (no `channel_fanout` unregister outbox row was written).

- [ ] **Step 3: Add the shared `markMemberLeftAndEnqueueFanoutUnregister` method + rewrite `/internal/test-leave`**

Add a new private method to the `ChatChannel` class. It runs the `UPDATE members` and the `channel_fanout` unregister outbox insert **in one transaction**, and bumps `channel_meta.membership_version` so the deliver gate (which compares `membership_version_at_event` to the subscription snapshot) can detect the leave. This is the single source of truth for "user left this channel"; the Phase-3 real leave endpoint will call it too (P1-3).

```typescript
  private async markMemberLeftAndEnqueueFanoutUnregister(channelId: string, userId: string, nowIso: string): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(
        "UPDATE members SET left_at=? WHERE channel_id=? AND user_id=?",
        nowIso, channelId, userId,
      );
      const meta = this.ctx.storage.sql.exec("SELECT membership_version, member_count FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as
        | { membership_version: number; member_count: number } | undefined;
      const nextMv = (meta?.membership_version ?? 0) + 1;
      const nextCount = Math.max(0, (meta?.member_count ?? 1) - 1);
      this.ctx.storage.sql.exec(
        "UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?",
        nextMv, nextCount, nowIso, channelId,
      );
      const fanoutPayload = { action: "unregister-user", channel_id: channelId, user_id: userId };
      this.ctx.storage.sql.exec(
        "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'channel_fanout', ?, '', ?, 'pending', ?, ?, ?, 0, 5)",
        `channel_fanout:unregister:${channelId}:${userId}:${nowIso}`,
        channelId,
        JSON.stringify(fanoutPayload),
        nowIso, nowIso, nowIso,
      );
    });
  }
```

Then rewrite the `/internal/test-leave` handler to call it (replace the existing handler body that only does `UPDATE members SET left_at=...`):
```typescript
    if (url.pathname === "/internal/test-leave") {
      const testOnly = request.headers.get("X-Test-Only");
      if (testOnly !== "1") return new Response("forbidden", { status: 403 });
      const b = (await request.json()) as { user_id: string };
      const userId = b.user_id;
      const meta = this.ctx.storage.sql.exec("SELECT channel_id FROM channel_meta").toArray()[0] as { channel_id: string } | undefined;
      if (meta === undefined) return new Response("not found", { status: 404 });
      const now = this.nowIso();
      await this.markMemberLeftAndEnqueueFanoutUnregister(meta.channel_id, userId, now);
      await this.scheduleOutboxAlarm(now);
      return Response.json({ ok: true });
    }
```

- [ ] **Step 4: Extend the `alarm()` `channel_fanout` branch to handle `action: "unregister-user"`**

In `src/do/chat-channel.ts` `alarm()`, in the `if (r.target_kind === "channel_fanout")` block, dispatch on `payload.action`:
```typescript
      if (r.target_kind === "channel_fanout") {
        const payload = JSON.parse(r.payload_json) as { action: string; channel_id: string; event_id?: string; event_json?: string; membership_version_at_event?: number; user_id?: string };
        const target = this.env.CHANNEL_FANOUT.getByName(r.target_key);
        try {
          let res: Response;
          if (payload.action === "unregister-user") {
            res = await target.fetch(new Request("https://x/unregister-user", {
              method: "POST",
              headers: { "X-Channel-Id": r.target_key, "Content-Type": "application/json" },
              body: JSON.stringify({ user_id: payload.user_id ?? "" }),
            }));
          } else {
            res = await target.fetch(new Request("https://x/fanout-enqueue", {
              method: "POST",
              headers: { "X-Channel-Id": r.target_key, "Content-Type": "application/json" },
              body: JSON.stringify({ event_id: payload.event_id ?? "", event_json: payload.event_json ?? "", membership_version_at_event: payload.membership_version_at_event ?? 0 }),
            }));
          }
          if (!res.ok) {
            const text = await res.text();
            await this.bumpOutboxRetry(r.outbox_id, nowIso, `${res.status}: ${text}`);
            continue;
          }
          this.ctx.storage.sql.exec("UPDATE projection_outbox SET status='delivered', updated_at=?, last_error=NULL WHERE outbox_id=?", nowIso, r.outbox_id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.bumpOutboxRetry(r.outbox_id, nowIso, msg);
        }
        continue;
      }
```
(This replaces the Task-4 `channel_fanout` block with the action-dispatching version.)

- [ ] **Step 5: Run the member-left test + full suite**

Run: `npm run test:once -- test/integration/member-left-unsubscribe.test.ts && npm run test:once && npm run typecheck`
Expected: member-left test PASSES; full suite green; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/do/chat-channel.ts test/integration/member-left-unsubscribe.test.ts
git -c user.name=kuma -c user.email=kuma@kuma.homes commit -m "feat(do): member.left writes channel_fanout unregister outbox (drop online sessions)"
```

---

## Task 9: Final full-suite + typecheck + Phase 2 acceptance sign-off

**Files:**
- (none — verification only)

**Interfaces:**
- Consumes: the entire Phase 2 implementation.
- Produces: confirmation that contract §12.3 + design §8 Phase 2 acceptance is met.

- [ ] **Step 1: Clean full run**

Run:
```bash
npm run typecheck && npm run test:once
```
Expected: `tsc --noEmit` exits 0; all tests pass (Phase 0/1/2). Count the tests; note any newly-flaky timing-based e2e tests and stabilize (the poll-before-send pattern in Task 5 should make e2e deterministic).

- [ ] **Step 2: Acceptance checklist (verify against contract §12.3 + design §8 Phase 2)**

Confirm each by pointing to the test that proves it:
- [ ] WS endpoint upgrades via Worker (JWT + Origin + subprotocol) → UserConnection DO. → `test/integration/message-send.test.ts`, `src/routes/ws.test.ts`
- [ ] `message.send` → `committed_ack` (status=committed, channel_id, message_id, event_id). → `test/do/user-connection.test.ts` (ack tests), `test/integration/message-send.test.ts`
- [ ] `message.created` event broadcast, including to the sender. → `test/integration/message-send.test.ts` (self-receive)
- [ ] **Sender receives own event even when sending immediately on open (no poll).** → `test/do/user-connection.test.ts` `ensureSubscribed` path is exercised by the ack tests (the ack tests don't poll ChannelFanout first; `webSocketMessage` calls `ensureSubscribed` synchronously before routing). Confirm by removing the poll from a copy of the e2e and checking self-receive still works.
- [ ] Implicit subscription (my_channels) on connect. → `test/integration/message-send.test.ts` (poll for session row), `test/do/user-connection.test.ts`
- [ ] Per-channel replay on connect (cursors param) + `GET /api/chat/events`. → `test/integration/hibernation-wake.test.ts`, `test/routes/events.test.ts`
- [ ] **Idempotency via `idempotency_keys` (not just `messages UNIQUE`):** same key+body → cached response; same key+different body → `409 IDEMPOTENCY_CONFLICT`; namespaced `dedupe_principal_key` keeps different users' same `client_message_id` separate. → `test/do/chat-channel-message-send.test.ts` (idempotent + IDEMPOTENCY_CONFLICT + namespacing tests)
- [ ] Monotonic `event_id` order. → `ChatChannel.nextEventId` (Phase 0, reused); the e2e test asserts the ack `event_id` equals the received event `event_id`.
- [ ] Hibernation wake restores cursors + replays missed events. → `test/integration/hibernation-wake.test.ts`
- [ ] **`member.left` drops online sessions (outbox flush) AND the deliver gate drops events during the unregister race window.** → `test/integration/member-left-unsubscribe.test.ts` (both tests)
- [ ] **Persisted event payload stores actor refs; live broadcast + replay resolve UserSummary** (no bare user_id on the wire). → `test/chat/event-broadcast.test.ts` (`buildMessageCreatedPayload` ref + `resolveSenderForLiveBroadcast` resolved/fallback tests)
- [ ] **`insertOutboxRowForFanout` is synchronous** — a fanout-outbox insert failure rolls back the message transaction (no committed message with a dropped broadcast). → code review of `ChatChannel.insertOutboxRowForFanout` (returns `void`, called inside `ctx.storage.transaction`).
- [ ] **Phase 2 is text-only:** `message.send` rejects `type!=text`, `reply_to_message_id`, and non-empty `attachment_ids` with `INVALID_MESSAGE`. → `test/chat/command.test.ts` (reject image / reject reply / reject attachment tests)

- [ ] **Step 3: Out-of-scope, explicitly NOT done in Phase 2 (record so the operator knows the boundary):**
- [ ] **No rate limiting.** Design §6.7 specifies per-user/per-channel/per-IP token buckets; Phase 2 does NOT implement them. **This means Phase 2 is NOT production-ready and must not be opened to real clients without Phase-3-or-later rate limiting.** The `rate_buckets` table exists (Phase 0 schema) but is unused.
- [ ] **No observability metrics.** Design §6.8 (WS connection count, send latency, replay lag, fanout/outbox backlog) is not instrumented in Phase 2.
- [ ] **`GET /api/chat/events` returns `last_event_id_per_channel`** (contract §10.3 field name). This is distinct from bootstrap's `event_state.per_channel` (contract §4.1) — they are two different endpoints with two different documented shapes. The frontend must read `last_event_id_per_channel` from `/events` and `event_state.per_channel` from `/bootstrap`. No contract change needed; this is already what v2.1 specifies.

- [ ] **Step 4: Do NOT push or deploy.** Report completion with the final test count and the list of files created/modified. The operator deploys.

---

## Notes for the implementer

- **Timing in e2e tests:** `registerOnlineOnConnect` runs in `ctx.waitUntil` after the 101 returns. The e2e test (Task 5) polls `ChannelFanout /dump` until the session appears before sending — this is a test convenience, NOT a product requirement. The product code does NOT depend on the poll: `webSocketMessage` calls `ensureSubscribed(channel_id)` synchronously before routing `message.send`, so a client that sends immediately on open is still subscribed before the event is enqueued. A real client never needs to wait.
- **`runDurableObjectAlarm`** is the test API to fire a DO's `alarm()` synchronously. Import from `cloudflare:test` (type added in Task 2 Step 5).
- **The `/spike-*` endpoints on ChatChannel are untouched.** They remain for the Phase-0 spike tests. Real Phase-2 writes use `/internal/message-send` + `/internal/replay` + the `alarm()`-flushed outbox.
- **`getByName` vs tests:** production uses `getByName(<id>)` (the wrangler `new_sqite_classes` mapping). Tests must use `getNamedDo(env.BINDING, name)` (which uses `idOfName`+`get`) because the prod name→id mapping isn't available in miniflare. This is already the established Phase-1 convention — follow it everywhere.
- **Live broadcast DOES resolve UserSummary (Hyperdrive is on the hot path).** Per design §3.5, the *persisted* `events.payload_json` stores only the sender ref (`{kind, user_id, bot_id}`), but the *wire* projection (live broadcast frame in the fanout outbox, and the replay output) resolves `sender.user.{display_name, avatar_url}` via `resolveSenderForLiveBroadcast` → `resolveUserSummaries`. This is intentional and spec-required: the client must never render a bare user_id. Fallback is `user-<shortid>` when pg has no row. Do NOT remove the resolve step to "optimize" — that would regress to bare ids.
- **`insertOutboxRowForFanout` is synchronous** (`void`, not `async`). It runs inside `ctx.storage.transaction`; a `sql.exec` failure throws synchronously and aborts the transaction so the message + event are NOT committed without their fanout row. The legacy `insertOutboxRow` (used by `/internal/join` for `user_directory` projection) is still `async`-without-await — left as-is in Phase 2 because a missed `user_directory` projection is repairable, unlike a missed `channel_fanout` row which drops a real-time event. A future cleanup can convert it too.
- **`projection_outbox` `event_id` column** is set to the real `event_id` for `fanout` action and `""` for `unregister-user` action (no event). The `OutboxRow` interface in `chat-channel.ts` doesn't include `event_id` but the column exists in the schema; the alarm reads `payload_json` for the event_id, not the column, so this is fine.
- **`idempotency_keys` expiry:** the row is written with `expires_at = now + 24h` and `status='completed'`. Phase 2 does not GC expired rows (no alarm sweep for `idempotency_keys`); a future task can add one. Correctness is unaffected — an expired row just means a same-key retry after 24h would re-create the message (acceptable; the client_message_id window of interest is short).
