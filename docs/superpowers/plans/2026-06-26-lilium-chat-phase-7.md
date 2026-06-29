# Lilium Chat Phase 7 Implementation Plan (Bot slash command + rich interaction)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the official-bot integration path on the v4.0 base, using **Bot Gateway WebSocket RPC** as the runtime bot transport (contract v2.10 / spec v4.3). Bot 主动 outbound 连 `/api/chat/bot/ws` → `BotConnection DO(bot_id)`；Chat 经此 WS 推 `delivery`（`command_invocation` / `message_interaction` / `message_event`），bot 回 `delivery_result`（含 effects），Chat 回 `delivery_ack`。HTTP callback（Chat → bot `POST <bot_callback_url>` + HMAC 签名）**降级为 future transport，Phase 7 不实现**。Bot 管理/主动发送（`PUT /bot/commands`、`POST /bot/channels/{id}/messages`）保留为 bot → Chat 的 outbound HTTP。覆盖：BotRegistry（singleton）global command catalog + aliases + event capabilities、per-channel installation + command bindings、`command.invoke`（异步 `bot_delivery_outbox` delivery）、bot effects pipeline（send / update / disable-components / stream）、`interaction.submit` rich-UI lifecycle、passive `message_event` 订阅、bot 直接发消息 — 全部在现有 channel-scoped + `operation_id` idempotency + payload-bearing committed_ack base 上。Contract authority: §9（含 §9.7 Bot Gateway WS RPC 重写 + §9.9 passive 订阅）+ §3.8 (MessageComponent) + §10.2 (CommandAck) + §14 (v2.10 addendum invariants) of `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`。Design authority: `docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md` §0.10 + 阶段 7 (7a–7g)。

**Architecture (收口径, 与 spec v4.3 / contract v2.10 对齐):**

```
BotRegistry DO (singleton, getByName("registry"))  — ALL bot identities + token hashes + GLOBAL command catalog + aliases + event capabilities + bot profile
  (token 原文→hash 不可反查 bot_id; bot API 入口只有 bearer token, 无法在验 token 前定位 by-bot_id DO.
   bot 数量小, singleton SQLite 做 SELECT ... WHERE token_hash=? 最简. 封装唯一 helper:
   `botRegistryStub(env) = env.BOT_REGISTRY.get(env.BOT_REGISTRY.idFromName("registry"))`, 全文件不散写其它 name.)
  bot_apps               (bot_id PK, display_name, avatar_url, status)   — callback_url/callback_secret Phase 7 不写入 (future HTTP transport)
  bot_tokens             (token_hash UNIQUE, bot_id, scopes, revoked_at)   — baseline v1 + idx_bot_tokens_hash
  bot_commands            (bot_command_id PK, bot_id, name, options_json, default_member_permission,
                            default_enabled_on_install, schema_version, definition_hash, enabled, …)
  bot_command_aliases     (bot_command_id, bot_id, alias)     — alternate slash triggers, same command
  bot_event_capabilities  (bot_id, event_type, filters_json, default_enabled_on_install)   — message.created 被动能力声明 (7e)
  /internal/bot-get?bot_id= 仍是 singleton 内按 bot_id 查 row, 不是路由到 bot_id DO.

BotConnection DO (by bot_id)  — bot runtime WS + delivery 队列 (Phase 7 新增 DO 类, 需 wrangler binding)
  bot_connection_state    (bot_id PK, session_id, status=connected|disconnected, connected_at, …)
  bot_deliveries           (delivery_id PK, bot_id, channel_id, kind, source_outbox_id, target_id,
                             request_json, status=pending|sent|completed|failed|expired, attempts, next_attempt_at, …)
  hibernation: ctx.acceptWebSocket; 一个 bot_id 单 active connection, 新连接替换旧连接.
  delivery at-least-once: 持久化 bot_deliveries 后再推 socket; delivery_result 按 delivery_id 幂等.
  把 delivery_result 的 effects 路由回源 ChatChannel /internal/bot-delivery-result (effect 应用归 ChatChannel, 不归 BotConnection).
  reconnect redelivery pending/sent 未完成的; message_event 短 TTL expire/drop.

ChatChannel DO (by channel_id)   — per-channel availability + invocation/interaction/effect source-of-truth
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
  bot_delivery_outbox        (outbox_id, channel_id, bot_id, kind=command_invocation|message_interaction|message_event,
                              invocation_id|interaction_id|event_id, request_json, status, attempts, next_attempt_at, …)
                              — 原名 bot_callback_outbox, 重命名 (transport 不再 HTTP callback-specific)
  bot_effects_applied        (channel_id, bot_id, client_effect_id, effect_type, request_hash,
                              response_json, message_id, applied_at) — effect 幂等 (PK=channel_id+bot_id+client_effect_id)
  channel_bot_event_subscriptions  (subscription_id, channel_id, bot_id, event_type=message.created,
                              status=enabled|disabled|removed, filters_json, …)  — passive 订阅 (7e)
  messages + components_json + sender_bot_display_name + sender_bot_avatar_url  — bot 消息持久化 components + bot actor snapshot
```

**数据所有权一句话:** `BotRegistry` (singleton) owns the global bot command catalog + aliases + event capabilities + bot identities + token hashes; `BotConnection DO(bot_id)` owns the bot WebSocket hibernation + delivery 队列（不应用 effect）；`ChatChannel` owns per-channel bot installation + command bindings (read-cache snapshot of the catalog) + invocation/interaction state + `bot_delivery_outbox` + effect 应用 + passive 订阅; `GET /channels/{id}/commands` returns the current user's effective channel command set from the local binding snapshot (read cache, may be briefly stale — suggest-only); `command.invoke` correctness source is the **current BotRegistry catalog** (not the binding snapshot — see Task 7c-invoke): it fetches the live definition, rejects disabled/deleted, and opportunistically refreshes the binding snapshot on `definition_hash` drift, **且 precheck BotConnection online**（离线 → `BOT_OFFLINE`）; `command.invoke` only persists the invocation + `command.invoked` event + a `bot_delivery_outbox` row, then returns committed_ack **without** waiting for the bot; ChatChannel alarm flushes `bot_delivery_outbox` 到 `BotConnection.enqueueDelivery`，bot 回 `delivery_result`，ChatChannel `/internal/bot-delivery-result` 异步应用 effects。

**Async delivery 状态机 (§9.7 改写为 Bot Gateway WS; 两套 status 枚举分开, 不要混):**
```
outbox row status  (bot_delivery_outbox, 对齐 projection_outbox 命名):
  pending | delivered | failed | dead_letter
delivery row status  (BotConnection.bot_deliveries):
  pending | sent | completed | failed | expired
invocation status  (command_invocations / interactions 的 lifecycle):
  pending | dispatched | completed | failed | expired

command.invoke transaction committed
  → insert command_invocations(status=pending)
  → emit command.invoked event (status=pending) + fanout outbox
  → insert bot_delivery_outbox(kind=command_invocation, status=pending, next_attempt_at=now)
  → return committed_ack { channel_id, invocation_id, event_id }

ChatChannel alarm flushes bot_delivery_outbox (earliest-wins, retry/backoff/dead-letter):
  → fetch BotConnection DO(bot_id).enqueueDelivery(outbox row)  (DO-to-DO fetch, 非 HTTP)
  → BotConnection 持久化 bot_deliveries(status=pending) → 推 delivery 帧到 bot WS (status=sent)
  → bot 回 delivery_result{ effects: [...] }
  → BotConnection 调源 ChatChannel /internal/bot-delivery-result(delivery_id, effects)
  → ChatChannel validate effects (bot owns target messages, stream_state invariants, component ownership)
  → apply effects idempotently (by channel_id+bot_id+client_effect_id via bot_effects_applied)
  → write bot messages / updates / stream deltas + events + fanout outbox
  → BotConnection 标 bot_deliveries.status=completed; ChatChannel 标 bot_delivery_outbox.status=delivered
  → BotConnection 回 delivery_ack{status=applied|failed} 给 bot
  (outbox attempts >= max_attempts → outbox status=dead_letter + invocation status=failed|expired)
```

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), Hono, vitest-pool-workers, jose (HS256 JWT — Browser JWT only; Bot Gateway WS 用 bot token 直接验，不用 HMAC callback 签名), `aws4fetch` 已就位 (Phase 5，本阶段不涉及 S3)。Bot WS hibernation 用 `ctx.acceptWebSocket`（同 UserConnection 模式，独立 DO `BotConnection`）。Bot token 验证 = SHA-256 hash → 查 BotRegistry `bot_tokens.token_hash`（无 HMAC）。**不再需要** `src/auth/callback-sign.ts` / `Content-Digest` / `X-Lilium-Signature`（HTTP callback 降级为 future transport，Phase 7 不实现）。

---

## Global Constraints

(Phase 0–6 + E + v4.0 constraints carry forward. Load-bearing for this plan:)

- **Bot API ≠ Browser API 认证路径，且 Bot WS ≠ Browser WS。** Browser API 用 ToolBear browser JWT（`verifyBrowserJwt`，已在 `src/auth/jwt.ts`）走 `/api/chat/ws` → `UserConnection DO(user_id)`。Bot API 用 `Authorization: Bearer <bot_token>`；bot runtime 走 `/api/chat/bot/ws`（bot token 鉴权）→ `BotConnection DO(bot_id)`。两条 WS 物理分离，bot 不复用 Browser WS。HTTP `PUT /api/chat/bot/commands` 是 bot → Chat 的 outbound catalog sync（bot token 鉴权），**不要求 bot 暴露 HTTP endpoint**；Bot 消息 mutation 只经 WS effects（contract v2.17 移除 `POST .../messages`）。`/api/chat/channels/{id}/bot-installations` 与 `.../event-subscriptions/...` 是 Browser API（channel admin 操作），走 `getIdentity`。各路径不混用。
- **Bot runtime transport = Bot Gateway WS RPC（非 HTTP callback）。** contract §9.7 v2.10：Chat 不再 `POST <bot_callback_url>` + HMAC 签名；改为 bot 主动连 `/api/chat/bot/ws`，Chat 推 `delivery`，bot 回 `delivery_result`，Chat 回 `delivery_ack`。HTTP callback（HMAC 签名）列为 future transport，**Phase 7 不实现**，不留 `callback-sign.ts` / `bot-callback.ts` / `callback_secret` 列。三类 runtime delivery（`command_invocation` / `message_interaction` / `message_event`）都走 Bot Gateway WS。
- **BotConnection DO 是新增 DO 类，需 wrangler binding。** `wrangler.jsonc` + `wrangler.test.jsonc` 加 `{ "name": "BOT_CONNECTION", "class_name": "BotConnection" }` 绑定 + `migrations[].new_sqlite_classes` 加 `"BotConnection"`（两个 config 同步，见 CLAUDE.md toolchain gotchas）。**加 binding 后必须 `npm run cf-typegen`** 再 typecheck，否则 `worker-configuration.d.ts` 漂移。`src/do/bot-connection.ts` 实现该 DO（hibernation + delivery 队列 + `/internal/enqueue-delivery` + `webSocketMessage` delivery_result 解析 + reconnect redelivery）。helper `botConnectionStub(env, botId) = env.BOT_CONNECTION.get(env.BOT_CONNECTION.idFromName(botId))`。
- **BotRegistry singleton。** `botRegistryStub(env) = env.BOT_REGISTRY.get(env.BOT_REGISTRY.idFromName("registry"))`，全文件统一，不散写 name。token 原文→hash 不可反查 `bot_id`，singleton 内 `SELECT ... WHERE token_hash=?` 靠 `idx_bot_tokens_hash` UNIQUE 索引。`/internal/bot-get?bot_id=` 是 singleton 内按 bot_id 查 row，不是路由到 by-bot_id DO。
- **command 定义 = bot 全局；channel 只存 binding/enable。** contract §9.3 的 `PUT /api/chat/bot/commands` 路径无 `channel_id`，因此它只能是 BotRegistry catalog sync（upsert `bot_commands` + `bot_command_aliases`）。"同一频道内 enabled command 名称不能冲突"（§9.3）是 **ChatChannel `channel_command_names` 层的约束**，不是 BotRegistry catalog 层。现有 baseline 的 `commands` 表（带 `uniq_enabled_command_name WHERE enabled=1`）语义收口为 `channel_command_bindings` + `channel_command_names`（见 Task 7a-migration）。
- **Alias 是同一 `bot_command_id` 的 alternate slash trigger，不是独立 command。** `command.invoke` 仍用 `bot_command_id`，payload 可带 `invoked_name`（canonical name 或 alias）；`invoked_name` 必须命中该 channel 的 `channel_command_names`（canonical 或 alias 行）；alias 参与同频道 slash-name conflict；delivery payload 同时带 canonical `command.name` 与 `invoked_name`。
- **Bot runtime delivery 异步，不在 command.invoke 请求路径同步等 bot。** `command.invoke` committed_ack 只表 invocation 已持久接受；ChatChannel alarm flush `bot_delivery_outbox` → `BotConnection.enqueueDelivery` 异步 delivery（contract §9.7 v2.10）。状态机 `pending → dispatched → completed | failed | expired`。理由：bot delivery 是外部 IO（WS push + 等 bot `delivery_result`），不能进 ChatChannel mutation 关键路径；bot 可能慢/超时/streaming/多 effect，需独立状态机 + retry/dead-letter/idempotent effect 应用。`command.invoke` / `interaction.submit` precheck 时 bot 离线 → `BOT_OFFLINE`（见 bot offline policy 约束）。
- **Bot offline policy（contract §9.7.2 / §14 invariant 8）。** `command_invocation`：command.invoke precheck 时 BotConnection 离线 → `command_error` `BOT_OFFLINE`；invocation 已 commit 但 delivery 前 bot 断连 → 短 TTL 后 invocation 标 failed。`message_interaction`：interaction.submit precheck 时离线 → `BOT_OFFLINE`；已 commit 后断连 → 短 TTL 标 failed。`message_event`：bot 离线时 drop/expire，无用户可见错误；Phase 7 不批量重放历史 passive event。BotConnection online 状态 = `bot_connection_state.status='connected'`（Task 7b-connection-state）。
- **`command_id` 是 `command.invoke` / `interaction.submit` 的 durable 幂等键**（operation 分别为 `command.invoke` / `interaction.submit`），与 `message.send` 同一套 `idempotency_keys` 机制（`(principal_kind, principal_id, operation, operation_id)`，`response_json` 存完整 committed_ack payload）。`command_invocations.UNIQUE(channel_id, invoker_user_id, command_id)` 与 `interactions.UNIQUE(message_id, dedupe_principal_key, command_id)` 仅为二级防御，与 `messages` 一致。
- **delivery at-least-once + effect 幂等（contract §9.7.1 / §14 invariant 5）。** `delivery_id` 是 server 生成的 durable delivery id；bot 必须按 `delivery_id` 去重；Server 可 reconnect 后 redeliver 已发送但未完成 `delivery_result`/`delivery_ack` 的 delivery；bot 可重发 `delivery_result`。Effects 按 `(channel_id, bot_id, client_effect_id)` 幂等（`bot_effects_applied`，跨 delivery retry 去重）；同 `client_effect_id` 异 body → `BOT_EFFECT_CONFLICT`；effect 校验失败 → `BOT_EFFECT_INVALID`（delivery_ack status=failed）。
- **`projectMessageForBrowser` 是唯一 message serializer**（`src/chat/message-projection.ts`，已接受 `components` opt，当前恒 `[]`）。Phase 7 让 bot 消息真正携带 components：send/bot-direct-message/start_stream 时从请求取 components 写入 `messages.components_json`；history/replay/lifecycle 读 `components_json` 反序列化后传入 builder。`components` 加入 deleted/recalled 安全投影（builder 已对 hidden 态清空 components，无需改）。普通用户消息 `components` 恒为 `[]`（`parseMessageSendCommand` 已强制非 bot 不能携带 components —— Task 7a-parser 显式拒绝）。
- **Bot actor 不查 ToolBear profile。** `sender_kind="bot"`，`sender_bot_id`；display_name/avatar 来自 BotRegistry `bot_apps`（chat 自有数据）。bot actor snapshot 持久化进 `messages.sender_bot_display_name` / `messages.sender_bot_avatar_url`（仅 `sender_kind='bot'` 写入，见 Task 7c-components / migration），使 **history pagination / committed_ack / live event / replay event / message context** 全路径同形输出 `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`，不靠 `events.payload_json` 单一来源，也不在 history/context 时 N 次回源 BotRegistry（design §3.5 例外确认：bot actor 是 chat-owned，可随 event + message 行持久化 snapshot）。`projectMessageForBrowser` bot sender 分支当前只输出 `{kind:"bot", bot_id}`（无 display_name/avatar）—— Task 7c-projection 扩展为优先读 `messages` 行的 bot snapshot 列，无则回退 `{bot_id}`。
- **Binding snapshot = read cache, 不是 correctness source。** `channel_command_bindings` / `bot_installations` 存的 catalog/bot summary snapshot（name/description/options_json/aliases_json/default_member_permission/definition_hash/bot_display_name/bot_avatar_url）仅供 `GET /channels/{id}/commands` 本地读、避免 N 跨 DO fetch，允许短暂 stale。`command.invoke` 的 correctness source 是 **当前 BotRegistry catalog**（Task 7c-invoke）：fetch live `bot_commands` 行，disabled/deleted → `BOT_COMMAND_DISABLED`，`definition_hash` drift → 用当前定义校验 + 同事务顺手刷新 binding snapshot。不要只用 binding snapshot 校验 invocation，否则用户可能用过期 schema 成功建 invocation、delivery 阶段才失败。
- **Components 校验由 Worker/ChatChannel 承担。** contract §3.8：组件由 Bot 生成，Worker 校验后随消息持久化；`kind ∈ {button, select}`，`style ∈ {primary, secondary, danger}`，`custom_id` 是 Bot 私有 payload 前端只原样回传。Task 7c-components 实现 `validateComponents(components)` pure helper。
- **Channel 路由 + 成员校验复用既有路径。** `channelRouteNameFor(env, userId, channelId)` + `UserConnection.ensureSubscribed`。`command.invoke` / `interaction.submit` 在 `UserConnection.webSocketMessage` 新增分支，走同一 `ensureSubscribed` 成员门禁。
- **`CHANNEL_DISSOLVED` write-gate** 适用于所有 ChatChannel 写入（bot-install / binding / invoke / interaction / bot-direct-message / effect 应用 / event-subscription），与既有 mutation 一致。
- **Git:** USE THE REPO DEFAULT git config（do NOT pass `-c user.name=...`）。`git add <files> && git commit -m '...'`。Do NOT push or deploy。
- **Test config:** `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`。Typecheck: `npm run typecheck`。本机高负载时 vitest 5s 默认 timeout 假失败，务必带 `--test-timeout=60000`（见 memory `vitest-load-starvation-timeouts`）。
- **前端不在本仓库实现（contract §12.9 / spec "关于前端阶段"）。** 7h 只列前端接入所需契约面 + dzmm_archive 侧 checklist，不在 lilium-chat 写前端代码。

---

## File Structure

**Create:**
- `src/auth/bot.ts` — `verifyBotToken(env, token): Promise<{ bot_id, scopes }>`（SHA-256 hash → 查 BotRegistry `bot_tokens` → 校验 status/revoked/scopes）+ `getBotIdentity(c)` Hono helper（类比 `getIdentity`）+ `botRegistryStub(env)` 唯一 helper + `botConnectionStub(env, botId)` helper。
- `src/chat/components.ts` — `validateComponents(components: unknown): { ok, components?, error? }`（pure；校验 §3.8 枚举 + 必填字段 + select options）+ `projectComponentsForBrowser(rows): unknown[]`。
- `src/chat/bot-gateway-protocol.ts` — Bot Gateway WS 帧协议 pure helpers：`buildDeliveryFrame(delivery)`（`command_invocation` / `message_interaction` / `message_event` 三种 kind）、`parseDeliveryResult(frame)`、`buildDeliveryAck(delivery_id, status, error?)`、`parseHello(frame)`、`buildReady(bot_id, session_id, server_time)`。帧 `api_version: "lilium.chat.bot.v1"`。
- `src/chat/bot-delivery.ts` — `buildCommandInvocationDeliveryPayload(...)` + `buildMessageInteractionDeliveryPayload(...)` + `buildMessageEventDeliveryPayload(...)`（pure；产出 contract §9.7 delivery `request_json`，含 `invoked_name`）。原 `bot-callback.ts` 重命名而来。
- `src/chat/bot-effects.ts` — `validateEffects(effects, ctx)` + `applyEffect(...)` 调度（pure 校验；写入仍由 ChatChannel DO 事务承担）。`EffectType` 联合类型。
- `src/routes/bot-ws.ts` — `GET /api/chat/bot/ws` WS upgrade：验 bot token → route 到 `BotConnection DO(bot_id)` → `acceptWebSocket` with subprotocol `lilium.chat.bot.v1`。
- `src/routes/bot.ts` — bot-token HTTP routes：`PUT /api/chat/bot/commands`（catalog sync）。消息 mutation 经 Bot Gateway WS effects，无 HTTP 发消息路由（v2.17）。
- `src/routes/bot-installations.ts` — Browser API routes：`GET/POST /api/chat/channels/:channel_id/bot-installations`、`PATCH .../bot-installations/:bot_id`、`PATCH .../commands/:bot_command_id`、`GET .../commands`（channel command 查询，prefix suggest）、`PATCH .../bot-installations/:bot_id/event-subscriptions/message.created`（7e passive 订阅）。
- `src/do/bot-connection.ts` — `BotConnection` DO：hibernation（`ctx.acceptWebSocket`）、`/internal/enqueue-delivery`、`webSocketMessage`（hello/delivery_result/ping 解析）、`webSocketClose`/`webSocketError`（断线 tracking）、alarm（redelivery pending/sent + expire）、`bot_connection_state` + `bot_deliveries` schema migration、`/internal/connection-state`（online 查询，供 ChatChannel offline precheck）。
- `src/do/migrations/bot-connection.ts` — `BotConnection` baseline schema + migration runner（`bot_connection_state` + `bot_deliveries` + `idx_bot_deliveries_due`）。`BOT_CONNECTION_BASELINE_SCHEMA` + `migrateBotConnectionSchema`。
- `src/chat/command-invoke.ts` — `parseCommandInvokeCommand(frame)` + `parseInteractionSubmitCommand(frame)`（类比 `parseMessageSendCommand`，pure）。
- Test files（见各 Task）。

**Modify:**
- `src/auth/bot.ts` (Create, 上面) — 同时导出 `botRegistryStub(env)` + `botConnectionStub(env, botId)` 唯一 helper。
- `src/do/bot-registry.ts` — 实现 BotRegistry (singleton)：`/internal/token-verify`、`/internal/commands-sync`、`/internal/bot-get?bot_id=`、`/internal/command-get?bot_id=&bot_command_id=`（返回当前 `bot_commands` 行 + aliases + event capabilities，供 7c-invoke correctness 校验）、`/internal/bot-commands?bot_id=`（返回该 bot 全部 enabled command 定义 + aliases + event capabilities，供 7a-install 写 binding snapshot）、`/internal/event-capabilities?bot_id=`（返回该 bot 声明的 event_type + 默认 filters，供 7e install 默认订阅）、`/internal/seed-official-bot`、alarm（无 due job 时无 alarm，保留壳）。
- `src/do/migrations/bot-registry.ts` — v2 migration：create `bot_commands`、`bot_command_aliases`、`bot_event_capabilities`、`bot_idempotency_keys`（与 ChatChannel 同形，operation=`bot.commands.sync`）；`idx_bot_tokens_hash UNIQUE`、`idx_bot_commands_bot(bot_id, enabled, name)`。**不 add `callback_secret`**（HTTP callback future transport，Phase 7 不需要）。`BOT_REGISTRY_CURRENT_SCHEMA_VERSION = 2`。
- `src/do/bot-connection.ts` (Create, 上面) — BotConnection DO 主体。
- `src/do/chat-channel.ts` — 新增 internal endpoints：`/internal/bot-install`、`/internal/bot-install-update`、`/internal/command-binding-update`、`/internal/channel-commands`、`/internal/command-invoke`、`/internal/interaction-submit`、`/internal/bot-message-send`、`/internal/bot-delivery-result`（BotConnection 回写 effects 应用）、`/internal/event-subscription-update`、`/internal/connection-state-probe`（封装查 BotConnection online）；扩展 `alarm()` flush `bot_delivery_outbox`（与 `projection_outbox` earliest-wins 合并，参考 `src/do/scheduler.ts` 多表）；message send 事务内为 enabled `message_event` 订阅写 `bot_delivery_outbox(kind=message_event)`（7e）；扩展 `projectMessageForBrowser` 调用点携带 components（history/replay/lifecycle）+ bot snapshot（从 `messages.sender_bot_display_name`/`sender_bot_avatar_url` 读，不再每次回源 BotRegistry）。
- `src/do/migrations/chat-channel.ts` — v2 migration（见 Schema Migrations 块）：DROP 未用 baseline `commands`/`invocations`（**Task 7a-migration Step 3 加测试 + grep 约束证明 Phase 7 前无 runtime path 写旧表；若发现写入则改 rename，不可盲目 drop**）；CREATE `channel_command_bindings`（含 catalog snapshot 列）、`channel_command_names`、`command_invocations`、`bot_delivery_outbox`（原 `bot_callback_outbox` 重命名，加 `event_id` 列 + `kind` 含 `message_event`）、`bot_effects_applied`（PK=channel_id+bot_id+client_effect_id）、`channel_bot_event_subscriptions`；ALTER `messages` ADD `components_json`/`sender_bot_display_name`/`sender_bot_avatar_url`；ALTER `bot_installations` ADD `status`/`updated_by`/`updated_at`/`bot_display_name`/`bot_avatar_url`；ALTER `interactions` ADD `updated_at`/`completed_at`/`error_code`。
- `src/chat/message-projection.ts` — bot sender 分支优先读 `messages.sender_bot_display_name`/`sender_bot_avatar_url` snapshot 列，输出 `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`；snapshot 列为空时回退 `{kind:"bot", bot_id}`（向后兼容）。`opts.botSummary` 仍可选用于 send/direct-message ack（此时还没入库 snapshot，由调用方从 BotRegistry 取传入）。其余不变。
- `src/chat/command.ts` — `parseMessageSendCommand` 显式拒绝非空 `components`（普通用户消息不能携带 components）。
- `src/do/user-connection.ts` — `webSocketMessage` 新增 `command.invoke` + `interaction.submit` 分支（路由到 ChatChannel `/internal/command-invoke` / `/internal/interaction-submit`，回 committed_ack `{channel_id, invocation_id|interaction_id, event_id}`）。
- `src/index.ts` — 注册 bot WS route（`/api/chat/bot/ws`）+ bot routes + bot-installation routes + event-subscription route（在 `app.all("/api/chat/*")` 404 兜底之前）。
- `wrangler.jsonc` + `wrangler.test.jsonc` — 加 `BOT_CONNECTION` DO binding + `new_sqlite_classes` 加 `"BotConnection"`（两 config 同步）。加 binding 后 `npm run cf-typegen`。

**Do NOT touch:** `src/do/channel-fanout.ts`、`src/do/user-directory.ts`（成员/读态已就位）、`src/ws/frames.ts`（frame 类型已预留 command 名）、`src/auth/jwt.ts`（Browser JWT 不动）、`src/ids/uuidv7.ts`、wrangler secrets（无新 secret — `callback_secret` 不再需要；BotConnection 无 secret）。`src/do/channel-directory.ts` / `invite-directory.ts` 本阶段无关。**不创建** `src/auth/callback-sign.ts`（HTTP callback future transport，Phase 7 不实现）。

---

## Schema Migrations (summary — full SQL in Task 7a-migration / 7b-migration)

### BotRegistry v2 (`src/do/migrations/bot-registry.ts`)

```sql
-- bot_apps 已有 status; bot_tokens 已有 scopes/revoked_at（baseline v1）
-- callback_secret / callback_url Phase 7 不写入 (HTTP callback = future transport, 不实现)

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

-- bot 全局声明的被动 event 能力 + 默认 filters (7e)
CREATE TABLE bot_event_capabilities (
  bot_id       TEXT NOT NULL,
  event_type   TEXT NOT NULL,           -- message.created (Phase 7 仅此)
  filters_json TEXT NOT NULL,           -- 默认 message_types/include_bot_messages/...
  default_enabled_on_install INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY(bot_id, event_type)
);
```

### BotConnection baseline (`src/do/migrations/bot-connection.ts`)

```sql
CREATE TABLE bot_connection_state (
  bot_id          TEXT PRIMARY KEY,
  session_id      TEXT,
  status          TEXT NOT NULL,             -- connected | disconnected
  connected_at    TEXT,
  disconnected_at TEXT,
  last_seen_at    TEXT
);

CREATE TABLE bot_deliveries (
  delivery_id      TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  kind             TEXT NOT NULL,            -- command_invocation | message_interaction | message_event
  source_outbox_id TEXT NOT NULL,            -- 来自源 ChatChannel bot_delivery_outbox.outbox_id
  target_id        TEXT NOT NULL,            -- invocation_id | interaction_id | event_id
  request_json     TEXT NOT NULL,            -- delivery frame 请求体
  status           TEXT NOT NULL,            -- pending | sent | completed | failed | expired
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_bot_deliveries_due ON bot_deliveries(bot_id, status, next_attempt_at);
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
  -- catalog snapshot (READ CACHE; correctness source = BotRegistry current row, 见 7c-invoke)
  name                     TEXT NOT NULL,           -- snapshot of bot_commands.name
  description              TEXT,
  options_json             TEXT NOT NULL,           -- snapshot of bot_commands.options_json
  aliases_json             TEXT NOT NULL DEFAULT '[]',  -- snapshot of bot_command_aliases
  default_member_permission TEXT NOT NULL,          -- snapshot of bot_commands.default_member_permission
  definition_hash          TEXT NOT NULL,           -- snapshot; 7c-invoke 检测漂移并刷新
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

-- 原 bot_callback_outbox 重命名: transport 不再 HTTP callback-specific; kind 加 message_event
CREATE TABLE bot_delivery_outbox (
  outbox_id        TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL,
  bot_id           TEXT NOT NULL,
  kind             TEXT NOT NULL,              -- command_invocation | message_interaction | message_event
  invocation_id    TEXT,                        -- 非空 when kind=command_invocation
  interaction_id   TEXT,                        -- 非空 when kind=message_interaction
  event_id         TEXT,                        -- 非空 when kind=message_event
  request_json     TEXT NOT NULL,              -- 完整 delivery 请求体 (含 canonical name + invoked_name / message snapshot)
  -- outbox row status (对齐 projection_outbox 命名; 与 invocation/delivery lifecycle 状态分开)
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | failed | dead_letter
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  last_error       TEXT,
  failed_at        TEXT,
  next_attempt_at   TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_bot_delivery_due ON bot_delivery_outbox(status, next_attempt_at);

-- effect 幂等: PK = channel_id+bot_id+client_effect_id (跨 delivery retry 去重, 不是 outbox/delivery id)
CREATE TABLE bot_effects_applied (
  channel_id       TEXT NOT NULL,
  bot_id           TEXT NOT NULL,
  client_effect_id TEXT NOT NULL,
  effect_type      TEXT NOT NULL,               -- send_message | update_message | disable_components | start_stream | append_stream | finalize_stream
  request_hash     TEXT NOT NULL,               -- effect 内容指纹 (同 client_effect_id 异内容 → BOT_EFFECT_CONFLICT)
  message_id       TEXT,                        -- effect 作用的消息 (start_stream/send_message 产生, 其余引用)
  response_json    TEXT,                        -- 应用结果 (e.g. 产生的 message_id / event_id), 幂等回放返回
  applied_at       TEXT NOT NULL,
  outbox_id        TEXT,                        -- debug 溯源 (非主键, 同 effect 跨 retry 同 client_effect_id)
  PRIMARY KEY (channel_id, bot_id, client_effect_id)
);

-- passive message_event 订阅 (7e)
CREATE TABLE channel_bot_event_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  bot_id          TEXT NOT NULL,
  event_type      TEXT NOT NULL,               -- message.created (Phase 7 仅此)
  status          TEXT NOT NULL,              -- enabled | disabled | removed
  filters_json    TEXT NOT NULL,              -- message_types/include_bot_messages/include_own_messages/only_when_mentioned
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_by      TEXT,
  updated_at      TEXT NOT NULL,
  UNIQUE(channel_id, bot_id, event_type)
);
CREATE INDEX idx_channel_bot_event_subscriptions_enabled
  ON channel_bot_event_subscriptions(channel_id, event_type, status);
```

> Migration 实现遵循 `src/do/sql-migrations.ts` 的 `SqlMigration[]` + baseline detector 模式（见 `src/do/migrations/user-directory.ts` 加列先例）。baseline 不变（fresh install 走 baseline，含新表）；存量 DO 走 v2 migration。BotConnection 是新 DO 类，fresh install 走其自身 baseline（`bot_connection_state` + `bot_deliveries`），无存量迁移。

---

## Section 7a — Bot registry + command catalog + channel installation/bindings

### Task 7a-0: Baseline green + HEAD + wrangler binding
**Files:** `wrangler.jsonc`, `wrangler.test.jsonc`
- [x] **Step 1:** `npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Expected: clean + green (记录当前通过数). Record HEAD (`git rev-parse --short HEAD`). — HEAD=15e8514, typecheck clean, vitest 355 passed | 2 skipped (357)
- [x] **Step 2:** 确认 baseline schema 现状：`grep -nE "commands|invocations|interactions|bot_installations" src/do/migrations/chat-channel.ts`（确认这些表是 Phase 7 前未写入的空壳，drop 安全）。 — confirmed shells + no runtime INSERT/UPDATE into commands/invocations in src/ or test/
- [x] **Step 3:** 加 `BotConnection` DO binding：`wrangler.jsonc` `durable_objects.bindings` 加 `{ "name": "BOT_CONNECTION", "class_name": "BotConnection" }`；`migrations[].new_sqlite_classes` 数组末尾加 `"BotConnection"`。`wrangler.test.jsonc` 同步两处。运行 `npm run cf-typegen` 重生成 `worker-configuration.d.ts`。`npm run typecheck` 绿（此时 `BotConnection` 类尚不存在，typecheck 会失败是预期的——本 step 只保证 binding 注册，类在 7b 创建后 typecheck 才转绿；若需 7a-0 即绿可先创建空 `src/do/bot-connection.ts` 占位类）。 — done both configs + created placeholder `src/do/bot-connection.ts` + `src/do/migrations/bot-connection.ts` (baseline) + exported in `src/index.ts`; cf-typegen + typecheck green; vitest pool starts (7a-0 即绿路径)

### Task 7a-migration: BotRegistry v2 + ChatChannel v2 + BotConnection baseline migrations
**Files:** `src/do/migrations/bot-registry.ts`, `src/do/migrations/chat-channel.ts`, `src/do/migrations/bot-connection.ts`, `test/do/bot-registry-migrations.test.ts`、`test/do/chat-channel-migrations-v2.test.ts`、`test/do/bot-connection-migrations.test.ts`
- [x] **Step 1:** 写 BotRegistry v2 migration（Schema Migrations 块 SQL）。`BOT_REGISTRY_CURRENT_SCHEMA_VERSION = 2`。建 `bot_commands`/`bot_command_aliases`/`bot_event_capabilities`/`bot_idempotency_keys`；建索引 `idx_bot_tokens_hash UNIQUE` + `idx_bot_commands_bot(bot_id, enabled, name)`（参考 `user-directory.ts` 加列先例）。**不加 `callback_secret`**。
- [x] **Step 2:** 写 BotConnection baseline（`src/do/migrations/bot-connection.ts`）：`bot_connection_state` + `bot_deliveries` + `idx_bot_deliveries_due`；`migrateBotConnectionSchema` 在 `BotConnection` constructor 调用。`BOT_CONNECTION_BASELINE_SCHEMA` + `botConnectionBaseline` detector + 空 `botConnectionMigrations`（v1）。
- [x] **Step 3:** 写 ChatChannel v2 migration（Schema Migrations 块 SQL）。`DROP TABLE IF EXISTS commands/invocations`。CREATE `channel_command_bindings`/`channel_command_names`/`command_invocations`/`bot_delivery_outbox`/`bot_effects_applied`/`channel_bot_event_subscriptions`；ALTER `messages`/`bot_installations`/`interactions`。
- [x] **Step 4:** **DROP 安全证明:** grep + 测试证明 Phase 7 前无 runtime path 写旧 `commands`/`invocations` 表（`grep -rn "INSERT INTO commands\|INSERT INTO invocations\|UPDATE commands\|UPDATE invocations" src/ test/` 应无命中；现有 ChatChannel baseline 仅 CREATE 未写）。若发现任何写入 → 改 rename 迁移（`ALTER TABLE commands RENAME ...`），不可 drop。文档化结论。 — grep 无命中（commands/invocations 仅 baseline CREATE + v2 DROP + 新 v2 test 引用，无 runtime SELECT/INSERT/UPDATE）；`drop-safe` 测试断言 fresh DO 无 commands/invocations 表。
- [x] **Step 5:** 失败测试先行：fresh install 走 baseline 含新表（ChatChannel baseline detector 同步加新表，使 fresh 与 migrated 终态一致）；存量 v1 DO 走 v2 migration 后 schema 一致（`PRAGMA table_info` + `PRAGMA index_list` 比对 fresh vs migrated）。migration runner 幂等（重跑不报错）。BotConnection fresh install 走 baseline。 — fresh/legacy/idempotent/parity 测试全绿（11 tests）；parity 用 freshCtx/legacyCtx 分别采集 cols 再外层比对（不可嵌套 DO I/O）。
- [x] **Step 6:** 绿。`npm run typecheck && vitest run test/do/bot-registry-migrations.test.ts test/do/chat-channel-migrations-v2.test.ts test/do/bot-connection-migrations.test.ts --no-file-parallelism --test-timeout=60000`。 — 3 files / 11 tests green；全量 366 passed | 2 skipped (368) 无回归。

### Task 7a-bot-identity: Bot token 验证 + BotRegistry token/profile internals
**Files:** `src/auth/bot.ts`, `src/do/bot-registry.ts`, `test/do/bot-registry.test.ts`
- [x] **Step 1:** 封装唯一 helper（全文件统一, 不散写 name）: `src/auth/bot.ts` 内 `export function botRegistryStub(env: Env) { return env.BOT_REGISTRY.get(env.BOT_REGISTRY.idFromName("registry")); }` + `export function botConnectionStub(env: Env, botId: string) { return env.BOT_CONNECTION.get(env.BOT_CONNECTION.idFromName(botId)); }`。所有调用方（`verifyBotToken`、`/bot/commands` handler、ChatChannel delivery dispatch、`/internal/bot-get` 调用方、offline precheck）只用此 helper。 — done; grep 确认仅 `botRegistryStub` 用 `idFromName("registry")`，无其它 name。
- [x] **Step 2:** BotRegistry `/internal/token-verify`：入 `{ token }` → SHA-256 hash(token) → `SELECT bot_id, scopes, revoked_at FROM bot_tokens JOIN bot_apps USING(bot_id) WHERE token_hash=? AND bot_apps.status='active'` → 命中且 `revoked_at IS NULL` → 返回 `{ bot_id, scopes }`；否则 401。singleton DO 内 `SELECT ... WHERE token_hash=?` 靠 `idx_bot_tokens_hash` UNIQUE 索引。 — done（入参为 `{ token_hash }`，hash 在 Worker 侧 `hashBotToken` 算好传入，避免 DO 侧 async hash）。
- [x] **Step 3:** BotRegistry `/internal/bot-get?bot_id=`：singleton 内按 bot_id 查 row，返回 `{ bot_id, display_name, avatar_url, status }`（供 ChatChannel actor 投影 + install snapshot）。**不返回 `callback_secret`/`callback_url`**（Phase 7 不实现 HTTP callback）。 — done；测试断言响应无 callback_secret/callback_url。
- [x] **Step 4:** `verifyBotToken(env, token)`：`botRegistryStub(env).fetch(/internal/token-verify { token })` → 注入 `bot_id` + `scopes`；非 active/revoked → 401。 — done（`hashBotToken` 在 Worker 侧算 hash，传 `token_hash` 给 DO）。
- [x] **Step 5:** `getBotIdentity(c)` Hono helper：取 `Authorization: Bearer` → `verifyBotToken` → 注入 `bot_id` + `scopes`；scope 不符 → `FORBIDDEN`。 — done（`getBotIdentity(c, requiredScope)`）。
- [x] **Step 6:** 测试：合法 token 通过；revoked token 401；非 active bot 401；scope 缺失 403；singleton name 统一（grep 无 `"global"` / 其它 name 残留）。绿。 — 9 tests green；grep 确认 singleton name 统一。errors.ts 加 BOT_NOT_FOUND/BOT_COMMAND_DISABLED/BOT_OFFLINE/BOT_EFFECT_INVALID/BOT_EFFECT_CONFLICT + BOT_OFFLINE retryable；contract §11 同步加 BOT_NOT_FOUND/BOT_COMMAND_DISABLED。

### Task 7a-catalog-sync: `PUT /api/chat/bot/commands` (BotRegistry catalog upsert + event capabilities)
**Files:** `src/routes/bot.ts`, `src/do/bot-registry.ts`, `test/routes/bot-commands.test.ts`
- [x] **Step 1:** `PUT /api/chat/bot/commands` handler：`getBotIdentity`（需 scope `chat:commands:manage`）→ `Idempotency-Key` 必填 → body `{ commands: [{ name, description, options, default_member_permission, aliases?, default_enabled_on_install? }], event_capabilities?: [{ event_type, filters, default_enabled_on_install }] }` → fetch BotRegistry `/internal/commands-sync`。 — src/routes/bot.ts putBotCommandsHandler; registered in src/index.ts.
- [x] **Step 2:** BotRegistry `/internal/commands-sync`：事务内 upsert `bot_commands`（`bot_command_id` 复用：同 `bot_id+name` 复用既有 id，否则新 UUIDv7）+ 全量替换 `bot_command_aliases`（diff 或 delete+reinsert）+ upsert `bot_event_capabilities`（按 `(bot_id, event_type)`）。校验 options schema（contract §9.3 type 枚举：string/integer/number/boolean/user/channel/role + min/max/required/description）—— pure `validateCommandOptions(options)`。校验 `event_capabilities.event_type ∈ {message.created}`（Phase 7 仅此）。返回 `{ commands: [{ bot_command_id, name, enabled, updated_at }] }`。`definition_hash = sha256(canonical(options+description+permission))`，`schema_version` 递增当 hash 变。 — src/chat/command-options.ts (validateCommand/validateEventCapability/canonicalCommandDefinition/sha256Hex/commandsRequestHash); BotRegistry handleCommandsSync; response 含 aliases + default_enabled_on_install (与 contract §9.3 response 一致)。
- [x] **Step 3:** 幂等：同 `Idempotency-Key` + 同 body → 同响应。BotRegistry singleton DO 内 `bot_idempotency_keys` 表（v2 migration 加，与 ChatChannel `idempotency_keys` 同形，`operation='bot.commands.sync'`, `principal_kind='bot'`, `principal_id=bot_id`, `operation_id=Idempotency-Key`），`response_json` 存完整 `{ commands: [...] }` 响应。命中同 `operation_id`+同 `request_hash` → 返回缓存；异 `request_hash` → `IDEMPOTENCY_CONFLICT`。 — cheap pre-check + conflict check + 24h TTL，与 ChatChannel idempotency 同形。
- [x] **Step 4:** 测试：首次注册返回 bot_command_id；重注册同名复用 id；options 非法 422；`event_capabilities` 非 `message.created` → 422；revoked token 401；缺 scope 403；幂等重试同响应。绿。 — 9 tests green；全量 384 passed | 2 skipped (386) 无回归。

### Task 7a-install: Browser API bot-installation + command binding
**Files:** `src/routes/bot-installations.ts`, `src/do/chat-channel.ts` (new internals), `test/routes/bot-installations.test.ts`, `test/do/chat-channel-bot-install.test.ts`

> **Event 收口:** Phase 7 **不新增** `bot.installed` / `bot.updated` / `command.binding_updated` channel event type（避免 patch API contract + 前端 reducer 扩面）。频道 bot 设置变更（install / uninstall / enable-disable command / permission override / event-subscription）一律写 **`system.notice`**（v2.6 delta 形状），`payload_json` 内用 `notice_kind ∈ {bot.installed, bot.updated, command.binding_updated, bot.subscription_updated}` + `actor_kind=user, actor_id=<admin user_id>`，只放 `bot_id`/`bot_command_id`/before-after，**不放 token**。`command.invoked` / `interaction.created` / `interaction.completed` 属 bot runtime lifecycle，contract 已围绕其设计，保留。

- [x] **Step 1:** `POST /api/chat/channels/:channel_id/bot-installations`（Browser API，channel owner/admin）：`getIdentity` → 校验 caller 是 channel owner/admin（ChatChannel `/internal/members-get` 查 role）→ `Idempotency-Key` → body `{ bot_id, initial_command_policy?, initial_event_subscriptions? }` → ChatChannel `/internal/bot-install`。 — src/routes/bot-installations.ts installBotHandler; registered in index.ts.
- [x] **Step 2:** ChatChannel `/internal/bot-install`：事务内 — 校验 `CHANNEL_DISSOLVED` gate；fetch BotRegistry `/internal/bot-get`（拿 profile，无 callback config），失败 → `BOT_NOT_FOUND`；fetch BotRegistry `/internal/bot-commands?bot_id=`（拿该 bot 全部 enabled command 定义 + aliases + event capabilities）—— upsert `bot_installations(channel_id, bot_id, status=active, installed_by, bot_display_name, bot_avatar_url)`；按 `initial_command_policy`（默认 = catalog `default_enabled_on_install`）为每个 enabled command 创建 `channel_command_bindings(status=enabled, name/description/options_json/aliases_json/default_member_permission/definition_hash snapshot, ...)` + 写 `channel_command_names`（canonical + 每个 alias 行）—— **name conflict 检查:** 写 `channel_command_names` 前 `SELECT 1 FROM channel_command_names WHERE channel_id=? AND slash_name=?` 命中 → `COMMAND_NAME_CONFLICT`（回滚）；按 `initial_event_subscriptions` 或 catalog `event_capabilities.default_enabled_on_install` 创建 `channel_bot_event_subscriptions(status=enabled|disabled, filters_json)` 行（7e 默认订阅）。emit `system.notice` (notice_kind=`bot.installed`) + fanout outbox。返回 `{ bot_id, status, bindings: [...], subscriptions: [...] }`。 — handleBotInstall; fetch /internal/bot-commands (含 profile/aliases/event_caps); re-install = upsert（先删本 bot 旧 bindings/names 再重建）；owner/admin gate via activeRole; name conflict rollback; system.notice(notice_kind=bot.installed, bot_id). BotRegistry 加 /internal/bot-commands + /internal/command-get.
- [x] **Step 3:** `PATCH /api/chat/channels/:channel_id/bot-installations/:bot_id`（enable/disable 整个 bot 的 binding 批量 / 卸载）：body `{ status, command_policy? }`。ChatChannel `/internal/bot-install-update`：更新 `bot_installations.status` + 同步 `channel_command_bindings.status` + 增删 `channel_command_names` 行。`status=removed` → 删 name 行 + 删 `channel_bot_event_subscriptions`（标 removed）。emit `system.notice` (notice_kind=`bot.updated`)。 — handleBotInstallUpdate; status=removed deletes names+bindings+subs; status=active re-enables per policy with conflict check; system.notice(bot.updated).
- [x] **Step 4:** `PATCH /api/chat/channels/:channel_id/commands/:bot_command_id`：body `{ enabled, permission_override? }`。ChatChannel `/internal/command-binding-update`：upsert binding status；`enabled=true` 时写 `channel_command_names`（name conflict 检查 → `COMMAND_NAME_CONFLICT`）；`enabled=false` 删 name 行。emit `system.notice` (notice_kind=`command.binding_updated`)。 — handleCommandBindingUpdate; enabled→names (conflict vs other bot_command_id) via ON CONFLICT upsert, disabled→delete names; system.notice(command.binding_updated, bot_id+bot_command_id).
- [x] **Step 5:** 测试：install 创建 bindings + names + bot summary snapshot + 默认 event subscriptions；重复 install 同 `Idempotency-Key` 同响应、异 body → `IDEMPOTENCY_CONFLICT`；install 时 name 冲突 → `COMMAND_NAME_CONFLICT` 回滚；非 admin 403；enable 一个 disabled command name 冲突 → 409；卸载删 name 行 + 标 subscriptions removed；`system.notice` 形状正确（无 token 泄露）。绿。 — 7 route tests green (install/idempotent/conflict/name-conflict/non-admin/uninstall/notice-no-token)；全量 392 passed | 2 skipped (394)。errors.ts + contract §11 加 COMMAND_NOT_FOUND。buildSystemNoticePayload 扩展 bot_id/bot_command_id/binding_changes optional 字段。

### Task 7a-commands-query: `GET /api/chat/channels/:channel_id/commands` (prefix suggest)
**Files:** `src/routes/bot-installations.ts`, `src/do/chat-channel.ts`, `test/routes/channel-commands.test.ts`
- [x] **Step 1:** `GET .../commands?prefix=as`：`getIdentity` → `channelRouteNameFor` + 成员校验 → ChatChannel `/internal/channel-commands?prefix=as&user_id=`。—— 已在 `src/routes/bot-installations.ts` 完成并复用 `LIST` 身份链路。
- [x] **Step 2:** ChatChannel `/internal/channel-commands`：**纯本地读** binding snapshot（read cache，允许短暂 stale —— catalog sync 后 binding snapshot 过期由 7c-invoke 顺手刷新，此处不强制刷新，suggest 场景可接受）。`SELECT binding_id, bot_command_id, bot_id, status, permission_override, name, description, options_json, aliases_json, default_member_permission, definition_hash FROM channel_command_bindings WHERE channel_id=? AND status='enabled'`，JOIN `bot_installations` 取 `bot_display_name`/`bot_avatar_url`（避免为每命令 fetch BotRegistry）。—— 已在 `src/do/chat-channel.ts` 新增 `/internal/channel-commands`，直接 `JOIN bot_installations`。
- [x] **Step 3:** 查询逻辑：prefix 命中 `name` 或 `aliases_json` 任一即返回；`permission_override ?? default_member_permission` 与 caller role 比较（member/admin/owner），过滤 caller 无权调用者。响应项含 contract §9.4 字段 + `bot:{bot_id, display_name, avatar_url}`（来自 `bot_installations` snapshot）+ `aliases` + `matched_name` + `matched_kind`（prefix 命中的是 canonical 还是 alias）。—— 已在 `ChatChannel.handleChannelCommands` 按位排序拼返回。
- [x] **Step 4:** 测试：prefix 命中 canonical / alias 分别返回正确 `matched_kind`；非成员 403；caller role 不足过滤掉 admin-only command；无 enabled command 返回空；bot summary 来自 snapshot（不触发跨 DO fetch）。—— 已新增 `test/routes/channel-commands.test.ts`（6 条用例）。
- [x] **Step 5:** `src/index.ts` 注册所有 7a 路由。`npm run typecheck` 绿。—— 已在 `src/index.ts` 注册 `GET /api/chat/channels/:channel_id/commands`，并在后续任务内回归检查路由收口。

### Task 7a-seed: 官方 bot seed (admin / system job)
**Files:** `src/do/bot-registry.ts` (`/internal/seed-official-bot`), `test/do/bot-registry-seed.test.ts`
- [x] **Step 1:** BotRegistry `/internal/seed-official-bot`：admin-only（由 Worker 内部调用，无外部 HTTP 暴露；用 `BOT_REGISTRY` binding 单例 + 不暴露 route。seed 由部署后手动脚本 / `wrangler` 调用触发，不在 HTTP 路由注册）。upsert `bot_apps` (official bot) + `bot_commands` (ask/summarize 等) + `bot_event_capabilities`（如官方 bot 声明 `message.created` 能力）+ 一条 `bot_tokens`（返回原文一次）。—— 已在 `src/do/bot-registry.ts` 增加 `/internal/seed-official-bot`，支持幂等 token 回显。
- [x] **Step 2:** 测试：seed 幂等（重复 seed 不重建 token、不换 bot_command_id）；catalog sync 覆盖 seed 定义。—— 已新增 `test/do/bot-registry-seed.test.ts`（3 条用例），覆盖 token 回显一次、idempotent、`PUT /api/chat/bot/commands` 覆盖定义。

---

## Section 7b — Bot Gateway WS + delivery protocol

### Task 7b-ws-route: `GET /api/chat/bot/ws` WS upgrade + routing
**Files:** `src/routes/bot-ws.ts`, `src/index.ts`, `test/routes/bot-ws-upgrade.test.ts`
- [x] **Step 1:** `GET /api/chat/bot/ws`：取 `Authorization: Bearer <bot_token>`（或 `Sec-WebSocket-Protocol: lilium.chat.bot.v1`，二选一传 token —— **决策:** 用 `Authorization` header，与 HTTP bot routes 一致）→ `verifyBotToken` → 拿 `bot_id` → `botConnectionStub(env, botId)` → `fetch` DO with `Upgrade: websocket` header + `Sec-WebSocket-Protocol: lilium.chat.bot.v1` → DO `fetch` 识别 upgrade → `ctx.acceptWebSocket(server, [bot_id])` with subprotocol `lilium.chat.bot.v1`。token 无效 → 401（不 upgrade）。已实现（协议透传到 DO，由 DO 完成 `acceptWebSocket`）。
- [x] **Step 2:** `src/index.ts` 注册 `/api/chat/bot/ws`（在 404 兜底前）。`npm run typecheck` 绿。已注册且位于 fallback 前。
- [x] **Step 3:** 测试：合法 token upgrade 成功（subprotocol `lilium.chat.bot.v1`）；非法/revoked token → 401；缺 token → 401。绿（`test/routes/bot-ws-upgrade.test.ts`）。

### Task 7b-connection: BotConnection DO hibernation + hello/ready + connection state
**Files:** `src/do/bot-connection.ts`, `src/chat/bot-gateway-protocol.ts`, `test/do/bot-connection.test.ts`
- [x] **Step 1:** `BotConnection` extends `DurableObject<Env>`；constructor 调 `migrateBotConnectionSchema(this.ctx)`。`fetch`：短 circuit `handleSchemaVersionRequest`；`/ping`；`/internal/connection-state`（返回 `{ status: connected|disconnected, session_id }`，供 ChatChannel offline precheck）；recognize websocket Upgrade -> `acceptWebSocket`（subprotocol set）；`/internal/enqueue-delivery` is deferred + TODO placeholder（Task 7b-delivery-queue）。
- [x] **Step 2:** `webSocketMessage(ws, msg)`：parse JSON frame。`type=hello` → 读 `last_received_delivery_id`（reconnect 恢复点；目前先记录/回放 hint）→ upsert `bot_connection_state(status=connected, session_id, connected_at, last_seen_at)` → 回 `buildReady(bot_id, session_id, server_time)`（session_id = uuidv7，server_time 由 args 传入或单调时间，见 `src/ids/uuidv7.ts`）；`type=delivery_result` → Task 7b-delivery-result；`type=ping` → 回 `pong` + 更新 `last_seen_at`。
- [x] **Step 3:** `webSocketClose`/`webSocketError`：upsert `bot_connection_state(status=disconnected, disconnected_at)`；**不删 `bot_deliveries`**（pending/sent 行等 reconnect redelivery 或 alarm expire）。一个 `bot_id` 单 active connection：新 `hello` 替换旧 session（row keyed by bot_id）。
- [x] **Step 4:** `src/chat/bot-gateway-protocol.ts` pure helpers：`parseHello(frame)`、`buildReady(...)`、`buildDeliveryFrame(delivery)`、`parseDeliveryResult(frame)`、`buildDeliveryAck(...)`、`buildPong()`。`api_version: "lilium.chat.bot.v1"`。已补齐（`buildDeliveryAck` + minimal `buildDeliveryFrame`）。
- [x] **Step 5:** 测试：hello → ready（含 bot_id/session_id）；ping → pong；close → disconnected；`/internal/connection-state` 返回正确 status。`test/do/bot-connection.test.ts` 通过。单 active connection 覆盖留待后续 7b-delivery-result/queue 子任务补充场景断言。

### Task 7b-delivery-queue: `/internal/enqueue-delivery` + push to socket
**Files:** `src/do/bot-connection.ts`, `test/do/bot-connection-delivery.test.ts`
- [x] **Step 1:** `/internal/enqueue-delivery`（ChatChannel alarm flush 调）：入 `{ outbox_id, channel_id, kind, target_id, request_json }`。事务内 insert `bot_deliveries(delivery_id=uuidv7, bot_id, channel_id, kind, source_outbox_id=outbox_id, target_id, request_json, status=pending, next_attempt_at=now)`（**先持久化再推 socket**，at-least-once）。`delivery_id` 是 server 生成的 durable delivery id（contract §9.7.1）。
- [x] **Step 2:** 若 `bot_connection_state.status=connected` → 取该 bot 的 hibernated ws（`ctx.getWebSockets()` 找 subprotocol 匹配）→ `ws.send(buildDeliveryFrame(delivery))` → 标 `bot_deliveries.status=sent`。若 disconnected → 保持 `pending`（等 reconnect redelivery 或 alarm expire）。
- [x] **Step 3:** alarm：`runDueJobs` flush `bot_deliveries(status=pending|sent, next_attempt_at<=now)`（reconnect redelivery / retry）。`message_event` kind 短 TTL 后 `status=expired`（bot 离线 drop，无用户可见错误）；`command_invocation`/`message_interaction` 重试至 `max_attempts` → `failed`（ChatChannel 标 invocation/interaction failed，可选 emit failed event）。
- [x] **Step 4:** 测试：enqueue 持久化 delivery；connected 时推 socket 标 sent；disconnected 时保持 pending；alarm redelivery pending/sent；message_event 离线 expire；command_invocation 重试至 failed。绿。

### Task 7b-delivery-result: `delivery_result` 解析 + 回写 ChatChannel + delivery_ack
**Files:** `src/do/bot-connection.ts`, `src/do/chat-channel.ts` (`/internal/bot-delivery-result`), `test/do/bot-connection-delivery-result.test.ts`, `test/do/chat-channel-bot-delivery-result.test.ts`
- [ ] **Step 1:** `webSocketMessage` `type=delivery_result` 分支：`parseDeliveryResult(frame)` → 按 `delivery_id` 查 `bot_deliveries`（幂等：已 `completed` → 直接回 `delivery_ack{applied}` 不重应用 effects）。校验 `status=ok` + `effects` 形状（`validateEffects` pure，见 7c-effects-validate，但 BotConnection 只做 frame 形状校验，业务 effect 校验归 ChatChannel）。
- [ ] **Step 2:** BotConnection 调源 ChatChannel `/internal/bot-delivery-result`（DO-to-DO fetch，body `{ delivery_id, outbox_id=source_outbox_id, bot_id, channel_id, effects }`）。ChatChannel 应用 effects（Task 7c-effect-apply）→ 返回 `{ status: applied|failed, error? }`。
- [ ] **Step 3:** BotConnection 按返回结果标 `bot_deliveries.status=completed|failed` + 回 `buildDeliveryAck(delivery_id, applied|failed, error?)` 给 bot ws。failed 时 `error.code` 来自 ChatChannel（`BOT_EFFECT_INVALID` / `BOT_EFFECT_CONFLICT` 等）。
- [ ] **Step 4:** 测试：delivery_result 成功 → effects 应用 + delivery_ack applied；重复 delivery_result（同 delivery_id 已 completed）→ 不重应用 + 回 applied；ChatChannel 拒绝 effect → delivery_ack failed + `BOT_EFFECT_INVALID`；`BOT_EFFECT_CONFLICT` 透传。绿。

### Task 7b-reconnect: reconnect redelivery + dedup
**Files:** `src/do/bot-connection.ts`, `test/do/bot-connection-reconnect.test.ts`
- [ ] **Step 1:** `hello.last_received_delivery_id`：bot reconnect 时传最后收到的 `delivery_id`。BotConnection 据此跳过已收到的（但仅作 hint；at-least-once 仍允许 redeliver —— bot 必须按 `delivery_id` 去重，contract §9.7.1）。
- [ ] **Step 2:** reconnect 后 alarm 立即 flush 该 bot 的 `bot_deliveries(status=pending|sent)`（已 sent 但未 completed 的也重发，bot 侧 `delivery_id` 去重）。
- [ ] **Step 3:** 测试：disconnect 中途 enqueue 的 delivery，reconnect 后收到；已 sent 未 completed 的 delivery reconnect 后重发（bot 去重不重复应用 effect）；`last_received_delivery_id` hint 跳过。绿。

---

## Section 7c — command.invoke + invocation + async delivery + effects + stream + bot actor snapshot

### Task 7c-parser: `parseCommandInvokeCommand` + WS routing
**Files:** `src/chat/command-invoke.ts`, `src/do/user-connection.ts`, `test/chat/command-invoke-parser.test.ts`
- [ ] **Step 1:** `parseCommandInvokeCommand(frame)`：校验 `frame.command==="command.invoke"` + 顶层 `command_id`（durable operation id）+ `channel_id` + payload `{ bot_command_id, invoked_name?, options }`。`options` 是 `{ [name]: { type, value } }` map（contract §9.5）。返回 `{ command_id, channel_id, bot_command_id, invoked_name: string|null, options }`。
- [ ] **Step 2:** `UserConnection.webSocketMessage` 新增 `command.invoke` 分支：parse → `channelRouteNameFor` + `ensureSubscribed`（成员门禁，失败 `CHANNEL_NOT_FOUND`/`FORBIDDEN`）→ fetch ChatChannel `/internal/command-invoke`（body 含 `operation_id=command_id`, `invoker_user_id`, `bot_command_id`, `invoked_name`, `options`, `channel_id`）→ 透传 committed_ack `{channel_id, invocation_id, event_id}` 给 socket。错误透传 `command_error`（含 `BOT_OFFLINE`）。
- [ ] **Step 3:** 测试：parser 拒缺 `command_id`/`channel_id`/`bot_command_id`；`options` 缺 type/value 的项被拒或归一。绿。

### Task 7c-invoke: ChatChannel `/internal/command-invoke` (校验 + outbox + offline precheck)
**Files:** `src/do/chat-channel.ts`, `test/do/chat-channel-command-invoke.test.ts`

> **Correctness source = 当前 BotRegistry catalog, 不是 binding snapshot.** binding snapshot 是 read cache（供 `/commands`）；`command.invoke` 必须查 BotRegistry 当前 `bot_commands` 行校验，否则用户可能用过期 schema 成功建 invocation、delivery 阶段才失败，污染状态机。

- [ ] **Step 1:** idempotency cheap pre-check（先于一切）：`SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=invoker AND operation='command.invoke' AND operation_id=command_id AND request_hash=? AND response_json IS NOT NULL` 命中 → 直接返回缓存 ack（不查 binding、不查 BotRegistry、不查 online）。
- [ ] **Step 2:** 读本地 binding: `SELECT bot_id, status, permission_override, definition_hash, name, aliases_json, default_member_permission FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?` → 不存在/`status=disabled|removed` → `COMMAND_NOT_FOUND`。校验 `invoked_name` ∈ `channel_command_names(channel_id, bot_command_id)`（canonical 或 alias）；缺 → `COMMAND_NOT_FOUND`。校验 caller role ≥ `permission_override ?? default_member_permission` → 不足 `FORBIDDEN`。
- [ ] **Step 3:** **fetch BotRegistry 当前 catalog** (`botRegistryStub(env).fetch(/internal/command-get?bot_id=&bot_command_id=)`)：返回当前 `bot_commands` 行（name/description/options_json/default_member_permission/schema_version/definition_hash/enabled/deleted_at）+ 当前 aliases。disabled/deleted → `BOT_COMMAND_DISABLED`。`definition_hash` 与 binding snapshot 不一致（drift）→ 用 **当前 BotRegistry 定义** 校验 options，并在事务内顺手 `UPDATE channel_command_bindings SET name/description/options_json/aliases_json/default_member_permission/definition_hash=当前值`（刷新 snapshot，下次 `/commands` 读到新值）。`invoked_name` 仍必须命中当前 aliases（catalog 改了 alias 也要重校验）→ 不命中 → `COMMAND_NOT_FOUND`。
- [ ] **Step 4:** 校验 `options` vs **当前** `options_json` schema（required/type/range/min/max/visibility/成员关系 —— user 类型校验该 user 是 channel 成员，channel 类型校验 caller 可见该 channel，contract §9.3）—— pure `validateInvocationOptions(currentOptionsSchema, optionsValues, ctx)`。失败 → 422 `INVALID_OPTIONS`。
- [ ] **Step 5:** **BotConnection offline precheck:** fetch `botConnectionStub(env, bot_id).fetch(/internal/connection-state)` → `status=disconnected` → `command_error` `BOT_OFFLINE`（`retryable=true`，contract §11）。**不在 precheck 持久化 invocation**（离线即拒，无副作用）。
- [ ] **Step 6:** 事务内 — insert `command_invocations(status=pending, command_schema_version=<当前>, command_definition_hash=<当前>, invoked_name, options_json, ...)`（`UNIQUE(channel_id, invoker_user_id, command_id)` 二级防御命中且同 body → 走 idempotent 缓存，不新建）；emit `command.invoked` event `payload={invocation:{invocation_id, status:"pending", created_at}}` + fanout outbox；insert `bot_delivery_outbox(kind=command_invocation, invocation_id, request_json=<§9.7 command_invocation delivery body with canonical name + invoked_name>, status=pending, next_attempt_at=now)`；写 `idempotency_keys.response_json = 完整 committed_ack payload`；bump alarm 到 `bot_delivery_outbox` 最早 `next_attempt_at`（与 `projection_outbox` earliest-wins 合并，参考 `src/do/scheduler.ts` `scheduleNextAlarm` 多表）。
- [ ] **Step 7:** 返回 `{ channel_id, invocation_id, event_id }`（= committed_ack payload）。`UserConnection` 回 `command_ack {frame_type, command:"command.invoke", command_id, status:"committed", payload:{channel_id, invocation_id, event_id}}`。
- [ ] **Step 8:** alarm flush `bot_delivery_outbox(kind=command_invocation, status=pending)` → `botConnectionStub(env, bot_id).fetch(/internal/enqueue-delivery, ...)` → 标 outbox `status=delivered`（成功 enqueue 到 BotConnection）；enqueue 失败（BotConnection fetch 异常）→ `bumpDeliveryRetry`（指数退避，`>=max_attempts` → `dead_letter` + `command_invocations.status=failed`）。
- [ ] **Step 9:** 测试：invoke 创建 invocation + outbox + event + ack；重复同 `command_id`+body 返回同 ack 不新建（走 cheap pre-check）；同 `command_id`+异 body → `IDEMPOTENCY_CONFLICT`；disabled binding → `COMMAND_NOT_FOUND`；catalog disabled/deleted（BotRegistry 当前行）→ `BOT_COMMAND_DISABLED`；catalog drift → 用新定义校验 + 刷新 binding snapshot；`invoked_name` 用旧 alias（catalog 已删该 alias）→ `COMMAND_NOT_FOUND`；role 不足 → `FORBIDDEN`；invalid options → 422；**bot 离线 → `BOT_OFFLINE` 且不持久化 invocation**；alarm flush enqueue 成功 → outbox delivered；enqueue 失败 → 退避 → dead_letter + invocation failed。绿。

### Task 7c-effects-validate: `validateEffects` + effect 应用调度
**Files:** `src/chat/bot-effects.ts`, `test/chat/bot-effects.test.ts`
- [ ] **Step 1:** `EffectType = "send_message" | "update_message" | "disable_components" | "start_stream" | "append_stream" | "finalize_stream"`（contract §9.7.3）。`validateEffects(effects, ctx)`：每 effect 校验 `client_effect_id` 唯一（同批内）；`send_message`/`start_stream` 的 `message` 字段形状（contract §9.8 + §3.4，`type`/`format`/`text`/`reply_to_message_id`/`attachment_ids`/`components`）；`update_message`/`disable_components`/`append_stream`/`finalize_stream` 需 `message_id` 且该消息 `sender_kind=bot` 且 `bot_id=ctx.bot_id`（bot 只能改自己的消息）；`append_stream` 需目标 `stream_state=streaming`；`disable_components` 校验 component_id 归属。返回 `{ ok, effects?, error? }`。校验失败 → `BOT_EFFECT_INVALID`。
- [ ] **Step 2:** `projectComponentsForBrowser(rows)` + `validateComponents`（§3.8 枚举）—— Task 7c-components 抽出，此处引用。
- [ ] **Step 3:** 测试：合法 effects 通过；bot 改他人消息 → `BOT_EFFECT_INVALID`；`append_stream` 到非 streaming → `BOT_EFFECT_INVALID`；重复 `client_effect_id` → `BOT_EFFECT_INVALID`。绿。

### Task 7c-components: Components 校验 + 持久化 + bot actor snapshot + 投影
**Files:** `src/chat/components.ts`, `src/chat/message-projection.ts`, `src/do/chat-channel.ts`, `test/chat/components.test.ts`, `test/chat/message-projection-components.test.ts`
- [ ] **Step 1:** `validateComponents(components)`：`kind ∈ {button, select}`，`style ∈ {primary, secondary, danger}`，必填 `component_id`/`custom_id`，select 需 `options:[{value,label}]`。返回规范化数组或 error。
- [ ] **Step 2:** `messages.components_json` 持久化：bot 消息 send / bot-direct-message / `start_stream` / `update_message` 时写入；普通用户消息恒 `[]`（`parseMessageSendCommand` Task 7a-parser 显式拒绝非空 components）。`projectMessageForBrowser` 调用点（history `/internal/messages`、replay、lifecycle ack/event、context 读）读 `components_json` 反序列化传入 `opts.components`。
- [ ] **Step 3:** **bot actor snapshot 持久化进 `messages` 行**（方案 A，全路径同形）：bot 消息写入时 `INSERT messages(..., sender_bot_display_name, sender_bot_avatar_url)` 写入从 BotRegistry `/internal/bot-get` 取到的 display_name/avatar_url（`sender_kind='user'` 消息这两列为 NULL）。`projectMessageForBrowser` bot sender 分支：优先读 row 的 `sender_bot_display_name`/`sender_bot_avatar_url` → 输出 `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`；列为 NULL（旧消息/向后兼容）→ 回退 `{kind:"bot", bot_id}`。send/direct-message **ack** 此时消息尚未入 row 的投影由调用方传 `opts.botSummary`（从 BotRegistry 取）覆盖。`buildMessageCreatedPayload`（持久化 event payload）的 bot sender 仍存 `{kind:"bot", bot_id}` ref —— live ack/event 投影不靠 event payload 取 bot summary，而是靠 `messages` 行 snapshot 列 + `projectMessageForBrowser`，避免 history/context N 次回源 BotRegistry。
- [ ] **Step 4:** 测试：`validateComponents` 各枚举边界；bot 消息 components + bot snapshot 入库 + history/replay/context 投影携带完整 `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`；普通用户消息 components 恒 `[]`、bot snapshot 列 NULL；deleted/recalled bot 消息 components 清空（bot snapshot 仍可保留，仅 content 清空）。绿。

### Task 7c-effect-apply: ChatChannel `/internal/bot-delivery-result` (apply effects idempotently)
**Files:** `src/do/chat-channel.ts`, `test/do/chat-channel-effect-apply.test.ts`
- [ ] **Step 1:** `/internal/bot-delivery-result`：入 `{ delivery_id, outbox_id, bot_id, channel_id, effects }`。逐 effect：查 `bot_effects_applied` 命中 `(channel_id, bot_id, client_effect_id)` → 返回缓存 `response_json`（幂等，跨 delivery retry 同 `client_effect_id` 去重，stream 多次重放安全）；命中但 `request_hash` 不一致 → `BOT_EFFECT_CONFLICT`（effect 内容漂移）；未命中 → `validateEffects` 校验 → 按 type 应用：
  - `send_message`：fetch BotRegistry `/internal/bot-get` 拿 bot summary → insert `messages(sender_kind=bot, sender_bot_id=bot_id, sender_bot_display_name, sender_bot_avatar_url, components_json=...)` + `message_attachments`（resolve bot-owned attachment_ids）+ emit `message.created` event（payload.message via `projectMessageForBrowser`，bot summary 来自行 snapshot 列）+ fanout outbox。记录 `message_id`。
  - `update_message`：校验 ownership → UPDATE `messages.text/components_json/updated_at/edited_at` + emit `message.updated`。
  - `disable_components`：UPDATE `messages.components_json`（标 disabled=true）+ emit `message.updated`（用 `message.updated` 收口，不新增 `message.components_disabled`）。
  - `start_stream`：insert `messages(stream_state=streaming, text="", sender_bot_*, components_json)` + emit `message.created`（stream_state=streaming）。
  - `append_stream`：校验 `stream_state=streaming` + ownership → UPDATE `messages.text = text || delta`（追加）+ emit `message.stream_delta` event `payload={message_id, delta}`（content-bearing，replay 走 `projectMessageForBrowser` 过滤）。
  - `finalize_stream`：UPDATE `messages.stream_state=final` + emit `message.stream_finalized`。
  - 每应用一个 effect → insert `bot_effects_applied(channel_id, bot_id, client_effect_id, effect_type, request_hash, response_json={message_id,...}, outbox_id)`。
- [ ] **Step 2:** 标 `command_invocations.status=completed`（全部 effect 应用完）/ `failed`（任 effect invalid）。emit `command.completed` event（含 bot preview，contract §10.4）—— `command.completed` 是 spec 列出的 content-bearing event，payload 走 `projectMessageForBrowser`。本 plan 交付 `command.completed`。返回 `{ status: applied|failed, error? }` 给 BotConnection。
- [ ] **Step 3:** 测试：send_message 创建 bot 消息 + components + bot summary 投影；重复 delivery_result 同 `client_effect_id` 跳过（含跨不同 outbox_id/delivery_id retry 场景）；同 `client_effect_id` 异 `request_hash` → `BOT_EFFECT_CONFLICT`；append_stream 到非 streaming → failed；bot 改他人消息 → failed；stream 全流程 start→append×N→final 产出正确 text + 事件序列。绿。

---

## Section 7d — Rich UI interaction.submit + component lifecycle

### Task 7d-parser: `parseInteractionSubmitCommand` + WS routing
**Files:** `src/chat/command-invoke.ts`, `src/do/user-connection.ts`, `test/chat/interaction-submit-parser.test.ts`
- [ ] **Step 1:** `parseInteractionSubmitCommand(frame)`：校验 `command==="interaction.submit"` + `command_id` + `channel_id` + payload `{ message_id, component_id, custom_id, value }`（contract §9.6）。
- [ ] **Step 2:** `UserConnection.webSocketMessage` 新增 `interaction.submit` 分支：parse → `channelRouteNameFor` + `ensureSubscribed` → ChatChannel `/internal/interaction-submit` → 透传 committed_ack `{channel_id, interaction_id, event_id}`。错误透传 `command_error`（含 `BOT_OFFLINE`）。
- [ ] **Step 3:** 测试：parser 边界。绿。

### Task 7d-interaction: ChatChannel `/internal/interaction-submit` (校验 + outbox + offline precheck)
**Files:** `src/do/chat-channel.ts`, `test/do/chat-channel-interaction-submit.test.ts`
- [ ] **Step 1:** 校验（contract §9.6）：caller 能看见该消息（成员 + 消息在该 channel）；消息 `sender_kind=bot`；component 未 disabled（读 `messages.components_json` 找 `component_id`，`disabled` 不为 true）；`custom_id` 与持久化 component 一致。失败 → `INVALID_INTERACTION` / `FORBIDDEN` / `COMPONENT_NOT_FOUND`。
- [ ] **Step 2:** **BotConnection offline precheck:** `botConnectionStub(env, bot_id).fetch(/internal/connection-state)` → `disconnected` → `command_error` `BOT_OFFLINE`（不持久化 interaction）。
- [ ] **Step 3:** 事务内 — idempotency（`operation=interaction.submit`）；insert `interactions(status=pending, actor_user_id, command_id[=operation_id], value_json)`（`UNIQUE(message_id, dedupe_principal_key, command_id)` 二级防御）；emit `interaction.created` event `payload={interaction:{interaction_id, status:"pending", created_at}}` + fanout；insert `bot_delivery_outbox(kind=message_interaction, interaction_id, request_json=<§9.7 message_interaction delivery body>)`；写 `idempotency_keys.response_json`；bump alarm。
- [ ] **Step 4:** 返回 `{ channel_id, interaction_id, event_id }`。`UserConnection` 回 committed_ack。alarm flush `kind=message_interaction` → `botConnectionStub.enqueueDelivery`（同 7c-invoke Step 8）。
- [ ] **Step 5:** 测试：submit 创建 interaction + outbox + event；重复同 command_id+body 同响应；disabled component → `COMPONENT_NOT_FOUND`；非 bot 消息 → `INVALID_INTERACTION`；非成员 → `FORBIDDEN`；**bot 离线 → `BOT_OFFLINE` 且不持久化**。绿。

### Task 7d-interaction-delivery: Message interaction delivery + effect apply
**Files:** `src/do/chat-channel.ts` (`/internal/bot-delivery-result` kind=message_interaction 分支), `test/do/chat-channel-interaction-delivery.test.ts`
- [ ] **Step 1:** `/internal/bot-delivery-result` 对 `kind=message_interaction`：bot 返回 effects → 走 Task 7c-effect-apply 同一 effect 应用管线（bot 可发新消息 / 更新原消息 / disable component 表达交互结果）；标 `interactions.status=completed/failed` + emit `interaction.completed` event（content-bearing，含 components，replay 走 `projectMessageForBrowser`）。
- [ ] **Step 2:** 测试：interaction delivery 成功 → bot effect 应用 + interaction completed；bot 失败 → interaction failed + dead_letter；幂等重放跳过已应用 effect（同 `client_effect_id`）。绿。

---

## Section 7e — Passive message_event subscriptions

### Task 7e-subscription-api: `PATCH .../event-subscriptions/message.created` (Browser admin)
**Files:** `src/routes/bot-installations.ts`, `src/do/chat-channel.ts` (`/internal/event-subscription-update`), `test/routes/event-subscriptions.test.ts`
- [ ] **Step 1:** `PATCH /api/chat/channels/:channel_id/bot-installations/:bot_id/event-subscriptions/message.created`（Browser API，owner/admin）：`getIdentity` → 校验 admin → `Idempotency-Key` → body `{ enabled, filters? }` → ChatChannel `/internal/event-subscription-update`。
- [ ] **Step 2:** ChatChannel `/internal/event-subscription-update`：校验 `bot_installations.status=active`（bot 必须已安装）；upsert `channel_bot_event_subscriptions(channel_id, bot_id, event_type=message.created, status=enabled|disabled, filters_json)`。`filters` 默认 `{message_types:["text"], include_bot_messages:false, include_own_messages:false, only_when_mentioned:false}`。emit `system.notice` (notice_kind=`bot.subscription_updated`)。返回 `{ subscription_id, channel_id, bot_id, event_type, status, filters }`。
- [ ] **Step 3:** 测试：enable/disable subscription；非 admin 403；bot 未安装 → 403；幂等重试同响应；`filters` 缺失走默认。绿。
- [ ] **Step 4:** `src/index.ts` 注册 route。`npm run typecheck` 绿。

### Task 7e-message-event-fanout: message send 事务内写 `bot_delivery_outbox(kind=message_event)`
**Files:** `src/do/chat-channel.ts` (message send 事务扩展), `test/do/chat-channel-message-event-fanout.test.ts`
- [ ] **Step 1:** message send 事务（既有 `message.send` + bot direct message + bot effect `send_message`/`start_stream`）：写 message + `message.created` event + fanout outbox 后，**额外**查 `channel_bot_event_subscriptions(channel_id, event_type=message.created, status=enabled)`，对每个匹配 subscription 跑 filters：`message_types` 含当前 `message.type`、`include_bot_messages` 或当前 `sender_kind!=bot`、`include_own_messages` 或当前 `sender_bot_id != subscription.bot_id`、`only_when_mentioned` 或该 bot 在 mentions。命中 → insert `bot_delivery_outbox(kind=message_event, event_id, bot_id, request_json=<§9.7 message_event delivery body with message snapshot via projectMessageForBrowser>)`。bump alarm。
- [ ] **Step 2:** **loop prevention:** 默认 `include_bot_messages=false` + `include_own_messages=false` 排除 bot 自己发的消息与该 bot 自己生成的消息（bot effect `send_message`/`start_stream` 产生的消息 `sender_bot_id=bot_id`，对该 bot 的 subscription 不触发）。`message_event` delivery 离线 drop/expire（BotConnection alarm short TTL），无用户可见错误。
- [ ] **Step 3:** alarm flush `kind=message_event` → `botConnectionStub(env, bot_id).enqueueDelivery`（同 7c/7d）。bot 回 `delivery_result`（通常 `effects:[]`，observer only；若带 effects 走 7c-effect-apply 同管线）。
- [ ] **Step 4:** 测试：启用订阅后发 text 消息 → 该 bot 收 `message_event` delivery；发 bot 自己的消息 → 不触发同 bot subscription（loop prevention）；`message_types` 不含 image → 不触发；`only_when_mentioned=true` 且未 mention → 不触发；bot 离线 → delivery expire drop；disable subscription 后不再产生 outbox 行。绿。

---

## Section 7f — Bot HTTP 发消息（已取消）

> **Contract v2.17：** Bot 消息 mutation 只经 Bot Gateway WS `delivery_result` / `session.effects`。不实现 `POST /api/chat/bot/channels/:channel_id/messages` 或 `/internal/bot-message-send`。

~~### Task 7f-bot-message~~（以下任务作废，保留作历史记录）

### Task 7f-bot-message: ~~Bot 直接发消息 `POST /api/chat/bot/channels/:channel_id/messages`~~
**Files:** `src/routes/bot.ts`, `src/do/chat-channel.ts` (`/internal/bot-message-send`), `test/routes/bot-message-send.test.ts`
- [ ] **Step 1:** `POST /api/chat/bot/channels/:channel_id/messages`：`getBotIdentity`（scope `chat:messages:write`）+ `Idempotency-Key` → body `{ type, text, reply_to_message_id, attachment_ids, components }` → ChatChannel `/internal/bot-message-send`。
- [ ] **Step 2:** ChatChannel `/internal/bot-message-send`：校验 bot installed in channel（`bot_installations` status=active，bot summary 从 `bot_installations` snapshot 取）+ scope；校验 `components`（`validateComponents`）；resolve bot-owned attachments；insert `messages(sender_kind=bot, sender_bot_id, sender_bot_display_name, sender_bot_avatar_url, components_json)` + emit `message.created`（payload.message via `projectMessageForBrowser`，bot summary 来自 snapshot）+ fanout；idempotency via `idempotency_keys(operation=bot.message.send, principal_kind='bot', operation_id=Idempotency-Key)`。返回 contract §9.8 `{ message, event:{event_id, type:"message.created"} }`。
- [ ] **Step 3:** 测试：bot 发消息含 components + bot summary 投影；未安装 bot → 403；非法 components → 422；幂等重试同响应（含完整 `message` 投影）。绿。
- [ ] **Step 4:** `src/index.ts` 注册 `PUT /api/chat/bot/commands` + `POST /api/chat/bot/channels/:channel_id/messages`（bot-token 路由，在 404 兜底前）。`npm run typecheck` 绿。

---

## Section 7g — Future stateful session (NON-GOAL for 7a–7f)

> **明确不在 Phase 7 范围：** 完整旧 external_commands stateful_ws session 语义。basic Bot Gateway WS RPC（§9.7）是 fire-and-forget delivery + `delivery_result` + `delivery_ack`，不含有状态 session。如需完整 stateful session，另起 phase（Phase 7g+）。Future stateful session features（参考旧 external command 架构，但与 basic Bot Gateway WS RPC 分离）：
> - `session.start` / `session.started` / `session.update listen_rules` / `session.input` / `session.timer` / `session.closed`。
> - effect frames with sequence + ack。
> - resume active sessions（reconnect 后恢复进行中的 session）。
> - room mutex / exclusive game session（同频道同 bot 单 active session）。
> - consume / stop-propagation semantics（旧 `listen_rules` 的 consume；Phase 7 passive listener 显式无此语义，见 §9.9）。
>
> 本 plan **不实现**上述任何项；本节仅作为 future note，避免后续误把 stateful session 塞进 7a–7f。

---

## Section 7h — Frontend integration surface (dzmm_archive; NOT implemented in lilium-chat)

> Per contract §12.9 + spec "关于前端阶段"：前端不进 lilium-chat。本节只列前端接入所需契约面 + dzmm_archive 侧 checklist，供前后端对齐，不在本仓库写前端代码。

- [ ] **Step 1:** 文档化前端接入契约面（写入本 plan 末尾附录，不单独建文件）：
  - `GET /api/chat/channels/:id/commands?prefix=` → slash command 补全（含 `matched_name`/`matched_kind`/`aliases` + bot summary）。
  - WS `command.invoke` frame 形状 + committed_ack `{channel_id, invocation_id, event_id}` + `command.invoked` event + `command.completed` event 的 reducer 语义（invocation pending → completed 状态机）。
  - WS `interaction.submit` frame + `interaction.created` / `interaction.completed` events。
  - MessageComponent 渲染（`kind=button|select`，`style`，`disabled`，前端只原样回传 `custom_id`，不解析）。
  - Bot actor 渲染（`sender.kind==="bot"` → 用 `bot.display_name`/`avatar_url`，不得把 bot_id 当 user_id）。
  - stream_state 渲染（`streaming` 态展示 typing/delta 流；`message.stream_delta` event 追加；`message.stream_finalized` 收敛）。
  - `system.notice`（notice_kind=`bot.installed`/`bot.updated`/`command.binding_updated`/`bot.subscription_updated`）渲染 bot 设置变更 toast/通知（**无 bot.*/command.binding_updated/bot.subscription_updated 独立 event type**）。
  - `command_error` `BOT_OFFLINE` 处理（invocation/interaction precheck bot 离线 → 提示重试，`retryable=true`）。
  - Bot admin settings sheet：install/uninstall bot、enable/disable command binding、enable/disable `message.created` event subscription（owner/admin only）。
- [ ] **Step 2:** 列 dzmm_archive 侧任务（不在本仓库执行）：slash input parser + suggest dropdown、command.invoke 发送 + optimistic invocation chip、interaction button/select 渲染 + submit、bot message 渲染、stream 渲染、bot settings sheet（admin install/uninstall bot + enable/disable command + event subscription toggle）、`BOT_OFFLINE` 重试 UI。明确这些依赖本 plan 7a–7f 后端交付完成。

---

## Acceptance (contract §12.8 + §14 v2.10 addendum)

- [ ] `PUT /api/chat/bot/commands`（bot token）注册全局 catalog + 别名 + event capabilities；`COMMAND_NAME_CONFLICT` 仅在 channel binding 层。
- [ ] `GET /api/chat/channels/:id/commands?prefix=` 返回当前用户有效 command 集（含 matched_name/kind/aliases + role 过滤；bot summary 来自 `bot_installations` snapshot，不回源 BotRegistry）。
- [ ] `POST /api/chat/channels/:id/bot-installations` + `PATCH .../bot-installations/:bot_id` + `PATCH .../commands/:bot_command_id` + `PATCH .../bot-installations/:bot_id/event-subscriptions/message.created`（Browser API，admin/owner）；变更全部写 `system.notice`，**不新增** bot.* / command.binding_updated / bot.subscription_updated channel event type。
- [ ] `GET /api/chat/bot/ws`（bot token，outbound WS，subprotocol `lilium.chat.bot.v1`）→ `BotConnection DO(bot_id)`；hello/ready → delivery → delivery_result → delivery_ack 帧协议；bot 不复用 Browser WS。
- [ ] WS `command.invoke` committed_ack `{channel_id, invocation_id, event_id}` + `command.invoked`(pending) → 异步 `bot_delivery_outbox` → `BotConnection` delivery → `delivery_result` → effects 应用 → `command.completed`；`command_id` durable 幂等；correctness source = 当前 BotRegistry catalog（drift 时刷新 binding snapshot）；bot offline precheck → `BOT_OFFLINE`。
- [ ] WS `interaction.submit` committed_ack `{channel_id, interaction_id, event_id}` + `interaction.created` → 异步 delivery → `interaction.completed`；component ownership/disabled/custom_id 校验；bot offline precheck → `BOT_OFFLINE`。
- [ ] Bot effects：send_message / update_message / disable_components / start_stream / append_stream / finalize_stream，按 `(channel_id, bot_id, client_effect_id)` 幂等（跨 delivery retry 去重），bot 只能改自己的消息，stream 不变量；同 `client_effect_id` 异 body → `BOT_EFFECT_CONFLICT`；非法 → `BOT_EFFECT_INVALID`（delivery_ack failed）。**唯一** Bot 消息 mutation 路径（无 HTTP 发消息路由，contract v2.17）。
- [ ] Passive `message_event` 订阅（§9.9）：`PATCH .../event-subscriptions/message.created`；message send 事务内为 enabled 且 filter 匹配的订阅写 `bot_delivery_outbox(kind=message_event)`；loop prevention（排除 bot 自己 / 自己生成的消息）；observer/responder only，无 consume/stop-propagation；bot 离线 drop/expire。
- [ ] `projectMessageForBrowser` 携带 components + bot actor `{kind:"bot", bot:{bot_id, display_name, avatar_url}}`（来源 `messages.sender_bot_*` snapshot 列，全路径同形）；deleted/recalled bot 消息安全投影（content 清空，bot summary 可留）。
- [ ] `bot_delivery_outbox`（原 `bot_callback_outbox` 重命名，`kind ∈ {command_invocation, message_interaction, message_event}`，`event_id` 列）+ `bot_effects_applied`（PK=`channel_id+bot_id+client_effect_id`，`outbox_id` debug 列）+ `channel_bot_event_subscriptions` + BotConnection `bot_connection_state`/`bot_deliveries`。
- [ ] 两套 status 分开：outbox `pending|delivered|failed|dead_letter`；delivery `pending|sent|completed|failed|expired`；invocation/interaction `pending|dispatched|completed|failed|expired`。
- [ ] BotRegistry singleton (`getByName("registry")`)，统一 `botRegistryStub(env)` helper，无散写 name；`idx_bot_tokens_hash UNIQUE`。BotConnection DO by `bot_id`，`botConnectionStub(env, botId)` helper；wrangler `BOT_CONNECTION` binding + `new_sqlite_classes` 同步两 config。
- [ ] **不创建** `src/auth/callback-sign.ts` / `src/chat/bot-callback.ts` / `callback_secret` 列（HTTP callback = future transport，Phase 7 不实现）。
- [ ] 全量 typecheck + vitest 绿（`--no-file-parallelism --test-timeout=60000`）。

---

## Revision notes

本 plan 历经两轮修订，作为执行基线：

### 第一轮 review pass (2026-06-26, commit ae513e7)
- **P0-1 (BotRegistry singleton 收口):** 顶部 Architecture + 全文件统一为 singleton `getByName("registry")`，封装 `botRegistryStub(env)`；删除 "by bot_id" 拓扑残留；加 `idx_bot_tokens_hash UNIQUE` + `idx_bot_commands_bot(bot_id, enabled, name)`。
- **P0-2 (command.invoke correctness = 当前 BotRegistry):** Task 7c-invoke 改为先 idempotency cheap pre-check，再读 binding snapshot，**再 fetch BotRegistry `/internal/command-get`** 校验当前 catalog；disabled/deleted → `BOT_COMMAND_DISABLED`；`definition_hash` drift → 用当前定义校验 + 同事务刷新 binding snapshot；`invoked_name` 重校验当前 aliases。`/commands` 查询允许 stale snapshot，`command.invoke` 不允许。
- **P0-3 (bot actor snapshot 全路径):** `messages` 加 `sender_bot_display_name`/`sender_bot_avatar_url` 列（仅 `sender_kind='bot'` 写），`projectMessageForBrowser` 优先读行 snapshot → history/ack/live event/replay/context 全路径输出 `{kind:"bot", bot:{...}}`，不靠 event payload、不 N 次回源 BotRegistry。
- **P0-4 (event 收口 system.notice):** 移除 `bot.installed`/`bot.updated`/`command.binding_updated` channel event type，统一 `system.notice` + `notice_kind`；保留 `command.invoked`/`interaction.created`/`interaction.completed`/`command.completed`（contract runtime lifecycle）。
- **P1-1 (effect 幂等键):** `bot_effects_applied` PK 改为 `(channel_id, bot_id, client_effect_id)`，`outbox_id` 降为普通 debug 列；加 `request_hash`/`response_json`，同 `client_effect_id` 异内容 → `BOT_EFFECT_CONFLICT`。
- **P1-2 (snapshot 字段补齐):** `channel_command_bindings` 加 `aliases_json`/`default_member_permission`；`bot_installations` 加 `bot_display_name`/`bot_avatar_url`；`/commands` 响应含 bot summary（来自 snapshot）。
- **P1-3 (两套 status 枚举分开):** outbox `pending|delivered|failed|dead_letter`（对齐 `projection_outbox`）；invocation `pending|dispatched|completed|failed|expired`。schema 注释 + 状态机块 + 测试固定。
- **DROP 安全:** Task 7a-migration 加 grep + 测试证明 Phase 7 前无 runtime path 写旧 `commands`/`invocations`，否则改 rename。

### 第二轮 transport 改造 (2026-06-26, contract v2.10 / spec v4.3)
按用户 patch 把 Phase 7 runtime bot transport 从 "Chat → Bot HTTP callback" 改成 "Bot 主动连接 Chat 的 Bot Gateway WebSocket RPC"，HTTP Bot API 保留为低频管理/主动发送接口：
- **P0-1 (Bot Gateway WS 为主 runtime transport):** §9.7 整节重写为 Bot Gateway WS RPC（contract v2.10）。`/api/chat/bot/ws`（bot token，subprotocol `lilium.chat.bot.v1`）→ `BotConnection DO(bot_id)`；delivery/delivery_result/delivery_ack 帧协议；三类 kind = `command_invocation`/`message_interaction`/`message_event`。HTTP callback 降级 future transport。
- **P0-2 (BotConnection DO 新增):** 新 DO 类 `BotConnection`（by `bot_id`），wrangler 加 `BOT_CONNECTION` binding + `new_sqlite_classes`（两 config 同步，加后 `npm run cf-typegen`）。`bot_connection_state` + `bot_deliveries` schema。helper `botConnectionStub(env, botId)`。一个 bot_id 单 active connection，新连接替换旧；delivery at-least-once（持久化再推 socket）；effect 应用仍归 ChatChannel（BotConnection 调 `/internal/bot-delivery-result`）。
- **P0-3 (outbox 重命名 + kind 扩展):** `bot_callback_outbox` → `bot_delivery_outbox`（transport 不再 HTTP callback-specific），加 `event_id` 列，`kind` 加 `message_event`。`src/chat/bot-callback.ts` → `src/chat/bot-delivery.ts`。
- **P0-4 (command.invoke / interaction.submit 改 delivery):** 不再 alarm POST callback_url + HMAC；改为 alarm flush `bot_delivery_outbox` → `BotConnection.enqueueDelivery`。加 **bot offline precheck**（`/internal/connection-state` → `BOT_OFFLINE`，不持久化）。新增 `src/chat/bot-gateway-protocol.ts` 帧协议 helpers。
- **P0-5 (effect 应用入口改名):** `/internal/callback-dispatch` / `/internal/effect-apply` → `/internal/bot-delivery-result`（BotConnection 回写）。effect 校验/应用逻辑不变（7c-effects-validate / 7c-effect-apply），输入源从 HTTP callback response 改为 `delivery_result`。
- **P0-6 (passive message_event 订阅, §9.9):** 新增 7e section。BotRegistry `bot_event_capabilities` + ChatChannel `channel_bot_event_subscriptions`；`PATCH .../event-subscriptions/message.created`（Browser admin）；message send 事务内写 `bot_delivery_outbox(kind=message_event)`；loop prevention；observer/responder only，无 consume/stop-propagation；bot 离线 drop/expire。
- **P0-7 (移除 callback-sign/HMAC 任务):** 不创建 `src/auth/callback-sign.ts`；不写 `callback_secret` 列；Tech Stack 移除 HMAC callback 签名。`BOT_CALLBACK_UNAVAILABLE` 语义收窄为 future transport 预留（不返回）。
- **P1-1 (effect 幂等键不变):** `bot_effects_applied` PK 仍 `(channel_id, bot_id, client_effect_id)`，`outbox_id` debug 列（patch §2.4 确认）。
- **P1-2 (bot offline policy 显式):** command_invocation/message_interaction precheck 离线 → `BOT_OFFLINE`；已 commit 后断连 → 短 TTL failed；message_event 离线 drop/expire，无用户可见错误，不批量重放。
- **P1-3 (loop prevention 规则):** 默认排除 bot 自己消息 + 该 bot 自己生成的消息；message_event best-effort drop。
- **P1-4 (future stateful session note):** 新增 7g section 明确 stateful_ws session 不在 7a–7f 范围。
- **section 重编号:** 7a registry/catalog/install（含 event capabilities + wrangler binding）、7b Bot Gateway WS + delivery、7c command.invoke+effects+stream+bot snapshot、7d interaction、7e passive 订阅、7f bot 直接发消息、7g future stateful（non-goal）、7h 前端接入面。与 spec v4.3 阶段 7 (7a–7g) 对齐（7h 前端面为 plan 内额外细化）。
