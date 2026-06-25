# Lilium Chat 后端设计

状态：设计稿（v4.1，Phase E：personal stickers + owner transfer + invite preview backend；v4.0 channel-scoped message API + WS write path + command_id idempotency + simplified DO topology）
日期：2026-06-22
范围：lilium-chat 仓库（Cloudflare Worker + Durable Object 纯后端）的实现设计
参考：

- `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`（权威 Browser/Bot API contract v2.6，v4.0-aligned）
- `dzmm_archive/docs/plans/2026-06-21-toolbear-chat-api-contract.md`（原始 API contract v1，本设计 v2 有 cursor 形状偏离，见第 0.2 节）
- `dzmm_archive/docs/plans/2026-06-20-lilium-chat-product-requirements.md`（PRD）
- `dzmm_archive/docs/plans/2026-06-20-lilium-chat-technical-architecture.md`（技术架构）
- `dzmm_archive/game-worker/`（既有 Cloudflare Worker 参考实现，DO WebSocket hibernation 模式来源）
- `dzmm_archive/toolbear_ui/auth_utils.py`（ToolBear JWT 验证规则）

## 0. 设计基线

### 0.1 contract 重定向

本设计以 2026-06-21 API contract 为权威 API 形状基础。该 contract 相对 2026-06-20 旧文档是一次技术栈重定向：

- 旧文档：Rust（lilium-ng）、Gateway + Worker via Unix socket、PostgreSQL、SeaweedFS。
- 新 contract：Cloudflare Worker + Durable Object，Worker 直接验证 ToolBear JWT。

本设计遵循新 contract，不复刻旧 Rust/Unix-socket 架构。

### 0.2 v2 修订：平台能力核验与代码评审

v1 草稿假设了若干 Cloudflare 平台不支持的 API，经核验（对照 developers.cloudflare.com 官方文档与 game-worker 既有代码）与代码评审确认后，v2 修订如下。这是一次实质重写，不是表面修补。

**核验结论（v1 错误 → v2 修正）：**

1. **跨 DO 2PC 不存在**。DO 事务只在**单个 DO 自己的 storage** 内（`state.storage.transaction()`），没有跨 DO 两阶段提交 API。v1 的 `env.CHAT_CHANNEL_STUB.transaction(tx => { tx.get(stubA)... tx.get(stubB)... })` 是虚构 API。→ v2 改 saga + projection + repair。
2. **WebSocket 不能放 Worker 内存**。game-worker 已用 `this.ctx.acceptWebSocket(server, [userId])`（`game-room.ts:261`），WS 必须落在 DO 上用 Hibernation API 承接。v1 的"Worker 内存 `channel_id → Set<connection>`"在 Worker isolate 间不持久、跨部署不可靠。→ v2 新增 `UserConnection` DO 接管 WS。
3. **无"列出所有 DO 实例"API**。只有 `idFromName/newUniqueId/idFromString/get`。v1 的"Cron 扫所有 UserDirectory DO"不可落地。→ v2 改 DO alarm（alarm 会唤醒 hibernated DO）做 GC。
4. **per-DO UUIDv7 + 单全局 cursor 不安全**。跨 DO 同毫秒顺序任意，单全局 `last_event_id` 会在 replay 时漏掉较小但未投递的 event。→ v2 改 per-channel cursor（并相应修订 contract API 形状）。
5. **event payload 落库即投影会在 replay 泄露**。`message.created` 全量 payload 落库后，消息被删/撤回就不再是"当前可见投影"，replay 原样返回会泄露原文/附件/components/mentions。→ v2 改 replay 时 join 当前 `messages.status` 过滤。
6. **`/messages/{id}`、`/invites/{code}`、`/channels/directory` 路由无法定位 DO**。这些 URL 不含 `channel_id`，UUIDv7 `message_id` / `invite_code` 无法定位到对应 ChatChannel DO。→ v2 新增 `MessageIndex` / `InviteDirectory` / `ChannelDirectory` 全局索引 DO。（v4.0：message mutation 全部 channel-scoped，`MessageIndex` 已移除；仅 `InviteDirectory` / `ChannelDirectory` 因 URL 天然不含 channel_id 而保留。）
7. **KV 不是 correctness layer**。KV 是 eventually consistent（~60s），不适合做"与业务写必须原子"的幂等去重。→ v2 幂等落目标 DO 的 SQLite，与业务 mutation 同事务；KV 仅作响应缓存优化。
8. **Hyperdrive + pg 的真实调用形状**。是 `new Client({ connectionString: env.LILIUM_DB.connectionString })` → `client.connect()` → `client.query(sql, [params])`，不是 v1 写的 `env.LILIUM_DB.connect().execute({sql, args})`（那是 D1 形状）。
9. **bot 全局身份与 token 不应在 ChatChannel DO**。token 原文只返回一次、只存 hash，bot 是全局实体。→ v2 新增 `BotRegistry` DO。

**本设计在本对话中与产品方确认的偏离 contract 原文的决定（v1 既定，v2 保留）：**

A. **Profile 来源**：Worker 通过 Hyperdrive 直读 ToolBear 生产 Postgres 的 `users` 表（`full_name`/`avatar_url`），只读；不新建 `POST /api/profiles/resolve` Python 端点。
B. **Origin 关系**：ToolBear SPA（`lilium.kuma.homes`）跨域调用 `chat.kuma.homes`，lilium-chat 仓库纯后端。
C. **附件存储**：自建 SeaweedFS（`s3.kuma.homes`，S3 兼容），不用 R2。附件 public read，读请求不签名（产品方显式接受 private 频道附件也公开，见第 5.4 节 risk acceptance）。
D. **默认频道**：所有用户共享一个系统公共频道。
System public channel is a single ChatChannel DO in Phase 1-3 (name `system-general`). All users + messages land there → single-DO write serialization hot spot. Acceptable for small communities; splitting (`system-general-0..N` by user hash, or read-only announce channel model) is explicit later work, not a Phase 1 blocker.
E. **事件 cursor**：per-channel cursor（v2 新增，相应修订 contract API 形状，见第 3.5 节）。

**v2 确认的技术选择：**

F. **event_id**：per-channel 单调 UUIDv7（per-DO 计数器版），保同频道顺序；客户端 per-channel cursor。
G. **跨 DO 一致性**：ChatChannel.members 是 auth source-of-truth，UserDirectory.my_channels 是可修复 projection；saga + repair，不用 2PC。
H. **WS 归属**：`UserConnection` DO（by `user_id`），`ctx.acceptWebSocket` hibernation，`serializeAttachment` 持久化 per-channel cursors。
I. **幂等**：目标 DO 的 SQLite，与业务 mutation 同事务；KV 仅响应缓存。
J. **JWT 库**：`jose`。
K. **邀请码**：明文存储，不 hash。
L. **read-state**：不校验成员关系作为强授权，但要求 `my_channels` 有 active row 作为写入 floor + cursor 单调前进。
M. **CORS origin**：白名单 `lilium.kuma.homes` + localhost 写死。

### 0.3 v3 修订：第二轮代码评审收口

v2 修掉了平台存在性问题，但第二轮评审指出 v2 在"跨 DO 投影可靠性 / WS command 归属 / fanout / alarm 调度 / Hyperdrive binding"上仍有实现前必须收口的 P0。v3 修订如下（已平台复核）：

**v3 核验结论：**

1. **projection 缺 durable outbox**。v2 只说"Worker 同步/异步更新 projection，失败 retry/repair"，存在 crash window：业务已提交、projection 没写 → `message_id` 路由不到 / bootstrap 看不到频道。而 repair 无法发现"UserDirectory 完全没有该 row"（无列举 DO 能力）。→ v3 在 source DO 加 `projection_outbox`，业务写同事务写 outbox 行，DO alarm flush + 目标 DO 幂等写入。
   - 平台核验：CF 无官方"transactional outbox"原语，但其 building blocks 官方文档明确支持——单 DO 私有事务性 storage（业务写与 outbox 行同事务）+ alarm 至少投递一次 + 重试预算耗尽前 re-arm。本设计用的是这些官方推荐的 DIY 组合，非虚拟 API。
2. **WS command 归属文字冲突**。v2 正文说"Worker 只 upgrade 代理到 UserConnection DO"，但 3.1 流程图仍画成 Worker 路由 command、发 ack、调 ChatChannel DO。→ v3 统一：HTTP 由 Worker 路由；**WS command 由 UserConnection DO 路由**（hibernation 模式要求 message handler 在 DO 上）。
3. **fanout 模型未闭合**。v2 给了两个模糊选项。→ v3 明确**方案 A：新增 `ChannelFanout` DO**，保存在线 session，只投递在线 UserConnection，delivery 失败不阻塞 command success。
4. **DO alarm 不能每 presign 一个**。平台核验：每个 DO 同一时间只一个 alarm，`setAlarm` 是 last-write-wins。→ v3 改 store + earliest-wins 循环：pending 列表存 storage，alarm 设最早到期项，handler 处理后重设下一个。
5. **Wrangler Hyperdrive binding 形状错**。平台核验：正确形状是 `[[hyperdrive]] binding="..." id="<config-id>"`（config id 由 `wrangler hyperdrive create` 生成），生产 connection string 不进 wrangler.toml，`localConnectionString` 仅本地 dev；Worker 读 `env.BINDING.connectionString`（property，不是 `.connect()`）。v2 写的 `[[hyperdrive.config]] name=... connection_string=...` 错。→ v3 改。
6. **idempotency 主键不符 contract 语义**。`command_idempotency` 用 `(channel_id, command_id)` 作 PK，同一 `idempotency_key` 换 `command_id` 会重复执行，不符 contract 2.5。→ v3 统一为 `(principal_kind, principal_id, operation, idempotency_key)` 主键，`command_id` 降级为 ack 关联 id。（v4.0 superseded：`command_id` 升为 durable operation id 兼幂等键，见 §0.7 v4.0、§3.6。）
7. **`my_channels` 无 active/left 字段**。v2 说 read-state 要 active row，但 schema 没该字段。→ v3 加软状态 `status`/`left_at`/`removed_at`。
8. **content-bearing event replay 过滤范围**：v2 只修 `message.created`。→ v3 统一规则覆盖 `message.updated`/`stream_*`/`interaction.completed`/`command.completed`。
9. **event payload 不能持久化 UserSummary**。v2 说 DO 不存 profile，但 `payload_json` 若存 sender display_name/avatar 即违反。→ v3 明确 payload 只存 `sender_user_id`/`actor_user_id`/`bot_id`，UserSummary 由 Worker/UserConnection 实时 resolve；bot actor 例外（来自 BotRegistry，是 chat-owned）。
10. **per-channel cursor 同步到 contract 和前端**。v2 只在后端注明偏离。→ v3 在 dzmm_archive 出正式 `2026-06-22-toolbear-chat-api-contract.md` v2 修订（见第 9 节）。
11. **audit_logs actor 应支持 system/bot**。→ v3 改 `actor_kind` + `actor_id`，`actor_user_id` nullable。
12. **rate limit 补 token bucket schema**。→ v3 补。
13. **测试表述矛盾**（"不测平台" vs "阶段 0 跑平台 spike"）。→ v3 改为"不测 CF 内部实现；阶段 0 跑平台集成验证我们依赖的行为"。

**v2 保留的核心设计（不变）：**

- `ChatChannel.members` 作 auth source-of-truth；`UserDirectory.my_channels` 作可修复 projection。
- `UserConnection DO` 接管 WebSocket + hibernation。
- per-channel cursor + per-channel 单调 UUIDv7。
- `MessageIndex` / `InviteDirectory` / `ChannelDirectory` / `BotRegistry`。（v4.0：`MessageIndex` 已移除，保留 `InviteDirectory` / `ChannelDirectory` / `BotRegistry`。）
- in-DO 幂等，KV 非 correctness。
- replay 按当前 message status 重投影。
- SeaweedFS public-read 显式 risk acceptance。
- Hyperdrive 只读 users profile，不持久化 profile 到 DO。

### 0.4 v3.1 修订：第三轮实现前收口

v3 P0 清零后，第三轮评审确认 v3 可作阶段 0/1 基线，剩余为实现细节。v3.1 收口：

- **`command_ack` = committed_ack**：携带 `status=committed` + `channel_id` + `message_id`/`invocation_id`/`interaction_id` + `event_id`。取代 contract 10.2 "ack 只表已接收"语义（记入第 9 节 contract delta）。（v4.0 addendum superseded：`message.*` 扁平 ID ack 改为 payload-bearing `{payload:{channel_id,event_id,message}}`，`message` 为完整 Browser 投影；`channel.mark_read` ack payload 为 read-state。见 §3.1、§9 v4.0 addendum delta。）
- **`message.send` 幂等简化**：只强制 `client_message_id`，`idempotency_key` 缺省映射为 `client_message_id`，`command_id` 仅作 ack 关联。（v4.0 superseded：`client_message_id`/`idempotency_key` 已删除，`command_id` 升级为 durable operation id 兼幂等键，见 §0.5 v4.0、§3.6、§3.7。）
- **outbox dead-letter**：`projection_outbox` / `fanout_queue` 加 `failed`/`dead_letter`/`last_error`/`failed_at`/`max_attempts` + retry 耗尽转 dead_letter + 指标 + admin repair。
- **per-DO 统一 scheduler（2.3a）**：`scheduleNextAlarm`/`runDueJobs`，禁止模块直接 `setAlarm`；各 DO 类 due work 映射清楚。
- **ChannelFanout 二层（fanout_events）**：event payload 本地缓存，投递不回源 ChatChannel。
- **`events.membership_version_at_event`**：正常 fanout 路径零权限回源，仅成员变更后才查 ChatChannel.members。
- **`409 ROUTE_INDEX_PENDING`**：索引 outbox lag 窗口不误报 404。（v4.0：仅保留 invite-code 路由的 `ROUTE_INDEX_PENDING`；message 路由已移除，不再返回此码，见 §0.5 v4.0、§9。）
- **per-IP WS connect 限流落点**：业务语义限流落 DO SQLite；per-IP 用 Cloudflare Rate Limiting/WAF（Worker 无持久内存，不另开 IP 限流 DO）。

### 0.5 v3.2 修订：client_message_id 命名空间化

> （v4.0 superseded：`client_message_id`/`client_invocation_id`/`client_interaction_id` 已从 Browser WS payload 删除，统一改用 `command_id` 作 durable operation id；`dedupe_principal_key` 命名空间化原则保留，UNIQUE 改为基于 `command_id`。见 §0.7 v4.0、§2.1、§3.6。以下为 v3.2 原文，仅作历史追溯。）

`messages` 原用 `UNIQUE(channel_id, client_message_id)`，把 client 提供的 ID 当频道内全局唯一——违反"不信任 client-provided ID"，构成攻击面：恶意用户可构造另一个用户可能用的 `client_message_id` 先占位，致后者撞 `IDEMPOTENCY_CONFLICT` 或错误归因。v3.2 改 `dedupe_principal_key`（`user:<uid>` / `bot:<bot_id>` / `system:<...>`）+ `UNIQUE(channel_id, dedupe_principal_key, client_message_id)`，按 principal 命名空间化。不同用户同 `client_message_id` 各自独立，互不挡。补三条幂等命名空间化测试（同 principal+同 key+同 body→同结果；同 principal+同 key+异 body→CONFLICT；异 principal+同 key→各自成功）。

同一原则套到 command invocation 与 interaction：`invocations` 加 `dedupe_principal_key` + `UNIQUE(command_id, dedupe_principal_key, client_invocation_id)`；`interactions` 加 `dedupe_principal_key` + `UNIQUE(message_id, dedupe_principal_key, client_interaction_id)`。`dedupe_principal_key` 服务端派生，不接受客户端输入。

另两项 v3.2 schema 收口：`commands` 加 `CREATE UNIQUE INDEX uniq_enabled_command_name ON commands(name) WHERE enabled=1`（频道内 enabled command 名唯一，contract `COMMAND_NAME_CONFLICT` 来源，`UNIQUE(bot_id,name)` 只防同 bot 重复注册）；`events.membership_version_at_event` 改 `INTEGER NOT NULL DEFAULT 0`（与 `fanout_events` 一致，保证正常 fanout 零回源门禁语义）。

### 0.6 v3.3 修订：前端 contract 缺口收口

- **解散群聊进入 contract**：新增 `POST /api/chat/channels/{channel_id}/dissolve`。ChatChannel DO owner-only 事务将 `channel_meta.status` 置为 `dissolved`，写 `channel.dissolved` + `system.notice` event、`audit_logs`、`projection_outbox`。解散后写入类操作返回 `CHANNEL_DISSOLVED`。
- **`system.notice` 事件进入 event log**：作为服务端生成的弱提示行事件，和 domain event 同事务追加。覆盖成员加入/离开/角色变更、频道更新/归档/解散、管理员删除他人消息。前端按 `notice_kind` 渲染文案，服务端不下发展示文案。
- **错误码收口**：不定义通用 `NOT_FOUND`。Browser client 使用 `CHANNEL_NOT_FOUND`、`MESSAGE_NOT_FOUND`、`MEMBER_NOT_FOUND`、`INVITE_NOT_FOUND`；已解散频道写入返回 `CHANNEL_DISSOLVED`。
- **非后端状态**：群聊标签是 Browser API v1 disabled 只读占位；免打扰是 browser local-only UI state。Worker、DO schema、outbox、fanout 均不为这两项建模。
- **`message.send` 幂等冲突语义收口（§3.6）**：WS `message.send` 命中 `idempotency_keys` 时，`request_hash` 一致 → 返回缓存 `response_json={message_id,event_id}`（同 commit_ack，不重发 event）；`request_hash` 不一致 → `409 IDEMPOTENCY_CONFLICT`（`command_error`，`retryable=false`）。幂等响应来自 `idempotency_keys.response_json`，**不扫 `events`**；`messages` 的 `UNIQUE` 仅为二级防御。与 contract v2.3 §2.5/§6.2 对齐。
- **Phase 3 范围收口（§8 阶段 3，v3.4）**：阶段 3 改为"Channel CRUD + Member Management + Read State"。新增 `POST /api/chat/channels`（频道创建）：任意已认证 Browser 用户可创建 `kind="channel"` 频道，创建者=owner，可带 `initial_members`，同事务发 `channel.created`+`member.joined`+`system.notice`，DO name=`channel_id`（系统频道例外=`system-general`）。member.left 复用 Phase 2 的 `markMemberLeftAndEnqueueFanoutUnregister`。公开目录/join/invites/DM/bot 留 Phase 6/7。与 contract v2.4 §5.2b/§12.4 对齐。
- **v3.5 (2026-06-24)**：补 create 幂等协调规则。`POST /api/chat/channels` 幂等归 `UserDirectory(creator_user_id)`（新增 `idempotency_keys` 表，状态机 `creating`→`completed`，持久化 `channel_id`），`ChatChannel.createChannel` 单事务原子写入。原因：create 端点无 URL `channel_id`，Worker 现场 mint 会使重试路由到不同 DO，Phase 2 in-DO 幂等模式对 create 结构性失效。

### 0.7 v4.0 修订：channel-scoped message API + WS write path + command_id idempotency

v3/v3.4 有四个结构性问题：

1. Browser API 存在 message-id-only mutation endpoint：
   - `PATCH /api/chat/messages/{message_id}`
   - `POST /api/chat/messages/{message_id}/recall`
   - `DELETE /api/chat/messages/{message_id}`
   这迫使后端引入 `MessageIndex DO` 做 `message_id → channel_id` 路由索引，并额外处理索引 lag、`ROUTE_INDEX_PENDING`、outbox repair 等复杂度。

2. `message.send` 是 WebSocket command，但 `message.edit` / `message.recall` / `message.delete` 是 HTTP mutation。同一种 timeline mutation 被拆成两套入口，前端 pending/ack/error/retry 状态机不统一。

3. read-state 是高频实时 UI 状态，且与 WS cursor/replay 绑定，但 v3 仍通过 HTTP `POST /channels/{channel_id}/read-state` 写入，导致 WS 连接状态和 read-state 状态分裂。

4. 协议同时存在 `command_id` 与 `client_message_id` / `client_mutation_id`。二者都由客户端生成，都可用于 pending 关联与重试幂等，语义重叠。

v4.0 收口如下：

- Browser API 中所有 message locator 必须是 `{channel_id, message_id}`。
- Browser API 不提供 message-id-only message mutation。
- 删除 `MessageIndex DO` 和 `message_index` 表。
- 删除 message mutation 的 `ROUTE_INDEX_PENDING` 语义。
- Browser-facing message mutations 全部改为 WebSocket commands：`message.send` / `message.edit` / `message.recall` / `message.delete`。
- Browser-facing read-state 写入改为 WebSocket command：`channel.mark_read`。
- `command_id` 改为客户端生成的稳定业务操作 ID：必填于所有 mutating WS command；同时用于 ack/error correlation 和 durable idempotency；断线重试同一业务操作必须复用同一个 `command_id`；用户真正发起新的业务操作必须生成新的 `command_id`；复用同一 `command_id` 但请求体不同返回 `IDEMPOTENCY_CONFLICT`。
- 删除 Browser WS payload 中的：`client_message_id` / `client_mutation_id` / `client_invocation_id` / `client_interaction_id`。
- `message_id` 仍由服务端生成。`event_id` 仍由服务端生成。
- `ChatChannel DO` 继续作为频道实时写入 owner / source-of-truth。
- 实时 fanout 不引入 Queue，继续走 DO→DO：ChatChannel 产生 event → ChannelFanout 维护在线 session 并投递 → UserConnection 接收 deliver 并推送 WebSocket。
- `projection_outbox` 保留，但只用于必要的跨 DO projection / fanout 补偿，不作为通用 MQ。

### 0.8 v4.1 修订：Phase E personal stickers（DO ownership 收口）

Phase E 引入 personal sticker library，需在落地前明确 DO ownership。v4.1 收口：

- **Personal sticker library 归 `UserDirectory DO(user_id)` 所有**：sticker library 是 user-local 收藏，非 channel timeline state、非 online fanout state、非全局 bot/profile state。listing / save / delete / save 幂等都在 `UserDirectory DO(user_id)`。
- **`UserDirectory` schema 新增 `personal_stickers` 表**（sticker_id PK + user_id + attachment_id + url/mime/dims + soft delete；`UNIQUE(user_id, attachment_id)`；index on `user_id, created_at DESC WHERE deleted_at IS NULL`）。
- **`ChatChannel` schema 新增 `message_stickers` 表**（message_id PK + sticker_id + attachment_id + url/mime/dims 快照）；`messages.type` 增加 `sticker` 取值（`text | image | sticker | system`）。快照 url/mime/dims 使历史 sticker 消息在 sender 删除库条目后仍稳定。
- **新增 ChatChannel 内部 DO-to-DO 方法 `resolveVisibleAttachment({user_id, attachment_id})`**：供 sticker save 流程校验附件可见性 + 返回 canonical projection；拒绝 deleted/recalled 消息附件；不返回 `storage_key`。
- **新增 UserDirectory 内部 DO-to-DO 方法 `resolveSticker(sticker_id)`**：供 sticker send 流程解析 sender sticker_id → canonical projection；要求属当前用户且未软删；不 mutate state。
- **`projectMessageForBrowser` 支持 `type="sticker"`**：`sticker={sticker_id, attachment_id, url, mime_type, width, height, size_bytes}`、`text=null`、`attachments=[]`、`format="plain"`；deleted/recalled → `sticker=null`。同一 builder 用于 history / replay / live event / ack。
- **不引入 `AttachmentDirectory DO`**（Phase E explicit non-goal）：save-sticker 用 `{channel_id, attachment_id}`，UserDirectory 路由可见性校验到源 `ChatChannel DO(channel_id)`。
- **幂等沿用 v4.0 `operation_id` 语义**：sticker save 幂等 operation = `sticker.save`，归 `UserDirectory(user_id)`；sticker send 幂等 = 现有 `message.send`，归 `ChatChannel(channel_id)`。
- **owner-transfer 后端实现不在本节范围**：API wire shape 见 contract issue #1028；若后续需后端 DO 实现，另行补丁。

## 1. 架构总览

Durable Objects:
- `ChatChannel` by `channel_id` — realtime write owner; channel metadata, members, messages, events, idempotency; source-of-truth for channel permissions and timeline
- `UserDirectory` by `user_id` — `my_channels` projection; read-state; pending attachment projection
- `UserConnection` by `user_id` — WebSocket hibernation; Browser command routing; per-channel cursors; read-state command handling; event delivery to browser socket
- `ChannelFanout` by `channel_id` — online session registry; short-lived fanout event cache; per-session delivery queue
- `InviteDirectory` by `invite_code` — invite_code → channel_id/status index; retained because invite URLs naturally do not contain channel_id
- `ChannelDirectory` — public channel directory read model
- `BotRegistry` by `bot_id` — bot identity; token hash; callback config

Removed: `MessageIndex DO`; `message_index` table; `message_id → channel_id` Browser route index; message `ROUTE_INDEX_PENDING`.

Architecture diagram:

```text
Browser
  │
  ├─ HTTP reads / auxiliary APIs
  │    └─ Worker → target DO
  │
  └─ WebSocket write path
       └─ Worker upgrade proxy
             └─ UserConnection DO
                   ├─ message.* commands → ChatChannel DO
                   ├─ channel.mark_read → UserDirectory DO
                   └─ deliver(event) → browser socket

Durable Objects
  ├─ ChatChannel      by channel_id  —— realtime write owner
  ├─ UserDirectory    by user_id     —— my_channels/read-state projection
  ├─ UserConnection   by user_id     —— WS hibernation + command routing
  ├─ ChannelFanout    by channel_id  —— online sessions + delivery queue
  ├─ InviteDirectory  by invite_code —— invite routing index
  ├─ ChannelDirectory global         —— public channel directory
  └─ BotRegistry      by bot_id      —— bot identity/token hash

External:
  ├─ Hyperdrive → ToolBear Postgres users table, read-only profile resolve
  └─ SeaweedFS/S3-compatible storage for attachment binaries
```

### 1.1 核心边界

1. **lilium-chat 仓库纯后端**：Worker + DO + wrangler 配置。前端留在 `dzmm_archive/toolbear_ui/frontend`。
2. **Worker 保持薄**：只做 JWT 自验、-Origin 校验、路由、ws upgrade 代理到 UserConnection DO。不存长期连接、不做业务规则、不做权限最终判断。
3. **Profile**：Hyperdrive 直读 `users` 表，只读，隔离在 `resolveUserSummaries()`。DO 不持久化 display_name/avatar。
4. **附件**：SeaweedFS presign PUT，浏览器直传，public read 不签。
5. **实时**：WS subprotocol `lilium.chat.v1` + `bearer.<jwt>`。command/event 同一条 WS。event_id = per-channel 单调 UUIDv7，**客户端 per-channel cursor**。
6. **ID**：实体 ID 用 UUIDv7；event_id 用 per-channel 单调 UUIDv7。
7. **"Worker 更新不掉 WS"语义修正**：旧 PRD 该目标来自 Gateway/Worker 分进程架构。CF Worker/DO 方案不承诺同等级不掉线；验收改为"连接可能重连，但已提交 event 不丢，客户端用 per-channel replay 恢复"。

### 1.2 请求路由分流

| 路径 / 协议 | 落到哪 |
|---|---|
| `GET /api/chat/bootstrap` | UserDirectory DO + ChatChannel DO |
| `GET /api/chat/channels/{channel_id}/messages` | ChatChannel DO |
| `GET /api/chat/channels/{channel_id}/messages/{message_id}/context` | ChatChannel DO |
| `GET /api/chat/channels/{channel_id}/members` | ChatChannel DO |
| `GET /api/chat/channels/{channel_id}/members/{user_id}` | ChatChannel DO + profile resolve |
| `POST /api/chat/channels/{channel_id}/invites` | ChatChannel DO |
| `POST /api/chat/invites/{invite_code}/accept` | InviteDirectory DO → ChatChannel DO |
| `GET /api/chat/channels/directory` | ChannelDirectory DO |
| `POST /api/chat/stickers` | UserDirectory DO(user_id) → ChatChannel DO(channel_id).resolveVisibleAttachment（Phase E） |
| `WS /api/chat/ws` | upgrade 代理到 UserConnection DO |
| WS command `message.send` | UserConnection DO → ChatChannel DO |
| WS command `message.edit` | UserConnection DO → ChatChannel DO |
| WS command `message.recall` | UserConnection DO → ChatChannel DO |
| WS command `message.delete` | UserConnection DO → ChatChannel DO |
| WS command `channel.mark_read` | UserConnection DO → UserDirectory DO，必要时查询 ChatChannel 计算 unread |
| WS command `command.invoke` | UserConnection DO → ChatChannel DO / Bot flow |
| WS command `interaction.submit` | UserConnection DO → ChatChannel DO / Bot flow |

Browser-facing message writes and read-state writes are WebSocket commands. Public HTTP endpoints must not mutate message timeline state or read-state. Internal DO-to-DO `fetch()` endpoints may still exist for implementation, but they are not Browser API.

## 2. Durable Object 内部表结构

贯穿全局约定：

- **存储后端**：DO SQLite，单 DO 内 `state.storage.transaction()` 是 ACID。
- **ID**：实体 ID 用 UUIDv7 字符串。event_id 用 per-channel 单调 UUIDv7。
- **时间**：ISO 8601 UTC 字符串（`TEXT`）。
- **软删除/审计**：deleted/recalled 只改 `status` + 时间戳，不清空原文。普通查询按 `status` 过滤投影。
- **跨 DO**：无跨 DO 事务；source-of-truth + projection + repair（见第 2.3 节）。

### Phase E: Personal sticker ownership

Personal sticker library is owned by `UserDirectory DO` keyed by `user_id`.

Rationale:

- Sticker library is user-local state.
- Listing, saving, deleting, and deduping stickers are scoped to the current user.
- Sticker library is not channel timeline state.
- Sticker library is not online fanout state.
- Sticker library is not global bot/profile state.

No standalone `StickerRegistry DO` is introduced in Phase E.

Ownership split:

| State / operation | Owner DO |
|---|---|
| Personal sticker library rows | `UserDirectory DO(user_id)` |
| Sticker list / delete / save idempotency | `UserDirectory DO(user_id)` |
| Attachment visibility validation for save-from-message | `ChatChannel DO(channel_id)` |
| Message creation for `type=sticker` | `ChatChannel DO(channel_id)` |
| Live event fanout for sticker messages | existing `ChannelFanout DO(channel_id)` |
| WebSocket command routing | existing `UserConnection DO(user_id)` |

### 2.1 ChatChannel DO（by channel_id）

一个 DO 实例 = 一个频道的全部状态 + 该频道的事件日志 + 频道内幂等。

```sql
-- 频道元信息（单行）
CREATE TABLE channel_meta (
  channel_id      TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,          -- channel | dm
  visibility      TEXT NOT NULL,          -- private | public_unlisted | public_listed
  title           TEXT NOT NULL,
  topic           TEXT,
  avatar_url      TEXT,
  status          TEXT NOT NULL,          -- active | archived | dissolved
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  member_count    INTEGER NOT NULL DEFAULT 0,
  membership_version INTEGER NOT NULL DEFAULT 0   -- 成员变更单调版本,订阅门禁用
);

-- 成员关系(权限 source of truth)
CREATE TABLE members (
  channel_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL,              -- owner | admin | member
  joined_at   TEXT NOT NULL,
  left_at     TEXT,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_members_active ON members(user_id) WHERE left_at IS NULL;

-- 消息(原文 + 生命周期 + 回复快照)
CREATE TABLE messages (
  message_id        TEXT PRIMARY KEY,        -- UUIDv7
  command_id        TEXT NOT NULL,           -- client-generated durable operation id for message.send
  dedupe_principal_key TEXT NOT NULL,        -- v3.2: user:<uid> | bot:<bot_id> | system:<...>,幂等命名空间化
  channel_id        TEXT NOT NULL,
  sender_kind       TEXT NOT NULL,           -- user | bot | system
  sender_user_id    TEXT,
  sender_bot_id     TEXT,
  type              TEXT NOT NULL,           -- text | image | sticker | system
  format            TEXT NOT NULL DEFAULT 'plain',
  status            TEXT NOT NULL DEFAULT 'normal',
  text              TEXT,                    -- 原文,deleted/recalled 不清空
  reply_to          TEXT,                    -- message_id
  reply_snapshot_json TEXT,                  -- 回复快照(发送时同事务生成)
  stream_state      TEXT NOT NULL DEFAULT 'none',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  edited_at         TEXT,
  deleted_at        TEXT,
  deleted_by        TEXT,
  recalled_at       TEXT,
  UNIQUE (channel_id, dedupe_principal_key, command_id)   -- v3.2: 命名空间化,防 client ID 互挡/劫持
);
CREATE INDEX idx_messages_history ON messages(channel_id, message_id DESC);

-- 编辑历史(审计,不对普通 API 暴露)
CREATE TABLE message_edits (
  edit_id         TEXT PRIMARY KEY,          -- UUIDv7
  message_id      TEXT NOT NULL,
  old_text        TEXT NOT NULL,
  new_text        TEXT NOT NULL,
  editor_user_id  TEXT NOT NULL,
  request_id      TEXT,
  edited_at       TEXT NOT NULL
);
CREATE INDEX idx_edits_message ON message_edits(message_id, edited_at);

-- 通用审计日志(管理动作、删除/撤回、权限变更、合规)
CREATE TABLE audit_logs (
  audit_id        TEXT PRIMARY KEY,          -- UUIDv7
  actor_kind      TEXT NOT NULL,             -- v3: user | bot | system
  actor_id        TEXT NOT NULL,             -- v3: user_id / bot_id / system actor id
  action          TEXT NOT NULL,             -- message.delete | message.recall | member.role_update | channel.archive | channel.dissolve | ...
  target_type     TEXT NOT NULL,             -- message | member | channel | invite | bot
  target_id       TEXT NOT NULL,
  before_json     TEXT,
  after_json      TEXT,
  reason          TEXT,
  request_id      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, created_at);
CREATE INDEX idx_audit_actor ON audit_logs(actor_kind, actor_id, created_at);

-- 附件元数据(二进制在 SeaweedFS,这里存归属 + 尺寸 + url + 生命周期)
CREATE TABLE attachments (
  attachment_id   TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL,
  kind            TEXT NOT NULL,           -- image
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  storage_key     TEXT NOT NULL,           -- chat/{attachment_id},不暴露给前端
  url             TEXT NOT NULL,           -- public read URL,存 DO
  status          TEXT NOT NULL,           -- pending | finalized | transferred | hidden
  created_at      TEXT NOT NULL
);

CREATE TABLE message_attachments (
  message_id    TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  PRIMARY KEY (message_id, attachment_id)
);

-- Phase E: sticker 消息快照(sender 个人库条目发送时的 url/mime/dims 快照)
CREATE TABLE message_stickers (
  message_id    TEXT PRIMARY KEY,
  sticker_id    TEXT NOT NULL,  -- sender's personal sticker id at send time
  attachment_id TEXT NOT NULL,
  url           TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  size_bytes    INTEGER
);
-- 备选方案: 用 message_attachments + messages.type='sticker',但 v1 首选 message_stickers。
-- 理由: sticker 消息应投影为 sticker 而非普通 image 附件; attachments=[] 避免重复渲染;
-- 快照 url/mime/width/height/size 使历史 sticker 消息在 sender 删除库条目后仍稳定。

-- mentions(主键改为 range,允许同一用户多次 mention)
CREATE TABLE mentions (
  message_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  start       INTEGER NOT NULL,            -- JS string index
  end_        INTEGER NOT NULL,            -- end 是 SQL 保留字
  PRIMARY KEY (message_id, start, end_)
);
CREATE INDEX idx_mentions_user ON mentions(user_id);

-- bot 安装与命令(snapshot;全局身份在 BotRegistry DO)
CREATE TABLE bot_installations (
  bot_id         TEXT PRIMARY KEY,
  installed_by   TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  installed_at   TEXT NOT NULL
);

CREATE TABLE commands (
  bot_command_id TEXT PRIMARY KEY,
  bot_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  options_json  TEXT NOT NULL,
  default_perm  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL,
  UNIQUE (bot_id, name)
);
-- v3.2: 频道内 enabled command 名称唯一,contract 的 COMMAND_NAME_CONFLICT 来源
CREATE UNIQUE INDEX uniq_enabled_command_name ON commands(name) WHERE enabled = 1;

CREATE TABLE invocations (
  invocation_id         TEXT PRIMARY KEY,
  bot_command_id        TEXT NOT NULL,
  bot_id                TEXT NOT NULL,
  invoker_user_id       TEXT NOT NULL,
  dedupe_principal_key  TEXT NOT NULL,        -- v3.2: user:<uid> | bot:<bot_id>,命名空间化
  command_id            TEXT NOT NULL, -- Browser WS command_id
  options_json          TEXT NOT NULL,
  status                TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  completed_at          TEXT,
  error_code            TEXT,
  UNIQUE (bot_command_id, dedupe_principal_key, command_id)
);

CREATE TABLE interactions (
  interaction_id        TEXT PRIMARY KEY,
  message_id            TEXT NOT NULL,
  component_id          TEXT NOT NULL,
  custom_id             TEXT NOT NULL,
  actor_user_id         TEXT NOT NULL,
  dedupe_principal_key  TEXT NOT NULL,        -- v3.2: 命名空间化
  command_id            TEXT NOT NULL, -- Browser WS command_id
  value_json            TEXT NOT NULL,
  status                TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE (message_id, dedupe_principal_key, command_id)
);

-- 邀请码(明文)
CREATE TABLE invites (
  invite_code  TEXT PRIMARY KEY,
  created_by   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  max_uses     INTEGER,
  used_count   INTEGER NOT NULL DEFAULT 0,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);

-- 该频道的事件日志(per-channel 单调 UUIDv7)
CREATE TABLE events (
  event_id     TEXT PRIMARY KEY,           -- per-channel 单调 UUIDv7
  event_type   TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  actor_kind   TEXT,                        -- v3: user | bot | system (引用,不存 UserSummary)
  actor_id     TEXT,                         -- v3: user_id / bot_id / system actor id
  actor_session_id TEXT,                    -- v3: 可选,操作者 session,审计用
  payload_json TEXT NOT NULL,                -- v3: 只存 id 引用(sender_user_id/actor_user_id/bot_id);不持久化 display_name/avatar。replay 时 join messages.status 重投影
  membership_version_at_event INTEGER NOT NULL DEFAULT 0,      -- v3.2: NOT NULL; 生成时从 channel_meta.membership_version 带出,fanout 便宜权限门禁
  occurred_at  TEXT NOT NULL
);
CREATE INDEX idx_events_after ON events(event_id);

-- per-channel 单调 UUIDv7 生成器状态
CREATE TABLE event_seq (
  last_ms   INTEGER NOT NULL,
  counter   INTEGER NOT NULL
);

-- v3: 统一幂等表(符合 contract 2.5: 同 principal + 同 operation + 同 key + 同 body → 同结果)
-- v4.0: transport-neutral operation_id. HTTP Idempotency-Key 和 WS command_id 是同一语义层，
-- 内部统一归一为 operation_id。WS command_id 是 durable operation id，同时用于 ack/error
-- correlation 和幂等键（不是仅作 ack 关联）。
CREATE TABLE idempotency_keys (
  principal_kind   TEXT NOT NULL,           -- user | bot
  principal_id     TEXT NOT NULL,
  operation        TEXT NOT NULL,           -- channel.create | message.send | message.edit | ...
  operation_id     TEXT NOT NULL,           -- HTTP Idempotency-Key or WS command_id
  request_hash     TEXT NOT NULL,
  response_json    TEXT,
  status           TEXT NOT NULL,           -- processing | completed | failed
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  PRIMARY KEY (principal_kind, principal_id, operation, operation_id)
);
CREATE INDEX idx_idem_expires ON idempotency_keys(expires_at);

-- 消息发送幂等由 messages UNIQUE(channel_id, dedupe_principal_key, command_id) 兜底
-- v3.2: principal 命名空间化,防 client-provided ID 被用于互挡/错误归因

-- v3: durable projection outbox(跨 DO 投影/索引/取消订阅的可靠性,见 2.3)
CREATE TABLE projection_outbox (
  outbox_id       TEXT PRIMARY KEY,
  target_kind     TEXT NOT NULL,  -- user_directory | invite_directory | channel_directory | channel_fanout
  target_key      TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | failed | dead_letter
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  last_error      TEXT,
  failed_at       TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_projection_outbox_due ON projection_outbox(status, next_attempt_at);
```

### 2.2 UserDirectory DO（by user_id）

my_channels projection（可修复，非 auth SoT）+ read-state + pending upload projection。

```sql
CREATE TABLE my_channels (
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  joined_at  TEXT NOT NULL,
  left_at    TEXT,                          -- v3 软状态:非空=已离开
  removed_at TEXT,                          -- v3:被移除
  status     TEXT NOT NULL DEFAULT 'active', -- v3:active | left | removed
  membership_version INTEGER NOT NULL,      -- 对应 ChatChannel.membership_version 快照
  last_read_event_id TEXT,                  -- per-channel cursor,唯一存 last_read 处
  PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX idx_my_channels ON my_channels(user_id, status);
CREATE INDEX idx_my_channels_active ON my_channels(user_id) WHERE status='active';

CREATE TABLE pending_attachments (
  attachment_id   TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL,
  kind            TEXT NOT NULL,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  storage_key     TEXT NOT NULL,
  url             TEXT NOT NULL,
  status          TEXT NOT NULL,           -- pending | finalized | transferred
  expires_at      TEXT NOT NULL,           -- v3:GC 用,单 alarm earliest-wins 循环
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_pending_expires ON pending_attachments(status, expires_at);

-- Phase E: personal sticker library
CREATE TABLE personal_stickers (
  sticker_id    TEXT PRIMARY KEY,        -- UUIDv7, user-local library item id
  user_id       TEXT NOT NULL,
  attachment_id TEXT NOT NULL,           -- canonical image attachment id
  url           TEXT NOT NULL,           -- Browser-visible stable image URL snapshot
  mime_type     TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  size_bytes    INTEGER,
  created_at    TEXT NOT NULL,
  deleted_at    TEXT,
  UNIQUE (user_id, attachment_id)
);

CREATE INDEX idx_personal_stickers_user_created
  ON personal_stickers(user_id, created_at DESC)
  WHERE deleted_at IS NULL;
```

Phase E adds the personal sticker library table `personal_stickers` to `UserDirectory DO`. `sticker_id` is user-local: receivers must not assume another user's `sticker_id` is usable by them. `attachment_id` is the reusable image identity; multiple users may have different `sticker_id` rows pointing to the same `attachment_id`. Deleting a personal sticker only sets `deleted_at`; it does not delete the underlying attachment object and does not affect historical messages.

`last_read_event_id` 唯一存于 `my_channels`，mark-read 单写 UserDirectory，不碰 channel DO。write floor（v3 明确）：要求该 `(user_id, channel_id)` 行存在且 `status='active'`（软状态，不硬删除）；cursor 单调前进（新值 > 旧值才接受）。unread 实时算（去 ChatChannel DO 查 `event_id > last_read_event_id` 且非自己发的条数）。`status='left'/'removed'` 的行保留供 audit/repair/客户端"刚被移除"处理，不参与 unread/read-state。**v4.0 收口：** read-state 写入走 WS command `channel.mark_read`（UserConnection DO → UserDirectory DO），**不写 channel timeline event、不写 `projection_outbox`**；多 session 同步用 user-local `read_state_updated` WS frame（非 channel event）。read-state 是 user-local state，不是 channel timeline state。

### 2.3 跨 DO 一致性：source-of-truth + narrow projection_outbox + repair

There is no cross-DO transaction. v4.0 keeps a narrow `projection_outbox` for cross-DO state required by the realtime architecture:
- `ChatChannel.members` → `UserDirectory.my_channels`
- `ChatChannel.channel_meta` public-listed summary → `ChannelDirectory.public_channels`
- `ChatChannel.invites` → `InviteDirectory.invite_index`
- `ChatChannel.events` → `ChannelFanout` online delivery

`projection_outbox` is not a general event bus and not a replacement for archive/search/analytics pipelines. Every outbox target must be justified by one of: (1) required for Browser routing where the URL naturally lacks channel_id, such as invite code; (2) required for realtime bootstrap/read-state projection, such as UserDirectory; (3) required for online delivery, such as ChannelFanout; (4) required for public directory read model, such as ChannelDirectory.

Message routing is explicitly excluded because Browser message APIs are channel-scoped. Read-state is explicitly excluded because it is owned by `UserDirectory DO` and written directly by `channel.mark_read`.

**`projection_outbox` 表（在 ChatChannel DO；其他 source DO 同形）：**

```sql
CREATE TABLE projection_outbox (
  outbox_id       TEXT PRIMARY KEY,
  target_kind     TEXT NOT NULL,  -- user_directory | invite_directory | channel_directory | channel_fanout
  target_key      TEXT NOT NULL,  -- user_id / invite_code / channel_id
  event_id        TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | failed | dead_letter (v3.1)
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,       -- v3.1: 预算上限
  last_error      TEXT,                            -- v3.1
  failed_at       TEXT,                            -- v3.1
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_projection_outbox_due ON projection_outbox(status, next_attempt_at);
```

**机制（平台核验合规）：** outbox 行在 source DO 业务写事务内同事务写入（单 DO 私有事务性 storage，业务写与 outbox 行原子）。由 per-DO 统一 scheduler 的 alarm flush pending 行（平台只有单 alarm，用 earliest `next_attempt_at` + 循环 re-arm；alarm at-least-once + 自动退避重试，目标 DO 写入幂等）。成功后置 `status='delivered'`。

**dead-letter（v3.1）：** `attempts < max_attempts` 用指数退避重试 + re-arm；`attempts >= max_attempts` 置 `status='dead_letter'` + `failed_at` + `last_error`，emit `projection_outbox_dead_letter` 指标 + Sentry alert，admin repair endpoint 可重置为 `pending`。防止"预算耗尽无处落态、静默丢弃"。

ChatChannel.members 是权限 source-of-truth；UserDirectory.my_channels 是可修复 projection。join/leave：

1. ChatChannel DO 内单事务写 `members` + `member.joined/left` event + `audit_logs` + 递增 `channel_meta.membership_version` **+ 写 `projection_outbox` 行（target_kind=user_directory，目标 user 的 my_channels 更新）**。
2. DO alarm flush：调用 UserDirectory DO 幂等更新 my_channels（写/软删 projection 行 + membership_version 快照）。失败重试。
3. 业务成功不依赖 projection 写成功（ack 在 source DO 事务后即可返回）；projection 最终一致。
4. bootstrap 和 WS 建连若发现 UserDirectory.membership_version 落后于 ChatChannel，按 ChatChannel SoT repair（这一步只修"有 row 但版本落后"；"完全没有 row"靠 outbox 保证不发生）。

同理：invite create/revoke → outbox 写 InviteDirectory；channel 事件 → outbox 写 ChannelDirectory；`member.left` → outbox 通知 ChannelFanout DO（取消该用户在线订阅）。v4.0 已移除 MessageIndex，消息路由不走 outbox（Browser message API 全部 channel-scoped，直接落 ChatChannel DO）。

解散群聊：`POST /channels/{channel_id}/dissolve` 路由到 ChatChannel DO。事务内校验 `kind='channel'`、actor 是 active owner、`channel_meta.status='active'`；写 `channel_meta.status='dissolved'`、`updated_at`、`channel.dissolved` event、`system.notice` event、`audit_logs(action='channel.dissolve')`、`projection_outbox(target_kind=channel_directory)`、`projection_outbox(target_kind=channel_fanout)`。成员行保留，UserDirectory.my_channels 行保留，bootstrap/list/detail 继续返回 `status='dissolved'` tombstone。解散后写入类 HTTP mutation 和 WS command 在 ChatChannel 权限入口统一拒绝为 `409 CHANNEL_DISSOLVED`；同一 Idempotency-Key 的重复 dissolve 返回缓存结果。

附件发送的跨 DO 读（Worker 先从 UserDirectory 取 pending metadata 再进 channel DO 事务）不是跨 DO 写：Worker 作协调者串行调用，channel DO 事务内校验 `attachment.owner == sender && status == finalized`，写 message_attachments + attachment 业务副本（含 url）落 channel DO。pending 行标记 transferred。

### 2.3a per-DO 统一 scheduler（v3.1 实现纪律）

每个 DO 同一时间只能有一个 alarm（平台核验，`setAlarm` last-write-wins）。因此每个 DO 类内必须有一个统一定时器，管理该 DO 内所有 due work，**不允许各模块直接调 `setAlarm()`**：

```ts
// 每个 DO 类共享
scheduleNextAlarm(reason?: string):  // 查该 DO 内所有 due tables 的最早 next_attempt_at/expires_at, setAlarm 到最早
runDueJobs(now):  // alarm handler 入口: flush 所有 due 表(outbox、fanout_queue、pending_attachments、idempotency 过期清理、rate_buckets 过期、stale online_sessions 等)
```

各 DO 类的 due work 映射：

- **ChatChannel DO**：`projection_outbox` flush、`idempotency_keys` 过期清理、`rate_buckets` 清理（若有）、`fanout_events` TTL 清理。
- **UserDirectory DO**：`pending_attachments` GC（earliest-wins，见 5.5）、`projection_outbox`（如该 DO 也发 outbox）。
- **ChannelFanout DO**：`fanout_queue` flush（带 dead-letter）、stale `online_sessions` 清理（断线未反注册的）、`fanout_events` TTL 清理。
- **InviteDirectory/ChannelDirectory/BotRegistry DO**：自身 outbox/过期清理（如有）。

`runDueJobs` 处理完后调 `scheduleNextAlarm()` 重设下一个最早 due。alarm at-least-once + 自动退避重试担保可靠性。

### 2.4 全局索引 DO + ChannelFanout DO

无跨 DO 事务；源 DO 业务写同事务写 `projection_outbox` 行，DO alarm flush 到目标 DO，目标 DO 写入幂等：

- **InviteDirectory DO（by invite_code）**：`invite_code → {channel_id, status, expires_at, revoked_at}`。invite 创建/撤销时写 outbox flush。`/invites/{code}/accept` 先查此 DO。
- **ChannelDirectory DO**：`public_listed` 且 `status=active` 的 channel summaries（title, member_count, last_message_at）。channel 事件写 outbox flush。
- **BotRegistry DO（by bot_id）**：bot profile(`display_name`/`avatar_url`/`callback_url`)、`token_hash`、scopes、status。token 原文只返回一次，只存 hash。callback HMAC secret 与 token 分开管理。
- **ChannelFanout DO（by channel_id，v3 新增）**：接管该频道在线成员 fanout，降低 ChatChannel 热点。

**ChannelFanout DO schema：**

```sql
-- 在线 session/user 注册表(status='active' 的是当前在线)
CREATE TABLE online_sessions (
  channel_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  membership_version INTEGER NOT NULL,   -- 订阅时的 ChatChannel.membership_version 快照
  registered_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, session_id)
);
CREATE INDEX idx_online_user ON online_sessions(channel_id, user_id);

-- v3.1: event payload 本地缓存,投递时按 event_id 读此表,不回源 ChatChannel
CREATE TABLE fanout_events (
  channel_id TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  event_json TEXT NOT NULL,             -- 完整 event frame(payload 只含 actor 引用,不含 UserSummary)
  membership_version_at_event INTEGER NOT NULL,  -- 来自 events.membership_version_at_event,便宜门禁
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, event_id)
);
CREATE INDEX idx_fanout_events_cleanup ON fanout_events(created_at);

-- 待投递 event 队列(ChatChannel event → outbox flush 进此;DO alarm 批量 flush 给 UserConnection)
CREATE TABLE fanout_queue (
  queue_id     TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | failed | dead_letter
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error   TEXT,
  failed_at    TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_fanout_due ON fanout_queue(status, next_attempt_at);
CREATE INDEX idx_fanout_event ON fanout_queue(channel_id, event_id);
```

**职责：**

- `registerOnline(channel_id, user_id, session_id, membership_version)`：UserConnection DO 建连/隐式订阅时，向对应 ChannelFanout DO 注册。
- `unregisterOnline(channel_id, session_id)`：WS 断开、hibernation 失活、member.left 时反注册。
- ChatChannel 产生 event 后写 outbox（target_kind=channel_fanout）→ ChannelFanout DO 取 event 时先写一行 `fanout_events`（event payload + `membership_version_at_event`）→ 展开成对每个在线 session 的 `fanout_queue` 行 → DO alarm 批量 `fetch` 各 UserConnection DO 的 `deliver(event_json)`（投递时按 `event_id` 读本地 `fanout_events`，**不回源 ChatChannel**）。
- `fanout_events`Clean up：投递完所有 target 后（或 TTL 到期）删除该 event 行。
- **fanout 只投递在线用户**，不扫全体 members。
- **fanout 不在业务写事务里**：ack 在 ChatChannel 事务后即返回，fanout 异步。
- **delivery 失败不阻塞 command success**：失败重试至 `max_attempts` → `dead_letter` + 指标，最终 replay 是补偿路径。
- **member.left 撤销**：ChatChannel leave 事务写 outbox（target_kind=channel_fanout, target_key=channel_id + 该 user）→ ChannelFanout 删除该 user 的 online_sessions 行 + 丢弃/标 failed 其 pending fanout_queue 行。
- **权限版本门禁（v3.1 便宜化）**：deliver 时用 `event.fanout_events.membership_version_at_event` 与 session 的订阅 `membership_version` 比较：
  - `event.membership_version_at_event <= subscription.membership_version` → 直接投递，不查 ChatChannel（正常路径零回源）。
  - `event.membership_version_at_event > subscription.membership_version` → 成员变更后才触发，回查 ChatChannel.members 当前状态确认仍在 → 否则拒投递 + repair。

**ChannelFanout 职责边界（v4.0 收口）：** `ChannelFanout DO` is not a membership registry and not a general projection target. It owns only channel-scoped online delivery state:
- `online_sessions`: current WebSocket sessions subscribed to the channel;
- `fanout_events`: short TTL cache of event frames received from ChatChannel projection_outbox;
- `fanout_queue`: per-session delivery attempts.

Membership source-of-truth remains `ChatChannel.members`. `ChannelFanout` must not be used to answer "who are the members of this channel". It can only answer "which sessions are currently online and subscribed to this channel".

Fanout path remains: ChatChannel txn writes messages/members/events + `projection_outbox(target_kind=channel_fanout)`; ChatChannel alarm flushes to ChannelFanout; ChannelFanout expands to online sessions + delivers to UserConnection + retries transient failures.

## 3. 写流程、事件广播与 cursor

### 3.1 WebSocket 帧处理总流程（v3：WS command 由 UserConnection DO 路由）

```
浏览器       Worker(薄)     UserConnection DO      ChatChannel DO      ChannelFanout DO
   │            │                  │                    │                     │
   │─ WS conn ─▶│ 验 subprotocol   │                    │                     │
   │            │ Origin 校验     │                    │                     │
   │            │── upgrade 代理▶│ acceptWebSocket(ws) │                     │
   │            │                  │ serializeAttachment   │                     │
   │            │                  │  ({user_id,session_id,│                     │
   │            │                  │   per_channel_cursors})│                     │
   │            │                  │ 读 UserDirectory →    │                     │
   │            │                  │ my_channels          │                     │
   │            │                  │ 向各 ChannelFanout    │                     │
   │            │                  │  registerOnline ─────────────────────────────▶│
   │            │                  │ (per-channel replay) │                     │
   │            │                  │                    │                     │
   │─ command ─▶│ (仅 HTTP 路由在 │ webSocketMessage:    │                     │
   │            │  Worker;WS 在 DO) parse command        │                     │
   │            │                  │ 路由: command 带    │                     │
   │            │                  │  channel_id? 直达   │                     │
   │            │                  │  message.* → ChatChannel │               │
   │            │                  │  channel.mark_read → UserDirectory │     │
   │            │                  │── do fetch ──────────────────────────────▶│ 单事务:
   │            │                  │                    │  权限/幂等(in-DO)     │
   │            │                  │                    │  写消息+event        │
   │            │                  │                    │  +outbox 行          │
   │            │                  │◀──────── event(s) ─────────────────────│
   │◀─ committed_ack ─────────────│ (DO 给 socket 发 ack:status=committed,    │
   │            │                  │  payload={channel_id,event_id,message})  │
   │            │                  │ outbox flush ──────────────────────────────▶│ 展开 fanout_queue
   │            │                  │                    │                     │ ─▶ 各 UserConnection
   │◀─ event frame ────────────── deliver(event) ◀────────────────────────────│ (含自己)
```

**WS command 归属（v3 收口）：** hibernation 模式要求 message handler 在 DO 上。Worker 只验 JWT + Origin + upgrade 代理，不处理命令、不维护连接集合、不发 ack、不做 fanout。HTTP 仍由 Worker 路由（read-only endpoints + `/invites/{code}` 先查 InviteDirectory 再看落 ChatChannel）。v4.0 起 Browser message mutation 与 read-state 写入全部走 WS command，不经 Worker HTTP 路由。

**`command_ack` 语义（v3.1 收口：committed_ack；v4.0 addendum：ack 携带 canonical mutation payload）：** `message.send` 用 committed_ack——ChatChannel 事务提交后，UserConnection DO 给当前 socket 发 ack，`status="committed"`，`payload` 为该 mutation 的 canonical Browser-visible result。对 `message.*`，`payload = { channel_id, event_id, message }`，`message` 为 mutation 后的完整 Browser-visible Message 投影（sender UserSummary、type、format、status、stream_state、text、reply_to、reply_snapshot、attachments、components、mentions、created/updated/edited/deleted/recalled）。前端可立即把本地 pending 绑定到 server message 并渲染最终投影，即使 fanout event frame 延迟也无需等待。event frame 仍是最终 timeline 收敛来源，ack 与 event 共用同一 `projectMessageForBrowser` builder（payload.message 同形）。`command.invoke`/`interaction.submit` 同样 committed_ack（`payload` 含 `invocation_id`/`interaction_id` + `event_id` 等 reconcile 所需 ID）。

```json
{
  "frame_type": "command_ack",
  "command": "message.send",
  "command_id": "cmd_...",
  "status": "committed",
  "payload": {
    "channel_id": "ch_...",
    "event_id": "evt_...",
    "message": {
      "message_id": "msg_...",
      "command_id": "cmd_...",
      "channel_id": "ch_...",
      "sender": {
        "kind": "user",
        "user": { "user_id": "u_...", "display_name": "Zemo", "avatar_url": null }
      },
      "type": "text",
      "format": "plain",
      "status": "normal",
      "stream_state": "final",
      "text": "hello",
      "reply_to": null,
      "reply_snapshot": null,
      "attachments": [],
      "components": [],
      "mentions": [],
      "created_at": "2026-06-21T05:30:00Z",
      "updated_at": "2026-06-21T05:30:00Z",
      "edited_at": null,
      "deleted_at": null,
      "recalled_at": null
    }
  }
}
```

`message.edit`/`message.recall`/`message.delete` 的 committed_ack `payload` 同形 `{ channel_id, event_id, message }`：edit 时 `message.status="edited"`、`payload.message.command_id` 保留**原始 message.send 的 command id**、`command_ack.command_id` 是本次 edit 操作 id（有意区分）；recall/delete 时 `message.status="recalled"/"deleted"`、`text=null`、`attachments=[]`/`components=[]`/`mentions=[]`，**不泄露原文/附件/components/mentions**（内部审计可保留，Browser API 永不返回）。`channel.mark_read` 的 committed_ack `payload = { channel_id, last_read_event_id, unread_count }`（无 `event_id`，read-state 不是 message mutation）。

协议校验失败仍返回 `command_error`（contract 10.2）。"ack 只表已接收、不表已创建"的 contract 原文语义由 committed_ack 取代——ack 现携带提交结果。这是 contract 10.2 的一项明确偏离，记入第 9 节 contract delta。

### 3.2 UserConnection DO + Hibernate

- Worker 只验 JWT + Origin，然后 `upgrade` 代理到 `UserConnection` DO（`idFromName(user_id)` 定位，保证同用户单 DO）。
- UserConnection DO：`ctx.acceptWebSocket(ws, [user_id])`，`ws.serializeAttachment({user_id, session_id, per_channel_cursors})`。
- **Hibernation**：DO 可被逐出内存但 WS 保持；事件到达时 DO 重建（constructor 跑），`serializeAttachment` 恢复 cursor。
- **生命周期 handler**：`webSocketMessage(ws, msg)` 处理 command（message.* 路由至 ChatChannel、channel.mark_read 路由至 UserDirectory）、`webSocketClose`/`webSocketError` 清理（反注册 ChannelFanout）、`deliver(event)`（被 ChannelFanout 调用，发 event frame + 更新 cursor 存 storage）。
- **fanout（v3 收口）**：不在 ChatChannel 维护在线列表，独立 ChannelFanout DO（见 2.4）。event 投递走 DO→DO `fetch`/RPC，不经过 Worker 内存全局表。

### 3.2a UserConnection DO command ownership（v4.0）

`UserConnection DO` owns Browser WebSocket command handling.

Worker responsibilities: verify JWT; verify Origin; upgrade/proxy to `UserConnection DO`; NOT parse Browser command frames; NOT send command ack; NOT mutate message/read-state.

`UserConnection DO` responsibilities: accept WebSocket using hibernation API; store `user_id`, `session_id`, `per_channel_cursors` in serialized attachment; parse Browser command frames; validate `command_id` exists for mutating commands; route message commands to `ChatChannel DO`; route read-state command to `UserDirectory DO`; return `command_ack` / `command_error`; receive `deliver(event)` from `ChannelFanout DO`; update per-channel cursors after ordered delivery; on reconnect, replay missing events by per-channel cursor.

Command routing:

| command | target |
|---|---|
| `message.send` | `ChatChannel DO` by `channel_id` |
| `message.edit` | `ChatChannel DO` by `channel_id` |
| `message.recall` | `ChatChannel DO` by `channel_id` |
| `message.delete` | `ChatChannel DO` by `channel_id` |
| `channel.mark_read` | `UserDirectory DO` by `user_id` |
| `command.invoke` | `ChatChannel DO` by `channel_id` |
| `interaction.submit` | `ChatChannel DO` by `channel_id` |

### 3.2b Read-state ownership（v4.0）

Read-state is owned by `UserDirectory DO`.

Table:
```sql
CREATE TABLE my_channels (
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  joined_at  TEXT NOT NULL,
  left_at    TEXT,
  removed_at TEXT,
  status     TEXT NOT NULL DEFAULT 'active',
  membership_version INTEGER NOT NULL,
  last_read_event_id TEXT,
  PRIMARY KEY (user_id, channel_id)
);
```

Browser writes read-state through WS command `channel.mark_read`. Semantics:
- command handled by `UserConnection DO`;
- `UserConnection DO` calls `UserDirectory DO` by `user_id`;
- `UserDirectory DO` requires `(user_id, channel_id)` row exists and `status='active'`;
- update is monotonic: if requested cursor > stored cursor, advance it; if ≤, keep stored;
- response always returns the stored floor after applying monotonic rule;
- unread count recomputed/returned as best-effort depending on phase;
- **no timeline event is appended to `ChatChannel.events`**;
- **no `projection_outbox` is written for read-state**;
- `command_id` echoed for ack correlation;
- durable read-state idempotency guaranteed by monotonic cursor semantics.

Committed ack（v4.0 addendum：ack payload 是 read-state，不是 message 投影，无 `event_id`）：

```json
{
  "frame_type": "command_ack",
  "command": "channel.mark_read",
  "command_id": "cmd_...",
  "status": "committed",
  "payload": {
    "channel_id": "ch_...",
    "last_read_event_id": "01J...",
    "unread_count": 0
  }
}
```

Read-state is user-local state, not channel timeline state.

> （v4.0 反转 Phase 3 Task 11 的 `read_state.updated` channel-event 设计：多 session 同步改用 user-local `read_state_updated` WS frame，非 channel event，详见 contract §20。）

### 3.3 隐式订阅 + 权限版本门禁 + member.left 撤销

- WS 建连（在 UserConnection DO）后读 UserDirectory.my_channels（`status='active'`），向各 ChannelFanout DO `registerOnline`。
- 订阅时记录 `membership_version`（来自 ChatChannel 当前版本）。
- **member.left 后主动撤销（v3 明确）**：ChatChannel leave 事务写 outbox（target_kind=channel_fanout）→ ChannelFanout DO 删该 user 的 online_sessions 行 + 丢弃 pending fanout_queue 行。投递前兜底：UserConnection DO `deliver` 时比对当前 channel membership_version > 订阅版本则拒投递并 repair。两层保障。

### 3.4 per-channel 单调 UUIDv7

`event_seq` 一行，ChatChannel DO 写事务内生成：

```js
function nextEventId(seq) {
  const nowMs = Date.now();
  let ms = seq.last_ms, counter = seq.counter;
  if (nowMs > ms) { ms = nowMs; counter = 0; }
  else { counter++; }
  return uuidV7FromParts(ms, counter, crypto.getRandomValues(...));
}
```

- 同频道同毫秒：counter 递增 → 严格单调。
- 跨频道：各 DO 各自 counter，同毫秒跨频道顺序任意，无因果依赖。
- 客户端 per-channel 比较字符串字典序。

### 3.5 事件 cursor 与 replay（per-channel，含 contract 偏离）

**contract 偏离（v2 起，v3 正式同步见第 9 节）：** 原 contract 用单全局 `last_event_id`/`since_event_id`/`after_event_id`。v2 起改 per-channel cursor。

- **bootstrap**：每个 `channels[]` 项带 `last_event_id`（该频道最后 event 的 per-channel 单调 UUIDv7）；顶层不再有单 `last_event_id`。`event_state` 改为 `per_channel: { channel_id: last_event_id }`。
- **WS 建连**：`?cursors=<base64(JSON {channel_id: since_event_id})>` 或建连后第一条 message 携带 per-channel `since_event_id` map。回放按 per-channel 走。
- **`GET /api/chat/events`**：`?channel_id=&after_event_id=` 单频道，或 `?cursors=<b64 map>` 取用户所有频道（UserDirectory 拿列表 → 并行查各 channel DO → 归并）。
- **replay 投影过滤（v3 统一规则；v4.0 addendum：event payload 走同一 `projectMessageForBrowser`，与 ack 同形）：所有 content-bearing event replay 都通过当前 message projection 过滤。** 不仅 `message.created`：`message.updated`/`message.stream_delta`/`message.stream_finalized`/`interaction.completed`(含 components)/`command.completed`(含 bot preview) 一律规则：
  - 当前 `messages.status` 为 `deleted`/`recalled` 的消息：其 `created`/`updated`/`stream_*` event 不重放（对应生命周期只返回 tombstone）。
  - `message.deleted`/`message.recalled` event payload 走 `projectMessageForBrowser` 安全投影：`payload.message` 含 `{message_id, channel_id, status, sender, type, format, stream_state, text:null, attachments:[], components:[], mentions:[], 操作时间戳(deleted_at/recalled_at), ...}`，**不含原 text/attachments/components/mentions**。事件 payload 形状与对应 committed_ack `payload.message` **同形**（同一 builder）。
  - 实时广播可用创建时投影（内容当时是当前的）；replay 不能直接扫 payload。
  - **event payload 不持久化 UserSummary（v3，v4.0 addendum J 保留）**：`events.payload_json` 只存 `sender_user_id`/`actor_user_id`(→ 改 `actor_kind`+`actor_id`)/`bot_id` 等引用；Browser 投影输出时由 `projectMessageForBrowser` + UserConnection DO/Worker 实时 `resolveUserSummaries` 回填 `display_name`/`avatar_url`。bot actor 例外（来自 BotRegistry，是 chat-owned 数据，可随 event 携带）。满足"DO 不持久化 profile"边界。

### 3.5b 共享 projection builder（v4.0 addendum J）

后端必须有**唯一** `projectMessageForBrowser(...)` builder，被以下所有路径共用：

- 历史分页 `GET /channels/{channel_id}/messages`；
- `message.send`/`message.edit`/`message.recall`/`message.delete` 的 committed_ack `payload.message`；
- `message.created`/`message.updated`/`message.recalled`/`message.deleted` event frame `payload.message`；
- 消息上下文读 `GET .../messages/{message_id}/context`。

规则：

- 不得为 ack/event 单独写 ad hoc serializer；ack 与 event 的 `payload.message` 必须同形。
- deleted/recalled 的原文/附件/components/mentions 过滤逻辑**集中在该 builder 内**（`status=deleted`/`recalled` 时 `text=null`、`attachments=[]`、`components=[]`、`mentions=[]`），调用方无需各自判断。
- UserSummary（`display_name`/`avatar_url`）**不持久化进 DO event payload**；持久化 event 只存 sender/actor user_id 引用，live ack/event 投影输出时实时 resolve。bot actor 例外（BotRegistry 是 chat-owned，可随 event 携带）。
- builder 输出字段集 = §contract §3.4 Message model 全投影（sender UserSummary、type、format、status、stream_state、text、reply_to、reply_snapshot、attachments、components、mentions、created_at、updated_at、edited_at、deleted_at、recalled_at）。

`projectMessageForBrowser` must support `type="sticker"`. Projection rules:

- normal sticker message:
  - `type="sticker"`
  - `text=null`
  - `attachments=[]`
  - `sticker={ sticker_id, attachment_id, url, mime_type, width, height, size_bytes }`
  - `components=[]`
  - `mentions=[]`
  - `format="plain"`
- deleted/recalled sticker message:
  - `type="sticker"`
  - `text=null`
  - `sticker=null`
  - `attachments=[]`
  - `components=[]`
  - `mentions=[]`

The same projection builder is used for history, replay, live event frame, and committed_ack payload.

### 3.5c `system.notice` 与解散事件（v3.3）

- `channel.dissolved` 是频道状态变更 domain event，payload 只含 `channel_id`、`status='dissolved'`、`dissolved_at`、`actor_kind`、`actor_id`。Browser 投影输出时回填 actor UserSummary。
- `system.notice` 是 timeline 弱提示行 event，不替代 `channel.dissolved`、`member.*`、`channel.updated`、`channel.archived`、`message.deleted`。ChatChannel 事务为 timeline-visible 管理动作追加一条 `system.notice`，event_id 紧跟 domain event。
- `system.notice.payload_json` 只存 `notice_kind`、`actor_kind`、`actor_id`、`target_user_id`、`message_id`、`channel_changes_json`。`channel_changes_json` 是字段级 before/after map，字段只允许 `title`、`topic`、`avatar_url`、`visibility`。输出投影包含 `actor`、`target_user` 的 UserSummary；服务端不下发展示文案。
- Replay 保留 `system.notice`。管理员删除消息的 `system.notice` 只携带 `message_id`，不携带原文、附件、components、mentions。

### 3.6 幂等（in-DO，与业务写同事务，v4.0 transport-neutral operation_id）

统一 `idempotency_keys` 表（见 2.1 schema），主键 `(principal_kind, principal_id, operation, operation_id)`，符合 contract 2.5"同 principal + 同 operation + 同 operation_id + 同 body → 同结果"。HTTP `Idempotency-Key` 与 WS `command_id` 是同一语义层，内部统一归一为 `operation_id`（映射：`HTTP Idempotency-Key -> operation_id`；`WS command_id -> operation_id`）。`command_id`（WS 帧）同时承担 ack 关联 id 与幂等键。

- **HTTP mutation**：`Idempotency-Key` 记录落目标 DO 的 SQLite（按 endpoint 路由到的 DO：含 channel 的落 ChatChannel、含 invite_code 的先查 InviteDirectory 再落 ChatChannel），与业务 mutation 同事务。命中且 `request_hash` 一致 → 返回缓存 `response_json`；不一致 → `IDEMPOTENCY_CONFLICT`。status: `processing`→`completed`/`failed`，`expires_at` 过期清理。KV 仅作响应缓存优化，不是 correctness gate。v4.0 起 HTTP 不再承载 message mutation / read-state 写入（这些改为 WS command），故 `Idempotency-Key` 仅用于剩余 HTTP mutation（channel create 等）。
- **WebSocket command（v4.0 收口；addendum K：幂等缓存存完整 ack payload）：** 所有 mutating WS command（`message.send`/`message.edit`/`message.recall`/`message.delete`/`channel.mark_read`/`command.invoke`/`interaction.submit`）必填 `command_id`。`command_id` 既是 ack/error correlation id，又是 durable idempotency key：服务端把 `operation_id = command_id` 写入 `idempotency_keys` 表（operation 由 command 名派生），与业务 mutation 同事务落对应目标 DO。命中 `(principal_kind, principal_id, operation, operation_id)`：`request_hash` 一致 → 返回缓存的 `response_json`（**完整 committed ack payload**，同首次 commit_ack，不重发 event）；`request_hash` 不一致 → `409 IDEMPOTENCY_CONFLICT`（走 `command_error`，`retryable=false`）。**幂等响应不扫 `events`**，`response_json` 存首次写入的**完整 ack payload**（`message.*` = `{channel_id, event_id, message}` 含完整 `projectMessageForBrowser` 投影；`channel.mark_read` = `{channel_id, last_read_event_id, unread_count}`），重复重试原样返回。`messages` 的 `UNIQUE(channel_id, dedupe_principal_key, command_id)` 仅为二级防御。`dedupe_principal_key` 按 principal 命名空间化（`user:<uid>` / `bot:<bot_id>` / `system:<...>`）——不同用户用相同 `command_id` 各自产生不同 message，互不挡。`command_id` scoped by `(principal_kind, principal_id, operation)`；客户端应为每次用户操作生成 UUIDv7，断线重试同一操作复用同一 `command_id`，新操作用新 `command_id`。若事后 profile display 数据变更，幂等重放仍可能返回旧的 `display_name`/`avatar_url`——可接受（idempotency replay 优先稳定提交结果；正常 history/event replay 按既有策略实时 resolve 新 profile）。

### 3.7 WS command_id

`command_id` is a client-generated durable operation id. Required for every mutating Browser WS command: `message.send`, `message.edit`, `message.recall`, `message.delete`, `channel.mark_read`, `command.invoke`, `interaction.submit`. It serves both (1) command ack/error correlation; (2) durable idempotency.

Rules:
- client generates `command_id` before sending the command;
- `command_id` must be stable across retries of the same user operation;
- retrying the same operation after disconnect must reuse the same `command_id`;
- a new user operation must use a new `command_id`;
- server echoes `command_id` in `command_ack` / `command_error`;
- server stores `command_id` as the idempotency key for commands that mutate durable state;
- reusing the same `command_id` with identical body returns the same committed result;
- reusing the same `command_id` with different body returns `IDEMPOTENCY_CONFLICT`;
- `command_id` is scoped by `(principal_kind, principal_id, operation)` for idempotency;
- clients should generate UUIDv7 or equivalent high-entropy sortable IDs.

Same operation retry:
```
first attempt:   command_id = 01JAAA..., command = message.send, body = "hello"
retry disconnect: command_id = 01JAAA..., command = message.send, body = "hello"
server: returns the same message_id/event_id
```

New message with same text:
```
first message:  command_id = 01JAAA..., body = "hello"
second message: command_id = 01JBBB..., body = "hello"
server: creates a second message
```

### 3.8 Transport-neutral operation_id（v4.0）

HTTP `Idempotency-Key` 和 WS `command_id` 是同一语义层：both client-generated durable operation IDs; both identify one user-intended mutation; both stable across retries; both not reused for a different body; both scoped by `(principal_kind, principal_id, operation)`; both use `request_hash` to detect body mismatch; both return same committed result on duplicate identical retry; both return `IDEMPOTENCY_CONFLICT` on duplicate key + different body. Differ only by transport (HTTP header `Idempotency-Key` vs WS field `command_id`). Normalize both into one internal concept `operation_id`:

```ts
type ClientOperationId = string;
function operationIdFromHttp(request: Request): ClientOperationId {
  return request.headers.get("Idempotency-Key") ?? "";
}
function operationIdFromWs(frame: CommandFrame): ClientOperationId {
  return frame.command_id;
}
```

Internal idempotency code receives `{principal_kind, principal_id, operation, operation_id, request_hash}` and must not care whether it came from HTTP or WS. Mapping: `HTTP operation_id = Idempotency-Key`; `WS operation_id = command_id`.

### 3.9 Phase E: ChatChannel 内部方法 resolveVisibleAttachment

`ChatChannel DO` exposes an internal method for Phase E sticker save:

```ts
resolveVisibleAttachment(input: {
  user_id: string
  attachment_id: string
}): AttachmentProjection
```

Rules:

- The caller is trusted Worker/UserDirectory internal code.
- `user_id` must be authorized against `members`.
- The channel must not be invisible to this user.
- `attachment_id` must exist in this channel's `attachments` table.
- The attachment must be linked to at least one Browser-visible normal image/sticker message.
- If the linked message is deleted/recalled, return `INVALID_STICKER_SOURCE` or `MESSAGE_NOT_FOUND` according to API contract.
- Return only Browser-safe projection:
  - `attachment_id`
  - `url`
  - `mime_type`
  - `width`
  - `height`
  - `size_bytes`
- Do not return `storage_key`.

### 3.10 Phase E: send sticker message 流程

Browser sends existing WS `message.send` command with `type="sticker"` and current user's `sticker_id`. Command ownership remains unchanged:

```text
Browser → UserConnection DO(user_id) → ChatChannel DO(channel_id)
```

`ChatChannel DO` remains the owner of message creation. Flow inside ChatChannel:

```text
ChatChannel.messageSend(type=sticker)
  ├─ check message.send idempotency first
  │    └─ if completed, return cached committed_ack without resolving sticker
  ├─ validate channel membership / channel status
  ├─ call UserDirectory DO(user_id).resolveSticker(sticker_id)
  │    └─ returns canonical attachment projection
  ├─ create message row type='sticker'
  ├─ store sticker attachment reference
  ├─ create message.created event
  ├─ write projection_outbox(target_kind=channel_fanout)
  ├─ complete idempotency row with canonical ack payload
  └─ return committed_ack
```

Important idempotency rule:

- ChatChannel must check completed idempotency before resolving `sticker_id`.
- If the original sticker send already committed, retrying the same `command_id` must return cached committed_ack even if the sender later removed that sticker from their personal library.
- If no committed idempotency entry exists and `sticker_id` no longer exists, return `STICKER_NOT_FOUND`.

`UserDirectory.resolveSticker(sticker_id)`:

- Requires the sticker belongs to the current user.
- Requires `deleted_at IS NULL`.
- Returns canonical attachment projection snapshot from `personal_stickers`.
- Does not mutate state.

## 4. 认证与 Profile

### 4.1 JWT 自验（Worker 内，零 DB）

从 `toolbear_ui/auth_utils.py` 提炼，HS256，`JWT_SECRET`。

```js
function verifyBrowserJwt(token, secret) {
  const payload = jwtVerify(token, secret, { algorithms: ["HS256"] });
  if (!payload.sub) throw 401 UNAUTHORIZED;
  if (payload.client_id !== undefined) throw 401 MACHINE_TOKEN_NOT_ALLOWED;
  const managed = payload.managed_session === true
    || (payload.owner_user_id !== undefined
        && payload.owner_user_id !== payload.sub
        && payload.effective_account_user_id === payload.sub);
  if (managed) throw 403 SESSION_NOT_ALLOWED;
  return { user_id: payload.sub };
}
```

self-session 判定：无 `client_id` + `owner_user_id == sub` + `effective_account_user_id == sub` + 非 `managed_session` → 放行。`principal_id` 校验对 self-session 跳过（Python 侧同样提前返回）。`exp` 自动验。日志不记原始 token。库用 `jose`。

### 4.2 WebSocket 认证（subprotocol）

前端 `new WebSocket("wss://chat.kuma.homes/api/chat/ws?cursors=<b64>", ["lilium.chat.v1", "bearer.<jwt>"])`。

Worker upgrade：

1. `Sec-WebSocket-Protocol` 必须是 `lilium.chat.v1` + `bearer.<jwt>`，缺一/多 → 拒（400）。
2. `verifyBrowserJwt` 失败 → 拒（401）。
3. Origin ∈ {`https://lilium.kuma.homes`, 本地 dev origin}，不匹配 → 拒。
4. 通过 → upgrade 代理到 UserConnection DO（`idFromName(user_id)`），DO `acceptWebSocket` + 隐式订阅 + per-channel 回放。

### 4.3 Profile：Hyperdrive + pg 直读 users 表

```ts
import { Client } from "pg";

async function resolveUserSummaries(userIds: string[], env: Env): Promise<Map<string, UserSummary>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const map = new Map<string, UserSummary>();
  // 分批,每批 50,不静默截断
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const client = new Client({ connectionString: env.LILIUM_DB.connectionString });
    await client.connect();
    try {
      const res = await client.query(
        "SELECT user_id::text, full_name, avatar_url FROM users WHERE user_id = ANY($1)",
        [batch],
      );
      for (const row of res.rows) {
        map.set(row.user_id, {
          user_id: row.user_id,
          display_name: row.full_name,
          avatar_url: row.avatar_url,
        });
      }
    } finally {
      await client.end();
    }
  }
  return map;
}
```

- **只读 DB 用户**：最小权限只允许 `SELECT user_id, full_name, avatar_url FROM users`。
- **字段映射**：`users.full_name` → `display_name`。唯一耦合点在 `resolveUserSummaries`。
- **请求级缓存**：单次请求/WS 批量内同一 user_id 只查一次（请求级 `Map`），不跨请求缓存。
- **missing user fallback**：resolve 不到的，`display_name` 不能是裸 user_id（contract 验收要求前端不展示裸 user id 为主身份），用 fallback 显示名（如 "user-xxxx 前 4 位"）+ `avatar_url = null`。
- **bot actor**：`kind=bot` 不走 resolve，来自 BotRegistry DO。
- **Hyperdrive query caching**：profile 查询不跨请求长期缓存。

bootstrap.me / 消息 sender / 成员列表批量 resolve 拼装，一次请求最多触发一组分批查询，不是 N+1。

## 5. 附件（SeaweedFS presign 上传流程）

### 5.1 SeaweedFS 配置

```toml
[vars]
S3_ENDPOINT = "https://s3.kuma.homes"
S3_BUCKET = "lilium-chat-attachments"
S3_PUBLIC_BASE = "https://s3.kuma.homes"
# S3_ACCESS_KEY / S3_SECRET_KEY → wrangler secret put
```

- storage_key = `chat/{attachment_id}`（高熵，不含 filename/user/channel）。
- public `url = https://s3.kuma.homes/lilium-chat-attachments/chat/{attachment_id}`，长期公开，存 DO。
- Worker 用 fetch + aws4fetch SigV4 签访问 SeaweedFS（presign PUT / HEAD / DELETE 时签）。

### 5.2 presign（`POST /api/chat/uploads/images/presign`）

Worker：验 JWT → 校验 mime_type ∈ {png,jpeg,webp,gif} + size ≤ 20 MiB → 生成 attachment_id（UUIDv7）+ storage_key → aws4fetch 签 5 分钟 presigned PUT（约束 Content-Type=size_bytes）→ 写 UserDirectory pending_attachments（status=pending, expires_at=now+1h）+ **更新单 alarm 到 earliest pending expires_at（见 5.5）** → 返回 `{attachment_id, upload_url, upload_method:"PUT", upload_headers, expires_at}`。

### 5.3 finalize（`POST /api/chat/uploads/images/{attachment_id}/finalize`）

Worker：验 JWT → 从 UserDirectory pending_attachments 取 → 校验 owner==user_id + status==pending → fetch HEAD SeaweedFS（SigV4）确认存在 + **校验 Content-Type 与 Content-Length 一致**（不只 length）→ status=finalized → 取消 alarm → 返回 Attachment 投影（含 public url）。幂等：已 finalized 直接返回。

### 5.4 附件访问 URL 与 risk acceptance

Public read，不签。`url` 长期公开存 DO。**产品方显式风险接受**：private 频道附件也 public（与旧 PRD 15.2 "私有频道附件不长期公开"相反，按产品方决定）。配套缓解措施（P1 risk register）：

- storage_key 高熵 `chat/{attachment_id}`，不含原始 filename/user/channel，不可猜。
- `url` 路径只暴露 `attachment_id`，不泄露频道/用户。
- filename 只在 JSON metadata 返回，前端必须转义防 XSS。
- finalize 校验 Content-Type + Content-Length，不只信浏览器上报。
- deleted/recalled 消息：Browser API 不再返回其附件 URL（投影过滤）；对象是否保留用于审计另写策略。
- `attachments.url` 保持为字段（非永久不可变事实），后续切 signed GET/proxy 可迁移。

### 5.5 GC：DO alarm + earliest-wins 循环（v3 修正）

平台核验：每个 DO 同一时间只能有一个 alarm，`setAlarm` 是 last-write-wins，不能"每个 presign 一个 alarm"。改 storage + earliest-wins 循环：

- presign：写 `pending_attachments`（含 `expires_at`）→ `setAlarm(min(existing earliest pending expires_at, new expires_at))`。
- finalize：标 finalized；若 finalize 的是当前最早 pending，则 `setAlarm(next earliest pending expires_at)`。**不无条件 cancel alarm**（cancel 会丢其他 pending 的清理）。
- alarm 触发（alarm 唤醒 hibernated DO，at-least-once + 自动退避重试）：DELETE 所有 `expires_at <= now && status='pending'` 的 SeaweedFS object（SigV4）+ 删/标行 → `setAlarm(next earliest pending expires_at)`（若无 pending 则 `deleteAlarm`）。

无"列出所有 DO 实例"需求：每个 UserDirectory DO 维护自己的 pending 列表 + 自己的单 alarm。

### 5.6 发送图片消息

finalize 拿到 attachment_id 后，前端发 WS command `{message.send, type:image, attachment_ids}`。Worker 从 UserDirectory 预取 metadata → ChatChannel DO 事务校验 `owner==sender && status==finalized` → 写 message + message_attachments + attachment 副本 + `message.created` event → 广播。

### 5.7 Phase E: save personal sticker 流程

Saving a visible image/sticker into personal sticker library uses `{ channel_id, attachment_id }`. `message_id` is not required and must not be used as the primary source locator. `channel_id` is required so backend can route to `ChatChannel DO(channel_id)` to verify current visibility and obtain canonical attachment projection. `attachment_id` is required so the selected image is unambiguous even if a message contains multiple attachments. Request shape:

```json
{
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "attachment_id": "00000000-0000-7000-8000-000000000501"
}
```

No `message_id` is needed in v1. If a future API wants to save by `attachment_id` alone, backend must first introduce an `AttachmentDirectory DO` or another global attachment locator. Phase E does not introduce that DO.

HTTP Browser request:

```text
POST /api/chat/stickers
body = { channel_id, attachment_id }
```

Flow:

```text
Worker
  └─ verifies Browser JWT
  └─ routes to UserDirectory DO(user_id)
       ├─ idempotency check in UserDirectory(operation=sticker.save)
       ├─ calls ChatChannel DO(channel_id).resolveVisibleAttachment(user_id, attachment_id)
       │    ├─ requires user is current active member or otherwise authorized by existing Browser visibility rules
       │    ├─ requires attachment is currently Browser-visible
       │    ├─ rejects deleted/recalled message attachments
       │    └─ returns canonical attachment projection { attachment_id, url, mime_type, width, height, size_bytes }
       ├─ upserts personal_stickers(user_id, attachment_id)
       └─ returns PersonalSticker projection
```

Semantics:

- Save operation is user-local and idempotent in `UserDirectory`.
- ChatChannel is consulted only for attachment visibility and canonical projection.
- No channel timeline event is written.
- No ChannelFanout delivery is produced.
- The original message is not mutated.
- Re-saving the same `attachment_id` by the same user returns the existing active sticker row, or restores a soft-deleted row depending on implementation choice. The chosen behavior must be deterministic.

## 6. 部署与 chat.kuma.homes / CORS / WS Origin

### 6.1 wrangler 配置

```toml
name = "lilium-chat"
main = "src/index.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = false
upload_source_maps = true
version_metadata = { binding = "CF_VERSION_METADATA" }

routes = [{ pattern = "chat.kuma.homes", custom_domain = true }]

[vars]
API_BASE_URL = "https://lilium.kuma.homes"
S3_ENDPOINT = "https://s3.kuma.homes"
S3_BUCKET = "lilium-chat-attachments"
S3_PUBLIC_BASE = "https://s3.kuma.homes"
SENTRY_ENVIRONMENT = "production"
SENTRY_DSN = "<sentry dsn>"

[[durable_objects.bindings]]
name = "CHAT_CHANNEL"
class_name = "ChatChannel"
[[durable_objects.bindings]]
name = "USER_DIRECTORY"
class_name = "UserDirectory"
[[durable_objects.bindings]]
name = "USER_CONNECTION"
class_name = "UserConnection"
[[durable_objects.bindings]]
name = "CHANNEL_DIRECTORY"
class_name = "ChannelDirectory"
[[durable_objects.bindings]]
name = "INVITE_DIRECTORY"
class_name = "InviteDirectory"
[[durable_objects.bindings]]
name = "BOT_REGISTRY"
class_name = "BotRegistry"
[[durable_objects.bindings]]
name = "CHANNEL_FANOUT"
class_name = "ChannelFanout"

# v3 修正: Hyperdrive binding 用 config id(由 `wrangler hyperdrive create --connection-string=...` 生成)
# 生产 connection string 不进 wrangler.toml, 存在 CF 侧。localConnectionString 仅本地 dev(不用 --remote)。
[[hyperdrive]]
binding = "LILIUM_DB"
id = "<hyperdrive-config-id>"
localConnectionString = "postgres://readonly_user:password@localhost:5432/toolbear"

# 不用 Cron 扫 DO;GC 走 DO alarm。如需 rate-limit 可加 [triggers]。

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatChannel", "UserDirectory", "UserConnection", "ChannelDirectory", "InviteDirectory", "BotRegistry", "ChannelFanout"]

[observability.logs]
enabled = true
invocation_logs = true
destinations = ["sentry-log"]
[observability.traces]
enabled = true
destinations = ["sentry"]
```

### 6.2 CORS（HTTP 跨域）

```js
app.use("/api/chat/*", cors({
  origin: ["https://lilium.kuma.homes"],   // dev 加 localhost
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
  exposeHeaders: ["X-Request-Id"],
  credentials: false,
  maxAge: 86400,
}));
```

### 6.3 WebSocket Origin 校验

Worker upgrade 时 `Origin` ∈ {`https://lilium.kuma.homes`, `http://localhost:5173`}，否则拒。

### 6.4 请求 ID 与错误 envelope

`req_<uuidv7>` 注入 `X-Request-Id` 响应头 + 错误 envelope。

错误码使用 contract v2.2 的资源级 code，不定义通用 `NOT_FOUND`。频道、消息、成员、邀请缺失分别返回 `CHANNEL_NOT_FOUND`、`MESSAGE_NOT_FOUND`、`MEMBER_NOT_FOUND`、`INVITE_NOT_FOUND`。`channel_meta.status='dissolved'` 的写入入口统一返回 `409 CHANNEL_DISSOLVED`。

### 6.5 本地开发

`wrangler dev`：DO SQLite 本地，Hyperdrive 指本地 PG，S3 指 MinIO 或 `s3.kuma.homes`，`JWT_SECRET` 用 dev 值。前端 dev 指向 `http://localhost:8787`。

### 6.6 部署

`wrangler deploy`（包 `scripts/deploy.mjs`：typecheck + deploy + sentry source map）。secrets 用 `wrangler secret put`。

### 6.7 限流（补 PRD 20.3）

DO 内业务语义限流兜底（不限平台层）：

- per-user 消息发送率、per-channel 消息发送率、per-user upload presign/finalize 率、per-IP WS connect 率（Worker 层）、per-channel command/bot callback 率、admin mutation 率。

**Token bucket schema（v3 补，放对应 DO 的 SQLite）：**

```sql
CREATE TABLE rate_buckets (
  bucket_key   TEXT PRIMARY KEY,    -- "msg:user:{uid}" / "msg:channel:{cid}" / "upload:{uid}" / "ws:ip:{ip}" / "cmd:channel:{cid}" / "admin:{uid}"
  tokens       REAL NOT NULL,        -- 当前令牌数
  refill_rate  REAL NOT NULL,        -- 每秒补充令牌
  capacity     REAL NOT NULL,        -- 桶容量
  updated_at   TEXT NOT NULL
);
```

窗口/容量配置化（如 per-user 消息 10/s + burst 20；per-channel 50/s；upload 5/min）。命中限流返回 `429 RATE_LIMITED`（`retryable: true`，带 `Retry-After`）。

**限流落点（v3.1 明确）：**

- **业务语义限流**（per-user message、per-channel message、per-user upload、per-channel command、admin mutation）→ 落目标 DO 的 SQLite `rate_buckets` 表，与业务写同 DO，token bucket 原子更新。
- **per-IP WS connect 限流** → **用 Cloudflare Rate Limiting/WAF**（Worker 无持久内存，DO 分片做 per-IP 没必要引入额外 DO）。在 wrangler 或 CF dashboard 配置规则，命中返回 `429` 或 upgrade 前拒绝。Worker 层作为最外层防线，DO 内语义限流作为兜底。

### 6.8 可观测性指标（补 PRD 21.2）

WS 连接数、WS 重连率、message send p50/p95/p99、event replay lag、DO 错误、attachment finalize 失败、bot callback 失败、rate limit 命中、projection outbox backlog（pending 行数）、fanout queue backlog、DO alarm 触发数。写入 Sentry / Workers Analytics。

## 7. 测试策略

`@cloudflare/vitest-pool-workers` + vitest，miniflare 跑真实 DO，非 mock。

### 7.1 测试分层

**单元：纯函数**
- `verifyBrowserJwt`：self-session 正例 + 各拒例。
- `nextEventId`：同毫秒递增、跨毫秒归零、跨次单调。
- 错误 envelope、cursor 编解码、SigV4 签名结构。

**DO 内逻辑（miniflare 真实 DO）**
- 成员/权限、解散群聊（owner-only + `CHANNEL_DISSOLVED`）、`system.notice`、消息生命周期（deleted/recalled 不出历史分页、replay 投影过滤）、幂等（in-DO，v4.0 operation_id）、事件顺序（同频道单调）、read-state（floor + 单调，v4.0 走 WS `channel.mark_read`，不写 channel event）、附件、bot command 冲突与 invocation、member.left 后订阅撤销。
- 跨 DO projection repair：ChatChannel.members 与 UserDirectory.my_channels 不一致时 bootstrap/subscribe 修复。
- **message.send 幂等命名空间化（v3.2，v4.0 改用 command_id，三条）：** 同一用户 + 同 channel + 同 `command_id` + 同 body → 返回同一 message_id/event_id；同一用户 + 同 channel + 同 `command_id` + 不同 body → `IDEMPOTENCY_CONFLICT`；不同用户 + 同 channel + 同 `command_id` → 都成功，各自不同 message_id（验证不被 client operation id 互挡/劫持）。

**全局索引 DO**
- InviteDirectory 路由 `/invites/{code}`、ChannelDirectory 目录查询、BotRegistry token_hash 校验。（v4.0 移除 MessageIndex，消息路由不再走全局索引 DO。）

**HTTP 端到端**：fetch 打 Hono app，覆盖只读/辅助契约端点 + 错误码。（v4.0 message mutation / read-state 写入不走 HTTP。）

**WebSocket 端到端**：subprotocol 握手、`message.send`/`message.edit`/`message.recall`/`message.delete`/`channel.mark_read` command_ack→event、`command_id` 幂等（同 id 同 body→同结果，同 id 异 body→`IDEMPOTENCY_CONFLICT`）、隐式订阅、per-channel cursor 回放、hibernation wake 后重连不丢事件。

### 7.2 profile resolve 测试

fake Hyperdrive stub 单元 + 标 `@skip` 的真 PG 集成（CI 跳过）。验分批不截断、字段映射、missing user 不显示裸 user_id。

### 7.3 平台 spike（新增，阶段 0 必跑）

- DO WebSocket hibernation：连接→休眠→恢复→`serializeAttachment` 恢复 cursor。
- DO lifecycle/redeploy 后客户端 reconnect + per-channel replay 不丢事件。
- Hyperdrive + pg 直连 ToolBear 只读库。
- SeaweedFS presigned PUT + HEAD finalize。
- KV 不作 correctness layer 的并发测试（证明双写不产生重复业务数据）。
- replay after delete：旧 `message.created` 不重放原文/附件/components/mentions。
- invite_code 路由（InviteDirectory）。（v4.0 移除 MessageIndex，无 message_id 路由 spike。）

### 7.4 不测什么（v3 表述修正）

不测试 Cloudflare 内部实现（DO 事务引擎、KV 复制机制、平台调度）。但阶段 0 必须跑平台集成 spike（见 7.3），验证我们依赖的平台行为和用法（hibernation 恢复、Hyperdrive+pg、SeaweedFS、alarm 单实例调度、replay-after-delete、KV 非 correctness 并发、invite_code 路由）。ToolBear JWT 签发与前端不在本 repo 测试范围。

### 7.5 CI

GitHub Actions：`typecheck` + `test`，scripts 跟 game-worker 一致。

## 8. 阶段切分

对照 contract 第 12 节，落到 lilium-chat repo。

### 阶段 0：骨架 + 平台 spike + 全局索引空壳

交付：Hono app + wrangler + 7 个 DO 类壳（ChatChannel/UserDirectory/UserConnection/ChannelDirectory/InviteDirectory/BotRegistry/ChannelFanout）+ JWT 自验 + Hyperdrive pg resolve + 部署 chat.kuma.homes + **平台 spike 全部跑通**（hibernation、Hyperdrive、SeaweedFS、replay-after-delete、invite_code 路由、KV 非 correctness、单 alarm earliest-wins 调度、projection outbox flush）。v4.0 WS frame 定义须预留 command 名 `message.send`/`message.edit`/`message.recall`/`message.delete`/`channel.mark_read`/`command.invoke`/`interaction.submit`，parser/types 拒未知 command；所有 mutating WS command 须有顶层 `command_id`，不允许 payload 级 client operation id（`client_message_id`/`client_mutation_id`/`client_invocation_id`/`client_interaction_id`）。

- `GET /bootstrap` 返回 me + 空 channels + per-channel cursor 字段 + `active_channel=null`。
- machine/managed 拒绝。
- CORS + WS Origin。
- InviteDirectory/ChannelDirectory/BotRegistry 作为空壳 DO 先建（为后续路由定位打底）。（v4.0 移除 MessageIndex。）

验收：curl bootstrap 通；各拒例；platform spike 通过。

### 阶段 1：Worker/DO 最小聊天核心（contract 12.1，per-channel cursor）

交付：ChatChannel 完整表 + UserDirectory projection + 系统公共频道 + bootstrap + 历史分页 + per-channel cursor + projection repair。

- bootstrap 返回 per-channel cursor；新用户自动入系统公共频道（saga 写 members + projection）。
- `GET /channels/{id}/messages` 分页。
- profile 批量回填。
- events + 单调 UUIDv7（无 WS，只写）。

验收：contract 12.1。

### 阶段 2：WebSocket command/event（contract 12.3，per-channel cursor + hibernation）

交付：UserConnection DO + WS hibernation + message.send + command_ack/event + 隐式订阅 + member.left 撤销 + per-channel replay。

- WS subprotocol 握手 + upgrade 代理到 UserConnection DO。
- `message.send` → `command_ack` → `message.created`（含自己）。
- `GET /events`（per-channel cursor）。
- in-DO 幂等。
- hibernation wake 后 reconnect + replay 不丢事件。

验收：contract 12.3 + hibernation spike。前端只读壳（contract 12.2）在 dzmm_archive，不进本 repo。

### 阶段 3：Channel CRUD + Member Management + Read State（contract 12.4，v3.4 范围收口）

交付：频道 CRUD（含创建）+ members + read-state + projection outbox flush + repair。

- **`POST /api/chat/channels`（频道创建，v3.4 新增）**：任意已认证 Browser 用户可创建 `kind="channel"` 频道。ChatChannel DO by `channel_id`（UUIDv7，即 DO name；系统频道例外，DO name=`system-general`）。事务内：写 `channel_meta`（创建者=`created_by`，`status='active'`，`membership_version` 初始）+ 写 `members`（创建者 `role='owner'`）+ 写 `channel.created` event + `member.joined`（创建者，actor=system）+ 对每个 `initial_members` 写 `members` + `member.joined` + `system.notice`（notice_kind=`channel.created`，actor=创建者）+ `idempotency_keys` + `projection_outbox(target_kind=user_directory)`（创建者及每个 initial_member 的 join projection）+ `projection_outbox(target_kind=channel_fanout)`（事件广播）。创建者不在 `initial_members`（owner 固定）。DM 创建不暴露（见"关于 DM"）。（v3.5）创建幂等由 `UserDirectory(creator_user_id)` 协调，不由 Worker mint 的 `ChatChannel` DO 承担：`UserDirectory.idempotency_keys` 事务内 mint `channel_id`、状态机 `creating`→`completed`、持久化 `channel_id`，再调 `ChatChannel(channel_id).createChannel`（单事务原子写 `channel_meta`+members+events+outbox，`channel_meta` 存在性即幂等 guard）。`status=creating` 崩溃窗口由 retry 重调同一 `ChatChannel(channel_id).createChannel`（幂等）后标 `completed` 修复，不重复建群。
- channels/members 增删改 + `membership_version` + member.left 经 outbox 通知 ChannelFanout 撤销订阅（member.left 复用 Phase 2 的 `markMemberLeftAndEnqueueFanoutUnregister`）。
- `PATCH /api/chat/channels/{channel_id}`：owner/admin 可改 title/topic/visibility（avatar_attachment_id Phase 5 才校验，Phase 3 接受 null）；写 `channel.updated` event + `system.notice`。
- `POST /api/chat/channels/{channel_id}/dissolve`：owner-only，写 `channel.dissolved` + `system.notice`，后续写入返回 `CHANNEL_DISSOLVED`。
- `GET /api/chat/channels/{channel_id}/members`（display_name/user_id 模糊搜索，前缀匹配）+ `GET /api/chat/channels/{channel_id}/members/{user_id}`（精确读单成员：role/joined_at/status）。
- `POST/PATCH/DELETE /api/chat/channels/{channel_id}/members[/{user_id}]`：添加成员（admin+）、改角色（owner）、移除/退出（owner 移除他人 / 成员退出自己）。member.left 复用 `markMemberLeftAndEnqueueFanoutUnregister`。
- read-state floor（my_channels `last_read_event_id`，per-channel 单调）+ WS command `channel.mark_read`（UserConnection DO → UserDirectory DO，要求 active 成员，只允许单调前进；**v4.0 不写 channel timeline event、不写 `projection_outbox`**；多 session 同步用 user-local `read_state_updated` WS frame，非 channel event）。
- unread 计算。
- in-DO HTTP 幂等（统一 `idempotency_keys` 表，同 Phase 2 message.send 模式：SELECT 在事务内，request_hash + response_json）。
- **`GET /api/chat/channels/{channel_id}/members/{user_id}`**：按 user_id 精确读单成员资料（role / joined_at / 离开状态）。供前端 profile sheet（`useChatUserProfile`）cache miss 回源。

不在本阶段：公开目录 / discovery、`POST /channels/{id}/join`、invite create/accept、DM 创建、bot command（留 Phase 6/7）。

验收：contract 12.4。

### 阶段 4：消息生命周期（contract 12.5）

交付：回复（reply_snapshot_json）+ 编辑（message_edits + audit_logs）+ 撤回 + admin 删除。

- `message.updated`/`message.recalled`/`message.deleted` event。
- 管理员删除他人消息追加 `system.notice`，payload 不含原文。
- deleted/recalled 原文保留审计，投影/replay 不含原文（join messages.status 过滤）。
- v4.0：编辑/撤回/删除全部走 WS command（`message.edit`/`message.recall`/`message.delete`），locator 为 `{channel_id, message_id}`，直接路由到 ChatChannel DO（无 MessageIndex）。

验收：contract 12.5。

### 阶段 5：图片附件（contract 12.6）

交付：SeaweedFS presign + finalize（Content-Type+Length 校验）+ DO alarm GC + 图片消息。

- pending 在 UserDirectory，alarm 1h GC。
- public url 存 DO。
- 发送图片校验 attachment owner + finalized。

验收：contract 12.6。

### 阶段 6：公开目录与邀请（contract 12.7）

交付：ChannelDirectory 目录 + join + invite 创建/接受（InviteDirectory 路由）。

- `GET /channels/directory`（ChannelDirectory）。
- `POST /channels/{id}/invites` + `POST /invites/{code}/accept`（InviteDirectory 路由）。
- 邀请不存在、不可见、撤销、过期返回 `INVITE_NOT_FOUND`。
- 邀请码明文。

验收：contract 12.7。

### 阶段 7：Bot slash command 与 rich interaction（contract 12.8）

交付：BotRegistry 全局身份 + token_hash + callback HMAC + command 注册 + invoke + interaction + effects + streaming。

- 7a：BotRegistry + token 认证 + `PUT /bot/commands` + channel commands 查询。
- 7b：`command.invoke` + invocation 状态 + bot callback 签名（HMAC jose）+ effects 校验。
- 7c：`interaction.submit` + interaction 状态 + message_interaction callback。
- 7d：stream effects + stream 事件。
- 7e：Bot 直接发消息。

验收：contract 12.8。

### 关于 DM

只做 `kind=channel`，DM 表结构预留，不暴露创建。

### 关于前端阶段（contract 12.2）

不进 lilium-chat，dzmm_archive 对应接入。

### 关于 cursor contract 偏离

per-channel cursor 改动需同步落到前端状态模型（`chatConnectionStore` 的 `last_event_id` 变 per-channel map）。这是 contract API 形状修订，需前端配合。

## 9. API contract v2.2 修订（per-channel cursor + 前端缺口收口）

per-channel cursor 是产品方确认的 contract API 形状修订（见第 0.2 节 E）。已落地为权威 contract v2.2：`docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`（本仓库），与 2026-06-21 原 contract（dzmm_archive）并存，明确 delta：

- `GET /api/chat/bootstrap` 响应 `event_state` 改为：

  ```json
  { "event_state": { "per_channel": { "<channel_id>": "<last_event_id>" } } }
  ```

  每个 `channels[]` 项带自身 `last_event_id`。空频道：`event_state.per_channel = {}`。

- WebSocket 建连：

  ```text
  wss://chat.kuma.homes/api/chat/ws?cursors=<base64url(JSON {channel_id: since_event_id})>
  ```

  `cursors` 可为空（首次建连，全部从最新开始）。

- `GET /api/chat/events`：

  ```text
  GET /api/chat/events?channel_id=<id>&after_event_id=<event_id>     # 单频道
  GET /api/chat/events?cursors=<base64url(JSON {channel_id: since_event_id})>  # 多频道归并
  ```

  响应 `last_event_id` 字段改为 per-channel（`per_channel: {...}`）。

**v3.1 追加 delta（committed_ack + message.send 幂等简化 + ROUTE_INDEX_PENDING）：**

- `message.send`/`command.invoke`/`interaction.submit` 的 `command_ack` 改为 committed_ack：`{frame_type:"command_ack", command_id, status:"committed", channel_id, message_id|invocation_id|interaction_id, event_id}`。取代 contract 10.2 "ack 只表已接收、不表已创建"的语义——ack 现携带提交结果。event frame 仍是最终 timeline 状态。（v4.0 addendum superseded：`message.*` 的扁平 ID ack 改为 payload-bearing `{payload:{channel_id,event_id,message}}`，`message` 为完整 Browser 投影；`channel.mark_read` ack payload 为 read-state。见下方 v4.0 addendum delta。）
- `message.send` 不再强制独立 `idempotency_key`（contract 6.2 原文同时传 `command_id` + `idempotency_key` + `payload.client_message_id`）。v3.1 简化：`message.send` 用 `command_id`(ack 关联) + `payload.client_message_id`(业务幂等)，`idempotency_key` 服务端缺省映射为 `client_message_id`。`command.invoke`/`interaction.submit` 仍用 `client_invocation_id`/`client_interaction_id`。（v4.0 superseded：`client_message_id`/`idempotency_key`/`client_invocation_id`/`client_interaction_id` 全部删除，统一用 `command_id` 作 durable operation id 兼幂等键，见下方 v4.0 delta。）
- 新增错误码 `409 ROUTE_INDEX_PENDING`（`retryable: true`）：`/invites/{code}` 在索引 outbox lag 窗口内返回此码而非 `404`。（v4.0：`/messages/{id}` 路由已移除，`ROUTE_INDEX_PENDING` 不再用于 message 操作——Browser message 操作始终 channel-scoped 直接路由 ChatChannel DO。）

**v4.0 追加 delta（channel-scoped message API + WS write path + command_id idempotency）：**

- Browser message locator 必须是 `{channel_id, message_id}`；不再提供 message-id-only mutation endpoint。
- 删除 `MessageIndex DO` / `message_index` 表 / message `ROUTE_INDEX_PENDING`。
- `message.edit`/`message.recall`/`message.delete` 改为 WS command（不再走 HTTP `PATCH/POST/DELETE /api/chat/messages/{message_id}`）；read-state 写入改为 WS command `channel.mark_read`（不再走 HTTP `POST /api/chat/channels/{channel_id}/read-state`）。
- `command_id` 是客户端生成的稳定业务操作 ID，必填于所有 mutating WS command，同时作 ack/error correlation 与 durable idempotency key（与 HTTP `Idempotency-Key` 同一语义层，内部归一为 `operation_id`）。
- 删除 Browser WS payload 中的 `client_message_id`/`client_mutation_id`/`client_invocation_id`/`client_interaction_id`；`commands.command_id` 改名 `commands.bot_command_id`，`invocations.command_id` 改名 `invocations.bot_command_id`。
- read-state 不写 channel timeline event、不写 `projection_outbox`；多 session 同步用 user-local `read_state_updated` WS frame（非 channel event）。详见 contract §20。

**v4.0 addendum 追加 delta（WS committed_ack returns canonical mutation payload）：**

- `committed_ack` 现携带 command-specific canonical result payload，不再是扁平 ID ack。
- `message.*` committed_ack `payload = { channel_id, event_id, message }`，`message` 为 mutation 后的完整 Browser-visible Message 投影（sender UserSummary、type、format、status、stream_state、text、reply_to、reply_snapshot、attachments、components、mentions、created/updated/edited/deleted/recalled）。
- `message.edit` ack：`payload.message.command_id` 保留原始 message.send 的 command id，`command_ack.command_id` 是本次 edit 操作 id（有意区分）。
- `message.recall`/`message.delete` ack：`payload.message` 安全投影，`text=null`、`attachments=[]`/`components=[]`/`mentions=[]`，不泄露原文/附件/components/mentions。
- `channel.mark_read` ack `payload = { channel_id, last_read_event_id, unread_count }`（无 `event_id`）。
- `message.*` event frame（`message.created`/`updated`/`recalled`/`deleted`）的 `payload.message` 与对应 ack **同形**（同一 `projectMessageForBrowser` builder）；recalled/deleted event 用安全投影。
- 后端有唯一 `projectMessageForBrowser(...)` builder，被历史分页 + message.* ack + message.* event + 消息上下文读共用；deleted/recalled 过滤集中在 builder 内；UserSummary 不持久化进 DO event payload，live 投影实时 resolve。
- 幂等 `idempotency_keys.response_json` 存**完整 committed ack payload**，重复重试原样返回。
- 前端 reducer 把 ack 与 event 视为按 `message_id` 的收敛 upsert（ack 先替换 pending，event 后收敛，不产生重复行）。

**v4.0 addendum 实现不变量（对应 patch Part 3 addendum N）：**

1. 每个 committed WS mutation ack 返回 command-specific 的 canonical result payload。
2. `message.*` committed ack payload 包含 `{ channel_id, event_id, message }`。
3. `payload.message` 是 mutation 后的 Browser-visible Message 投影。
4. `message.*` event payload 使用与 ack 相同的 Browser-visible Message 投影形状。
5. deleted/recalled 的 message 投影不得暴露原始 text、attachments、components、mentions。
6. `channel.mark_read` ack payload 包含 read-state，不包含 `event_id`。
7. 幂等缓存存完整 committed ack payload（不只 ID）。
8. ack 与 event reducer 必须是按 `message_id` / `event_id` 的幂等 upsert。

**v3.3 追加 delta（前端缺口收口）：**

- 新增 `POST /api/chat/channels/{channel_id}/dissolve`，owner-only，成功后写 `channel.dissolved` + `system.notice`，后续写入返回 `CHANNEL_DISSOLVED`。
- 新增 `system.notice` 事件，payload 用 `notice_kind` + 引用字段，前端负责文案。
- 不定义通用 `NOT_FOUND`；新增 `INVITE_NOT_FOUND`，并保留 `CHANNEL_NOT_FOUND`、`MESSAGE_NOT_FOUND`、`MEMBER_NOT_FOUND`。
- 群聊标签列为 Browser API v1 disabled 只读占位；免打扰列为 browser local-only non-server state。

权威 contract v2.2 已落本仓库 `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`（含 per-channel cursor + committed_ack + 幂等简化 + ROUTE_INDEX_PENDING（v4.0 仅 invite-code 路由保留）+ dissolve + system.notice + 资源级 not-found code + 风险登记 delta；v4.0 追加 channel-scoped message API + WS write path + command_id/operation_id 幂等；v4.1 追加 Phase E personal stickers + sticker save/send API 形状，详见下方 v4.1 delta）。前端开工前须按此 contract 接入，并与前端 `chatConnectionStore` 重构同步（`last_event_id` → per-channel map）。后端阶段 1/2 实现按 contract 形状，不实现原 2026-06-21 contract 的单全局 cursor 与 accepted-only ack。

**v4.1 追加 delta（Phase E personal stickers）：**

- Personal sticker library 归 `UserDirectory DO(user_id)`（新增 `personal_stickers` 表），不引入 `StickerRegistry DO`。
- `POST /api/chat/stickers` 请求体为 `{ channel_id, attachment_id }`，不携带 `message_id`；backend 路由 `UserDirectory(user_id)` → `ChatChannel(channel_id).resolveVisibleAttachment` 校验可见性 + 取 canonical projection。
- WS `message.send` 新增 `type="sticker"` + `sticker_id`；ChatChannel 先查 `message.send` 幂等（命中即返回缓存 ack，不解析 sticker），再 `UserDirectory(user_id).resolveSticker` → 写 `messages(type='sticker')` + `message_stickers` 快照 + `message.created` event + `projection_outbox(channel_fanout)`。
- `messages.type` 取值改为 `text | image | sticker | system`；新增 `message_stickers` 表（message_id PK + url/mime/dims 快照）。
- `projectMessageForBrowser` 支持 `type="sticker"`：`sticker={sticker_id, attachment_id, url, mime_type, width, height, size_bytes}`、`text=null`、`attachments=[]`、`format="plain"`；deleted/recalled → `sticker=null`。
- 幂等沿用 v4.0 `operation_id`：sticker save operation=`sticker.save`（归 `UserDirectory`）；sticker send operation=`message.send`（归 `ChatChannel`）。

**Phase E explicit non-goal：**

Phase E does not add `AttachmentDirectory DO`. Because save-sticker uses `{ channel_id, attachment_id }`, UserDirectory can route visibility validation to the source `ChatChannel DO(channel_id)`. A global attachment locator is unnecessary. If a future API accepts only `attachment_id` without `channel_id`, then a new global attachment index/DO must be designed. Do not implement attachment-id-only routing by scanning channels or by guessing from UUID.

**Phase E required invariants：**

```text
保存表情：UserDirectory(user_id) owns library; ChatChannel(channel_id) validates attachment visibility.
发送表情：ChatChannel(channel_id) owns message creation; UserDirectory(user_id) resolves sender sticker_id.
不新增 AttachmentDirectory：save request 必须带 channel_id + attachment_id。
```
