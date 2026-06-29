# Lilium Chat Bot Slash Command Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 7 bot-installation product model with the Slash Command model from `docs/superpowers/specs/2026-06-28-lilium-chat-bot-spec-revised.md`: global slash namespace, per-channel allow/block bindings, bootstrap manifest, stateless `command.invoke`, and stateful command sessions.

**Architecture:** `BotRegistry` (singleton) owns bot identity, tokens, global command catalog, and `bot_command_names` (global slash namespace). `ChatChannel` owns `channel_command_bindings` + `command_manifest_version` + stateful sessions + `stateful_session_inputs`; manifest is projected locally without BotRegistry on bootstrap hot path. **`BotConnection` (by `bot_id`) owns `active_stateful_session_refs`** — a reconnect routing index `{session_id, channel_id, bot_id, status}` so reconnect can find which ChatChannel DOs to call without enumerating all channels. Allow binding reads BotRegistry once at PATCH time and stores `command_snapshot_json`. `UserConnection` routes WS `command.invoke` to ChatChannel; stateless delivery reuses existing `bot_delivery_outbox` → `BotConnection` pipeline; stateful sessions add `session.*` Bot Gateway frames and input replay via refs + per-channel input rows.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), Hono, vitest-pool-workers, jose (browser JWT), existing scheduler/outbox/idempotency patterns.

**Spec authority:** `docs/superpowers/specs/2026-06-28-lilium-chat-bot-spec-revised.md`

**Frontend plan (separate repo):** `dzmm_archive/docs/superpowers/plans/2026-06-28-lilium-chat-bot-slash-command-frontend.md`

---

## Required Context

Read before editing:

- `docs/superpowers/specs/2026-06-28-lilium-chat-bot-spec-revised.md`
- `docs/api-contract.md` (will be superseded in Task 1)
- `AGENTS.md` § DO topology, scheduler, migrations
- `src/do/chat-channel.ts` (existing bot-install + binding handlers to remove)
- `src/do/bot-registry.ts` (existing catalog sync to refactor)
- `src/do/bot-connection.ts` (stateless delivery — extend for session frames)
- `src/do/user-connection.ts` (`command.invoke` currently stubbed)

## Global Constraints

- **Greenfield DB:** Database is empty — **no product migration, no data preservation, no upgrade path from old installation schema.** Rewrite `*_BASELINE_SCHEMA` and bump `*_CURRENT_SCHEMA_VERSION` only because the migration runner requires a version stamp. Do **not** add `up()` steps that upgrade v3→v4 or preserve old rows. If the runner requires a versioned `up()` for local/test DO stores, it is a **defensive schema reset only** (e.g. `DROP TABLE IF EXISTS` + recreate), not a compatibility migration. Delete `bot_installations`, `channel_command_names`, `channel_bot_event_subscriptions`, `bot_event_capabilities` from ChatChannel/BotRegistry baselines — they must not appear in fresh-create schema.
- **Product model:** Users/admins manage **Slash Commands**, not Bot installations. No `POST .../bot-installations`.
- **Global slash namespace:** `bot_command_names(slash_token PK)` lives in BotRegistry. Conflict at catalog sync time, not per-channel.
- **Manifest hot path:** `GET /api/chat/bootstrap?channel_id=` and slash palette must not call BotRegistry. Manifest built from `channel_command_bindings` only.
- **Bootstrap shape:** Extend existing `GET /api/chat/bootstrap?channel_id=` with `command_manifest` (do **not** add `GET /channels/{id}/bootstrap`).
- **Binding API:** `PATCH .../commands/{bot_command_id}` body uses `status: "allowed" | "blocked"` (not `enabled: boolean`).
- **Event delta:** `command.binding_updated` payload **must** include required `command_manifest_delta` (greenfield v1).
- **DM channels:** Command routes return `UNSUPPORTED_CHANNEL_KIND` or empty manifest per DM addendum.
- **Scheduler:** Never call `ctx.storage.setAlarm` directly; use `scheduleNextAlarm` / `runDueJobs`.
- **Tests:** `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`
- **Typecheck after wrangler binding changes:** `npm run cf-typegen && npm run typecheck`
- **Git:** Conventional Commits. Do NOT push or deploy.

## File Structure

**Create:**

- `docs/api-contract/2026-06-28-bot-slash-command-contract-addendum.md` — contract delta vs v2.15
- `src/chat/slash-token.ts` — `normalizeSlashToken`, validation
- `src/chat/command-manifest.ts` — manifest projection + delta builders (pure)
- `src/chat/command-invoke.ts` — `parseCommandInvokeCommand` (pure)
- `src/chat/stateful-session.ts` — listen_rules match, session wire helpers (pure)
- `src/routes/bots.ts` — Browser bot developer API (`POST/GET /bots`, tokens)
- `src/routes/command-directory.ts` — `GET /commands/directory`
- `src/routes/stateful-session.ts` — `GET/POST .../stateful-session`
- `test/chat/slash-token.test.ts`
- `test/chat/command-manifest.test.ts`
- `test/routes/bots.test.ts`
- `test/routes/command-directory.test.ts`
- `test/routes/command-manifest-bootstrap.test.ts`
- `test/do/stateful-session.test.ts`
- `test/do/command-invoke.test.ts`

**Modify:**

- `src/do/migrations/bot-registry.ts` — baseline schema reset (global names, execution_mode; no `bot_event_capabilities`)
- `src/do/migrations/chat-channel.ts` — baseline schema reset (new bindings, stateful tables; no install tables)
- `src/do/bot-registry.ts` — catalog sync + bot CRUD + directory search + `/internal/command-get`
- `src/do/chat-channel.ts` — remove bot-install; new binding/manifest/invoke/stateful handlers
- `src/do/chat-channel/routes/bot-routes.ts` — route map updates
- `src/do/migrations/bot-connection.ts` — add `active_stateful_session_refs` to baseline
- `src/do/bot-connection.ts` — session WS frames + session ref index + reconnect resume
- `src/do/user-connection.ts` — wire `command.invoke`
- `src/chat/channel-events.ts` — `buildCommandBindingUpdatedPayload` + manifest delta
- `src/chat/command-options.ts` — `execution.mode` stateful config validation
- `src/chat/bot-gateway-protocol.ts` — session frame builders/parsers
- `src/contract/bot-api.ts`, `src/contract/events.ts`, `src/contract/bot-gateway.ts`, `src/contract/persisted.ts`
- `src/errors.ts` — new error codes from spec §14
- `src/routes/bootstrap.ts` — attach `command_manifest`
- `src/routes/bot.ts` — remove `event_capabilities` from sync handler body
- `src/routes/bot-installations.ts` — **delete** (move binding + list handlers elsewhere)
- `src/index.ts` — route table swap
- `docs/bot-developer-guide.md` — align with new model

**Delete:**

- `src/routes/bot-installations.ts`
- `test/routes/bot-installations.test.ts`
- Tests asserting per-channel slash conflict / `?prefix=` hot path / bot-install flows

---

## Task 1: Contract Addendum + Shared Types

**Files:**

- Create: `docs/api-contract/2026-06-28-bot-slash-command-contract-addendum.md`
- Modify: `src/contract/bot-api.ts`
- Modify: `src/contract/events.ts`
- Modify: `src/contract/persisted.ts`
- Modify: `src/errors.ts`
- Test: `test/errors.test.ts`
- Test: `test/chat/channel-events-binding-updated.test.ts` (persisted + replay delta)

- [ ] **Step 1: Write contract addendum**

Create `docs/api-contract/2026-06-28-bot-slash-command-contract-addendum.md` documenting:

- Remove Browser routes: `POST/PATCH .../bot-installations`, `PATCH .../event-subscriptions/message.created`
- Add Browser routes: `POST/GET /api/chat/bots`, `GET /api/chat/bots/{bot_id}`, `GET /api/chat/bots/{bot_id}/tokens`, `POST/DELETE .../tokens`, `GET /api/chat/commands/directory`, `GET/POST .../stateful-session`
- Defer (document explicitly): `PATCH /api/chat/bots/{bot_id}` — v1.1
- Change `PATCH .../commands/{bot_command_id}` to `{ status, permission_override?, stateful_max_ttl_seconds? }`
- Change `GET .../commands` to full manifest `{ version, items[] }` (no required `?prefix=`)
- Change `PUT /bot/commands` to include `execution.mode` / `execution.stateful`; remove `event_capabilities`, `default_enabled_on_install`
- Global `COMMAND_NAME_CONFLICT` at catalog sync with `conflict` object
- Extend `command.binding_updated` with `command_manifest_delta`
- Add events: `stateful_session.started`, `stateful_session.updated`, `stateful_session.closed`
- Bot Gateway session frames §10.3–10.6

- [ ] **Step 2: Add types to `src/contract/bot-api.ts`**

Add at end of file:

```ts
export type CommandExecutionMode = "stateless" | "stateful";

export interface CommandStatefulConfig {
  mutex_scope: "channel";
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  listen_capability: {
    message_types: string[];
    include_bot_messages: boolean;
    include_own_messages: boolean;
  };
}

export interface CommandExecutionSpec {
  mode: CommandExecutionMode;
  stateful?: CommandStatefulConfig;
}

export interface CommandManifestBotSummary {
  bot_id: string;
  display_name: string;
  avatar_url: string | null;
}

export interface CommandManifestItem {
  bot_command_id: string;
  name: string;
  aliases: string[];
  description: string;
  bot: CommandManifestBotSummary;
  options: unknown[];
  effective_member_permission: "member" | "admin" | "owner";
  execution: CommandExecutionSpec;
}

export interface CommandManifestResponse {
  version: number;
  items: CommandManifestItem[];
}

export interface CommandManifestDelta {
  op: "upsert" | "remove";
  manifest_version: number;
  item?: CommandManifestItem;
}

export interface ChannelCommandBindingPatchRequest {
  status: "allowed" | "blocked";
  permission_override?: "member" | "admin" | "owner" | null;
  stateful_max_ttl_seconds?: number | null;
}

export interface BotAppSummary {
  bot_id: string;
  owner_user_id: string;
  display_name: string;
  avatar_url: string | null;
  description: string | null;
  visibility: "private" | "unlisted" | "public" | "official";
  status: "active" | "disabled" | "deleted";
  command_count?: number;
  created_at: string;
  updated_at: string;
}

export interface BotTokenCreated {
  token_id: string;
  name: string;
  scopes: string[];
  plaintext: string;
  created_at: string;
  expires_at: string | null;
}
```

- [ ] **Step 3: Extend event payload types in `src/contract/events.ts`**

Add to imports from `./bot-api`: `CommandManifestDelta`, `CommandManifestItem`.

Extend `CommandBindingUpdatedEventPayload`:

```ts
export interface CommandBindingUpdatedEventPayload {
  channel_id: ChatId;
  bot_id: ChatId;
  bot_command_id: ChatId;
  binding_changes: Record<string, { before: unknown; after: unknown }>;
  actor?: UserSummary | null;
  command_manifest_delta: CommandManifestDelta;
}
```

Add new event types to `ChatEventType`:

```ts
  | "stateful_session.started"
  | "stateful_session.updated"
  | "stateful_session.closed"
```

Add payload interfaces:

```ts
export interface StatefulSessionSummary {
  session_id: string;
  bot_command_id: string;
  command_name: string;
  status: string;
  started_by: UserSummary;
  started_at: IsoDateTimeString;
  expires_at: IsoDateTimeString;
}

export interface StatefulSessionStartedPayload {
  session: StatefulSessionSummary;
}

export interface StatefulSessionClosedPayload {
  session_id: string;
  bot_command_id: string;
  command_name: string;
  status: string;
  reason: string;
  closed_at: IsoDateTimeString;
}
```

Register in `ChatEventWirePayloadMap` and `DOMAIN_TIMELINE_EVENT_TYPES` for the three stateful events.

- [ ] **Step 3b: Persist `command_manifest_delta` on wire and replay paths**

Extend `CommandBindingUpdatedPersistedPayload` in `src/contract/persisted.ts`:

```ts
import type { CommandManifestDelta } from "./bot-api";

export interface CommandBindingUpdatedPersistedPayload extends ActorPersistedFields {
  channel_id: string;
  bot_id: string;
  bot_command_id: string;
  binding_changes: Record<string, { before: unknown; after: unknown }>;
  command_manifest_delta: CommandManifestDelta;
}
```

Update `buildCommandBindingUpdatedPayload` in `src/chat/channel-events.ts`:

```ts
export function buildCommandBindingUpdatedPayload(raw: {
  channel_id: string;
  bot_id: string;
  bot_command_id: string;
  binding_changes: Record<string, { before: unknown; after: unknown }>;
  actor_kind: string;
  actor_id: string;
  command_manifest_delta: CommandManifestDelta;
}): CommandBindingUpdatedPersistedPayload {
  return {
    channel_id: raw.channel_id,
    bot_id: raw.bot_id,
    bot_command_id: raw.bot_command_id,
    binding_changes: raw.binding_changes,
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
    command_manifest_delta: raw.command_manifest_delta,
  };
}
```

In `resolveActorWithMap` / management replay projection: pass `command_manifest_delta` through unchanged (it is already a Browser projection shape; do not strip it on replay).

Write `test/chat/channel-events-binding-updated.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCommandBindingUpdatedPayload } from "../../src/chat/channel-events";

describe("buildCommandBindingUpdatedPayload", () => {
  it("persists command_manifest_delta for replay", () => {
    const payload = buildCommandBindingUpdatedPayload({
      channel_id: "ch-1",
      bot_id: "bot-1",
      bot_command_id: "cmd-1",
      binding_changes: { status: { before: "blocked", after: "allowed" } },
      actor_kind: "user",
      actor_id: "user-1",
      command_manifest_delta: {
        op: "upsert",
        manifest_version: 2,
        item: {
          bot_command_id: "cmd-1",
          name: "ask",
          aliases: [],
          description: "Ask",
          bot: { bot_id: "bot-1", display_name: "Bot", avatar_url: null },
          options: [],
          effective_member_permission: "member",
          execution: { mode: "stateless" },
        },
      },
    });
    expect(payload.command_manifest_delta.op).toBe("upsert");
    expect(payload.command_manifest_delta.manifest_version).toBe(2);
  });
});
```

Add integration test (in `test/routes/channel-commands.test.ts` or dedicated file): fetch channel timeline/history after binding update and assert replayed `command.binding_updated` event wire payload still includes `command_manifest_delta`.

- [ ] **Step 4: Add error codes to `src/errors.ts`**

```ts
  COMMAND_NOT_ALLOWED: 403,
  COMMAND_PERMISSION_DENIED: 403,
  COMMAND_OPTIONS_INVALID: 422,
  COMMAND_MANIFEST_VERSION_STALE: 409,
  STATEFUL_SESSION_BUSY: 409,
  STATEFUL_SESSION_NOT_FOUND: 404,
  STATEFUL_SESSION_NOT_ACTIVE: 409,
  STATEFUL_SESSION_PERMISSION_DENIED: 403,
  STATEFUL_SESSION_EXPIRED: 410,
  STATEFUL_INPUT_BACKLOG_OVERFLOW: 429,
  BOT_TOKEN_INVALID: 401,
  BOT_TOKEN_REVOKED: 401,
  BOT_SCOPE_DENIED: 403,
  BOT_DISABLED: 403,
```

Add `BOT_OFFLINE` to `RETRYABLE_CODES` if not already present.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: PASS (fix any broken references from payload shape change)

- [ ] **Step 6: Commit**

```bash
git add docs/api-contract/2026-06-28-bot-slash-command-contract-addendum.md \
  src/contract/bot-api.ts src/contract/events.ts src/contract/persisted.ts \
  src/chat/channel-events.ts src/errors.ts test/chat/channel-events-binding-updated.test.ts
git commit -m "docs(contract): add bot slash command addendum and shared types"
```

---

## Task 2: Slash Token Normalization (Pure)

**Files:**

- Create: `src/chat/slash-token.ts`
- Create: `test/chat/slash-token.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/chat/slash-token.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeSlashToken, validateSlashToken, collectSlashTokens } from "../../src/chat/slash-token";

describe("normalizeSlashToken", () => {
  it("strips leading slashes and lowercases", () => {
    expect(normalizeSlashToken("/Ask")).toBe("ask");
    expect(normalizeSlashToken("  /AI  ")).toBe("ai");
  });

  it("applies NFKC", () => {
    expect(normalizeSlashToken("ＡＳＫ")).toBe("ask");
  });
});

describe("validateSlashToken", () => {
  it("rejects empty", () => {
    expect(validateSlashToken("")).toEqual({ ok: false, error: "empty" });
  });

  it("rejects whitespace", () => {
    expect(validateSlashToken("a b")).toEqual({ ok: false, error: "invalid_characters" });
  });

  it("rejects length over 32 code points", () => {
    expect(validateSlashToken("a".repeat(33))).toEqual({ ok: false, error: "too_long" });
  });

  it("accepts unicode alias", () => {
    expect(validateSlashToken("狼人杀")).toEqual({ ok: true, token: "狼人杀" });
  });
});

describe("collectSlashTokens", () => {
  it("returns canonical, aliases, and all tokens", () => {
    const out = collectSlashTokens("/Ask", ["AI"]);
    expect(out).toEqual({
      ok: true,
      canonical: "ask",
      aliases: ["ai"],
      all: ["ask", "ai"],
    });
  });

  it("rejects duplicate canonical/alias in same request", () => {
    expect(collectSlashTokens("ask", ["ASK"])).toEqual({ ok: false, error: "duplicate_in_request" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/slash-token.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`

Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/chat/slash-token.ts`**

```ts
export interface SlashTokenOk {
  ok: true;
  token: string;
}

export interface SlashTokenError {
  ok: false;
  error: string;
}

export type SlashTokenResult = SlashTokenOk | SlashTokenError;

export interface CollectedSlashTokens {
  ok: true;
  canonical: string;
  aliases: string[];
  all: string[];
}

export type CollectSlashTokensResult = CollectedSlashTokens | SlashTokenError;

export function normalizeSlashToken(input: string): string {
  return input
    .trim()
    .replace(/^\/+/, "")
    .normalize("NFKC")
    .toLowerCase();
}

export function validateSlashToken(raw: string): SlashTokenResult {
  const token = normalizeSlashToken(raw);
  if (!token) return { ok: false, error: "empty" };
  if ([...token].length > 32) return { ok: false, error: "too_long" };
  if (/\s/.test(token)) return { ok: false, error: "invalid_characters" };
  if (/[\u0000-\u001f\u007f]/.test(token)) return { ok: false, error: "invalid_characters" };
  if (token.includes("/")) return { ok: false, error: "invalid_characters" };
  return { ok: true, token };
}

export function collectSlashTokens(name: string, aliases: string[]): CollectSlashTokensResult {
  const canonicalResult = validateSlashToken(name);
  if (!canonicalResult.ok) return canonicalResult;

  const normalizedAliases: string[] = [];
  const seen = new Set<string>([canonicalResult.token]);

  for (const raw of aliases) {
    const v = validateSlashToken(String(raw));
    if (!v.ok) return v;
    if (seen.has(v.token)) return { ok: false, error: "duplicate_in_request" };
    seen.add(v.token);
    normalizedAliases.push(v.token);
  }

  return {
    ok: true,
    canonical: canonicalResult.token,
    aliases: normalizedAliases,
    all: [canonicalResult.token, ...normalizedAliases],
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/chat/slash-token.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat/slash-token.ts test/chat/slash-token.test.ts
git commit -m "feat(chat): add global slash token normalization helpers"
```

---

## Task 3: BotRegistry Baseline Schema Reset (Global Namespace)

**Files:**

- Modify: `src/do/migrations/bot-registry.ts` (rewrite `BOT_REGISTRY_BASELINE_SCHEMA` + bump version)
- Test: `test/do/bot-registry-migrations.test.ts`

**Greenfield rule:** This task rewrites the **fresh-create baseline only**. Do not implement a product migration path from Phase 7 schema. Tests assert new tables exist on fresh DO construction and removed tables are absent from baseline SQL.

- [ ] **Step 1: Write failing baseline schema test**

Add to `test/do/bot-registry-migrations.test.ts`:

```ts
  it("fresh BotRegistry baseline includes bot_command_names and excludes bot_event_capabilities", async () => {
    await withRegistry((ctx) => {
      expect(tableExists(ctx, "bot_command_names")).toBe(true);
      expect(tableExists(ctx, "bot_event_capabilities")).toBe(false);
    });
  });
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run test/do/bot-registry-migrations.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`

- [ ] **Step 3: Rewrite BotRegistry baseline schema**

In `src/do/migrations/bot-registry.ts`:

- Bump `BOT_REGISTRY_CURRENT_SCHEMA_VERSION` (e.g. `4`) because the runner requires a version stamp
- **Rewrite `BOT_REGISTRY_BASELINE_SCHEMA`** in full — do not layer v4 `up()` on top of old Phase 7 tables as a compatibility path
- `bot_apps`: add `description`, `visibility`; remove `callback_url`
- `bot_tokens`: columns per spec §6.1 (`token_id`, `name`, `scopes_json`, `expires_at`, `last_used_at`, `revoked_at`)
- `bot_commands`: add `execution_mode`, `stateful_config_json`, `status`; remove `default_enabled_on_install`, `enabled`
- Add `bot_command_names` to baseline:

```sql
CREATE TABLE IF NOT EXISTS bot_command_names (
  slash_token TEXT PRIMARY KEY,
  bot_command_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- **Do not** include `bot_event_capabilities` in baseline
- If the migration runner requires a versioned `up()` for local/test DO stores that already ran an older version, that `up()` is **defensive reset only** (`DROP TABLE IF EXISTS` + recreate). No row preservation, no upgrade semantics.

- [ ] **Step 4: Run baseline schema tests**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/do/migrations/bot-registry.ts test/do/bot-registry-migrations.test.ts
git commit -m "feat(do): reset bot registry baseline for global slash namespace"
```

---

## Task 4: BotRegistry Catalog Sync (Global Uniqueness)

**Files:**

- Modify: `src/chat/command-options.ts`
- Modify: `src/do/bot-registry.ts`
- Modify: `src/routes/bot.ts`
- Test: `test/routes/bot-commands.test.ts`
- Test: `test/do/bot-registry.test.ts`

- [ ] **Step 1: Write failing global conflict test**

Add to `test/routes/bot-commands.test.ts`:

```ts
  it("returns COMMAND_NAME_CONFLICT when two bots register the same slash token", async () => {
    const botA = await seedBotToken("bot-a");
    const botB = await seedBotToken("bot-b");
    const syncA = await putCommands(botA, {
      commands: [{ name: "ask", aliases: [], description: "A", options: [], default_member_permission: "member", execution: { mode: "stateless" } }],
    });
    expect(syncA.status).toBe(200);

    const syncB = await putCommands(botB, {
      commands: [{ name: "ask", aliases: [], description: "B", options: [], default_member_permission: "member", execution: { mode: "stateless" } }],
    });
    expect(syncB.status).toBe(409);
    const body = await syncB.json() as { error: { code: string; conflict: { slash_token: string } } };
    expect(body.error.code).toBe("COMMAND_NAME_CONFLICT");
    expect(body.error.conflict.slash_token).toBe("ask");
  });
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Update `validateCommand` in `src/chat/command-options.ts`**

Replace `default_enabled_on_install` with:

```ts
export interface ValidatedCommand {
  name: string;
  aliases: string[];
  description: string;
  options: CommandOption[];
  default_member_permission: "member" | "admin" | "owner";
  execution_mode: "stateless" | "stateful";
  stateful_config: CommandStatefulConfig | null;
}
```

Add validation for `execution.mode` and nested `stateful` block per spec §7.2.

- [ ] **Step 4: Refactor `/internal/commands-sync` in `src/do/bot-registry.ts`**

Inside `transactionSync`:

1. Normalize via `collectSlashTokens(name, aliases)` — use `all` for global conflict checks
2. For each token in `collected.all`, `SELECT bot_command_id FROM bot_command_names WHERE slash_token=?` — if row exists for a different `bot_command_id`, abort whole request with `COMMAND_NAME_CONFLICT` payload
3. Upsert `bot_commands`, replace `bot_command_aliases`, replace `bot_command_names` rows for this bot atomically
4. Do not write `bot_event_capabilities` (table removed)

- [ ] **Step 5: Update `src/routes/bot.ts`**

Remove `event_capabilities` from request body forwarding. Map 409 conflict body to `ApiError("COMMAND_NAME_CONFLICT", ..., { conflict })`.

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/routes/bot-commands.test.ts test/do/bot-registry.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/chat/command-options.ts src/do/bot-registry.ts src/routes/bot.ts test/routes/bot-commands.test.ts test/do/bot-registry.test.ts
git commit -m "feat(bot): global slash namespace on catalog sync"
```

---

## Task 5: Browser Bot Developer API (v1 scope)

**Files:**

- Create: `src/routes/bots.ts`
- Modify: `src/do/bot-registry.ts`
- Modify: `src/index.ts`
- Create: `test/routes/bots.test.ts`

**v1 scope (explicit):**

```text
In scope:
  POST   /api/chat/bots
  GET    /api/chat/bots
  GET    /api/chat/bots/{bot_id}
  GET    /api/chat/bots/{bot_id}/tokens
  POST   /api/chat/bots/{bot_id}/tokens
  DELETE /api/chat/bots/{bot_id}/tokens/{token_id}

Deferred (document in contract addendum, do not implement in this task):
  PATCH  /api/chat/bots/{bot_id}   — bot profile update; spec §13.1 security rule deferred to v1.1
```

`GET /bots/{bot_id}` is required so the developer UI can open a bot detail + token list without scanning the list endpoint. `PATCH` is explicitly deferred.

- [ ] **Step 1: Write failing tests**

Create `test/routes/bots.test.ts` covering:

- `POST /api/chat/bots` — owner creates bot + optional one-time plaintext token (spec §7.1)
- `GET /api/chat/bots` — list with `command_count`
- `GET /api/chat/bots/{bot_id}` — owner can read own bot; non-owner → `403`
- `GET /api/chat/bots/{bot_id}/tokens` — lists token metadata (no plaintext)
- `POST /api/chat/bots/{bot_id}/tokens` + `DELETE .../tokens/{token_id}`

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement BotRegistry internals**

Add routes on BotRegistry DO:

- `POST /internal/bots-create` — insert `bot_apps`, optional `bot_tokens`, return `{ bot, initial_token? }`
- `GET /internal/bots-list?owner_user_id=` — cursor list with `command_count`
- `GET /internal/bots-get?bot_id=` — single bot row (owner check in Worker)
- `GET /internal/bots-tokens-list?bot_id=` — token metadata rows (no plaintext)
- `POST /internal/bots-token-create`
- `POST /internal/bots-token-revoke`

Token plaintext format: `lcbot_` + base64url random; store SHA-256 hash only.

**Archive (spec §0.1 / archive plan §6.4):** each write path appends inside `transactionSync`:

- `bots-create` → `chat_bot_apps` + optional `chat_bot_tokens` (hash/metadata only)
- `bots-token-create` → `chat_bot_tokens` upsert
- `bots-token-revoke` → `chat_bot_tokens` upsert with `revoked_at`

Covered by `test/routes/bots.test.ts` archive_outbox assertion.

- [ ] **Step 4: Implement `src/routes/bots.ts` + register in `src/index.ts`**

```ts
app.post("/api/chat/bots", (c) => createBotHandler(c));
app.get("/api/chat/bots", (c) => listBotsHandler(c));
app.get("/api/chat/bots/:bot_id", (c) => getBotHandler(c));
app.get("/api/chat/bots/:bot_id/tokens", (c) => listBotTokensHandler(c));
app.post("/api/chat/bots/:bot_id/tokens", (c) => createBotTokenHandler(c));
app.delete("/api/chat/bots/:bot_id/tokens/:token_id", (c) => revokeBotTokenHandler(c));
```

Verify `owner_user_id === jwt user_id` on all `/:bot_id` mutations and reads.

- [ ] **Step 5: Run tests + typecheck**

- [ ] **Step 6: Commit**

```bash
git add src/routes/bots.ts src/do/bot-registry.ts src/index.ts test/routes/bots.test.ts
git commit -m "feat(api): browser bot developer list/detail and token management"
```

---

## Task 6: Command Directory Search

**Files:**

- Create: `src/routes/command-directory.ts`
- Modify: `src/do/bot-registry.ts`
- Create: `test/routes/command-directory.test.ts`

- [ ] **Step 1: Write failing test for GET /api/chat/commands/directory?query=werewolf**

- [ ] **Step 2: Implement `/internal/commands-directory` on BotRegistry**

Search `bot_commands` + aliases by normalized prefix/substring on `name`/`alias`; join `bot_apps` for display profile; return paginated `items` per spec §7.3.

- [ ] **Step 3: Wire route + test**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(api): global command directory for admin search"
```

---

## Task 7: ChatChannel Baseline Schema Reset (Bindings + Stateful)

**Files:**

- Modify: `src/do/migrations/chat-channel.ts` (rewrite `CHAT_CHANNEL_BASELINE_SCHEMA` + bump version)
- Test: `test/do/chat-channel-migrations-v2.test.ts` (rename/update)

**Greenfield rule:** Rewrite fresh-create baseline. Removed tables (`bot_installations`, `channel_command_names`, `channel_bot_event_subscriptions`) must not appear in baseline SQL. No product migration from Phase 7 binding shape.

- [ ] **Step 1: Write failing baseline schema tests**

Assert on fresh ChatChannel DO:

- `channel_command_bindings` exists with `command_snapshot_json`, `status`, `stateful_max_ttl_seconds`
- `stateful_command_sessions`, `stateful_session_inputs` exist
- `channel_meta.command_manifest_version` exists
- `bot_installations`, `channel_command_names`, `channel_bot_event_subscriptions` **do not** exist

- [ ] **Step 2: Rewrite ChatChannel baseline schema**

Replace binding table in baseline:

```sql
CREATE TABLE channel_command_bindings (
  channel_id TEXT NOT NULL,
  bot_command_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  status TEXT NOT NULL,
  permission_override TEXT,
  command_snapshot_json TEXT NOT NULL,
  stateful_max_ttl_seconds INTEGER,
  updated_by_user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, bot_command_id)
);
```

Add stateful tables per spec §6.3 including partial unique index:

```sql
CREATE UNIQUE INDEX uniq_active_stateful_session_per_channel
ON stateful_command_sessions(channel_id)
WHERE status IN ('starting', 'active', 'suspended', 'closing');
```

Add `command_manifest_version` to `channel_meta` baseline definition.

- [ ] **Step 3: Run baseline schema tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(do): reset chat channel baseline for slash bindings and stateful sessions"
```

---

## Task 8: Command Manifest Projection (Pure)

**Files:**

- Create: `src/chat/command-manifest.ts`
- Create: `test/chat/command-manifest.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { projectCommandManifest, buildManifestUpsertDelta } from "../../src/chat/command-manifest";

describe("projectCommandManifest", () => {
  it("returns only allowed bindings sorted by name", () => {
    const manifest = projectCommandManifest(3, [
      {
        status: "allowed",
        command_snapshot_json: JSON.stringify({
          bot_command_id: "cmd-1",
          name: "zebra",
          aliases: [],
          description: "Z",
          bot: { bot_id: "b1", display_name: "Bot", avatar_url: null },
          options: [],
          default_member_permission: "member",
          execution: { mode: "stateless" },
        }),
        permission_override: null,
      },
      { status: "blocked", command_snapshot_json: "{}", permission_override: null },
    ]);
    expect(manifest.version).toBe(3);
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]?.name).toBe("zebra");
    expect(manifest.items[0]?.effective_member_permission).toBe("member");
  });
});
```

- [ ] **Step 2: Implement projection + delta helpers**

`projectCommandManifest(version, bindingRows)` parses snapshot JSON, applies `permission_override`, filters `status === "allowed"`.

`buildManifestUpsertDelta(version, item)` / `buildManifestRemoveDelta(version)` return spec §8.1 shapes.

- [ ] **Step 3: Run tests — PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(chat): command manifest projection helpers"
```

---

## Task 9: Allow/Block Binding + Manifest Delta Event

**Files:**

- Modify: `src/do/chat-channel.ts`
- Modify: `src/chat/channel-events.ts`
- Modify: `src/routes/bot-installations.ts` → move to `src/routes/channel-commands.ts`
- Modify: `src/index.ts`
- Delete: bot-install route handlers from `chat-channel.ts`
- Test: rewrite `test/routes/channel-commands.test.ts`

- [ ] **Step 1: Write failing allow test**

```ts
  it("admin allow writes snapshot and emits command.binding_updated with manifest delta", async () => {
    const { channelId, botCommandId } = await seedChannelAndCatalogCommand();
    const res = await browserReq(ownerId, "PATCH", `/api/chat/channels/${channelId}/commands/${botCommandId}`, {
      status: "allowed",
      permission_override: "member",
    }, `key-allow-${crypto.randomUUID()}`);
    expect(res.status).toBe(200);

    const manifestRes = await browserReq(ownerId, "GET", `/api/chat/channels/${channelId}/commands`);
    const manifest = await manifestRes.json() as { version: number; items: unknown[] };
    expect(manifest.items).toHaveLength(1);

    // poll channel events or fanout dump for command.binding_updated payload.command_manifest_delta.op === "upsert"
  });
```

- [ ] **Step 2: Implement `/internal/command-binding-update` refactor**

Flow (spec §12.2):

1. Verify owner/admin
2. If `status === "allowed"`: Worker fetches command from BotRegistry `/internal/command-get?bot_command_id=` **before** DO transaction; pass full definition into ChatChannel request body
3. ChatChannel transaction: upsert binding with `command_snapshot_json`, increment `channel_meta.command_manifest_version`, emit `command.binding_updated` with `command_manifest_delta`
4. If `status === "blocked"`: set blocked or delete row; emit remove delta

Replace `enabled: boolean` with `status: "allowed" | "blocked"`.

- [ ] **Step 3: Remove bot-install handlers**

Delete from `src/do/chat-channel.ts`:

- `handleBotInstall`
- `handleBotInstallUpdate`
- All `channel_command_names` writes
- `bot_installations` / `channel_bot_event_subscriptions` logic

Delete `src/routes/bot-installations.ts` install/update handlers; create `src/routes/channel-commands.ts` with binding + list only.

Update `src/index.ts`:

```ts
// remove:
app.post("/api/chat/channels/:channel_id/bot-installations", ...);
app.patch("/api/chat/channels/:channel_id/bot-installations/:bot_id", ...);
// keep/move:
app.patch("/api/chat/channels/:channel_id/commands/:bot_command_id", ...);
app.get("/api/chat/channels/:channel_id/commands", ...);
```

- [ ] **Step 4: Change GET commands to full manifest (no prefix requirement)**

Return `{ version, items }` from `projectCommandManifest`. Remove prefix filter from hot-path handler (deprecated `?prefix=` query param: ignore and return full manifest; test asserts full list returned even when `?prefix=` present).

- [ ] **Step 4b: DM channel command routes**

Per DM addendum, pick one consistent behavior and test it:

```ts
  it("GET /channels/{dm_id}/commands returns empty manifest", async () => {
    // { version: 0, items: [] }
  });

  it("PATCH /channels/{dm_id}/commands/{bot_command_id} returns UNSUPPORTED_CHANNEL_KIND", async () => {
    // 409 UNSUPPORTED_CHANNEL_KIND
  });
```

- [ ] **Step 5: Run channel command tests**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(channel): allow/block slash commands with manifest delta events"
```

---

## Task 10: Bootstrap Command Manifest

**Files:**

- Modify: `src/routes/bootstrap.ts`
- Modify: `src/do/chat-channel.ts` — `/internal/command-manifest`
- Create: `test/routes/command-manifest-bootstrap.test.ts`

- [ ] **Step 1: Write failing bootstrap test**

When `?channel_id=` set and channel has allowed bindings, bootstrap JSON includes:

```json
{
  "command_manifest": { "version": 1, "items": [ ... ] }
}
```

- [ ] **Step 2: Implement ChatChannel `/internal/command-manifest`**

Read bindings + version; return projected manifest. No BotRegistry call.

- [ ] **Step 3: Extend `bootstrapHandler`**

After resolving `activeChannel`, if present and `kind !== "dm"`, fetch manifest and attach to response.

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(bootstrap): include per-channel command manifest"
```

---

## Task 11: Stateless command.invoke

**Files:**

- Create: `src/chat/command-invoke.ts`
- Modify: `src/do/chat-channel.ts` — `/internal/command-invoke`
- Modify: `src/do/user-connection.ts`
- Create: `test/do/command-invoke.test.ts`

- [ ] **Step 1: Write failing invoke test**

Member invokes allowed command → WS `command_ack` status committed with `{ invocation_id, event_id }`; `command.invoked` event exists; outbox row enqueued.

- [ ] **Step 2: Implement `parseCommandInvokeCommand`**

```ts
export interface ParsedCommandInvoke {
  channel_id: string;
  command_id: string;
  bot_command_id: string;
  invoked_name: string;
  command_manifest_version: number;
  options: Record<string, { type: string; value: unknown }>;
}
```

Validate required fields; map WS frame per spec §9.1.

- [ ] **Step 3: Implement ChatChannel `/internal/command-invoke`**

Checks (spec §12.5):

- idempotency via `idempotency_keys` operation `command.invoke`
- membership + binding `status === "allowed"`
- role vs effective permission
- options validation against snapshot JSON
- optional manifest version stale check → `COMMAND_MANIFEST_VERSION_STALE`
- BotConnection online via `/internal/connection-state` → else `BOT_OFFLINE`
- insert `command_invocations`, emit `command.invoked`, insert `bot_delivery_outbox`

- [ ] **Step 4: Wire UserConnection**

Replace stub block at `command.invoke` with fetch to `/internal/command-invoke` and return committed ack payload.

- [ ] **Step 5: Run tests + existing bot-connection delivery tests**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(ws): implement stateless command.invoke pipeline"
```

---

## Task 12: Stateful Session Core

**Files:**

- Create: `src/chat/stateful-session.ts`
- Modify: `src/do/chat-channel.ts`
- Modify: `src/do/bot-connection.ts`
- Modify: `src/chat/bot-gateway-protocol.ts`
- Modify: `src/contract/bot-gateway.ts`
- Create: `src/routes/stateful-session.ts`
- Create: `test/do/stateful-session.test.ts`

**Event timing rule (normative):** Emit `stateful_session.started` **only after** Bot sends `session.started` and ChatChannel marks the session `active`. Do **not** fanout `stateful_session.started` while status is `starting`. The invoke ack may return `session_id` immediately; the channel-visible started event waits for bot ack.

- [ ] **Step 1: Write failing tests**

```ts
  it("returns STATEFUL_SESSION_BUSY when second stateful invoke races same channel", async () => {
    // first invoke succeeds with session_id; second returns STATEFUL_SESSION_BUSY + active_session
  });

  it("does not emit stateful_session.started until bot sends session.started", async () => {
    // after invoke ack: no stateful_session.started in channel events/fanout
    // after bot session.started: exactly one stateful_session.started with status=active
  });

  it("closes starting session on bot start timeout and releases mutex", async () => {
    // session stays starting past timeout → status failed/closed, mutex released, no started event
  });

  it("replays unacked session.input rows after bot reconnect", async () => {
    // disconnect bot; enqueue inputs; reconnect; BotConnection receives session.input for seq > input_last_acked_seq
  });

  it("closes session with STATEFUL_INPUT_BACKLOG_OVERFLOW when pending inputs exceed max", async () => {
    // pending rows > 1000 → session closed, mutex released
  });

  it("offline stateful invoke returns BOT_OFFLINE and creates no session row", async () => {
    // BotConnection disconnected → command_error BOT_OFFLINE, no stateful_command_sessions insert, mutex free
  });

  it("reconnect uses BotConnection session refs to resume inputs from ChatChannel", async () => {
    // active ref {session_id, channel_id}; reconnect → BotConnection fetches ChatChannel /internal/stateful-session-inputs
  });
```

- [ ] **Step 1b: BotConnection session routing index (required for resume)**

`BotConnection` is named by `bot_id` and **cannot** enumerate ChatChannel DOs. Reconnect resume therefore requires a **bot-scoped session ref index** owned by `BotConnection`.

Add to `src/do/migrations/bot-connection.ts` baseline:

```sql
CREATE TABLE active_stateful_session_refs (
  session_id   TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL,
  bot_id       TEXT NOT NULL,
  status       TEXT NOT NULL,   -- starting | active | suspended | closing
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_active_stateful_session_refs_bot_status
  ON active_stateful_session_refs(bot_id, status, updated_at);
```

Lifecycle (ChatChannel orchestrates, BotConnection stores refs):

1. **Register ref** — when ChatChannel creates `status=starting` session and enqueues `session.start`, it calls `BotConnection /internal/stateful-session-ref-upsert` with `{session_id, channel_id, bot_id, status:"starting"}` in the same logical flow (after ChatChannel transaction commits).
2. **Update ref** — on `session.started` → `status=active`; on `suspended`/`closing` transitions update `status` + `updated_at`.
3. **Delete ref** — on `closed`/`expired`/`failed` → remove row.

BotConnection internal routes:

- `POST /internal/stateful-session-ref-upsert`
- `POST /internal/stateful-session-ref-delete`

ChatChannel internal route for resume payload:

- `GET /internal/stateful-session-inputs?session_id=` — returns session row + inputs where `seq > input_last_acked_seq` ordered by `seq` (active sessions only).

- [ ] **Step 2: Implement stateful invoke branch**

**Precheck (before any session row):** Query `BotConnection /internal/connection-state` for target `bot_id`. If offline → return `BOT_OFFLINE` immediately. **Do not** insert `stateful_command_sessions`, **do not** occupy channel mutex.

On stateful `command.invoke` (bot online):

1. Insert `stateful_command_sessions` with `status=starting` (partial unique index enforces mutex)
2. Call `BotConnection /internal/stateful-session-ref-upsert` to register `{session_id, channel_id, bot_id, status:"starting"}`
3. Enqueue `session.start` to BotConnection (extend `bot_delivery_outbox.kind` with `session_start` or dedicated session outbox — pick one and document in code)
4. Return committed ack including `session_id`
5. **Do not** emit `stateful_session.started` yet
6. When Bot sends `session.started`: ChatChannel marks session `active`, updates ref `status=active`, emits **exactly one** `stateful_session.started` (payload `status=active`)
7. If Bot does not ack `session.started` before start timeout: mark session `failed`/`closed`, **delete ref**, release mutex, optionally notify bot

- [ ] **Step 3: Hook message.created (active sessions only)**

After normal message write, if **active** session matches `listen_rules_json`:

1. Insert `stateful_session_inputs` with `status=pending`, monotonic `seq`
2. Increment `input_next_seq`
3. Enqueue `session.input` to BotConnection

Implement `matchesListenRules(message, rules, session)` in `src/chat/stateful-session.ts`. Ignore messages while session is `starting`.

- [ ] **Step 4: Input ack + send status**

`stateful_session_inputs.status`: `pending | sent | acked | expired`

- On BotConnection push `session.input`: mark row `sent`
- On Bot `session.input_ack` with `last_received_seq`: ChatChannel updates `input_last_acked_seq`, marks inputs `seq <= last_received_seq` as `acked`

- [ ] **Step 5: Resume / redelivery on Bot reconnect**

On Bot Gateway `hello` / connect:

1. BotConnection reads **local** `active_stateful_session_refs WHERE bot_id=? AND status IN ('starting','active','suspended','closing')`
2. For each ref, `ChatChannel(channel_id).fetch('/internal/stateful-session-inputs?session_id=...')` — returns inputs where `seq > input_last_acked_seq` ordered by `seq`
3. BotConnection sends `session.input` frames in order (at-least-once; Bot dedupes by `seq`)
4. If ChatChannel reports pending|sent input count > `max_pending_inputs` (default 1000): ChatChannel closes session with `STATEFUL_INPUT_BACKLOG_OVERFLOW`, emits `stateful_session.closed`, deletes ref, releases mutex

**Do not** implement reconnect by calling a non-existent global ChatChannel enumerator or `ChatChannel /internal/stateful-sessions-active?bot_id=` (ChatChannel is per-channel; it cannot list all channels for a bot).

- [ ] **Step 6: Session close paths**

- Bot `session.close`
- `POST /channels/{id}/stateful-session/stop`
- TTL alarm via scheduler due table on `stateful_command_sessions.expires_at`
- Bot offline grace 120s during active session

Each transitions to closed/expired/failed, emits `stateful_session.closed`, **deletes BotConnection session ref**, releases mutex, stops new input enqueue.

- [ ] **Step 7: HTTP routes GET/POST stateful-session**

- [ ] **Step 8: BotConnection session frame routing**

Parse/send: `session.start`, `session.started`, `session.input`, `session.input_ack`, `session.effects`, `session.effects_ack`, `session.close`, `session.closed`.

- [ ] **Step 9: Run stateful tests (spec §15.6)**

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(stateful): channel mutex sessions with durable input resume"
```

---

## Task 13: Cleanup + Documentation

**Files:**

- Delete: `test/routes/bot-installations.test.ts`
- Modify: `docs/bot-developer-guide.md`
- Modify: archive projection code if it references removed tables

- [ ] **Step 1: Delete obsolete tests and grep cleanup scope**

Run runtime/code grep (must be clean):

```bash
rg "bot-installations|bot_installations|channel_command_names|bot_event_capabilities" src test
```

For each hit in `src/` or `test/`: remove or rewrite (no leftover installation model code/tests).

Docs handling (do **not** delete historical mentions):

- `docs/bot-developer-guide.md` — rewrite for new model (required)
- `docs/api-contract/2026-06-28-bot-slash-command-contract-addendum.md`, `docs/superpowers/specs/`, `docs/superpowers/plans/` — **allowed** to mention removed routes/tables as non-goals or migration notes; do not strip these references

Archive projection (`src/archive/`): update or remove references to deleted ChatChannel tables if present. Slash-catalog PG migration: `scripts/archive-local/migrations/006_slash_catalog_archive.sql` (bot table realignment — see archive spec §0.1). BotRegistry developer API paths (`bots-create`, `bots-token-create`, `bots-token-revoke`) must emit `chat_bot_apps` / `chat_bot_tokens` archive rows (hash only).

- [ ] **Step 2: Update bot developer guide**

Document: global namespace, allow/block model, stateful session protocol, removed installation API.

- [ ] **Step 3: Full verification**

Run: `npm run typecheck`

Run: `npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(bot): remove installation model and update developer guide"
```

---

## Spec Coverage Self-Review

| Spec section | Task |
|---|---|
| §5 Slash token rules | Task 2 |
| §6.1 BotRegistry schema | Tasks 3–4 |
| §6.2 ChatChannel bindings | Tasks 7, 9 |
| §6.3 Stateful tables | Tasks 7, 12 |
| §7.1 Bot developer API | Task 5 (PATCH deferred v1.1) |
| §7.2 Catalog sync | Task 4 |
| §7.3 Command directory | Task 6 |
| §7.4 Bootstrap manifest | Task 10 |
| §7.5 GET commands manifest | Task 9 |
| §7.6 PATCH binding | Task 9 |
| §7.7–7.8 Stateful HTTP | Task 12 |
| §8 Events + delta | Tasks 1, 9 |
| §9 Browser WS invoke | Task 11 |
| §10 Bot Gateway session | Task 12 |
| §12 Backend flows | Tasks 4, 9–12 |
| §13 Security | Tasks 5, 9, 11, 12 |
| §14 Error codes | Task 1 |
| §15 Tests | Each task |

**Out of scope (explicit non-goals):** bot marketplace, per-channel alias, HTTP bot send path changes, passive `message_event` subscriptions, product migration tasks, `PATCH /api/chat/bots/{bot_id}` (deferred v1.1).

---

## Execution Order

```
Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13
```

Tasks 5–6 can parallel after Task 4. Task 10 can start after Task 8–9. Frontend manifest work can begin after Task 10 lands.
