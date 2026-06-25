# Lilium Chat Phase 7 Implementation Plan (Bot slash command + rich interaction)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the official-bot integration path on the v4.0 base: BotRegistry global command catalog, per-channel bot installation + command bindings, `command.invoke` (async bot-callback outbox), bot effects pipeline (send / update / disable-components / stream), `interaction.submit` rich-UI lifecycle, and bot direct message send — all on the existing channel-scoped + `operation_id` idempotency + payload-bearing committed_ack base. Contract authority: §9 (Bot 迁移预留) + §3.8 (MessageComponent) + §10.2 (CommandAck) + §13 (v4.0 addendum invariants) of `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`. Design authority: `docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md` 阶段 7 (7a–7e).

**Architecture (收口径, 与用户 2026-06-26 对齐确认):**

```
BotRegistry DO (singleton, getByName("registry"))  — ALL bot identities + token hashes + callback config + GLOBAL command catalog
  (token 原文→hash 不可反查 bot_id; bot API 入口只有 bearer token, 无法在验 token 前定位 by-bot_id DO.
   bot 数量小, singleton SQLite 做 SELECT ... WHERE token_hash=? 最简. 封装唯一 helper:
   `botRegistryStub(env) = env.BOT_REGISTRY.get(env.BOT_REGISTRY.idFromName("registry"))`, 全文件不散写其它 name.)
  bot_apps            (bot_id PK, display_name, avatar_url, callback_url, callback_secret, status)
  bot_tokens          (token_hash UNIQUE, bot_id, scopes, revoked_at)   — already in baseline v1
  bot_commands         (bot_command_id PK, bot_id, name, options_json, default_member_permission,
                         default_enabled_on_install, schema_version, definition_hash, enabled, …)
  bot_command_aliases  (bot_command_id, bot_id, alias)     — alternate slash triggers, same command
  /internal/bot-get?bot_id= 仍是 singleton 内按 bot_id 查 row, 不是路由到 bot_id DO.

ChatChannel DO (by channel_id)   — per-channel availability + invocation/interaction state
  bot_installations         (channel_id, bot_id, status, installed_by, bot_display_name, bot_avatar_url, …) — extend baseline
  channel_command_bindings  (binding_id, channel_id, bot_command_id, status=enabled|disabled|removed,
                              permission_override, name, description, options_json, aliases_json,
                              default_member_permission, definition_hash, …)              — read-cache snapshot, repurposes old `commands`
  channel_command_names     (channel_id, slash_name, bot_command_id, kind=canonical|alias) — conflict域
  command_invocations        (invocation_id, channel_id, command_id[=operation_id], invoker_user_id,
                              bot_id, bot_command_id, invoked_name, command_schema_version,
                              command_definition_hash, options_json, status, …) — repurposes old `invocations`
  interactions               (interaction_id, message_id, component_id, custom_id, actor_user_id,
                              command_id[=operation_id], value_json, status, …) — extend baseline
  bot_callback_outbox        (outbox_id, channel_id, bot_id, kind=command_invocation|message_interaction,
                              invocation_id|interaction_id, request_json, status, attempts, next_attempt_at, …)
  bot_effects_applied        (channel_id, bot_id, client_effect_id, effect_type, request_hash,
                              response_json, message_id, applied_at) — effect 幂等 (PK=channel_id+bot_id+client_effect_id)
  messages + components_json + sender_bot_display_name + sender_bot_avatar_url  — bot 消息持久化 components + bot actor snapshot
```

**数据所有权一句话:** `BotRegistry` (singleton) owns the global bot command catalog + bot identities + token hashes + callback config; `ChatChannel` owns per-channel bot installation + command bindings (read-cache snapshot of the catalog) + invocation/interaction state; `GET /channels/{id}/commands` returns the current user's effective channel command set from the local binding snapshot (read cache, may be briefly stale — suggest-only); `command.invoke` correctness source is the **current BotRegistry catalog** (not the binding snapshot — see Task 7b-invoke): it fetches the live definition, rejects disabled/deleted, and opportunistically refreshes the binding snapshot on `definition_hash` drift; `command.invoke` only persists the invocation + `command.invoked` event + a `bot_callback_outbox` row, then returns committed_ack **without** waiting for the bot; bot callback effects are applied later by the ChatChannel alarm-driven callback dispatch + effect pipeline.

**Async callback 状态机 (§9.7 改写为异步; 两套 status 枚举分开, 不要混):**
```
outbox row status  (bot_callback_outbox, 对齐 projection_outbox 命名):
  pending | delivered | failed | dead_letter
invocation status  (command_invocations / interactions 的 lifecycle):
  pending | dispatched | completed | failed | expired

command.invoke transaction committed
  → insert command_invocations(status=pending)
  → emit command.invoked event (status=pending) + fanout outbox
  → insert bot_callback_outbox(kind=command_invocation, status=pending, next_attempt_at=now)
  → return committed_ack { channel_id, invocation_id, event_id }

ChatChannel alarm flushes bot_callback_outbox (earliest-wins, retry/backoff/dead-letter):
  → POST <bot callback_url> with HMAC signature + Content-Digest + Idempotency-Key
  → bot returns { effects: [...] }
  → validate effects (bot owns target messages, stream_state invariants, component ownership)
  → apply effects idempotently (by channel_id+bot_id+client_effect_id via bot_effects_applied)
  → write bot messages / updates / stream deltas + events + fanout outbox
  → mark outbox status=delivered; mark command_invocations.status = completed | failed
  (outbox attempts >= max_attempts → outbox status=dead_letter + invocation status=failed|expired)
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
- **Bot actor 不查 ToolBear profile。** `sender_kind="bot"`，`sender_bot_id`；display_name/avatar 来自 BotRegistry `bot_apps`（chat 自有数据）。bot actor snapshot 持久化进 `messages.sender_bot_display_name` / `messages.sender_bot_avatar_url`（仅 `sender_kind='bot'` 写入，见 Task 7c-components / migration），使 **history pagination / committed_ack / live event / replay event / message context** 全路径同形输出 `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`，不靠 `events.payload_json` 单一来源，也不在 history/context 时 N 次回源 BotRegistry（design §3.5 例外确认：bot actor 是 chat-owned，可随 event + message 行持久化 snapshot）。`projectMessageForBrowser` bot sender 分支当前只输出 `{kind:"bot", bot_id}`（无 display_name/avatar）—— Task 7c-projection 扩展为优先读 `messages` 行的 bot snapshot 列，无则回退 `{bot_id}`。
- **Binding snapshot = read cache, 不是 correctness source。** `channel_command_bindings` / `bot_installations` 存的 catalog/bot summary snapshot（name/description/options_json/aliases_json/default_member_permission/definition_hash/bot_display_name/bot_avatar_url）仅供 `GET /channels/{id}/commands` 本地读、避免 N 跨 DO fetch，允许短暂 stale。`command.invoke` 的 correctness source 是 **当前 BotRegistry catalog**（Task 7b-invoke）：fetch live `bot_commands` 行，disabled/deleted → `BOT_COMMAND_DISABLED`，`definition_hash` drift → 用当前定义校验 + 同事务顺手刷新 binding snapshot。不要只用 binding snapshot 校验 invocation，否则用户可能用过期 schema 成功建 invocation、callback 阶段才失败。
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
- `src/auth/bot.ts` (Create, 上面) — 同时导出 `botRegistryStub(env)` 唯一 helper（统一 singleton name `"registry"`，全文件不散写）。
- `src/do/bot-registry.ts` — 实现 BotRegistry (singleton)：`/internal/token-verify`、`/internal/commands-sync`、`/internal/bot-get?bot_id=`、`/internal/command-get?bot_id=&bot_command_id=`（返回当前 `bot_commands` 行 + aliases，供 7b-invoke correctness 校验）、`/internal/bot-commands?bot_id=`（返回该 bot 全部 enabled command 定义 + aliases，供 7a-install 写 binding snapshot）、`/internal/seed-official-bot`、alarm（无 due job 时无 alarm，保留壳）。
- `src/do/migrations/bot-registry.ts` — v2 migration：create `bot_commands`、`bot_command_aliases`、`bot_idempotency_keys`（与 ChatChannel 同形，operation=`bot.commands.sync`）；`idx_bot_tokens_hash UNIQUE`、`idx_bot_commands_bot(bot_id, enabled, name)`；add `callback_secret TEXT` 到 `bot_apps`。`BOT_REGISTRY_CURRENT_SCHEMA_VERSION = 2`。
- `src/do/chat-channel.ts` — 新增 internal endpoints：`/internal/bot-install`、`/internal/bot-install-update`、`/internal/command-binding-update`、`/internal/channel-commands`、`/internal/command-invoke`、`/internal/interaction-submit`、`/internal/bot-message-send`、`/internal/callback-dispatch`、`/internal/effect-apply`；扩展 `alarm()` flush `bot_callback_outbox`（与 `projection_outbox` earliest-wins 合并，参考 `src/do/scheduler.ts` 多表）；扩展 `projectMessageForBrowser` 调用点携带 components（history/replay/lifecycle）+ bot snapshot（从 `messages.sender_bot_display_name`/`sender_bot_avatar_url` 读，不再每次回源 BotRegistry）。
- `src/do/migrations/chat-channel.ts` — v2 migration（见 Schema Migrations 块）：DROP 未用 baseline `commands`/`invocations`（**Task 7a-migration Step 3 加测试 + grep 约束证明 Phase 7 前无 runtime path 写旧表；若发现写入则改 rename，不可盲目 drop**）；CREATE `channel_command_bindings`（含 catalog snapshot 列 name/description/options_json/aliases_json/default_member_permission/definition_hash）、`channel_command_names`、`command_invocations`、`bot_callback_outbox`、`bot_effects_applied`（PK=channel_id+bot_id+client_effect_id）；ALTER `messages` ADD `components_json`/`sender_bot_display_name`/`sender_bot_avatar_url`；ALTER `bot_installations` ADD `status`/`updated_by`/`updated_at`/`bot_display_name`/`bot_avatar_url`；ALTER `interactions` ADD `updated_at`/`completed_at`/`error_code`。
- `src/chat/message-projection.ts` — bot sender 分支优先读 `messages.sender_bot_display_name`/`sender_bot_avatar_url` snapshot 列，输出 `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`；snapshot 列为空时回退 `{kind:"bot", bot_id}`（向后兼容）。`opts.botSummary` 仍可选用于 send/direct-message ack（此时还没入库 snapshot，由调用方从 BotRegistry 取传入）。其余不变。
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

-- token 原文→hash 不可反查 bot_id; singleton registry 内按 token_hash 查 row, 必须唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_tokens_hash ON bot_tokens(token_hash);

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
CREATE INDEX idx_bot_commands_bot ON bot_commands(bot_id, enabled, name);

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
-- (Task 7a-migration Step 3 加测试 + grep 约束证明 Phase 7 前无 runtime path 写旧表; 若发现写入则改 rename, 不可盲目 drop)
DROP TABLE IF EXISTS commands;
DROP TABLE IF EXISTS invocations;

-- bot 消息持久化 components + bot actor snapshot (仅 sender_kind='bot' 写 bot 两列)
ALTER TABLE messages ADD COLUMN components_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN sender_bot_display_name TEXT;
ALTER TABLE messages ADD COLUMN sender_bot_avatar_url TEXT;

ALTER TABLE bot_installations ADD COLUMN status             TEXT NOT NULL DEFAULT 'active';
ALTER TABLE bot_installations ADD COLUMN updated_by         TEXT;
ALTER TABLE bot_installations ADD COLUMN updated_at         TEXT;
-- bot summary snapshot: /commands 返回 bot 字段时本地读, 不回源 BotRegistry
ALTER TABLE bot_installations ADD COLUMN bot_display_name   TEXT NOT NULL DEFAULT '';
ALTER TABLE bot_installations ADD COLUMN bot_avatar_url     TEXT;

ALTER TABLE interactions ADD COLUMN updated_at   TEXT;
ALTER TABLE interactions ADD COLUMN completed_at  TEXT;
ALTER TABLE interactions ADD COLUMN error_code    TEXT;

CREATE TABLE channel_command_bindings (
  binding_id               TEXT PRIMARY KEY,
  channel_id               TEXT NOT NULL,
  bot_id                   TEXT NOT NULL,
  bot_command_id           TEXT NOT NULL,
  status                   TEXT NOT NULL,           -- enabled | disabled | removed
  permission_override       TEXT,                    -- null=继承 snapshot 的 default_member_permission
  -- catalog snapshot (READ CACHE; correctness source = BotRegistry current row, 见 7b-invoke)
  name                     TEXT NOT NULL,           -- snapshot of bot_commands.name
  description              TEXT,
  options_json             TEXT NOT NULL,           -- snapshot of bot_commands.options_json
  aliases_json             TEXT NOT NULL DEFAULT '[]',  -- snapshot of bot_command_aliases
  default_member_permission TEXT NOT NULL,          -- snapshot of bot_commands.default_member_permission
  definition_hash          TEXT NOT NULL,           -- snapshot; 7b-invoke 检测漂移并刷新
  created_by               TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_by               TEXT,
  updated_at               TEXT NOT NULL,
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
  -- outbox row status (对齐 projection_outbox 命名; 与 invocation lifecycle 状态分开)
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | failed | dead_letter
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  last_error        TEXT,
  failed_at         TEXT,
  next_attempt_at   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_callback_due ON bot_callback_outbox(status, next_attempt_at);

-- effect 幂等: PK = channel_id+bot_id+client_effect_id (跨 callback retry 去重, 不是 outbox attempt id)
CREATE TABLE bot_effects_applied (
  channel_id       TEXT NOT NULL,
  bot_id           TEXT NOT NULL,
  client_effect_id TEXT NOT NULL,
  effect_type      TEXT NOT NULL,               -- send_message | update_message | disable_components | start_stream | append_stream | finalize_stream
  request_hash     TEXT NOT NULL,               -- effect 内容指纹 (同 client_effect_id 异内容 → 冲突)
  message_id       TEXT,                        -- effect 作用的消息 (start_stream/send_message 产生, 其余引用)
  response_json    TEXT,                        -- 应用结果 (e.g. 产生的 message_id / event_id), 幂等回放返回
  applied_at       TEXT NOT NULL,
  outbox_id        TEXT,                        -- debug 溯源 (非主键, 同 effect 跨 retry 同 client_effect_id)
  PRIMARY KEY (channel_id, bot_id, client_effect_id)
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
**Files:** `src/do/migrations/bot-registry.ts`, `src/do/migrations/chat-channel.ts`, `test/do/bot-registry-migrations.test.ts`、`test/do/chat-channel-migrations-v2.test.ts`
- [ ] **Step 1:** 写 BotRegistry v2 migration（Schema Migrations 块 SQL）。`BOT_REGISTRY_CURRENT_SCHEMA_VERSION = 2`。加列 `ALTER TABLE ... ADD COLUMN`；建 `bot_commands`/`bot_command_aliases`/`bot_idempotency_keys`；建索引 `idx_bot_tokens_hash UNIQUE` + `idx_bot_commands_bot(bot_id, enabled, name)`（参考 `user-directory.ts` 加列先例）。
- [ ] **Step 2:** 写 ChatChannel v2 migration（Schema Migrations 块 SQL）。`DROP TABLE IF EXISTS commands/invocations`。
- [ ] **Step 3:** **DROP 安全证明:** grep + 测试证明 Phase 7 前无 runtime path 写旧 `commands`/`invocations` 表（`grep -rn "INSERT INTO commands\|INSERT INTO invocations\|UPDATE commands\|UPDATE invocations" src/ test/` 应无命中；现有 ChatChannel baseline 仅 CREATE 未写）。若发现任何写入 → 改 rename 迁移（`ALTER TABLE commands RENAME ...`），不可 drop。文档化结论。
- [ ] **Step 4:** 失败测试先行：fresh install 走 baseline 含新表（baseline detector 同步加新表，使 fresh 与 migrated 终态一致）；存量 v1 DO 走 v2 migration 后 schema 一致（`PRAGMA table_info` + `PRAGMA index_list` 比对 fresh vs migrated）。migration runner 幂等（重跑不报错）。
- [ ] **Step 5:** 绿。`npm run typecheck && vitest run test/do/bot-registry-migrations.test.ts test/do/chat-channel-migrations-v2.test.ts --no-file-parallelism --test-timeout=60000`。

### Task 7a-bot-identity: Bot token 验证 + BotRegistry token/profile internals
**Files:** `src/auth/bot.ts`, `src/do/bot-registry.ts`, `src/do/migrations/bot-registry.ts` (helper 封装), `test/do/bot-registry.test.ts`
- [ ] **Step 1:** 封装唯一 BotRegistry stub helper（全文件统一, 不散写 name）: `src/auth/bot.ts` 内 `export function botRegistryStub(env: Env) { return env.BOT_REGISTRY.get(env.BOT_REGISTRY.idFromName("registry")); }`。所有调用方（`verifyBotToken`、`/bot/commands` handler、ChatChannel callback dispatch、`/internal/bot-get` 调用方）只用此 helper。
- [ ] **Step 2:** BotRegistry `/internal/token-verify`：入 `{ token }` → SHA-256 hash(token) → `SELECT bot_id, scopes, revoked_at FROM bot_tokens JOIN bot_apps USING(bot_id) WHERE token_hash=? AND bot_apps.status='active'` → 命中且 `revoked_at IS NULL` → 返回 `{ bot_id, scopes }`；否则 401。singleton DO 内 `SELECT ... WHERE token_hash=?` 靠 `idx_bot_tokens_hash` UNIQUE 索引。
- [ ] **Step 3:** BotRegistry `/internal/bot-get?bot_id=`：singleton 内按 bot_id 查 row，返回 `{ bot_id, display_name, avatar_url, callback_url, callback_secret, status }`（供 ChatChannel callback 签名 + actor 投影）。`callback_secret` 仅 DO 间内部调用，不外泄。
- [ ] **Step 4:** `verifyBotToken(env, token)`：`botRegistryStub(env).fetch(/internal/token-verify { token })` → 注入 `bot_id` + `scopes`；非 active/revoked → 401。
- [ ] **Step 5:** `getBotIdentity(c)` Hono helper：取 `Authorization: Bearer` → `verifyBotToken` → 注入 `bot_id` + `scopes`；scope 不符 → `FORBIDDEN`。
- [ ] **Step 6:** 测试：合法 token 通过；revoked token 401；非 active bot 401；scope 缺失 403；singleton name 统一（grep 无 `"global"` / 其它 name 残留）。绿。

### Task 7a-catalog-sync: `PUT /api/chat/bot/commands` (BotRegistry catalog upsert)
**Files:** `src/routes/bot.ts`, `src/do/bot-registry.ts`, `test/routes/bot-commands.test.ts`
- [ ] **Step 1:** `PUT /api/chat/bot/commands` handler：`getBotIdentity`（需 scope `chat:commands:manage`）→ `Idempotency-Key` 必填 → body `{ commands: [{ name, description, options, default_member_permission, aliases?, default_enabled_on_install? }] }` → fetch BotRegistry `/internal/commands-sync`。
- [ ] **Step 2:** BotRegistry `/internal/commands-sync`：事务内 upsert `bot_commands`（`bot_command_id` 复用：同 `bot_id+name` 复用既有 id，否则新 UUIDv7）+ 全量替换 `bot_command_aliases`（diff 或 delete+reinsert）。校验 options schema（contract §9.3 type 枚举：string/integer/number/boolean/user/channel/role + min/max/required/description）—— pure `validateCommandOptions(options)`。返回 `{ commands: [{ bot_command_id, name, enabled, updated_at }] }`。`definition_hash = sha256(canonical(options+description+permission))`，`schema_version` 递增当 hash 变。
- [ ] **Step 3:** 幂等：同 `Idempotency-Key` + 同 body → 同响应。BotRegistry singleton DO 内 `bot_idempotency_keys` 表（v2 migration 加，与 ChatChannel `idempotency_keys` 同形，`operation='bot.commands.sync'`, `principal_kind='bot'`, `principal_id=bot_id`, `operation_id=Idempotency-Key`），`response_json` 存完整 `{ commands: [...] }` 响应。命中同 `operation_id`+同 `request_hash` → 返回缓存；异 `request_hash` → `IDEMPOTENCY_CONFLICT`。
- [ ] **Step 4:** 测试：首次注册返回 bot_command_id；重注册同名复用 id；options 非法 422；revoked token 401；缺 scope 403；幂等重试同响应。绿。

### Task 7a-install: Browser API bot-installation + command binding
**Files:** `src/routes/bot-installations.ts`, `src/do/chat-channel.ts` (new internals), `test/routes/bot-installations.test.ts`, `test/do/chat-channel-bot-install.test.ts`

> **Event 收口:** Phase 7 **不新增** `bot.installed` / `bot.updated` / `command.binding_updated` channel event type（避免 patch API contract + 前端 reducer 扩面）。频道 bot 设置变更（install / uninstall / enable-disable command / permission override）一律写 **`system.notice`**（v2.6 delta 形状），`payload_json` 内用 `notice_kind ∈ {bot.installed, bot.updated, command.binding_updated}` + `actor_kind=user, actor_id=<admin user_id>`，只放 `bot_id`/`bot_command_id`/before-after，**不放 callback_secret/token**。`command.invoked` / `interaction.created` / `interaction.completed` 属 bot runtime lifecycle，contract 已围绕其设计，保留。

- [ ] **Step 1:** `POST /api/chat/channels/:channel_id/bot-installations`（Browser API，channel owner/admin）：`getIdentity` → 校验 caller 是 channel owner/admin（ChatChannel `/internal/members-get` 查 role）→ `Idempotency-Key` → body `{ bot_id, initial_command_policy? }` → ChatChannel `/internal/bot-install`。
- [ ] **Step 2:** ChatChannel `/internal/bot-install`：事务内 — 校验 `CHANNEL_DISSOLVED` gate；fetch BotRegistry `/internal/bot-get`（拿 profile + callback config），失败 → `BOT_NOT_FOUND`；fetch BotRegistry `/internal/bot-commands?bot_id=`（拿该 bot 全部 enabled command 定义 + aliases）—— upsert `bot_installations(channel_id, bot_id, status=active, installed_by, bot_display_name, bot_avatar_url)`；按 `initial_command_policy`（默认 = catalog `default_enabled_on_install`）为每个 enabled command 创建 `channel_command_bindings(status=enabled, name/description/options_json/aliases_json/default_member_permission/definition_hash snapshot, ...)` + 写 `channel_command_names`（canonical + 每个 alias 行）—— **name conflict 检查:** 写 `channel_command_names` 前 `SELECT 1 FROM channel_command_names WHERE channel_id=? AND slash_name=?` 命中 → `COMMAND_NAME_CONFLICT`（回滚）。emit `system.notice` (notice_kind=`bot.installed`) + fanout outbox。返回 `{ bot_id, status, bindings: [...] }`。
- [ ] **Step 3:** `PATCH /api/chat/channels/:channel_id/bot-installations/:bot_id`（enable/disable 整个 bot 的 binding 批量 / 卸载）：body `{ status, command_policy? }`。ChatChannel `/internal/bot-install-update`：更新 `bot_installations.status` + 同步 `channel_command_bindings.status` + 增删 `channel_command_names` 行。`status=removed` → 删 name 行。emit `system.notice` (notice_kind=`bot.updated`)。
- [ ] **Step 4:** `PATCH /api/chat/channels/:channel_id/commands/:bot_command_id`：body `{ enabled, permission_override? }`。ChatChannel `/internal/command-binding-update`：upsert binding status；`enabled=true` 时写 `channel_command_names`（name conflict 检查 → `COMMAND_NAME_CONFLICT`）；`enabled=false` 删 name 行。emit `system.notice` (notice_kind=`command.binding_updated`)。
- [ ] **Step 5:** 测试：install 创建 bindings + names + bot summary snapshot；重复 install 同 `Idempotency-Key` 同响应、异 body → `IDEMPOTENCY_CONFLICT`；install 时 name 冲突 → `COMMAND_NAME_CONFLICT` 回滚；非 admin 403；enable 一个 disabled command name 冲突 → 409；卸载删 name 行；`system.notice` 形状正确（无 secret/token 泄露）。绿。

### Task 7a-commands-query: `GET /api/chat/channels/:channel_id/commands` (prefix suggest)
**Files:** `src/routes/bot-installations.ts`, `src/do/chat-channel.ts`, `test/routes/channel-commands.test.ts`
- [ ] **Step 1:** `GET .../commands?prefix=as`：`getIdentity` → `channelRouteNameFor` + 成员校验 → ChatChannel `/internal/channel-commands?prefix=as&user_id=`。
- [ ] **Step 2:** ChatChannel `/internal/channel-commands`：**纯本地读** binding snapshot（read cache，允许短暂 stale —— catalog sync 后 binding snapshot 过期由 7b-invoke 顺手刷新，此处不强制刷新，suggest 场景可接受）。`SELECT binding_id, bot_command_id, bot_id, status, permission_override, name, description, options_json, aliases_json, default_member_permission, definition_hash FROM channel_command_bindings WHERE channel_id=? AND status='enabled'`，JOIN `bot_installations` 取 `bot_display_name`/`bot_avatar_url`（避免为每命令 fetch BotRegistry）。
- [ ] **Step 3:** 查询逻辑：prefix 命中 `name` 或 `aliases_json` 任一即返回；`permission_override ?? default_member_permission` 与 caller role 比较（member/admin/owner），过滤 caller 无权调用者。响应项含 contract §9.4 字段 + `bot:{bot_id, display_name, avatar_url}`（来自 `bot_installations` snapshot）+ `aliases` + `matched_name` + `matched_kind`（prefix 命中的是 canonical 还是 alias）。
- [ ] **Step 4:** 测试：prefix 命中 canonical / alias 分别返回正确 `matched_kind`；非成员 403；caller role 不足过滤掉 admin-only command；无 enabled command 返回空；bot summary 来自 snapshot（不触发跨 DO fetch）。绿。
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

> **Correctness source = 当前 BotRegistry catalog, 不是 binding snapshot.** binding snapshot 是 read cache（供 `/commands`）；`command.invoke` 必须查 BotRegistry 当前 `bot_commands` 行校验，否则用户可能用过期 schema 成功建 invocation、callback 阶段才失败，污染状态机。

- [ ] **Step 1:** idempotency cheap pre-check（先于一切）：`SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=invoker AND operation='command.invoke' AND operation_id=command_id AND request_hash=? AND response_json IS NOT NULL` 命中 → 直接返回缓存 ack（不查 binding、不查 BotRegistry）。
- [ ] **Step 2:** 读本地 binding: `SELECT bot_id, status, permission_override, definition_hash, name, aliases_json, default_member_permission FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?` → 不存在/`status=disabled|removed` → `COMMAND_NOT_FOUND`。校验 `invoked_name` ∈ `channel_command_names(channel_id, bot_command_id)`（canonical 或 alias）；缺 → `COMMAND_NOT_FOUND`。校验 caller role ≥ `permission_override ?? default_member_permission` → 不足 `FORBIDDEN`。
- [ ] **Step 3:** **fetch BotRegistry 当前 catalog** (`botRegistryStub(env).fetch(/internal/command-get?bot_id=&bot_command_id=)`)：返回当前 `bot_commands` 行（name/description/options_json/default_member_permission/schema_version/definition_hash/enabled/deleted_at）+ 当前 aliases。disabled/deleted → `BOT_COMMAND_DISABLED`。`definition_hash` 与 binding snapshot 不一致（drift）→ 用 **当前 BotRegistry 定义** 校验 options，并在事务内顺手 `UPDATE channel_command_bindings SET name/description/options_json/aliases_json/default_member_permission/definition_hash=当前值`（刷新 snapshot，下次 `/commands` 读到新值）。`invoked_name` 仍必须命中当前 aliases（catalog 改了 alias 也要重校验）→ 不命中 → `COMMAND_NOT_FOUND`。
- [ ] **Step 4:** 校验 `options` vs **当前** `options_json` schema（required/type/range/min/max/visibility/成员关系 —— user 类型校验该 user 是 channel 成员，channel 类型校验 caller 可见该 channel，contract §9.3）—— pure `validateInvocationOptions(currentOptionsSchema, optionsValues, ctx)`。失败 → 422 `INVALID_OPTIONS`。
- [ ] **Step 5:** 事务内 — insert `command_invocations(status=pending, command_schema_version=<当前>, command_definition_hash=<当前>, invoked_name, options_json, ...)`（`UNIQUE(channel_id, invoker_user_id, command_id)` 二级防御命中且同 body → 走 idempotent 缓存，不新建）；emit `command.invoked` event `payload={invocation:{invocation_id, status:"pending", created_at}}` + fanout outbox；insert `bot_callback_outbox(kind=command_invocation, invocation_id, request_json=<§9.7 callback body with canonical name + invoked_name>, status=pending, next_attempt_at=now)`；写 `idempotency_keys.response_json = 完整 committed_ack payload`；bump alarm 到 `bot_callback_outbox` 最早 `next_attempt_at`（与 `projection_outbox` earliest-wins 合并，参考 `src/do/scheduler.ts` `scheduleNextAlarm` 多表）。
- [ ] **Step 6:** 返回 `{ channel_id, invocation_id, event_id }`（= committed_ack payload）。`UserConnection` 回 `command_ack {frame_type, command:"command.invoke", command_id, status:"committed", payload:{channel_id, invocation_id, event_id}}`。
- [ ] **Step 7:** 测试：invoke 创建 invocation + outbox + event + ack；重复同 `command_id`+body 返回同 ack 不新建（走 cheap pre-check，不查 BotRegistry）；同 `command_id`+异 body → `IDEMPOTENCY_CONFLICT`；disabled binding → `COMMAND_NOT_FOUND`；catalog disabled/deleted（BotRegistry 当前行）→ `BOT_COMMAND_DISABLED`；catalog drift → 用新定义校验 + 刷新 binding snapshot；`invoked_name` 用旧 alias（catalog 已删该 alias）→ `COMMAND_NOT_FOUND`；role 不足 → `FORBIDDEN`；invalid options → 422。绿。

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

### Task 7c-components: Components 校验 + 持久化 + bot actor snapshot + 投影
**Files:** `src/chat/components.ts`, `src/chat/message-projection.ts`, `src/do/chat-channel.ts`, `test/chat/components.test.ts`, `test/chat/message-projection-components.test.ts`
- [ ] **Step 1:** `validateComponents(components)`：`kind ∈ {button, select}`，`style ∈ {primary, secondary, danger}`，必填 `component_id`/`custom_id`，select 需 `options:[{value,label}]`。返回规范化数组或 error。
- [ ] **Step 2:** `messages.components_json` 持久化：bot 消息 send / bot-direct-message / `start_stream` / `update_message` 时写入；普通用户消息恒 `[]`（`parseMessageSendCommand` Task 7a-parser 显式拒绝非空 components）。`projectMessageForBrowser` 调用点（history `/internal/messages`、replay、lifecycle ack/event、context 读）读 `components_json` 反序列化传入 `opts.components`。
- [ ] **Step 3:** **bot actor snapshot 持久化进 `messages` 行**（方案 A，全路径同形）：bot 消息写入时 `INSERT messages(..., sender_bot_display_name, sender_bot_avatar_url)` 写入从 BotRegistry `/internal/bot-get` 取到的 display_name/avatar_url（`sender_kind='user'` 消息这两列为 NULL）。`projectMessageForBrowser` bot sender 分支：优先读 row 的 `sender_bot_display_name`/`sender_bot_avatar_url` → 输出 `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`；列为 NULL（旧消息/向后兼容）→ 回退 `{kind:"bot", bot_id}`。send/direct-message **ack** 此时消息尚未入 row 的投影由调用方传 `opts.botSummary`（从 BotRegistry 取）覆盖。`buildMessageCreatedPayload`（持久化 event payload）的 bot sender 仍存 `{kind:"bot", bot_id}` ref —— live ack/event 投影不靠 event payload 取 bot summary，而是靠 `messages` 行 snapshot 列 + `projectMessageForBrowser`，避免 history/context N 次回源 BotRegistry（design §3.5 例外：bot actor chat-owned，可随 message 行持久化 snapshot，spec line 958 确认）。
- [ ] **Step 4:** 测试：`validateComponents` 各枚举边界；bot 消息 components + bot snapshot 入库 + history/replay/context 投影携带完整 `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`；普通用户消息 components 恒 `[]`、bot snapshot 列 NULL；deleted/recalled bot 消息 components 清空（bot snapshot 仍可保留，仅 content 清空）。绿。

### Task 7c-effect-apply: ChatChannel `/internal/effect-apply` (apply effects idempotently)
**Files:** `src/do/chat-channel.ts`, `test/do/chat-channel-effect-apply.test.ts`
- [ ] **Step 1:** `/internal/effect-apply`：入 `{ outbox_id, bot_id, effects }`。逐 effect：查 `bot_effects_applied` 命中 `(channel_id, bot_id, client_effect_id)` → 返回缓存 `response_json`（幂等，跨 callback retry 同 `client_effect_id` 去重，stream 多次重放安全）；命中但 `request_hash` 不一致 → `IDEMPOTENCY_CONFLICT`（effect 内容漂移）；未命中 → 按 type 应用：
  - `send_message`：fetch BotRegistry `/internal/bot-get` 拿 bot summary → insert `messages(sender_kind=bot, sender_bot_id=bot_id, sender_bot_display_name, sender_bot_avatar_url, components_json=...)` + `message_attachments`（resolve bot-owned attachment_ids）+ emit `message.created` event（payload.message via `projectMessageForBrowser`，bot summary 来自行 snapshot 列）+ fanout outbox。记录 `message_id`。
  - `update_message`：校验 ownership → UPDATE `messages.text/components_json/updated_at/edited_at` + emit `message.updated`。
  - `disable_components`：UPDATE `messages.components_json`（标 disabled=true）+ emit `message.updated`（用 `message.updated` 收口，不新增 `message.components_disabled`）。
  - `start_stream`：insert `messages(stream_state=streaming, text="", sender_bot_*, components_json)` + emit `message.created`（stream_state=streaming）。
  - `append_stream`：校验 `stream_state=streaming` + ownership → UPDATE `messages.text = text || delta`（追加）+ emit `message.stream_delta` event `payload={message_id, delta}`（content-bearing，replay 走 `projectMessageForBrowser` 过滤）。
  - `finalize_stream`：UPDATE `messages.stream_state=final` + emit `message.stream_finalized`。
  - 每应用一个 effect → insert `bot_effects_applied(channel_id, bot_id, client_effect_id, effect_type, request_hash, response_json={message_id,...}, outbox_id)`。
- [ ] **Step 2:** 标 `command_invocations.status=completed`（全部 effect 应用完）/ `failed`（任 effect invalid）。emit `command.completed` event（含 bot preview，contract §10.4）—— `command.completed` 是 spec line 954 列出的 content-bearing event，payload 走 `projectMessageForBrowser`。本 plan 交付 `command.completed`。
- [ ] **Step 3:** 测试：send_message 创建 bot 消息 + components + bot summary 投影；重复 effect-apply 同 `client_effect_id` 跳过（含跨不同 outbox_id retry 场景）；同 `client_effect_id` 异 `request_hash` → `IDEMPOTENCY_CONFLICT`；append_stream 到非 streaming → failed；bot 改他人消息 → failed；stream 全流程 start→append×N→final 产出正确 text + 事件序列。绿。

### Task 7c-bot-message: Bot 直接发消息 `POST /api/chat/bot/channels/:channel_id/messages`
**Files:** `src/routes/bot.ts`, `src/do/chat-channel.ts` (`/internal/bot-message-send`), `test/routes/bot-message-send.test.ts`
- [ ] **Step 1:** `POST /api/chat/bot/channels/:channel_id/messages`：`getBotIdentity`（scope `chat:messages:write`）+ `Idempotency-Key` → body `{ type, text, reply_to_message_id, attachment_ids, components }` → ChatChannel `/internal/bot-message-send`。
- [ ] **Step 2:** ChatChannel `/internal/bot-message-send`：校验 bot installed in channel（`bot_installations` status=active，bot summary 从 `bot_installations` snapshot 取）+ scope；校验 `components`（`validateComponents`）；resolve bot-owned attachments；insert `messages(sender_kind=bot, sender_bot_id, sender_bot_display_name, sender_bot_avatar_url, components_json)` + emit `message.created`（payload.message via `projectMessageForBrowser`，bot summary 来自 snapshot）+ fanout；idempotency via `idempotency_keys(operation=bot.message.send, principal_kind='bot', operation_id=Idempotency-Key)`。返回 contract §9.8 `{ message, event:{event_id, type:"message.created"} }`。
- [ ] **Step 3:** 测试：bot 发消息含 components + bot summary 投影；未安装 bot → 403；非法 components → 422；幂等重试同响应（含完整 `message` 投影）。绿。
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
  - `GET /api/chat/channels/:id/commands?prefix=` → slash command 补全（含 `matched_name`/`matched_kind`/`aliases` + bot summary）。
  - WS `command.invoke` frame 形状 + committed_ack `{channel_id, invocation_id, event_id}` + `command.invoked` event + `command.completed` event 的 reducer 语义（invocation pending → completed 状态机）。
  - WS `interaction.submit` frame + `interaction.created` / `interaction.completed` events。
  - MessageComponent 渲染（`kind=button|select`，`style`，`disabled`，前端只原样回传 `custom_id`，不解析）。
  - Bot actor 渲染（`sender.kind==="bot"` → 用 `bot.display_name`/`avatar_url`，不得把 bot_id 当 user_id）。
  - stream_state 渲染（`streaming` 态展示 typing/delta 流；`message.stream_delta` event 追加；`message.stream_finalized` 收敛）。
  - `system.notice`（notice_kind=`bot.installed`/`bot.updated`/`command.binding_updated`）渲染 bot 设置变更 toast/通知（**无 bot.*/command.binding_updated 独立 event type**）。
- [ ] **Step 2:** 列 dzmm_archive 侧任务（不在本仓库执行）：slash input parser + suggest dropdown、command.invoke 发送 + optimistic invocation chip、interaction button/select 渲染 + submit、bot message 渲染、stream 渲染、bot settings sheet（admin install/uninstall bot + enable/disable command）。明确这些依赖本 plan 7a–7d 后端交付完成。

---

## Acceptance (contract §12.8)

- [ ] `PUT /api/chat/bot/commands`（bot token）注册全局 catalog + 别名；`COMMAND_NAME_CONFLICT` 仅在 channel binding 层。
- [ ] `GET /api/chat/channels/:id/commands?prefix=` 返回当前用户有效 command 集（含 matched_name/kind/aliases + role 过滤；bot summary 来自 `bot_installations` snapshot，不回源 BotRegistry）。
- [ ] `POST /api/chat/channels/:id/bot-installations` + `PATCH .../bot-installations/:bot_id` + `PATCH .../commands/:bot_command_id`（Browser API，admin/owner）；变更全部写 `system.notice`（notice_kind=bot.installed/bot.updated/command.binding_updated），**不新增** bot.* / command.binding_updated channel event type。
- [ ] WS `command.invoke` committed_ack `{channel_id, invocation_id, event_id}` + `command.invoked`(pending) → 异步 callback → effects 应用 → `command.completed`；`command_id` durable 幂等；correctness source = 当前 BotRegistry catalog（drift 时刷新 binding snapshot）。
- [ ] WS `interaction.submit` committed_ack `{channel_id, interaction_id, event_id}` + `interaction.created` → 异步 callback → `interaction.completed`；component ownership/disabled/custom_id 校验。
- [ ] Bot effects：send_message / update_message / disable_components / start_stream / append_stream / finalize_stream，按 `channel_id+bot_id+client_effect_id` 幂等（跨 retry 去重），bot 只能改自己的消息，stream 不变量。
- [ ] `POST /api/chat/bot/channels/:id/messages`（bot token，可带 components）。
- [ ] Bot callback 签名 `X-Lilium-Signature: v1=` + `X-Lilium-Timestamp` + `Content-Digest: sha-256=:`（§9.7）；callback 异步（outbox `pending|delivered|failed|dead_letter`，invocation `pending|dispatched|completed|failed|expired` 两套分开）。
- [ ] `projectMessageForBrowser` 携带 components + bot actor `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`（来源 `messages.sender_bot_*` snapshot 列，全路径同形）；deleted/recalled bot 消息安全投影（content 清空，bot summary 可留）。
- [ ] BotRegistry singleton (`getByName("registry")`)，统一 `botRegistryStub(env)` helper，无散写 name；`idx_bot_tokens_hash UNIQUE`。
- [ ] 全量 typecheck + vitest 绿（`--no-file-parallelism --test-timeout=60000`）。

---

## Revision notes (2026-06-26 review pass)

本 plan 已纳入 review pass 的 P0/P1 修订，作为执行基线：

- **P0-1 (BotRegistry singleton 收口):** 顶部 Architecture + 全文件统一为 singleton `getByName("registry")`，封装 `botRegistryStub(env)`；删除 "by bot_id" 拓扑残留；加 `idx_bot_tokens_hash UNIQUE` + `idx_bot_commands_bot(bot_id, enabled, name)`。
- **P0-2 (command.invoke correctness = 当前 BotRegistry):** Task 7b-invoke 改为先 idempotency cheap pre-check，再读 binding snapshot，**再 fetch BotRegistry `/internal/command-get`** 校验当前 catalog；disabled/deleted → `BOT_COMMAND_DISABLED`；`definition_hash` drift → 用当前定义校验 + 同事务刷新 binding snapshot；`invoked_name` 重校验当前 aliases。`/commands` 查询允许 stale snapshot，`command.invoke` 不允许。
- **P0-3 (bot actor snapshot 全路径):** `messages` 加 `sender_bot_display_name`/`sender_bot_avatar_url` 列（仅 `sender_kind='bot'` 写），`projectMessageForBrowser` 优先读行 snapshot → history/ack/live event/replay/context 全路径输出 `{kind:"bot", bot:{...}}`，不靠 event payload、不 N 次回源 BotRegistry。
- **P0-4 (event 收口 system.notice):** 移除 `bot.installed`/`bot.updated`/`command.binding_updated` channel event type，统一 `system.notice` + `notice_kind`；保留 `command.invoked`/`interaction.created`/`interaction.completed`/`command.completed`（contract runtime lifecycle）。
- **P1-1 (effect 幂等键):** `bot_effects_applied` PK 改为 `(channel_id, bot_id, client_effect_id)`，`outbox_id` 降为普通 debug 列；加 `request_hash`/`response_json`，同 `client_effect_id` 异内容 → `IDEMPOTENCY_CONFLICT`。
- **P1-2 (snapshot 字段补齐):** `channel_command_bindings` 加 `aliases_json`/`default_member_permission`；`bot_installations` 加 `bot_display_name`/`bot_avatar_url`；`/commands` 响应含 bot summary（来自 snapshot）。
- **P1-3 (两套 status 枚举分开):** outbox `pending|delivered|failed|dead_letter`（对齐 `projection_outbox`）；invocation `pending|dispatched|completed|failed|expired`。schema 注释 + 状态机块 + 测试固定。
- **DROP 安全:** Task 7a-migration 加 grep + 测试证明 Phase 7 前无 runtime path 写旧 `commands`/`invocations`，否则改 rename。