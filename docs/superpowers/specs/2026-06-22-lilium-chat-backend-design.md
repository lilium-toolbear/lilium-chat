# Lilium Chat 后端设计

状态：设计稿（v2，经平台能力核验与代码评审修订）
日期：2026-06-22
范围：lilium-chat 仓库（Cloudflare Worker + Durable Object 纯后端）的实现设计
参考：

- `dzmm_archive/docs/plans/2026-06-21-toolbear-chat-api-contract.md`（API contract，本设计 v2 有 cursor 形状偏离，见第 0.2 节）
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
6. **`/messages/{id}`、`/invites/{code}`、`/channels/directory` 路由无法定位 DO**。这些 URL 不含 `channel_id`，UUIDv7 `message_id` / `invite_code` 无法定位到对应 ChatChannel DO。→ v2 新增 `MessageIndex` / `InviteDirectory` / `ChannelDirectory` 全局索引 DO。
7. **KV 不是 correctness layer**。KV 是 eventually consistent（~60s），不适合做"与业务写必须原子"的幂等去重。→ v2 幂等落目标 DO 的 SQLite，与业务 mutation 同事务；KV 仅作响应缓存优化。
8. **Hyperdrive + pg 的真实调用形状**。是 `new Client({ connectionString: env.TOOLBEAR_DB.connectionString })` → `client.connect()` → `client.query(sql, [params])`，不是 v1 写的 `env.TOOLBEAR_DB.connect().execute({sql, args})`（那是 D1 形状）。
9. **bot 全局身份与 token 不应在 ChatChannel DO**。token 原文只返回一次、只存 hash，bot 是全局实体。→ v2 新增 `BotRegistry` DO。

**本设计在本对话中与产品方确认的偏离 contract 原文的决定（v1 既定，v2 保留）：**

A. **Profile 来源**：Worker 通过 Hyperdrive 直读 ToolBear 生产 Postgres 的 `users` 表（`full_name`/`avatar_url`），只读；不新建 `POST /api/profiles/resolve` Python 端点。
B. **Origin 关系**：ToolBear SPA（`lilium.kuma.homes`）跨域调用 `chat.kuma.homes`，lilium-chat 仓库纯后端。
C. **附件存储**：自建 SeaweedFS（`s3.kuma.homes`，S3 兼容），不用 R2。附件 public read，读请求不签名（产品方显式接受 private 频道附件也公开，见第 5.4 节 risk acceptance）。
D. **默认频道**：所有用户共享一个系统公共频道。
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

## 1. 架构总览

```
                          ┌──────────────────────────────────┐
  ToolBear SPA            │  Cloudflare Worker (thin)       │
  lilium.kuma.homes       │  chat.kuma.homes                │
  浏览器 JWT               │  Hono app, /api/chat/*          │
        │                 │  1. 自验 ToolBear JWT (HS256)     │
        │ HTTPS/CORS      │     JWT_SECRET = wrangler secret │
        │ WS + Origin chk │  2. 认证/Origin/路由,不存连接   │
        ▼                 │  3. upgrade 代理到 UserConn DO  │
  ┌────────────────────────────────────────────────────────────┐
  │  Durable Objects (SQLite-backed, 单 DO 内 ACID 事务)        │
  │                                                            │
  │  ChatChannel (by channel_id)   —— auth SoT, messages,       │
  │     per-channel events (单调 UUIDv7), channel-local 幂等    │
  │  UserDirectory (by user_id)    —— my_channels projection,   │
  │     read-state, pending upload projection (可修复)          │
  │  UserConnection (by user_id)  —— WS hibernation 接管,      │
  │     serializeAttachment(cursors), replay + 权限版本门禁      │
  │  ChannelDirectory             —— public_listed 目录索引     │
  │  MessageIndex (by message_id) —— message_id → channel_id   │
  │  InviteDirectory (by code)    —— invite_code → channel_id  │
  │  BotRegistry (by bot_id)      —— bot 身份/token_hash/callback│
  └────────────────────────────────────────────────────────────┘
        │ 不出 DO 读 profile
        ▼
  ┌─────────────────────────────┐    ┌──────────────────────┐
  │ Hyperdrive → ToolBear       │    │ SeaweedFS             │
  │ 生产 Postgres, users 表     │    │ s3.kuma.homes         │
  │ (full_name / avatar_url)    │    │ 浏览器直传 presign PUT │
  │ 只读, pg Client             │    │ public read, 不签名   │
  └─────────────────────────────┘    └──────────────────────┘
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

| 路径 | 落到哪 |
|---|---|
| `GET /api/chat/bootstrap` | UserDirectory DO + 系统公共频道 lazy 加入 + 按频道列表查 ChatChannel DO |
| `GET/POST/PATCH/DELETE /api/chat/channels/**`、`/members/**`、`/uploads/**` | 对应 ChatChannel DO（`/uploads/**` 主落 UserDirectory pending + presign 由 Worker 签） |
| `GET /api/chat/channels/{channel_id}/messages` | ChatChannel DO（URL 含 channel_id，直接定位） |
| `PATCH/POST/DELETE /api/chat/messages/{message_id}`、`/recall` | 先查 MessageIndex DO → channel_id → ChatChannel DO |
| `POST /api/chat/channels/{channel_id}/invites` | ChatChannel DO |
| `POST /api/chat/invites/{invite_code}/accept` | 先查 InviteDirectory DO → channel_id → ChatChannel DO |
| `GET /api/chat/channels/directory` | ChannelDirectory DO |
| `GET /api/chat/events` | UserDirectory 拿 channel 列表 → 并行查各 ChatChannel DO 事件 → 归并（per-channel cursor） |
| `WS /api/chat/ws` | upgrade 代理到 UserConnection DO（by user_id），hibernation |

## 2. Durable Object 内部表结构

贯穿全局约定：

- **存储后端**：DO SQLite，单 DO 内 `state.storage.transaction()` 是 ACID。
- **ID**：实体 ID 用 UUIDv7 字符串。event_id 用 per-channel 单调 UUIDv7。
- **时间**：ISO 8601 UTC 字符串（`TEXT`）。
- **软删除/审计**：deleted/recalled 只改 `status` + 时间戳，不清空原文。普通查询按 `status` 过滤投影。
- **跨 DO**：无跨 DO 事务；source-of-truth + projection + repair（见第 2.3 节）。

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
  client_message_id TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  sender_kind       TEXT NOT NULL,           -- user | bot
  sender_user_id    TEXT,
  sender_bot_id     TEXT,
  type              TEXT NOT NULL,           -- text | image | system
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
  UNIQUE (channel_id, client_message_id)
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
  actor_user_id   TEXT NOT NULL,
  action          TEXT NOT NULL,             -- message.delete | message.recall | member.role_update | channel.archive | ...
  target_type     TEXT NOT NULL,             -- message | member | channel | invite | bot
  target_id       TEXT NOT NULL,
  before_json     TEXT,
  after_json      TEXT,
  reason          TEXT,
  request_id      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, created_at);

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
  command_id    TEXT PRIMARY KEY,
  bot_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  options_json  TEXT NOT NULL,
  default_perm  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL,
  UNIQUE (bot_id, name)
);

CREATE TABLE invocations (
  invocation_id         TEXT PRIMARY KEY,
  command_id            TEXT NOT NULL,
  bot_id                TEXT NOT NULL,
  invoker_user_id       TEXT NOT NULL,
  client_invocation_id  TEXT NOT NULL,
  options_json          TEXT NOT NULL,
  status                TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  completed_at          TEXT,
  error_code            TEXT,
  UNIQUE (command_id, client_invocation_id)
);

CREATE TABLE interactions (
  interaction_id        TEXT PRIMARY KEY,
  message_id            TEXT NOT NULL,
  component_id          TEXT NOT NULL,
  custom_id             TEXT NOT NULL,
  actor_user_id         TEXT NOT NULL,
  client_interaction_id TEXT NOT NULL,
  value_json            TEXT NOT NULL,
  status                TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE (message_id, client_interaction_id)
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
  actor_user_id TEXT,
  payload_json TEXT NOT NULL,              -- 创建时投影;replay 时仍需 join messages.status
  occurred_at  TEXT NOT NULL
);
CREATE INDEX idx_events_after ON events(event_id);

-- per-channel 单调 UUIDv7 生成器状态
CREATE TABLE event_seq (
  last_ms   INTEGER NOT NULL,
  counter   INTEGER NOT NULL
);

-- 频道内 command 幂等(与业务写同事务)
CREATE TABLE command_idempotency (
  channel_id        TEXT NOT NULL,
  command_id        TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  result_event_ids  TEXT NOT NULL,          -- JSON array
  created_at        TEXT NOT NULL,
  PRIMARY KEY (channel_id, command_id)
);

-- 频道内消息发送幂等也由 messages.client_message_id UNIQUE 兜底
```

### 2.2 UserDirectory DO（by user_id）

my_channels projection（可修复，非 auth SoT）+ read-state + pending upload projection。

```sql
CREATE TABLE my_channels (
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  joined_at  TEXT NOT NULL,
  membership_version INTEGER NOT NULL,      -- 对应 ChatChannel.membership_version 快照
  last_read_event_id TEXT,                  -- per-channel cursor,唯一存 last_read 处
  PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX idx_my_channels ON my_channels(user_id);

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
  status          TEXT NOT NULL,           -- pending | finalized
  created_at      TEXT NOT NULL
);
```

`last_read_event_id` 唯一存于 `my_channels`，mark-read 单写 UserDirectory，不碰 channel DO。write floor：要求该 `(user_id, channel_id)` 行存在且 active（非 left）；cursor 单调前进（新值 > 旧值才接受）。unread 实时算（去 ChatChannel DO 查 `event_id > last_read_event_id` 且非自己发的条数）。

### 2.3 跨 DO 一致性：source-of-truth + projection + repair

ChatChannel.members 是权限 source-of-truth；UserDirectory.my_channels 是可修复 projection。join/leave：

1. ChatChannel DO 内单事务写 `members` + `member.joined/left` event + `audit_logs` + 递增 `channel_meta.membership_version`。
2. Worker 同步或异步幂等更新 UserDirectory.my_channels（写 projection 行 + membership_version 快照）。
3. 失败不回滚 channel 权限事实：retry / repair。
4. bootstrap 和 WS 建连若发现 UserDirectory 与 ChatChannel.membership_version 不一致，按 ChatChannel SoT 修复（补成员、删已 left 的行）。

附件发送的跨 DO 读（Worker 先从 UserDirectory 取 pending metadata 再进 channel DO 事务）不是跨 DO 写：Worker 作协调者串行调用，channel DO 事务内校验 `attachment.owner == sender && status == finalized`，写 message_attachments + attachment 业务副本（含 url）落 channel DO。pending 行标记 transferred。

### 2.4 全局索引 DO

无跨 DO 事务，但索引 DO 在对应业务事件后由 Worker 幂等更新：

- **MessageIndex DO（by message_id）**：`message_id → {channel_id, created_at}`。message.created 后由 Worker 写入。`/messages/{id}` 路由先查此 DO。幂等：重复写覆盖。
- **InviteDirectory DO（by invite_code）**：`invite_code → {channel_id, status, expires_at, revoked_at}`。invite 创建后写入，撤销/过期更新。`/invites/{code}/accept` 先查此 DO。
- **ChannelDirectory DO**：`public_listed` 且 `status=active` 的 channel summaries（title, member_count, last_message_at）。channel create/update/archive/dissolve 事件后由 Worker 更新。directory/search 查此 DO。
- **BotRegistry DO（by bot_id）**：bot profile(`display_name`/`avatar_url`/`callback_url`)、`token_hash`、scopes、status。token 原文只返回一次，只存 hash。callback HMAC secret 与 token 分开管理。

## 3. 写流程、事件广播与 cursor

### 3.1 WebSocket 帧处理总流程

```
浏览器            Worker(薄)        UserConnection DO      ChatChannel DO
   │                │                    │                       │
   │─ WS connect ─▶│ 验 subprotocol JWT  │                       │
   │                │ Origin 校验        │                       │
   │                │── upgrade 代理 ───▶│ acceptWebSocket(ws)    │
   │                │                    │ serializeAttachment     │
   │                │                    │  ({user_id, session_id,│
   │                │                    │   per_channel_cursors})│
   │                │                    │ 读 UserDirectory 拿    │
   │                │                    │ my_channels,订阅各频道  │
   │                │                    │ (per-channel cursor)   │
   │                │                    │                       │
   │─ command ────▶│ 路由: message_id?  │                       │
   │                │  MessageIndex→ch   │                       │
   │                │  channel_id? 直达  │                       │
   │                │── do fetch ──────────────────────────────▶│ 单事务:
   │                │                    │                       │  权限/幂等/
   │                │                    │                       │  写消息+event
   │                │                    │                       │  (单调 UUIDv7)
   │                │◀──────────── event(s) ─────────────────────│
   │◀─ command_ack ─│                    │                       │
   │                │                    │ 把 event frame 投给该 │
   │◀─ event frame ─────────────────────│ 频道在线订阅者(含自己) │
   │                │                    │ (UserConnection DO 内) │
```

`command_ack` 与 event 是两帧：ack 只表示协议校验通过、Worker/DO 已接收；最终状态以 event frame 为准（contract 10.2）。

### 3.2 UserConnection DO + Hibernate

- Worker 只验 JWT + Origin，然后 `upgrade` 代理到 `UserConnection` DO（`idFromName(user_id)` 定位，保证同用户单 DO）。
- UserConnection DO：`ctx.acceptWebSocket(ws, [user_id])`，`ws.serializeAttachment({user_id, session_id, per_channel_cursors})`。
- **Hibernation**：DO 可被逐出内存但 WS 保持；事件到达时 DO 重建（constructor 跑），`serializeAttachment` 恢复 cursor。
- **生命周期 handler**：`webSocketMessage(ws, msg)` 处理 command；`webSocketClose`/`webSocketError` 清理。
- 广播：ChatChannel DO 产生 event 后，`fetch` 通知各成员的 UserConnection DO 投递（或 ChatChannel DO 维护"该频道有哪些在线 user_id"，通过 UserConnection DO 的 RPC `deliver(event)` 发送）。事件投递走 DO→DO `fetch`/RPC，不经过 Worker 内存全局表。

### 3.3 隐式订阅 + 权限版本门禁

- WS 建连（在 UserConnection DO）后读 UserDirectory.my_channels，全部订阅。
- 订阅时记录 `membership_version`（来自 ChatChannel 当前版本）。
- **member.left 后主动撤销**：ChatChannel leave 事务后，通知该用户的 UserConnection DO 取消该频道订阅；或投递前 UserConnection DO 重新查 target channel 的 `membership_version` > 订阅版本则拒绝投递并 repair。两者择一，v2 默认前者（事件驱动 unsubscribe）+ 后者兜底。

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

**contract 偏离（v2）：** 原 contract 用单全局 `last_event_id`/`since_event_id`/`after_event_id`。v2 改 per-channel cursor。

- **bootstrap**：每个 `channels[]` 项带 `last_event_id`（该频道最后 event 的 per-channel 单调 UUIDv7）；顶层不再有单 `last_event_id`。`event_state` 改为 `per_channel: { channel_id: last_event_id }`。
- **WS 建连**：`?cursors=<base64(JSON {channel_id: since_event_id})>` 或建连后第一条 message 携带 per-channel `since_event_id` map。回放按 per-channel 走。
- **`GET /api/chat/events`**：`?channel_id=&after_event_id=` 单频道，或 `?cursors=<b64 map>` 取用户所有频道（UserDirectory 拿列表 → 并行查各 channel DO → 归并）。
- **replay 投影过滤（修 #4）**：`message.created` replay 时 join `messages.status`：若当前 `deleted`/`recalled`，不返回 created event（只会在其生命周期 event 处返回 tombstone）。`message.deleted`/`message.recalled` replay 只返回 `{message_id, channel_id, status, 操作时间, 操作者摘要}`，不含原 text/attachments/components/mentions。实时广播可用创建时投影（内容当时是当前的）；replay 不能直接扫 payload。

### 3.6 幂等（in-DO，与业务写同事务）

- **HTTP mutation**：`Idempotency-Key` 记录落目标 DO 的 SQLite（按 endpoint 路由到的 DO），与业务 mutation 同事务。命中且 request_hash 一致 → 返回缓存结果；不一致 → `IDEMPOTENCY_CONFLICT`。KV 仅作响应缓存优化，不是 correctness gate。
- **WebSocket command**：command frame `idempotency_key` 落 ChatChannel DO 的 `command_idempotency` 表，与业务写同事务。`client_message_id`（消息业务幂等）落 `messages.client_message_id` UNIQUE。

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
    const client = new Client({ connectionString: env.TOOLBEAR_DB.connectionString });
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

Worker：验 JWT → 校验 mime_type ∈ {png,jpeg,webp,gif} + size ≤ 20 MiB → 生成 attachment_id（UUIDv7）+ storage_key → aws4fetch 签 5 分钟 presigned PUT（约束 Content-Type=size_bytes）→ 写 UserDirectory pending_attachments（status=pending）+ **设 DO alarm 1h 后 GC** → 返回 `{attachment_id, upload_url, upload_method:"PUT", upload_headers, expires_at}`。

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

### 5.5 GC：DO alarm（不扫所有 DO）

pending 超过 1h 未 finalize → 该 UserDirectory DO 的 alarm 触发（alarm 会唤醒 hibernated DO）→ DELETE SeaweedFS object（SigV4）+ 删 pending 行。无"列出所有 DO 实例"需求，每个 presign 自带自己的 alarm。

### 5.6 发送图片消息

finalize 拿到 attachment_id 后，前端发 WS command `{message.send, type:image, attachment_ids}`。Worker 从 UserDirectory 预取 metadata → ChatChannel DO 事务校验 `owner==sender && status==finalized` → 写 message + message_attachments + attachment 副本 + `message.created` event → 广播。

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
name = "MESSAGE_INDEX"
class_name = "MessageIndex"
[[durable_objects.bindings]]
name = "INVITE_DIRECTORY"
class_name = "InviteDirectory"
[[durable_objects.bindings]]
name = "BOT_REGISTRY"
class_name = "BotRegistry"

[[hyperdrive.config]]
name = "TOOLBEAR_DB"
connection_string = "<wrangler secret: HYPERDRIVE_CONN>"

# 不用 Cron 扫 DO;GC 走 DO alarm。如需 rate-limit 可加 [triggers]。

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatChannel", "UserDirectory", "UserConnection", "ChannelDirectory", "MessageIndex", "InviteDirectory", "BotRegistry"]

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

### 6.5 本地开发

`wrangler dev`：DO SQLite 本地，Hyperdrive 指本地 PG，S3 指 MinIO 或 `s3.kuma.homes`，`JWT_SECRET` 用 dev 值。前端 dev 指向 `http://localhost:8787`。

### 6.6 部署

`wrangler deploy`（包 `scripts/deploy.mjs`：typecheck + deploy + sentry source map）。secrets 用 `wrangler secret put`。

### 6.7 限流（补 PRD 20.3）

DO 内业务语义限流兜底（不限平台层）：

- per-user 消息发送率（UserDirectory 或 ChatChannel 内 token bucket）。
- per-channel 消息发送率。
- per-user upload presign/finalize 率。
- per-IP WS connect 率（Worker 层）。
- per-channel command/bot callback 率。
- admin mutation 率。

限流状态放 DO storage 或 Cloudflare Rate Limiting/WAF；业务语义限流在 DO 内兜底。

### 6.8 可观测性指标（补 PRD 21.2）

WS 连接数、WS 重连率、message send p50/p95/p99、event replay lag、DO 错误、attachment finalize 失败、bot callback 失败、rate limit 命中、outbox backlog（如有）。写入 Sentry / Workers Analytics。

## 7. 测试策略

`@cloudflare/vitest-pool-workers` + vitest，miniflare 跑真实 DO，非 mock。

### 7.1 测试分层

**单元：纯函数**
- `verifyBrowserJwt`：self-session 正例 + 各拒例。
- `nextEventId`：同毫秒递增、跨毫秒归零、跨次单调。
- 错误 envelope、cursor 编解码、SigV4 签名结构。

**DO 内逻辑（miniflare 真实 DO）**
- 成员/权限、消息生命周期（deleted/recalled 不出历史分页、replay 投影过滤）、幂等（in-DO）、事件顺序（同频道单调）、read-state（floor + 单调）、附件、bot command 冲突与 invocation、member.left 后订阅撤销。
- 跨 DO projection repair：ChatChannel.members 与 UserDirectory.my_channels 不一致时 bootstrap/subscribe 修复。

**全局索引 DO**
- MessageIndex 路由 `/messages/{id}`、InviteDirectory 路由 `/invites/{code}`、ChannelDirectory 目录查询、BotRegistry token_hash 校验。

**HTTP 端到端**：fetch 打 Hono app，覆盖契约端点 + 错误码。

**WebSocket 端到端**：subprotocol 握手、command_ack→event、隐式订阅、per-channel cursor 回放、hibernation wake 后重连不丢事件。

### 7.2 profile resolve 测试

fake Hyperdrive stub 单元 + 标 `@skip` 的真 PG 集成（CI 跳过）。验分批不截断、字段映射、missing user 不显示裸 user_id。

### 7.3 平台 spike（新增，阶段 0 必跑）

- DO WebSocket hibernation：连接→休眠→恢复→`serializeAttachment` 恢复 cursor。
- DO lifecycle/redeploy 后客户端 reconnect + per-channel replay 不丢事件。
- Hyperdrive + pg 直连 ToolBear 只读库。
- SeaweedFS presigned PUT + HEAD finalize。
- KV 不作 correctness layer 的并发测试（证明双写不产生重复业务数据）。
- replay after delete：旧 `message.created` 不重放原文/附件/components/mentions。
- message_id 路由（MessageIndex）、invite_code 路由（InviteDirectory）。

### 7.4 不测什么

Cloudflare 平台本身、ToolBear JWT 签发、前端。

### 7.5 CI

GitHub Actions：`typecheck` + `test`，scripts 跟 game-worker 一致。

## 8. 阶段切分

对照 contract 第 12 节，落到 lilium-chat repo。

### 阶段 0：骨架 + 平台 spike + 全局索引空壳

交付：Hono app + wrangler + 7 个 DO 类壳 + JWT 自验 + Hyperdrive pg resolve + 部署 chat.kuma.homes + **平台 spike 全部跑通**（hibernation、Hyperdrive、SeaweedFS、replay-after-delete、message_id/invite_code 路由、KV 非 correctness）。

- `GET /bootstrap` 返回 me + 空 channels + per-channel cursor 字段 + `active_channel=null`。
- machine/managed 拒绝。
- CORS + WS Origin。
- MessageIndex/InviteDirectory/ChannelDirectory/BotRegistry 作为空壳 DO 先建（为后续路由定位打底）。

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

### 阶段 3：频道与成员管理 + read-state（contract 12.4）

交付：频道 CRUD + members + read-state + 2PC→saga projection repair。

- channels/members 增删改 + `membership_version` + member.left 主动撤销订阅。
- read-state floor（my_channels active row）+ cursor 单调。
- unread 计算。
- in-DO HTTP 幂等。

验收：contract 12.4。

### 阶段 4：消息生命周期（contract 12.5）

交付：回复（reply_snapshot_json）+ 编辑（message_edits + audit_logs）+ 撤回 + admin 删除。

- `message.updated`/`message.recalled`/`message.deleted` event。
- deleted/recalled 原文保留审计，投影/replay 不含原文（join messages.status 过滤）。
- MessageIndex 路由 `/messages/{id}`。

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

v2 的 per-channel cursor 改动需同步落到前端状态模型（`chatConnectionStore` 的 `last_event_id` 变 per-channel map）。这是 contract API 形状修订，需前端配合。
