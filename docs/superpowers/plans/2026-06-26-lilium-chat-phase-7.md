# Lilium Chat Phase 7 Implementation Plan (Bot slash command + rich interaction)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the official-bot integration path on the v4.0 base: BotRegistry global command catalog, per-channel bot installation + command bindings, `command.invoke` (async bot-callback outbox), bot effects pipeline (send / update / disable-components / stream), `interaction.submit` rich-UI lifecycle, and bot direct message send — all on the existing channel-scoped + `operation_id` idempotency + payload-bearing committed_ack base. Contract authority: §9 (Bot 迁移预留) + §3.8 (MessageComponent) + §10.2 (CommandAck) + §13 (v4.0 addendum invariants) of `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`. Design authority: `docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md` 阶段 7 (7a–7e).

**Architecture (收口径, 与用户 2026-06-26 对齐确认):**

```
BotRegistry DO (by bot_id)        — global bot identity + GLOBAL command catalog
  bot_apps            (id, display_name, avatar_url, callback_url, callback_secret, status)
  bot_tokens          (token_hash, scopes)         — already in baseline v1
  bot_commands         (bot_command_id PK, name, options_json, default_member_permission,
                         default_enabled_on_install, schema_version, definition_hash, enabled, …)
  bot_command_aliases  (bot_command_id, alias)     — alternate slash triggers, same command

ChatChannel DO (by channel_id)   — per-channel availability + invocation/interaction state
  bot_installations         (channel_id, bot_id, status, installed_by, …)   — extend baseline
  channel_command_bindings  (binding_id, channel_id, bot_command_id, status=enabled|disabled|removed,
                              permission_override, …)                       — repurposes old `commands`
  channel_command_names     (channel_id, slash_name, bot_command_id, kind=canonical|alias) — conflict域
  command_invocations        (invocation_id, channel_id, command_id[=operation_id], invoker_user_id,
                              bot_id, bot_command_id, invoked_name, options_json, status, …) — repurposes old `invocations`
  interactions               (interaction_id, message_id, component_id, custom_id, actor_user_id,
                              command_id[=operation_id], value_json, status, …) — extend baseline
  bot_callback_outbox        (outbox_id, channel_id, bot_id, kind=command_invocation|message_interaction,
                              invocation_id|interaction_id, request_json, status, attempts, next_attempt_at, …)
  bot_effects_applied        (channel_id, outbox_id, client_effect_id, effect_type, message_id, applied_at) — effect 幂等
  messages + components_json  — bot 消息持久化 components (普通用户消息 components 恒为 [])
```

**数据所有权一句话:** `BotRegistry` owns the global bot command catalog; `ChatChannel` owns per-channel bot installation + command bindings + invocation/interaction state; `GET /channels/{id}/commands` returns the current user's effective channel command set ( BotRegistry catalog ∩ ChatChannel enabled bindings, projected with `matched_name`/`matched_kind` for prefix suggest); `command.invoke` only persists the invocation + `command.invoked` event + a `bot_callback_outbox` row, then returns committed_ack **without** waiting for the bot; bot callback effects are applied later by the ChatChannel alarm-driven callback dispatch + effect pipeline.

**Async callback 状态机 (§9.7 改写为异步):**
```
command.invoke transaction committed
  → insert command_invocations(status=pending)
  → emit command.invoked event (status=pending) + fanout outbox
  → insert bot_callback_outbox(kind=command_invocation, status=pending, next_attempt_at=now)
  → return committed_ack { channel_id, invocation_id, event_id }

ChatChannel alarm flushes bot_callback_outbox (earliest-wins, retry/backoff/dead-letter):
  → POST <bot callback_url> with HMAC signature + Content-Digest + Idempotency-Key
  → bot returns { effects: [...] }
  → validate effects (bot owns target messages, stream_state invariants, component ownership)
  → apply effects idempotently (by client_effect_id via bot_effects_applied)
  → write bot messages / updates / stream deltas + events + fanout outbox
  → mark command_invocations.status = completed | failed
```

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), Hono, vitest-pool-workers, jose (HS256 JWT + HS256 HMAC for callback signatures), `aws4fetch` 已就位 (Phase 5，本阶段不涉及 S3)。Bot callback 签名用 `jose` 或 WebCrypto HMAC-SHA256 + `base64url`，`Content-Digest: sha-256=:base64:` 走 RFC 9530 形式（与 contract §9.7 一致）。

---

## Global Constraints

(Phase 0–6 + E + v4.0 constraints carry forward. Load-bearing for this plan:)

- **Bot API ≠ Browser API 认证路径。** Browser API 用 ToolBear browser JWT（`verifyBrowserJwt`，已在 `src/auth/jwt.ts`）。Bot API 用 `Authorization: Bearer <bot_token>`，Worker 取 token → 查 BotRegistry `bot_tokens.token_hash`（SHA-256 hash）→ 命中且未 revoked 且 scope 允许 → 注入 `bot_id`。token 原文只返回一次，服务端只存 hash（contract §9.1）。两条路径不混用；`/api/chat/bot/*` 与 `/api/chat/channels/{id}/bot-installations`（后者是 Browser API，channel admin 操作）各自走自己的 `getIdentity` / `getBotIdentity`。
- **command 定义 = bot 全局；channel 只存 binding/enable。** contract §9.3 的 `PUT /api/chat/bot/commands` 路径无 `channel_id`，因此它只能是 BotRegistry catalog sync（upsert `bot_commands` + `bot_command_aliases`）。"同一频道内 enabled command 名称不能冲突"（§9.3）是 **ChatChannel `channel_command_names` 层的约束**，不是 BotRegistry catalog 层。现有 baseline 的 `commands` 表（带 `uniq_enabled_command_name WHERE enabled=1`）语义收口为 `channel_command_bindings` + `channel_command_names`（见 Task 7a-migration）。
- **Alias 是同一 `bot_command_id` 的 alternate slash trigger，不是独立 command。** `command.invoke` 仍用 `bot_command_id`，payload 可带 `invoked_name`（canonical name 或 alias）；`invoked_name` 必须命中该 channel 的 `channel_command_names`（canonical 或 alias 行）；alias 参与同频道 slash-name conflict；callback payload 同时带 canonical `command.name` 与 `invoked_name`。
- **Bot callback 异步，不在 command.invoke 请求路径同步等待。** `command.invoke` committed_ack 只表 invocation 已持久接受；bot effects 由 ChatChannel alarm 驱动的 `bot_callback_outbox` flush 异步应用（contract §9.7 改写）。状态机 `pending → dispatched → completed | failed | expired`。理由：bot callback 是外部网络 IO，不能进 ChatChannel mutation 关键路径；bot 可能慢/超时/streaming/多 effect，需独立状态机 + retry/dead-letter/idempotent effect 应用。
- **`command_id` 是 `command.invoke` / `interaction.submit` 的 durable 幂等键**（operation 分别为 `command.invoke` / `interaction.submit`），与 `message.send` 同一套 `idempotency_keys` 机制（`(principal_kind, principal_id, operation, operation_id)`，`response_json` 存完整 committed_ack payload）。`command_invocations.UNIQUE(channel_id, invoker_user_id, command_id)` 与 `interactions.UNIQUE(message_id, dedupe_principal_key, command_id)` 仅为二级防御，与 `messages` 一致。
- **`projectMessageForBrowser` 是唯一 message serializer**（`src/chat/message-projection.ts`，已接受 `components` opt，当前恒 `[]`）。Phase 7 让 bot 消息真正携带 components：send/bot-direct-message 时从请求取 components 写入 `messages.components_json`；history/replay/lifecycle 读 `components_json` 反序列化后传入 builder。`components` 加入 deleted/recalled 安全投影（builder 已对 hidden 态清空 components，无需改）。普通用户消息 `components` 恒为 `[]`（`parseMessageSendCommand` 已强制非 bot 不能携带 components —— Task 7a-parser 显式拒绝）。
- **Bot actor 不查 ToolBear profile。** `sender_kind="bot"`，`sender_bot_id`；display_name/avatar 来自 BotRegistry `bot_apps`（chat 自有数据，可随 event payload 持久化 —— design §3.5 例外）。`projectMessageForBrowser` 的 bot sender 分支当前只输出 `{kind:"bot", bot_id}`（无 display_name/avatar）—— Task 7c-projection 扩展为接受 `botSummary` opts 并输出 `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`，与 contract §9.2 形状一致。
- **Components 校验由 Worker 承担。** contract §3.8：组件由 Bot 生成，Worker 校验后随消息持久化；`kind ∈ {button, select}`，`style ∈ {primary, secondary, danger}`，`custom_id` 是 Bot 私有 payload 前端只原样回传。Task 7c-components 实现 `validateComponents(components)` pure helper。
- **Channel 路由 + 成员校验复用既有路径。** `channelRouteNameFor(env, userId, channelId)` + `UserConnection.ensureSubscribed`。`command.invoke` / `interaction.submit` 在 `UserConnection.webSocketMessage` 新增分支，走同一 `ensureSubscribed` 成员门禁。
- **`CHANNEL_DISSOLVED` write-gate** 适用于所有 ChatChannel 写入（bot-install / binding / invoke / interaction / bot-direct-message / effect 应用），与既有 mutation 一致。
- **Git:** USE THE REPO DEFAULT git config（do NOT pass `-c user.name=...`）。`git add <files> && git commit -m '...'`。Do NOT push or deploy。
- **Test config:** `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`。Typecheck: `npm run typecheck`。本机高负载时 vitest 5s 默认 timeout 假失败，务必带 `--test-timeout=60000`（见 memory `vitest-load-starvation-timeouts`）。
- **前端不在本仓库实现（contract §12.9 / spec "关于前端阶段"）。** 7e 只列前端接入所需契约面 + dzmm_archive 侧 checklist，不在 lilium-chat 写前端代码。

---

## File Structure

**Create:**
- `src/auth/bot.ts` — `verifyBotToken(env, token): Promise<{ bot_id, scopes }>`（SHA-256 hash → 查 BotRegistry `bot_tokens` → 校验 status/revoked/scopes）+ `getBotIdentity(c)` Hono helper（类比 `getIdentity`）。
- `src/auth/callback-sign.ts` — `signBotCallback(env, botApp, body): Promise<{ headers, body }>`：HMAC-SHA256 over `timestamp + digest`，`X-Lilium-Signature: v1=<base64>`，`X-Lilium-Timestamp`，`Content-Digest: sha-256=:base64:`（RFC 9530）。纯函数 + WebCrypto，可注入假 secret 测试。
- `src/chat/components.ts` — `validateComponents(components: unknown): { ok, components?, error? }`（pure；校验 §3.8 枚举 + 必填字段 + select options）+ `projectComponentsForBrowser(rows): unknown[]`。
- `src/chat/bot-callback.ts` — `buildCommandInvocationCallbackPayload(...)` + `buildMessageInteractionCallbackPayload(...)`（pure；产出 contract §9.7 请求体，含 `invoked_name`）。
- `src/chat/bot-effects.ts` — `validateEffects(effects, ctx)` + `applyEffect(...)` 调度（pure 校验；写入仍由 ChatChannel DO 事务承担）。`EffectType` 联合类型。
- `src/routes/bot.ts` — bot-token HTTP routes：`PUT /api/chat/bot/commands`（catalog sync）、`POST /api/chat/bot/channels/:channel_id/messages`（bot 直接发消息）。
- `src/routes/bot-installations.ts` — Browser API routes：`GET/POST /api/chat/channels/:channel_id/bot-installations`、`PATCH .../bot-installations/:bot_id`、`PATCH .../commands/:bot_command_id`、`GET .../commands`（channel command 查询，prefix suggest）。
- `src/chat/command-invoke.ts` — `parseCommandInvokeCommand(frame)` + `parseInteractionSubmitCommand(frame)`（类比 `parseMessageSendCommand`，pure）。
- Test files（见各 Task）。

**Modify:**
- `src/do/bot-registry.ts` — 实现 BotRegistry：`/internal/token-verify`、`/internal/commands-sync`（upsert `bot_commands` + `bot_command_aliases`）、`/internal/bot-get`（profile + callback config，供 ChatChannel callback 签名 + actor 投影）、`/internal/seed-official-bot`（admin seed 官方 bot）、alarm（无 due job 时无 alarm，保留壳）。
- `src/do/migrations/bot-registry.ts` — v2 migration：create `bot_commands`、`bot_command_aliases`；add `callback_secret TEXT` + `status` 收口到 `bot_apps`（baseline 已有 `status`，仅加 `callback_secret`）。
- `src/do/chat-channel.ts` — 新增 internal endpoints：`/internal/bot-install`、`/internal/bot-install-update`、`/internal/command-binding-update`、`/internal/channel-commands`（查询）、`/internal/command-invoke`、`/internal/interaction-submit`、`/internal/bot-message-send`、`/internal/callback-dispatch`（alarm flush 单行回调 + 应用 effects）、`/internal/effect-apply`；扩展 `alarm()` flush `bot_callback_outbox`（earliest-wins，与现有 `projection_outbox` flush 同一 alarm，参考 `src/do/scheduler.ts` `runDueJobs`/`scheduleNextAlarm` 多表模式）；扩展 `projectMessageForBrowser` 调用点携带 components（history/replay/lifecycle）。
- `src/do/migrations/chat-channel.ts` — v2 migration：DROP 未用的 baseline `commands`、`invocations`（空表，Phase 7 前无写入）；CREATE `channel_command_bindings`、`channel_command_names`、`command_invocations`、`bot_callback_outbox`、`bot_effects_applied`；ALTER `messages` ADD `components_json TEXT NOT NULL DEFAULT '[]'`；ALTER `bot_installations` ADD `status TEXT NOT NULL DEFAULT 'active'`、`updated_by TEXT`、`updated_at TEXT`；ALTER `interactions` ADD `updated_at TEXT`、`completed_at TEXT`、`error_code TEXT`（若 baseline 缺）。
- `src/chat/message-projection.ts` — bot sender 分支接受 `botSummary?: { bot_id, display_name, avatar_url } | null` opts，输出 `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`；其余不变。
- `src/chat/command.ts` — `parseMessageSendCommand` 显式拒绝非空 `components`（普通用户消息不能携带 components）。
- `src/do/user-connection.ts` — `webSocketMessage` 新增 `command.invoke` + `interaction.submit` 分支（路由到 ChatChannel `/internal/command-invoke` / `/internal/interaction-submit`，回 committed_ack `{channel_id, invocation_id|interaction_id, event_id}`）。
- `src/index.ts` — 注册 bot routes + bot-installation routes（在 `app.all("/api/chat/*")` 404 兜底之前）。

**Do NOT touch:** `src/do/channel-fanout.ts`、`src/do/user-directory.ts`（成员/读态已就位）、`src/ws/frames.ts`（frame 类型已预留 command 名）、`src/auth/jwt.ts`（Browser JWT 不动）、`src/ids/uuidv7.ts`、wrangler configs（无新 binding/secret —— `callback_secret` 由 BotRegistry 自管，不进 wrangler secret）。`src/do/channel-directory.ts` / `invite-directory.ts` 本阶段无关。

---

## Schema Migrations (summary — full SQL in Task 7a-migration / 7b-migration)

### BotRegistry v2 (`src/do/migrations/bot-registry.ts`)

```sql
ALTER TABLE bot_apps ADD COLUMN callback_secret TEXT;        -- HMAC secret, 与 token 分开管理
-- bot_apps 已有 status；bot_tokens 已有 scopes/revoked_at（baseline v1）

CREATE TABLE bot_commands (
  bot_command_id            TEXT PRIMARY KEY,
  bot_id                    TEXT NOT NULL,
  name                      TEXT NOT NULL,
  description               TEXT,
  options_json              TEXT NOT NULL,           -- contract §9.3 options schema
  default_member_permission TEXT NOT NULL,           -- member | admin | owner
  default_enabled_on_install INTEGER NOT NULL DEFAULT 1,
  schema_version            INTEGER NOT NULL DEFAULT 1,
  definition_hash           TEXT NOT NULL,           -- 内容指纹, detect 语义漂移
  enabled                   INTEGER NOT NULL DEFAULT 1,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  UNIQUE (bot_id, name)
);
CREATE INDEX idx_bot_commands_bot ON bot_commands(bot_id);

CREATE TABLE bot_command_aliases (
  bot_command_id TEXT NOT NULL,
  bot_id         TEXT NOT NULL,
  alias          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (bot_command_id, alias),
  UNIQUE (bot_id, alias)
);
```

### ChatChannel v2 (`src/do/migrations/chat-channel.ts`)

```sql
-- baseline 的 commands / invocations 表 Phase 7 前未写入, drop 重建为收口后的语义
DROP TABLE IF EXISTS commands;
DROP TABLE IF EXISTS invocations;

ALTER TABLE messages ADD COLUMN components_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE bot_installations ADD COLUMN status     TEXT NOT NULL DEFAULT 'active';
ALTER TABLE bot_installations ADD COLUMN updated_by TEXT;
ALTER TABLE bot_installations ADD COLUMN updated_at TEXT;

ALTER TABLE interactions ADD COLUMN updated_at   TEXT;
ALTER TABLE interactions ADD COLUMN completed_at  TEXT;
ALTER TABLE interactions ADD COLUMN error_code    TEXT;

CREATE TABLE channel_command_bindings (
  binding_id          TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL,
  bot_id              TEXT NOT NULL,
  bot_command_id      TEXT NOT NULL,
  status              TEXT NOT NULL,           -- enabled | disabled | removed
  permission_override TEXT,                    -- null=继承 bot_commands.default_member_permission
  name                TEXT NOT NULL,           -- snapshot of bot_commands.name (查询本地读, 避免 N 跨 DO fetch)
  description         TEXT,
  options_json        TEXT NOT NULL,           -- snapshot of bot_commands.options_json
  definition_hash     TEXT NOT NULL,           -- snapshot; callback 时再校验是否漂移
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_by          TEXT,
  updated_at          TEXT NOT NULL,
  UNIQUE (channel_id, bot_command_id)
);
CREATE INDEX idx_bindings_channel_enabled ON channel_command_bindings(channel_id, status);

CREATE TABLE channel_command_names (
  channel_id     TEXT NOT NULL,
  slash_name     TEXT NOT NULL,
  bot_command_id TEXT NOT NULL,
  bot_id         TEXT NOT NULL,
  kind           TEXT NOT NULL,               -- canonical | alias
  created_at     TEXT NOT NULL,
  PRIMARY KEY (channel_id, slash_name)
);
-- 同频道 enabled slash token 唯一: 由 binding 启用时写 name 行, 禁用时删 name 行, 冲突 → COMMAND_NAME_CONFLICT

CREATE TABLE command_invocations (
  invocation_id              TEXT PRIMARY KEY,
  channel_id                 TEXT NOT NULL,
  command_id                  TEXT NOT NULL,   -- Browser WS operation_id
  invoker_user_id             TEXT NOT NULL,
  bot_id                      TEXT NOT NULL,
  bot_command_id              TEXT NOT NULL,
  command_name                TEXT NOT NULL,   -- canonical name (from bot_commands)
  invoked_name                TEXT NOT NULL,   -- 用户实际输入的 slash token
  command_schema_version      INTEGER NOT NULL,
  command_definition_hash     TEXT NOT NULL,
  options_json                TEXT NOT NULL,
  status                      TEXT NOT NULL,   -- pending | dispatched | completed | failed | expired
  error_code                  TEXT,
  error_message               TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  completed_at                TEXT,
  UNIQUE (channel_id, invoker_user_id, command_id)   -- 二级防御; 幂等 SoT 在 idempotency_keys
);
CREATE INDEX idx_invocations_status ON command_invocations(status, updated_at);

CREATE TABLE bot_callback_outbox (
  outbox_id        TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL,
  bot_id           TEXT NOT NULL,
  kind             TEXT NOT NULL,              -- command_invocation | message_interaction
  invocation_id    TEXT,                        -- 非空 when kind=command_invocation
  interaction_id   TEXT,                        -- 非空 when kind=message_interaction
  request_json     TEXT NOT NULL,              -- 完整 callback 请求体 (含 canonical name + invoked_name)
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | dispatched | delivered | failed | dead_letter
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  last_error        TEXT,
  failed_at         TEXT,
  next_attempt_at   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_callback_due ON bot_callback_outbox(status, next_attempt_at);

CREATE TABLE bot_effects_applied (
  channel_id       TEXT NOT NULL,
  outbox_id        TEXT NOT NULL,
  client_effect_id TEXT NOT NULL,
  effect_type      TEXT NOT NULL,               -- send_message | update_message | disable_components | start_stream | append_stream | finalize_stream
  message_id       TEXT,                        -- effect 作用的消息 (start_stream/send_message 产生, 其余引用)
  applied_at       TEXT NOT NULL,
  PRIMARY KEY (channel_id, outbox_id, client_effect_id)
);
```

> Migration 实现遵循 `src/do/sql-migrations.ts` 的 `SqlMigration[]` + baseline detector 模式（见 `src/do/migrations/user-directory.ts` 加列先例）。baseline 不变（fresh install 走 baseline，含新表）；存量 DO 走 v2 migration。

---

## Section 7a — Bot registry + command catalog + channel installation/bindings

### Task 7a-0: Baseline green + HEAD
**Files:** (none)
- [ ] **Step 1:** `npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Expected: clean + green (记录当前通过数). Record HEAD (`git rev-parse --short HEAD`).
- [ ] **Step 2:** 确认 baseline schema 现状：`grep -nE "commands|invocations|interactions|bot_installations" src/do/migrations/chat-channel.ts`（确认这些表是 Phase 7 前未写入的空壳，drop 安全）。

### Task 7a-migration: BotRegistry v2 + ChatChannel v2 migrations
**Files:** `src/do/migrations/bot-registry.ts`, `src/do/migrations/chat-channel.ts`, `test/do/user-directory-migrations.test.ts`（类比先例）/ 新 `test/do/bot-registry-migrations.test.ts`、`test/do/chat-channel-migrations-v2.test.ts`
- [ ] **Step 1:** 写 BotRegistry v2 migration（上 SQL）。`BOT_REGISTRY_CURRENT_SCHEMA_VERSION = 2`，加列用 `ALTER TABLE ... ADD COLUMN`（参考 `user-directory.ts` 加列先例）。
- [ ] **Step 2:** 写 ChatChannel v2 migration（上 SQL）。`DROP TABLE IF EXISTS commands/invocations`（空表安全）；加列 / 建表。
- [ ] **Step 3:** 失败测试先行：fresh install 走 baseline 含新表；存量 v1 DO 走 v2 migration 后 schema 一致（`PRAGMA table_info` + `PRAGMA index_list` 比对）。migration runner 幂等（重跑不报错）。
- [ ] **Step 4:** 绿。`npm run typecheck && vitest run test/do/bot-registry-migrations.test.ts test/do/chat-channel-migrations-v2.test.ts --no-file-parallelism --test-timeout=60000`。

### Task 7a-bot-identity: Bot token 验证 + BotRegistry token/profile internals
**Files:** `src/auth/bot.ts`, `src/do/bot-registry.ts`, `test/do/bot-registry.test.ts`
- [ ] **Step 1:** BotRegistry `/internal/token-verify`：入 `{ token }` → SHA-256 hash(token) → `SELECT bot_id, scopes, revoked_at FROM bot_tokens JOIN bot_apps USING(bot_id) WHERE token_hash=? AND bot_apps.status='active'` → 命中且 `revoked_at IS NULL` → 返回 `{ bot_id, scopes }`；否则 401。
- [ ] **Step 2:** BotRegistry `/internal/bot-get?bot_id=`：返回 `{ bot_id, display_name, avatar_url, callback_url, callback_secret, status }`（供 ChatChannel actor 投影 + callback 签名）。`callback_secret` 仅 DO 间内部调用，不外泄。
- [ ] **Step 3:** `verifyBotToken(env, token)`：fetch BotRegistry by `bot_id`? token 不含 bot_id —— 先 hash 再用 hash 作 BotRegistry name 路由? **决策:** BotRegistry 用 `bot_id` 做 DO name。token → hash 不能反查 bot_id。改为：BotRegistry 单例 DO（`c.env.BOT_REGISTRY.getByName("global")` 或 `getById` 固定 id），所有 bot token/profile 集中存。**调整 wrangler?** 不需要 —— `BOT_REGISTRY` binding 已存在，用固定 name `getByName("registry")` 即可单例。token verify 在单例 DO 内 `SELECT ... WHERE token_hash=?`。✅
- [ ] **Step 4:** `getBotIdentity(c)` Hono helper：取 `Authorization: Bearer` → `verifyBotToken` → 注入 `bot_id` + `scopes`；scope 不符 → `FORBIDDEN`。
- [ ] **Step 5:** 测试：合法 token 通过；revoked token 401；非 active bot 401；scope 缺失 403。绿。

### Task 7a-catalog-sync: `PUT /api/chat/bot/commands` (BotRegistry catalog upsert)
**Files:** `src/routes/bot.ts`, `src/do/bot-registry.ts`, `test/routes/bot-commands.test.ts`
- [ ] **Step 1:** `PUT /api/chat/bot/commands` handler：`getBotIdentity`（需 scope `chat:commands:manage`）→ `Idempotency-Key` 必填 → body `{ commands: [{ name, description, options, default_member_permission, aliases?, default_enabled_on_install? }] }` → fetch BotRegistry `/internal/commands-sync`。
- [ ] **Step 2:** BotRegistry `/internal/commands-sync`：事务内 upsert `bot_commands`（`bot_command_id` 复用：同 `bot_id+name` 复用既有 id，否则新 UUIDv7）+ 全量替换 `bot_command_aliases`（diff 或 delete+reinsert）。校验 options schema（contract §9.3 type 枚举：string/integer/number/boolean/user/channel/role + min/max/required/description）—— pure `validateCommandOptions(options)`。返回 `{ commands: [{ bot_command_id, name, enabled, updated_at }] }`。`definition_hash = sha256(canonical(options+description+permission))`，`schema_version` 递增当 hash 变。
- [ ] **Step 3:** 幂等：同 `Idempotency-Key` + 同 body → 同响应（BotRegistry 单例 DO 内自建 `idempotency_keys` 或复用 ChatChannel? BotRegistry baseline 无 idempotency_keys 表 —— Task 加一张 `bot_idempotency_keys` 于 BotRegistry v2，或简单用 `(bot_id, name)` 幂等 upsert + 返回稳定结果。**决策:** 加 `bot_idempotency_keys` 到 BotRegistry v2 migration，与 ChatChannel 同形，operation=`bot.commands.sync`）。
- [ ] **Step 4:** 测试：首次注册返回 bot_command_id；重注册同名复用 id；options 非法 422；revoked token 401；缺 scope 403；幂等重试同响应。绿。

### Task 7a-install: Browser API bot-installation + command binding
**Files:** `src/routes/bot-installations.ts`, `src/do/chat-channel.ts` (new internals), `test/routes/bot-installations.test.ts`, `test/do/chat-channel-bot-install.test.ts`
- [ ] **Step 1:** `POST /api/chat/channels/:channel_id/bot-installations`（Browser API，channel owner/admin）：`getIdentity` → 校验 caller 是 channel owner/admin（ChatChannel `/internal/members-get` 查 role）→ `Idempotency-Key` → body `{ bot_id, initial_command_policy? }` → ChatChannel `/internal/bot-install`。
- [ ] **Step 2:** ChatChannel `/internal/bot-install`：事务内 — 校验 `CHANNEL_DISSOLVED` gate；校验 bot 存在 + active（fetch BotRegistry `/internal/bot-get`，失败 → `BOT_NOT_FOUND`）；upsert `bot_installations(channel_id, bot_id, status=active, installed_by, installed_at)`；按 `initial_command_policy`（默认 = bot catalog `default_enabled_on_install`）为每个 `enabled` 的 `bot_commands` 创建 `channel_command_bindings(status=enabled)` + 写 `channel_command_names`（canonical + 每个alias）—— **name conflict 检查:** 写 `channel_command_names` 前 `SELECT 1 FROM channel_command_names WHERE channel_id=? AND slash_name=?` 命中 → `COMMAND_NAME_CONFLICT`（回滚）。emit `bot.installed` event + fanout outbox。返回 `{ bot_id, status, bindings: [...] }`。
- [ ] **Step 3:** `PATCH /api/chat/channels/:channel_id/bot-installations/:bot_id`（enable/disable 整个 bot 的 binding 批量 / 卸载）：body `{ status, command_policy? }`。ChatChannel `/internal/bot-install-update`：更新 `bot_installations.status` + 同步 `channel_command_bindings.status` + 增删 `channel_command_names` 行。`status=removed` → 删 name 行。emit `bot.updated` event。
- [ ] **Step 4:** `PATCH /api/chat/channels/:channel_id/commands/:bot_command_id`：body `{ enabled, permission_override? }`。ChatChannel `/internal/command-binding-update`：upsert binding status；`enabled=true` 时写 `channel_command_names`（name conflict 检查 → `COMMAND_NAME_CONFLICT`）；`enabled=false` 删 name 行。emit `command.binding_updated` event（contract 无显式定义，按 `system.notice` 或新增 event type —— **决策:** 用 `system.notice` v2.6 delta 形状，避免新增 event type 扩面）。
- [ ] **Step 5:** 测试：install 创建 bindings + names；重复 install 同 `Idempotency-Key` 同响应、异 body → `IDEMPOTENCY_CONFLICT`；install 时 name 冲突 → `COMMAND_NAME_CONFLICT` 回滚；非 admin 403；enable 一个 disabled command name 冲突 → 409；卸载删 name 行。绿。

### Task 7a-commands-query: `GET /api/chat/channels/:channel_id/commands` (prefix suggest)
**Files:** `src/routes/bot-installations.ts`, `src/do/chat-channel.ts`, `test/routes/channel-commands.test.ts`
- [ ] **Step 1:** `GET .../commands?prefix=as`：`getIdentity` → `channelRouteNameFor` + 成员校验 → ChatChannel `/internal/channel-commands?prefix=as&user_id=`。
- [ ] **Step 2:** ChatChannel `/internal/channel-commands`：`SELECT b.binding_id, b.bot_command_id, b.bot_id, b.status, b.permission_override, c.name, c.description, c.options_json FROM channel_command_bindings b JOIN bot_commands c? ` — **问题:** `bot_commands` 在 BotRegistry DO，ChatChannel 无 join。**决策:** install/binding-update 时把 `name/description/options_json` snapshot 进 `channel_command_bindings`（加 `name TEXT, description TEXT, options_json TEXT` 冗余列 —— Task 7a-migration 补这三列；catalog sync 后 binding snapshot 过期由 `definition_hash` 检测，callback 时再校验）。或查询时 fetch BotRegistry `/internal/bot-commands?bot_id=` 汇总。**采用:** binding 存 snapshot（name/description/options_json/definition_hash），查询纯本地读，避免 N 跨 DO fetch。修 `channel_command_bindings` schema 加这三列 + `definition_hash`。
- [ ] **Step 3:** 查询逻辑：`SELECT ... FROM channel_command_bindings WHERE channel_id=? AND status='enabled' AND (name LIKE ? OR EXISTS(alias match))` —— alias 在 `channel_command_names`，prefix 命中 canonical 或 alias 任一即返回；`permission_override ?? default_member_permission` 与 caller role 比较（member/admin/owner），过滤 caller 无权调用者。响应项含 contract §9.4 字段 + `aliases` + `matched_name` + `matched_kind`（prefix 命中的是 canonical 还是 alias）。
- [ ] **Step 4:** 测试：prefix 命中 canonical / alias 分别返回正确 `matched_kind`；非成员 403；caller role 不足过滤掉 admin-only command；无 enabled command 返回空。绿。
- [ ] **Step 5:** `src/index.ts` 注册所有 7a 路由。`npm run typecheck` 绿。

### Task 7a-seed: 官方 bot seed (admin / system job)
**Files:** `src/do/bot-registry.ts` (`/internal/seed-official-bot`), `test/do/bot-registry-seed.test.ts`
- [ ] **Step 1:** BotRegistry `/internal/seed-official-bot`：admin-only（由 Worker 内部调用，header 校验一个部署期 secret? —— **决策:** 仅 Worker→DO 内部，无外部 HTTP 暴露；用 `c.env` 无 admin secret，靠 `BOT_REGISTRY` binding 单例 + 不暴露 route。seed 由部署后手动脚本 / `wrangler` 调用触发，不在 HTTP 路由注册）。upsert `bot_apps` (official bot) + `bot_commands` (ask/summarize 等) + 一条 `bot_tokens`（返回原文一次）。
- [ ] **Step 2:** 测试：seed 幂等（重复 seed 不重建 token、不换 bot_command_id）；catalog sync 覆盖 seed 定义。绿（文档级，不强求 HTTP route）。

---

## Section 7b — command.invoke + invocation state + async callback outbox

### Task 7b-parser: `parseCommandInvokeCommand` + WS routing
**Files:** `src/chat/command-invoke.ts`, `src/do/user-connection.ts`, `test/chat/command-invoke-parser.test.ts`
- [ ] **Step 1:** `parseCommandInvokeCommand(frame)`：校验 `frame.command==="command.invoke"` + 顶层 `command_id`（durable operation id）+ `channel_id` + payload `{ bot_command_id, invoked_name?, options }`。`options` 是 `{ [name]: { type, value } }` map（contract §9.5）。返回 `{ command_id, channel_id, bot_command_id, invoked_name: string|null, options }`。
- [ ] **Step 2:** `UserConnection.webSocketMessage` 新增 `command.invoke` 分支：parse → `channelRouteNameFor` + `ensureSubscribed`（成员门禁，失败 `CHANNEL_NOT_FOUND`/`FORBIDDEN`）→ fetch ChatChannel `/internal/command-invoke`（body 含 `operation_id=command_id`, `invoker_user_id`, `bot_command_id`, `invoked_name`, `options`, `channel_id`）→ 透传 committed_ack `{channel_id, invocation_id, event_id}` 给 socket。错误透传 `command_error`。
- [ ] **Step 3:** 测试：parser 拒缺 `command_id`/`channel_id`/`bot_command_id`；`options` 缺 type/value 的项被拒或归一。绿。

### Task 7b-invoke: ChatChannel `/internal/command-invoke` (事务 + outbox)
**Files:** `src/do/chat-channel.ts`, `test/do/chat-channel-command-invoke.test.ts`
- [ ] **Step 1:** 事务前预检：fetch BotRegistry `/internal/bot-get?bot_id=`（由 binding 推出 bot_id）—— 等等，`bot_command_id` → bot_id 需查 `channel_command_bindings`（本地有 `bot_id` snapshot）。先 `SELECT bot_id, status, permission_override, definition_hash, name, options_json FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?` → 不存在/disabled → `COMMAND_NOT_FOUND` 或 `FORBIDDEN`（caller role 不足）。
- [ ] **Step 2:** 校验 `invoked_name` ∈ `channel_command_names(channel_id, bot_command_id)`（canonical 或 alias）；缺 → `COMMAND_NOT_FOUND`。校验 caller role ≥ `permission_override ?? default_member_permission` → 不足 `FORBIDDEN`。校验 `options` vs `bot_commands.options_json` snapshot（required/type/range/visibility/成员关系 —— user/channel 类型要校验 caller 是该 channel 成员 / channel 可见，contract §9.3）—— pure `validateInvocationOptions(optionsSchema, optionsValues, ctx)`。
- [ ] **Step 3:** 事务内 — idempotency 预检（cheap pre-check：`idempotency_keys` 命中 `operation='command.invoke'` + `operation_id=command_id` + `request_hash` 一致 → 返回缓存 `response_json`；不一致 → `IDEMPOTENCY_CONFLICT`）；insert `command_invocations(status=pending, ...)`（`UNIQUE(channel_id, invoker_user_id, command_id)` 二级防御命中且同 body → 走 idempotent 缓存）；emit `command.invoked` event `payload={invocation:{invocation_id, status:"pending", created_at}}` + fanout outbox；insert `bot_callback_outbox(kind=command_invocation, invocation_id, request_json=<§9.7 callback body with canonical name + invoked_name>, status=pending, next_attempt_at=now)`；写 `idempotency_keys.response_json = 完整 committed_ack payload`；bump alarm 到 `bot_callback_outbox` 最早 `next_attempt_at`（与 `projection_outbox` earliest-wins 合并，参考 `src/do/scheduler.ts` `scheduleNextAlarm` 多表）。
- [ ] **Step 4:** 返回 `{ channel_id, invocation_id, event_id }`（= committed_ack payload）。`UserConnection` 回 `command_ack {frame_type, command:"command.invoke", command_id, status:"committed", payload:{channel_id, invocation_id, event_id}}`。
- [ ] **Step 5:** 测试：invoke 创建 invocation + outbox + event + ack；重复同 `command_id`+body 返回同 ack 不新建；同 `command_id`+异 body → `IDEMPOTENCY_CONFLICT`；disabled binding → `COMMAND_NOT_FOUND`；role 不足 → `FORBIDDEN`；invalid options → 422。绿。

### Task 7b-callback-sign: Bot callback 签名 + dispatch (alarm flush)
**Files:** `src/auth/callback-sign.ts`, `src/chat/bot-callback.ts`, `src/do/chat-channel.ts` (`/internal/callback-dispatch` + alarm 扩展), `test/do/chat-channel-callback-dispatch.test.ts`
- [ ] **Step 1:** `signBotCallback(env, botApp, bodyBytes)`：`timestamp = floor(Date.now()/1000)`；`digest = sha256(bodyBytes)` → `Content-Digest: sha-256=:base64(digest):`；`sig = hmacSha256(botApp.callback_secret, `${timestamp}.${digest}`)` → `X-Lilium-Signature: v1=<base64url(sig)>` + `X-Lilium-Timestamp: <ts>`。pure + WebCrypto，可注入假 secret。
- [ ] **Step 2:** `buildCommandInvocationCallbackPayload(...)`：产出 contract §9.7 `kind:"command_invocation"` body，含 `command.name`（canonical）+ `invoked_name` + `options` + `invoker` UserSummary（实时 resolve）。
- [ ] **Step 3:** ChatChannel `alarm()` 扩展：在现有 `projection_outbox` flush 后，flush `bot_callback_outbox`（`status='pending' AND next_attempt_at<=now`，earliest-wins + retry/backoff/dead-letter，参考 `fanout-scheduler.ts` `bumpFanoutRetry` 形状）。每行：fetch BotRegistry `/internal/bot-get?bot_id=` 拿 `callback_url` + `callback_secret` → `signBotCallback` → `fetch(callback_url, { method:POST, headers, body: request_json, signal? })` → 2xx + 合法 JSON `{ effects:[...] }` → 标 `status=delivered` + 调 `/internal/effect-apply`（apply effects）；非 2xx / 超时 → `bumpCallbackRetry`（指数退避，`>=max_attempts` → `dead_letter` + `command_invocations.status=failed`）；bot 返回非法 effects → `status=failed` + `error_code=INVALID_EFFECTS`。
- [ ] **Step 4:** `bumpCallbackRetry` + `scheduleCallbackAlarm`（与 projection_outbox 合并 earliest-wins，统一 `setAlarm(min(...))`）。
- [ ] **Step 5:** 测试（fake BotRegistry stub + fake callback target）：成功 dispatch → delivered + effects 应用；bot 500 → 退避重试 → dead_letter；超时 → 重试；签名 header 形状正确（`X-Lilium-Signature`/`X-Lilium-Timestamp`/`Content-Digest`）。绿。

---

## Section 7c — Bot effects + bot messages + stream effects

### Task 7c-effects-validate: `validateEffects` + effect 应用调度
**Files:** `src/chat/bot-effects.ts`, `test/chat/bot-effects.test.ts`
- [ ] **Step 1:** `EffectType = "send_message" | "update_message" | "disable_components" | "start_stream" | "append_stream" | "finalize_stream"`（contract §9.7）。`validateEffects(effects, ctx)`：每 effect 校验 `client_effect_id` 唯一（同批内）；`send_message`/`start_stream` 的 `message` 字段形状（contract §9.8 + §3.4，`type`/`format`/`text`/`reply_to_message_id`/`attachment_ids`/`components`）；`update_message`/`disable_components`/`append_stream`/`finalize_stream` 需 `message_id` 且该消息 `sender_kind=bot` 且 `bot_id=ctx.bot_id`（bot 只能改自己的消息）；`append_stream` 需目标 `stream_state=streaming`；`disable_components` 校验 component_id 归属。返回 `{ ok, effects?, error? }`。
- [ ] **Step 2:** `projectComponentsForBrowser(rows)` + `validateComponents`（§3.8 枚举）—— Task 7c-components 抽出，此处引用。
- [ ] **Step 3:** 测试：合法 effects 通过；bot 改他人消息 → invalid；`append_stream` 到非 streaming → invalid；重复 `client_effect_id` → invalid。绿。

### Task 7c-components: Components 校验 + 持久化 + 投影
**Files:** `src/chat/components.ts`, `src/chat/message-projection.ts`, `src/do/chat-channel.ts`, `test/chat/components.test.ts`, `test/chat/message-projection-components.test.ts`
- [ ] **Step 1:** `validateComponents(components)`：`kind ∈ {button, select}`，`style ∈ {primary, secondary, danger}`，必填 `component_id`/`custom_id`，select 需 `options:[{value,label}]`。返回规范化数组或 error。
- [ ] **Step 2:** `messages.components_json` 持久化：bot 消息 send / bot-direct-message / `start_stream` / `update_message` 时写入；普通用户消息恒 `[]`（`parseMessageSendCommand` Task 7a-parser 显式拒绝非空 components）。`projectMessageForBrowser` 调用点（history `/internal/messages`、replay、lifecycle ack/event）读 `components_json` 反序列化传入 `opts.components`。
- [ ] **Step 3:** `projectMessageForBrowser` bot sender 分支扩展：接受 `botSummary?: {bot_id, display_name, avatar_url} | null`，输出 `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`；`hidden` 态 components 已清空（builder 已有 `components: hidden ? [] : ...`）。`buildMessageCreatedPayload`（持久化 event payload）的 bot sender 仍存 `{kind:"bot", bot_id}` ref，live 投影时由 `projectMessageForBrowser` + 实时 fetch BotRegistry 回填（design §3.5 例外：bot actor 是 chat-owned 可随 event 携带 —— **决策:** bot actor display_name/avatar 可直接持久化进 event payload，避免 replay 时 N 跨 DO fetch；与 UserSummary 不持久化原则的例外，已在 spec line 958 确认）。
- [ ] **Step 4:** 测试：`validateComponents` 各枚举边界；bot 消息 components 入库 + history/replay 投影携带；普通用户消息 components 恒 `[]`；deleted/recalled bot 消息 components 清空。绿。

### Task 7c-effect-apply: ChatChannel `/internal/effect-apply` (apply effects idempotently)
**Files:** `src/do/chat-channel.ts`, `test/do/chat-channel-effect-apply.test.ts`
- [ ] **Step 1:** `/internal/effect-apply`：入 `{ outbox_id, bot_id, effects }`。逐 effect：查 `bot_effects_applied(channel_id, outbox_id, client_effect_id)` 命中 → 跳过（幂等，stream 多次重放安全）；未命中 → 按 type 应用：
  - `send_message`：insert `messages(sender_kind=bot, sender_bot_id=bot_id, components_json=...)` + `message_attachments`（resolve bot-owned attachment_ids）+ emit `message.created` event（payload.message via `projectMessageForBrowser` + botSummary from BotRegistry）+ fanout outbox。记录 `message_id`。
  - `update_message`：校验 ownership → UPDATE `messages.text/components_json/updated_at/edited_at` + emit `message.updated`。
  - `disable_components`：UPDATE `messages.components_json`（标 disabled=true）+ emit `message.updated`（或 `message.components_disabled` —— 用 `message.updated` 收口）。
  - `start_stream`：insert `messages(stream_state=streaming, text="")` + components + emit `message.created`（stream_state=streaming）。
  - `append_stream`：校验 `stream_state=streaming` + ownership → UPDATE `messages.text = text || delta`（追加）+ emit `message.stream_delta` event `payload={message_id, delta}`（content-bearing，replay 走 `projectMessageForBrowser` 过滤）。
  - `finalize_stream`：UPDATE `messages.stream_state=final` + emit `message.stream_finalized`。
  - 每应用一个 effect → insert `bot_effects_applied`。
- [ ] **Step 2:** 标 `command_invocations.status=completed`（全部 effect 应用完）/ `failed`（任 effect invalid）。emit `command.completed` event（含 bot preview，contract §10.4）—— **决策:** `command.completed` 是 spec line 954 列出的 content-bearing event，payload 走 `projectMessageForBrowser`。如本阶段不交付 `command.completed`（可选），至少标 invocation completed 并在 ack 幂等重放上保持一致。本 plan 交付 `command.completed`。
- [ ] **Step 3:** 测试：send_message 创建 bot 消息 + components 投影；重复 effect-apply 同 outbox_id+client_effect_id 跳过；append_stream 到非 streaming → failed；bot 改他人消息 → failed；stream 全流程 start→append×N→final 产出正确 text + 事件序列。绿。

### Task 7c-bot-message: Bot 直接发消息 `POST /api/chat/bot/channels/:channel_id/messages`
**Files:** `src/routes/bot.ts`, `src/do/chat-channel.ts` (`/internal/bot-message-send`), `test/routes/bot-message-send.test.ts`
- [ ] **Step 1:** `POST /api/chat/bot/channels/:channel_id/messages`：`getBotIdentity`（scope `chat:messages:write`）+ `Idempotency-Key` → body `{ type, text, reply_to_message_id, attachment_ids, components }` → ChatChannel `/internal/bot-message-send`。
- [ ] **Step 2:** ChatChannel `/internal/bot-message-send`：校验 bot installed in channel（`bot_installations` status=active）+ scope；校验 `components`（`validateComponents`）；resolve bot-owned attachments；insert `messages(sender_kind=bot, components_json)` + emit `message.created` + fanout；idempotency via `idempotency_keys(operation=bot.message.send, operation_id=Idempotency-Key)`。返回 contract §9.8 `{ message, event:{event_id, type:"message.created"} }`。
- [ ] **Step 3:** 测试：bot 发消息含 components；未安装 bot → 403；非法 components → 422；幂等重试同响应。绿。
- [ ] **Step 4:** `src/index.ts` 注册 `PUT /api/chat/bot/commands` + `POST /api/chat/bot/channels/:channel_id/messages`（bot-token 路由，在 404 兜底前）。`npm run typecheck` 绿。

---

## Section 7d — Rich UI interaction.submit + component lifecycle

### Task 7d-parser: `parseInteractionSubmitCommand` + WS routing
**Files:** `src/chat/command-invoke.ts`, `src/do/user-connection.ts`, `test/chat/interaction-submit-parser.test.ts`
- [ ] **Step 1:** `parseInteractionSubmitCommand(frame)`：校验 `command==="interaction.submit"` + `command_id` + `channel_id` + payload `{ message_id, component_id, custom_id, value }`（contract §9.6）。
- [ ] **Step 2:** `UserConnection.webSocketMessage` 新增 `interaction.submit` 分支：parse → `channelRouteNameFor` + `ensureSubscribed` → ChatChannel `/internal/interaction-submit` → 透传 committed_ack `{channel_id, interaction_id, event_id}`。
- [ ] **Step 3:** 测试：parser 边界。绿。

### Task 7d-interaction: ChatChannel `/internal/interaction-submit` (校验 + outbox)
**Files:** `src/do/chat-channel.ts`, `test/do/chat-channel-interaction-submit.test.ts`
- [ ] **Step 1:** 校验（contract §9.6）：caller 能看见该消息（成员 + 消息在该 channel）；消息 `sender_kind=bot`；component 未 disabled（读 `messages.components_json` 找 `component_id`，`disabled` 不为 true）；`custom_id` 与持久化 component 一致。失败 → `INVALID_INTERACTION` / `FORBIDDEN` / `COMPONENT_NOT_FOUND`。
- [ ] **Step 2:** 事务内 — idempotency（`operation=interaction.submit`）；insert `interactions(status=pending, actor_user_id, command_id[=operation_id], value_json)`（`UNIQUE(message_id, dedupe_principal_key, command_id)` 二级防御）；emit `interaction.created` event `payload={interaction:{interaction_id, status:"pending", created_at}}` + fanout；insert `bot_callback_outbox(kind=message_interaction, interaction_id, request_json=<§9.7 message_interaction body>)`；写 `idempotency_keys.response_json`；bump alarm。
- [ ] **Step 3:** 返回 `{ channel_id, interaction_id, event_id }`。`UserConnection` 回 committed_ack。
- [ ] **Step 4:** 测试：submit 创建 interaction + outbox + event；重复同 command_id+body 同响应；disabled component → `COMPONENT_NOT_FOUND`；非 bot 消息 → `INVALID_INTERACTION`；非成员 → `FORBIDDEN`。绿。

### Task 7d-callback-interaction: Message interaction callback dispatch + effect apply
**Files:** `src/do/chat-channel.ts` (alarm flush `kind=message_interaction` branch), `src/chat/bot-callback.ts` (`buildMessageInteractionCallbackPayload`), `test/do/chat-channel-interaction-callback.test.ts`
- [ ] **Step 1:** `buildMessageInteractionCallbackPayload`：产出 contract §9.7 `kind:"message_interaction"` body（`interaction_id, message_id, channel_id, component:{component_id, custom_id, value}, actor`）。
- [ ] **Step 2:** alarm flush 复用 Task 7b-callback-dispatch 的 `bot_callback_outbox` flush，`kind=message_interaction` 走同一签名 + dispatch；bot 返回 effects → `/internal/effect-apply`（同 7c，bot 可发新消息 / 更新原消息 / disable component 表达交互结果）；标 `interactions.status=completed/failed` + emit `interaction.completed` event（content-bearing，含 components，replay 走 `projectMessageForBrowser`）。
- [ ] **Step 3:** 测试：interaction callback 成功 → bot effect 应用 + interaction completed；bot 失败 → interaction failed + dead_letter；幂等重放跳过已应用 effect。绿。

---

## Section 7e — Frontend integration surface (dzmm_archive; NOT implemented in lilium-chat)

> Per contract §12.9 + spec "关于前端阶段"：前端不进 lilium-chat。本节只列前端接入所需契约面 + dzmm_archive 侧 checklist，供前后端对齐，不在本仓库写前端代码。

- [ ] **Step 1:** 文档化前端接入契约面（写入本 plan 末尾附录，不单独建文件）：
  - `GET /api/chat/channels/:id/commands?prefix=` → slash command 补全（含 `matched_name`/`matched_kind`/`aliases`）。
  - WS `command.invoke` frame 形状 + committed_ack `{channel_id, invocation_id, event_id}` + `command.invoked` event + `command.completed` event 的 reducer 语义（invocation pending → completed 状态机）。
  - WS `interaction.submit` frame + `interaction.created` / `interaction.completed` events。
  - MessageComponent 渲染（`kind=button|select`，`style`，`disabled`，前端只原样回传 `custom_id`，不解析）。
  - Bot actor 渲染（`sender.kind==="bot"` → 用 `bot.display_name`/`avatar_url`，不得把 bot_id 当 user_id）。
  - stream_state 渲染（`streaming` 态展示 typing/delta 流；`message.stream_delta` event 追加；`message.stream_finalized` 收敛）。
- [ ] **Step 2:** 列 dzmm_archive 侧任务（不在本仓库执行）：slash input parser + suggest dropdown、command.invoke 发送 + optimistic invocation chip、interaction button/select 渲染 + submit、bot message 渲染、stream 渲染、bot settings sheet（admin install/uninstall bot + enable/disable command）。明确这些依赖本 plan 7a–7d 后端交付完成。

---

## Acceptance (contract §12.8)

- [ ] `PUT /api/chat/bot/commands`（bot token）注册全局 catalog + 别名；`COMMAND_NAME_CONFLICT` 仅在 channel binding 层。
- [ ] `GET /api/chat/channels/:id/commands?prefix=` 返回当前用户有效 command 集（含 matched_name/kind/aliases + role 过滤）。
- [ ] `POST /api/chat/channels/:id/bot-installations` + `PATCH .../bot-installations/:bot_id` + `PATCH .../commands/:bot_command_id`（Browser API，admin/owner）。
- [ ] WS `command.invoke` committed_ack `{channel_id, invocation_id, event_id}` + `command.invoked`(pending) → 异步 callback → effects 应用 → `command.completed`；`command_id` durable 幂等。
- [ ] WS `interaction.submit` committed_ack `{channel_id, interaction_id, event_id}` + `interaction.created` → 异步 callback → `interaction.completed`；component ownership/disabled/custom_id 校验。
- [ ] Bot effects：send_message / update_message / disable_components / start_stream / append_stream / finalize_stream，按 `client_effect_id` 幂等，bot 只能改自己的消息，stream 不变量。
- [ ] `POST /api/chat/bot/channels/:id/messages`（bot token，可带 components）。
- [ ] Bot callback 签名 `X-Lilium-Signature: v1=` + `X-Lilium-Timestamp` + `Content-Digest: sha-256=:`（§9.7）。
- [ ] `projectMessageForBrowser` 携带 components + bot actor `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`；deleted/recalled bot 消息安全投影。
- [ ] 全量 typecheck + vitest 绿（`--no-file-parallelism --test-timeout=60000`）。