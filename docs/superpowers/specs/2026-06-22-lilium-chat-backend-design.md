# Lilium Chat 后端设计

状态：设计稿
日期：2026-06-22
范围：lilium-chat 仓库（Cloudflare Worker + Durable Object 纯后端）的实现设计
参考：

- `dzmm_archive/docs/plans/2026-06-21-toolbear-chat-api-contract.md`（API contract，权威）
- `dzmm_archive/docs/plans/2026-06-20-lilium-chat-product-requirements.md`（PRD）
- `dzmm_archive/docs/plans/2026-06-20-lilium-chat-technical-architecture.md`（技术架构）
- `dzmm_archive/game-worker/`（既有 Cloudflare Worker 参考实现）
- `dzmm_archive/toolbear_ui/auth_utils.py`（ToolBear JWT 验证规则）

## 0. 设计基线

本设计以 2026-06-21 API contract 为权威 API 形状契约。该 contract 相对 2026-06-20 的两份旧文档是一次技术栈重定向：

- 旧文档：Rust（lilium-ng）、Gateway + Worker via Unix socket、PostgreSQL、SeaweedFS。
- 新 contract：Cloudflare Worker + Durable Object，Worker 直接验证 ToolBear JWT。

本设计遵循新 contract，不复刻旧 Rust/Unix-socket 架构。

本设计在本对话中与产品方确认的四项偏离 contract 原文的决定：

1. **Profile 来源**：不新建 `POST /api/profiles/resolve` Python 端点，Worker 通过 Hyperdrive 直读 ToolBear 生产 Postgres 的 `users` 表（`full_name`/`avatar_url`），只读。
2. **Origin 关系**：ToolBear SPA（`lilium.kuma.homes`）跨域调用 `chat.kuma.homes`，lilium-chat 仓库纯后端。
3. **附件存储**：使用自建 SeaweedFS（`s3.kuma.homes`，S3 兼容），不用 Cloudflare R2。附件 public read，读请求不签名。
4. **默认频道**：所有用户共享一个系统公共频道（非每用户私人频道）。

本设计在本对话中确认的技术选择：

5. **event_id**：使用单调 UUIDv7（per-DO 计数器版），不用单例 event 序列器 DO，也不用 Flake/Snowflake。
6. **跨 DO 一致性**：成员加入/离开使用 Cloudflare DO multi-DO transaction（2PC），不靠对账 job。
7. **HTTP 幂等**：用 Cloudflare KV 存 `Idempotency-Key` 结果。
8. **WS 订阅**：隐式订阅——建连后按 UserDirectory 自动订阅全部频道，无显式 `subscribe.channel` 帧。
9. **JWT 库**：`jose`（HS256 验签 + 后续 bot callback HMAC 签名统一）。
10. **邀请码**：明文存储，不 hash。
11. **read-state**：不校验成员关系，只更新游标；存 UserDirectory，不存 ChatChannel。
12. **CORS origin**：白名单 `lilium.kuma.homes` + localhost 写死。

## 1. 架构总览

```
                          ┌─────────────────────────────┐
  ToolBear SPA            │  Cloudflare Worker          │
  lilium.kuma.homes       │  chat.kuma.homes            │
  ─────────────           │  Hono app, /api/chat/*      │
  浏览器 JWT               │                             │
        │                 │  1. 自验 ToolBear JWT (HS256) │
        │ HTTPS/CORS      │     JWT_SECRET = wrangler   │
        │ WS + Origin chk │     secret, 同 game-worker   │
        ▼                 │  2. 路由到 DO               │
  ┌─────────────────────────────────────────────────────────┐
  │  Durable Objects (SQLite-backed, 按实体分片)             │
  │                                                         │
  │   ChatChannel DO          UserDirectory DO              │
  │   (by channel_id)         (by user_id)                  │
  │   ─ channel/member/msg    ─ 我加入的 channel 列表        │
  │   ─ read-state(无)        ─ 每频道 last_read_event      │
  │   ─ bot install / cmd     ─ 每频道 unread_count(算)     │
  │   ─ 该频道 event log      ─ pending_attachments          │
  │   ─ 单调 UUIDv7 生成器    ─ 无 event log                 │
  └─────────────────────────────────────────────────────────┘
        │ 不出 DO 读 profile
        ▼
  ┌─────────────────────────────┐    ┌──────────────────────┐
  │ Hyperdrive → ToolBear       │    │ SeaweedFS             │
  │ 生产 Postgres, users 表     │    │ s3.kuma.homes         │
  │ (full_name / avatar_url)    │    │ 浏览器直传 presign PUT │
  │ 只读                        │    │ public read, 不签名   │
  └─────────────────────────────┘    └──────────────────────┘
```

### 1.1 核心边界

1. **lilium-chat 仓库纯后端**：Worker + DO + wrangler 配置。前端留在 `dzmm_archive/toolbear_ui/frontend`。
2. **认证**：Worker 直接验 ToolBear browser JWT（HS256，`JWT_SECRET`）。machine token / delegated / managed session 拒绝。browser self-session 加密可验，不碰 PostgreSQL 做鉴权。
3. **Profile**：Hyperdrive 直读 `users` 表，只读 `full_name`/`avatar_url`，隔离在 `resolveUserSummaries()` 一个函数。DO 不持久化 display_name/avatar（contract 第 1 节硬约束）。
4. **附件**：SeaweedFS（`s3.kuma.homes`）+ presigned PUT，浏览器直传，Worker 不收二进制。public read，不签 GET。
5. **实时**：WS subprotocol `lilium.chat.v1` + `bearer.<jwt>`，不设 Authorization header（contract 2.1）。command/event 同一条 WS（contract 2.7）。event_id = 单调 UUIDv7，客户端单游标。
6. **ID**：channel/message/attachment/event 等全部 UUIDv7（普通版）；event_id 用单调 UUIDv7（per-DO 计数器版，保同频道顺序）。

### 1.2 请求路由分流

| 路径 | 落到哪 |
|---|---|
| `GET /api/chat/bootstrap` | UserDirectory DO + 系统公共频道 lazy 加入 + 按频道列表查 ChatChannel DO |
| `GET/POST/PATCH/DELETE /api/chat/channels/**`、`/messages/**`、`/members/**`、`/uploads/**`、`/invites/**` | 对应 ChatChannel DO |
| `GET /api/chat/events` | UserDirectory 拿 channel 列表 → 并行查各 ChatChannel DO 事件 → 归并 |
| `WS /api/chat/ws` | 单条连接，Worker 维护订阅；事件由各 channel DO 推 |

### 1.3 Bootstrap 读路径

只读 UserDirectory DO 一次拿到频道列表；频道列表项里的 `last_message_preview`/`last_message_at` 不冗余存 UserDirectory，bootstrap 时按频道列表查对应 ChatChannel DO 取。`active_channel` 的完整 messages 列表额外读那一个 ChatChannel DO。unread 实时算（该频道 events 里 `event_id > last_read_event_id` 且非自己发的条数）。本设计明确接受 bootstrap 查多 DO，换取写路径零跨 DO。

## 2. Durable Object 内部表结构

贯穿全局约定：

- **存储后端**：DO SQLite，事务是真正 ACID，业务数据和事件同事务写入。
- **ID**：所有实体 ID 用普通 UUIDv7 字符串（`01J...`）。event_id 单独用单调 UUIDv7（per-DO 计数器版）。
- **时间**：存为 ISO 8601 UTC 字符串（`TEXT`），与 contract 2.3 对齐。
- **软删除/审计**：deleted/recalled 只改 `status` + 时间戳，不清空原文（contract 3.4、架构 18.2）。普通查询按 `status` 过滤投影。

### 2.1 ChatChannel DO（by channel_id）

一个 DO 实例 = 一个频道的全部状态 + 该频道的事件日志。

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
  created_by      TEXT NOT NULL,          -- user_id
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  member_count    INTEGER NOT NULL DEFAULT 0   -- 冗余计数,省 COUNT(*)
);

-- 成员关系
CREATE TABLE members (
  channel_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL,              -- owner | admin | member
  joined_at   TEXT NOT NULL,
  left_at     TEXT,                       -- 非空 = 已离开(保留历史,active 成员 left_at IS NULL)
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_members_active ON members(user_id) WHERE left_at IS NULL;

-- 消息(原文 + 生命周期)
CREATE TABLE messages (
  message_id        TEXT PRIMARY KEY,        -- UUIDv7
  client_message_id TEXT NOT NULL,           -- 前端给的幂等键
  channel_id        TEXT NOT NULL,
  sender_kind       TEXT NOT NULL,           -- user | bot
  sender_user_id    TEXT,                    -- kind=user 时
  sender_bot_id     TEXT,                    -- kind=bot 时
  type              TEXT NOT NULL,           -- text | image | system
  format            TEXT NOT NULL DEFAULT 'plain',  -- plain | markdown (markdown 仅 bot)
  status            TEXT NOT NULL DEFAULT 'normal', -- normal | edited | deleted | recalled
  text              TEXT,                    -- 原文,deleted/recalled 不清空
  reply_to          TEXT,                    -- message_id
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  edited_at         TEXT,
  deleted_at        TEXT,
  deleted_by        TEXT,                    -- user_id (admin 删除)
  recalled_at       TEXT,
  stream_state      TEXT NOT NULL DEFAULT 'none',  -- none | streaming | final (bot 流式)
  UNIQUE (channel_id, client_message_id)   -- 幂等:同客户端消息 id 不重复建
);
CREATE INDEX idx_messages_history ON messages(channel_id, message_id DESC);

-- 附件元数据(二进制在 SeaweedFS,这里只存归属 + 尺寸 + url)
CREATE TABLE attachments (
  attachment_id   TEXT PRIMARY KEY,        -- UUIDv7
  owner_user_id   TEXT NOT NULL,           -- 上传者,finalize 时校验归属
  kind            TEXT NOT NULL,           -- image (第一版只有 image)
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  storage_key     TEXT NOT NULL,           -- SeaweedFS key,不暴露给前端
  url             TEXT NOT NULL,           -- public read URL,长期有效,存 DO
  status          TEXT NOT NULL,           -- pending | finalized | transferred
  created_at      TEXT NOT NULL
);

-- 消息-附件关联(一条消息多个附件)
CREATE TABLE message_attachments (
  message_id    TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  PRIMARY KEY (message_id, attachment_id)
);

-- mentions
CREATE TABLE mentions (
  message_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  start       INTEGER NOT NULL,            -- JS string index
  end_        INTEGER NOT NULL,            -- end 是 SQL 保留字
  PRIMARY KEY (message_id, user_id)
);

-- bot app(该频道安装的 bot,第一版预留)
CREATE TABLE bot_apps (
  bot_id         TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  avatar_url     TEXT,
  callback_url   TEXT NOT NULL,
  status         TEXT NOT NULL,             -- active | disabled
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- bot 安装(该频道装了哪些 bot)
CREATE TABLE bot_installations (
  bot_id         TEXT NOT NULL,
  installed_by   TEXT NOT NULL,
  scopes         TEXT NOT NULL,            -- JSON array
  installed_at   TEXT NOT NULL,
  PRIMARY KEY (bot_id)
);

-- slash command 注册(每个已安装 bot 的命令)
CREATE TABLE commands (
  command_id    TEXT PRIMARY KEY,
  bot_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  options_json  TEXT NOT NULL,
  default_perm  TEXT NOT NULL,             -- owner | admin | member
  enabled       INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL,
  UNIQUE (bot_id, name)
);

-- command invocation 状态
CREATE TABLE invocations (
  invocation_id         TEXT PRIMARY KEY,
  command_id            TEXT NOT NULL,
  bot_id                TEXT NOT NULL,
  invoker_user_id       TEXT NOT NULL,
  client_invocation_id  TEXT NOT NULL,
  options_json          TEXT NOT NULL,
  status                TEXT NOT NULL,     -- pending | completed | failed
  created_at            TEXT NOT NULL,
  completed_at          TEXT,
  error_code            TEXT,
  UNIQUE (command_id, client_invocation_id)  -- 幂等
);

-- rich UI interaction 状态
CREATE TABLE interactions (
  interaction_id        TEXT PRIMARY KEY,
  message_id            TEXT NOT NULL,
  component_id          TEXT NOT NULL,
  custom_id             TEXT NOT NULL,
  actor_user_id         TEXT NOT NULL,
  client_interaction_id TEXT NOT NULL,
  value_json            TEXT NOT NULL,
  status                TEXT NOT NULL,     -- pending | completed | failed
  created_at            TEXT NOT NULL,
  UNIQUE (message_id, client_interaction_id)  -- 幂等
);

-- 邀请码(明文存储,不 hash)
CREATE TABLE invites (
  invite_code  TEXT PRIMARY KEY,        -- 明文,直接索引查
  created_by   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  max_uses     INTEGER,                 -- NULL = 无限
  used_count   INTEGER NOT NULL DEFAULT 0,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);

-- 该频道的事件日志(单调 UUIDv7)
CREATE TABLE events (
  event_id     TEXT PRIMARY KEY,           -- 单调 UUIDv7
  event_type   TEXT NOT NULL,              -- message.created 等
  channel_id   TEXT NOT NULL,              -- 冗余,回放投影用
  actor_user_id TEXT,
  payload_json TEXT NOT NULL,              -- 完整可见投影,落库即最终形态
  occurred_at  TEXT NOT NULL
);
CREATE INDEX idx_events_after ON events(event_id);  -- since_event_id 范围扫描

-- 单调 UUIDv7 生成器状态(per-DO 计数器)
CREATE TABLE event_seq (
  last_ms   INTEGER NOT NULL,              -- 上次时间戳(毫秒)
  counter   INTEGER NOT NULL               -- 同毫秒内计数
);
```

事件 payload 存的是完整可见投影（contract 10.3 要求 replay 返回可见投影，deleted/recalled 不带原文）。`message.created` payload 直接存 Message 全字段 JSON，`message.deleted` 只存 `{message_id, status, deleted_at, deleted_by_summary}`。事件落库时即最终形态，广播和回放直接取，不二次组装。

### 2.2 UserDirectory DO（by user_id）

极薄。只存"我加入了哪些频道 + 每频道已读游标 + pending 附件"。不存 event log，不存 last_message_preview。

```sql
CREATE TABLE my_channels (
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind       TEXT NOT NULL,                -- channel | dm
  joined_at  TEXT NOT NULL,
  last_read_event_id TEXT,                 -- 单调 UUIDv7,唯一存 last_read 处
  PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX idx_my_channels ON my_channels(user_id);

-- pending 附件(presign 时还没绑频道,放这里)
CREATE TABLE pending_attachments (
  attachment_id   TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL,
  kind            TEXT NOT NULL,           -- image
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  storage_key     TEXT NOT NULL,
  url             TEXT NOT NULL,           -- public read URL
  status          TEXT NOT NULL,           -- pending | finalized
  created_at      TEXT NOT NULL
);
```

`unread_count` 不存，bootstrap 时实时算：对该频道去 ChatChannel DO 查 `event_id > last_read_event_id` 且非自己发的条数。`last_read_event_id` 唯一存于 `my_channels`，mark-read 单写 UserDirectory，不碰 channel DO，不校验成员。

### 2.3 跨 DO 一致性

DO 之间无跨实例事务，唯一跨 DO 写场景是成员加入/离开（ChatChannel.members + UserDirectory.my_channels），使用 Cloudflare DO multi-DO transaction（2PC），两阶段提交，要么都成功要么都回滚：

```js
await env.CHAT_CHANNEL_STUB.transaction(async (tx) => {
  await tx.get(channelDOStub).addMember(...);
  await tx.get(userDirStub).addChannel(...);
});
```

`member.joined` 事件在 channel DO 侧、事务提交后广播。2PC 失败 → 整个加入回滚，前端收到 `command_error`，可重试。

附件发送的跨 DO 读（Worker 先从 UserDirectory 取 pending metadata 再进 channel DO 事务）不是跨 DO 写，不需 2PC：Worker 作为协调者串行调用，channel DO 事务内校验 `attachment.owner == sender && status == finalized`，写 `message_attachments` 关联 + attachment 业务副本（含 url）落 channel DO。pending 表那行标记 transferred 或保留作 GC。

## 3. 写流程与事件广播

### 3.1 WebSocket 帧处理总流程

```
浏览器                          Worker                    ChatChannel DO
   │                              │                            │
   │── WS connect ───────────────▶│ 验 subprotocol JWT          │
   │                              │ 注册连接(user→conn 映射)    │
   │                              │ 隐式订阅 my_channels        │
   │                              │                            │
   │── command frame ────────────▶│ 解析 command                │
   │   {command_id, idempotency,  │ 协议校验(字段/类型)         │
   │    command, channel_id,      │                            │
   │    payload}                  │ 定位 channel_id → DO        │
   │                              │── DO.transaction(write)───▶│
   │                              │                            │ DO 内 SQLite 事务:
   │                              │                            │  1. 权限校验(member/role)
   │                              │                            │  2. 幂等查 idempotency
   │                              │                            │  3. 写业务数据
   │                              │                            │  4. 发单调 UUIDv7 event_id
   │                              │                            │  5. 写 events 表
   │                              │                            │  6. (若跨DO,2PC 参与方)
   │                              │◀───── 返回 event(s) ────────│
   │                              │                            │
   │◀─ command_ack ───────────────│                            │
   │   {accepted:true}            │                            │
   │                              │ 广播 event frame 给该频道    │
   │◀─ event frame ───────────────│ 所有在线订阅者(含自己)      │
   │   {event_id, type, payload}  │                            │
```

`command_ack` 和 event 是两帧：command_ack 只表示协议校验通过、Worker 已接收，不表示消息已创建；最终状态以 event frame 为准（contract 10.2）。前端收到 ack 保持 pending，收到对应 `message.created` 才用服务端 `message_id` 替换 pending（contract 12.3）。

### 3.2 单调 UUIDv7 生成

`event_seq` 表一行，生成逻辑（在 DO 写事务内部，跟业务数据 + events 写在同事务，event_id 分配和事件落库原子）：

```js
function nextEventId(seq) {
  const nowMs = Date.now();
  let ms = seq.last_ms, counter = seq.counter;
  if (nowMs > ms) { ms = nowMs; counter = 0; }
  else { counter++; }                       // 同毫秒递增,保序
  // UUIDv7: 48bit ms | 12bit counter | 62bit random
  return uuidV7FromParts(ms, counter, crypto.getRandomValues(...));
}
```

- 同 DO 同毫秒：counter 递增 → event_id 严格递增 → `message.created` 永远先于同毫秒的 `message.deleted`。
- 跨 DO：各 DO 各自 counter，同毫秒跨频道顺序任意，无因果依赖，无所谓。
- 客户端 event_id 比较用字符串字典序（UTF-8 字典序 = 时间序，单调 UUIDv7 保序），符合 contract 2.2 "ID 不透明字符串"。

### 3.3 幂等

两层：

- **HTTP mutation**：Cloudflare KV 存 `Idempotency-Key` 结果。key 格式 `idem:{user_id}:{endpoint}:{key}`，TTL 24h。命中且 body hash 一致 → 返回缓存结果；不一致 → `IDEMPOTENCY_CONFLICT`。KV eventual consistency 极短窗口内并发可能双写，但 DO 事务里 UNIQUE 约束兜底不产生重复业务数据，重复广播由前端 event_id 去重吸收。
- **WebSocket command**：command frame 里 `idempotency_key` 落到 DO 内 `command_idempotency` 小表 `(channel_id, command_id) → result_event_ids`。重复 command 进 DO 事务，命中 → 返回已存在的 event_id，不重复创建。`client_message_id`（消息业务幂等）落 `messages.client_message_id` UNIQUE。幂等查在 DO 事务内，不依赖外部缓存，WS 重连/重发天然安全。

`client_message_id` 和 `idempotency_key` 是两个字段（contract 6.2）：前者防止重复消息，后者防止重复 command（哪怕包含多个 effect，整体幂等）。

### 3.4 广播：谁收到、怎么投递

事件落库后，Worker 把 event frame 发给该频道所有在线订阅者。订阅关系在 Worker 内存（`channel_id → Set<connection>`，每个 connection 绑定 user_id）。

- **谁收到**：该频道当前在线的成员。成员资格在 DO 写消息时已校验（发送者必须是 active member），广播时 Worker 按 channel_id 找订阅连接。
- **含发送者自己**：contract 2.7"当前用户也通过同一条事件流确认最终状态"。
- **隐式订阅**：WS 建连后，Worker 读 UserDirectory 拿 `my_channels`，全部加入订阅集，不需前端逐个发订阅帧。非成员不在 my_channels，自然不订阅。
- **消息可见性投影**：deleted/recalled 消息的 event payload 在落库时已是投影形态，广播直接发。历史分页查询加 `WHERE status NOT IN ('deleted','recalled')`（contract 6.1、10.3）。

### 3.5 事件回放

客户端给 `since_event_id=<uuidv7>`，Worker 并行问用户所有 channel DO 要 `event_id > 游标` 的事件，按 event_id 字符串归并排序投递。用户几十个频道，O(频道数) 可接受。回放只发生在重连/补发，不是热路径。`GET /api/chat/events` 同此路径。

## 4. 认证与 Profile

### 4.1 JWT 自验（Worker 内，零 DB）

从 `toolbear_ui/auth_utils.py` 提炼验证规则，Worker 原样复刻。算法 HS256，密钥是 wrangler secret `JWT_SECRET`（与 game-worker 同值、同源签发）。

```js
function verifyBrowserJwt(token, secret) {
  const payload = jwtVerify(token, secret, { algorithms: ["HS256"] });  // 验签名 + exp
  if (!payload.sub) throw 401 UNAUTHORIZED;

  // machine token:有 client_id → 拒
  if (payload.client_id !== undefined) throw 401 MACHINE_TOKEN_NOT_ALLOWED;

  // delegated / managed session → 拒(contract 2.1 的 SESSION_NOT_ALLOWED)
  const managed = payload.managed_session === true
    || (payload.owner_user_id !== undefined
        && payload.owner_user_id !== payload.sub
        && payload.effective_account_user_id === payload.sub);
  if (managed) throw 403 SESSION_NOT_ALLOWED;

  // browser self-session:owner_user_id == sub == effective_account_user_id
  // → 通过,principal_id 校验跳过(Python 侧对 self-session 也提前返回不查库)
  return { user_id: payload.sub };
}
```

对齐点：

- self-session 判定：无 `client_id` + `owner_user_id == sub` + `effective_account_user_id == sub` + `managed_session` falsy → 放行。这是聊天允许的唯一会话类型。
- `principal_id` 校验：Python 侧 `_validate_principal_payload` 对 self-session 提前返回不查库（`auth_utils.py:177-178`），Worker 不复刻 principal 查库逻辑也不影响安全。
- `exp`：库自动验。过期 → `401 UNAUTHORIZED`。
- 日志不记录原始 token（架构 20.2），只记 user_id + request_id。

JWT 库用 `jose`（纯 JS、Workers 兼容、HS256 支持，后续 bot callback HMAC 签名统一）。

### 4.2 WebSocket 认证（subprotocol）

contract 2.1：WS 不能设 Authorization header，用 subprotocol 传 JWT。

```js
// 前端
new WebSocket("wss://chat.kuma.homes/api/chat/ws?since_event_id=<uuidv7>", [
  "lilium.chat.v1",
  "bearer.<toolbear_browser_jwt>"
])
```

Worker 端 WS upgrade：

1. 从 `Sec-WebSocket-Protocol` 读两个子协议：必须是 `lilium.chat.v1` + `bearer.<jwt>`。缺一或多了别的 → 拒（400）。
2. 对 `bearer.` 后那段跑 `verifyBrowserJwt`。失败 → 拒（401，不升级）。
3. 通过 → 回选 `lilium.chat.v1`（不回选 `bearer.*`），升级 WS，绑定 `user_id`。
4. **Origin 校验**：upgrade 时检查 `Origin` ∈ {`https://lilium.kuma.homes`，本地开发 origin}。不匹配 → 拒。这是跨域 WS 核心防线（contract 2.1 隐含、架构 20.2 明确）。
5. 升级后隐式订阅：读 UserDirectory 拿 `my_channels`，全部加入订阅集；按 `since_event_id` 回放缺失事件。

### 4.3 Profile：Hyperdrive 直读 users 表

Worker 在返回 `UserSummary`（Message.sender、成员列表、bootstrap.me；bot actor 除外）前，用 Hyperdrive 只读查 ToolBear 生产 Postgres 的 `users` 表。

```toml
[[hyperdrive.config]]
name = "TOOLBEAR_DB"
connection_string = "<wrangler secret: HYPERDRIVE_CONN>"
local_connection_string = "..."
```

Worker 用 `env.TOOLBEAR_DB.connect()` 拿缓存的 PG 连接池，`node:pg` 兼容。

```js
async function resolveUserSummaries(userIds, env) {
  const unique = [...new Set(userIds)].slice(0, 50);
  if (unique.length === 0) return new Map();
  const conn = env.TOOLBEAR_DB.connect();
  const res = await conn.execute({
    sql: "SELECT user_id::text, full_name, avatar_url FROM users WHERE user_id = ANY($1)",
    args: [unique],
  });
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.user_id, {
      user_id: row.user_id,
      display_name: row.full_name,    // users 表字段 full_name 映射成契约的 display_name
      avatar_url: row.avatar_url,
    });
  }
  return map;
}
```

- **只读**：Worker 只 `SELECT`，不改 ToolBear 数据。
- **字段映射**：`users.full_name` → `UserSummary.display_name`。`avatar_url` 同名。这是 Worker 对 ToolBear schema 的唯一耦合点，集中在 `resolveUserSummaries`。
- **请求级缓存**：一次 HTTP 请求 / 一次 WS 事件批量内，同一 user_id 多次 resolve 只查一次——请求级 `Map` 缓存（生命周期 = 单次请求）。不跨请求缓存（避免 display_name 改了不更新，也避免持久化 profile 进 DO）。
- **missing user 容错**：resolve 不到的 user_id，`display_name` fallback 成 user_id 前 8 位或 "unknown"，`avatar_url = null`，前端用标准 fallback（contract 3.1）。
- **bot actor**：`kind=bot` 的 sender 不走 resolve，`display_name`/`avatar_url` 来自 `chat_bot_apps` 表（在 ChatChannel DO），是聊天系统自有数据，不查 ToolBear。

### 4.4 bootstrap.me 与成员列表的 resolve 拼装

- `bootstrap.me`：resolve 单个 user_id（自己）。
- `messages.items` 里每条 `sender`：批量收集所有 sender user_id（去重）→ 一次 `resolveUserSummaries` → 回填。
- 成员列表：批量 resolve 所有成员 user_id。
- `last_message_preview` 里的发送者名：channel DO 查 last message 时连同 sender_user_id 取，Worker 再批量 resolve。

一次请求最多触发一次 `resolveUserSummaries`（收集完所有 user_id 再一次性查），不是 N+1。

## 5. 附件（SeaweedFS presign 上传流程）

contract 第 8 节两步上传，presign + finalize。二进制不进 Worker，不进 DO。

### 5.1 SeaweedFS 配置

```toml
[vars]
S3_ENDPOINT = "https://s3.kuma.homes"
S3_BUCKET = "lilium-chat-attachments"
S3_PUBLIC_BASE = "https://s3.kuma.homes"   # public read, 同 endpoint
# S3_ACCESS_KEY / S3_SECRET_KEY → wrangler secret put
```

- storage_key = `chat/{attachment_id}`（attachment_id 是 UUIDv7）。
- public `url` = `https://s3.kuma.homes/lilium-chat-attachments/chat/{attachment_id}`（长期公开，存 DO，不签）。
- Worker 用 fetch（aws4fetch SigV4）访问 SeaweedFS，不用 R2 binding。
- 依赖 `aws4fetch`（纯 JS SigV4 实现，Workers 兼容）。

### 5.2 presign（`POST /api/chat/uploads/images/presign`）

```
浏览器 → Worker:
  { filename, mime_type, size_bytes, width, height }

Worker:
  1. 验 JWT(4.1) → user_id
  2. 校验:
     - mime_type ∈ {image/png, image/jpeg, image/webp, image/gif}(第一版只图片,contract 8.1)
     - size_bytes ≤ 上限(初始 20 MiB,PRD 15.1)
     - 不信任 width/height(浏览器报的),存着,finalize 时若能验再验
  3. 生成 attachment_id (UUIDv7),storage_key = chat/{attachment_id}
  4. aws4fetch 签 SeaweedFS presigned PUT URL(5 分钟过期),约束:
     - method PUT
     - Content-Type 必须等于 mime_type(防上传时换类型)
     - Content-Length 上限 = size_bytes
  5. 写 pending attachment metadata 进 UserDirectory DO pending_attachments 表(status=pending)
  6. 返回 { attachment_id, upload_url, upload_method: "PUT", upload_headers, expires_at }
```

```js
const url = await aws4fetch.sign({
  url: `${S3_ENDPOINT}/${S3_BUCKET}/chat/${attachment_id}`,
  method: "PUT",
  expires: 300,
  headers: { "Content-Type": mime_type, "Content-Length": String(size_bytes) },
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
  region: "us-east-1",   // SeaweedFS 通常忽略 region,SigV4 仍需填
  service: "s3",
});
```

### 5.3 finalize（`POST /api/chat/uploads/images/{attachment_id}/finalize`）

```
浏览器(直传 SeaweedFS 成功后) → Worker:
  { etag }

Worker:
  1. 验 JWT → user_id
  2. 从 UserDirectory pending_attachments 取该 attachment_id
  3. 校验:owner_user_id == user_id(不是你的附件 → 拒)
     status == pending(重复 finalize 幂等:已 finalized 直接返回当前 attachment)
  4. fetch HEAD SeaweedFS object(SigV4 签)确认存在 + ContentLength 一致(contract 8.2)
  5. status = finalized
  6. 返回 Attachment 投影(含 public url)
```

幂等：重复 finalize 同一 attachment_id，已 finalized → 直接返回，不报错。KV HTTP idempotency 兜底。

### 5.4 附件访问 URL

Public read，不签。`url = https://s3.kuma.homes/lilium-chat-attachments/chat/{attachment_id}`，长期公开，存 DO（channel DO `attachments.url` + UserDirectory pending_attachments.url）。Worker 返回 Message/Attachment 投影时直接取，不现签。

产品决定：private 频道附件也 public（PRD 15.2 原本要求"私有频道附件不长期公开"，本设计按产品方决定放宽）。

### 5.5 GC

pending_attachments 里 status=pending 超过 1 小时没 finalize 的 → Cron Trigger（每天 4:17）扫 UserDirectory DO pending 表 + DELETE SeaweedFS object（SigV4 签）+ 删 pending 行。

### 5.6 发送图片消息

finalize 拿到 `attachment_id` 后，前端发 WS command（contract 6.2）：

```json
{ "command": "message.send", "payload": { "type": "image", "attachment_ids": ["..."], "text": "" } }
```

channel DO 事务内：Worker 先从 UserDirectory 预取 pending metadata → channel DO 校验每个 attachment_id 的 `owner == sender && status == finalized` → 写 message + message_attachments + attachment 业务副本（含 url）落 channel DO + `message.created` 事件（payload 里 attachments 数组带 url）→ 广播。

## 6. 部署与 chat.kuma.homes 域名 / CORS / WS Origin

### 6.1 wrangler 配置骨架

```toml
name = "lilium-chat"
main = "src/index.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = false
upload_source_maps = true
version_metadata = { binding = "CF_VERSION_METADATA" }

routes = [
  { pattern = "chat.kuma.homes", custom_domain = true }
]

[vars]
API_BASE_URL = "https://lilium.kuma.homes"
S3_ENDPOINT = "https://s3.kuma.homes"
S3_BUCKET = "lilium-chat-attachments"
S3_PUBLIC_BASE = "https://s3.kuma.homes"
SENTRY_ENVIRONMENT = "production"
SENTRY_DSN = "<sentry dsn>"
# JWT_SECRET, S3_ACCESS_KEY, S3_SECRET_KEY, HYPERDRIVE_CONN → wrangler secret put

[[durable_objects.bindings]]
name = "CHAT_CHANNEL"
class_name = "ChatChannel"

[[durable_objects.bindings]]
name = "USER_DIRECTORY"
class_name = "UserDirectory"

[[hyperdrive.config]]
name = "TOOLBEAR_DB"
connection_string = "<wrangler secret: HYPERDRIVE_CONN>"

[[triggers]]
crons = ["17 4 * * *"]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatChannel", "UserDirectory"]

[observability.logs]
enabled = true
invocation_logs = true
destinations = ["sentry-log"]

[observability.traces]
enabled = true
destinations = ["sentry"]
```

- `nodejs_compat`：aws4fetch、`jose`、Hyperdrive（`pg` 驱动）需要。
- 自定义域 `chat.kuma.homes`：Cloudflare custom domain，HTTP 和 WS 同一个域同一条 route。
- DO migrations：两个 DO 类首次声明 `new_sqlite_classes`（SQLite-backed）。
- Cron GC：凌晨 4:17 跑附件 GC，避开整点。
- Sentry：复用 game-worker 模式。

### 6.2 CORS（HTTP 跨域）

```js
app.use("/api/chat/*", cors({
  origin: ["https://lilium.kuma.homes"],   // 生产;dev 加 http://localhost:5173 等
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
  exposeHeaders: ["X-Request-Id"],
  credentials: false,                       // Bearer token 走 header,不需要 cookie
  maxAge: 86400,
}));
```

- `credentials: false`：认证走 `Authorization: Bearer`，不是 cookie。
- `exposeHeaders: ["X-Request-Id"]`：前端拿 request_id 追踪错误。
- `Idempotency-Key` 必须进 `allowHeaders`（contract 2.5）。
- origin 白名单写死生产 + localhost，需要多 origin 再配置化。

### 6.3 WebSocket Origin 校验

WS 不受 CORS 约束，Worker 自己验 Origin：

```js
const ALLOWED_WS_ORIGINS = new Set(["https://lilium.kuma.homes", "http://localhost:5173"]);
if (!ALLOWED_WS_ORIGINS.has(request.headers.get("Origin") || "")) {
  return new Response("origin not allowed", { status: 403 });
}
```

### 6.4 请求 ID 与错误 envelope

每个 HTTP 请求 / WS 命令分配 `req_<uuidv7>` 作为 request_id，注入 `X-Request-Id` 响应头 + 错误 envelope（contract 2.6）。日志带 request_id 串联。

### 6.5 本地开发

- `wrangler dev`：Worker 本地跑，DO SQLite 本地文件，Hyperdrive 指本地 PG，S3 指 MinIO 或直接打 `s3.kuma.homes`，`JWT_SECRET` 用 dev 值。
- 前端 dev server（dzmm_archive 本地跑）指向 `http://localhost:8787`，CORS origin 加 localhost。

### 6.6 部署

跟 game-worker 一致：`wrangler deploy`（包一层 `scripts/deploy.mjs` 跑 typecheck + deploy + sentry source map upload）。secrets 用 `wrangler secret put` 一次性配置。DO 数据持久化由 Cloudflare 托管，无自管 DB。

## 7. 测试策略

复用 game-worker 已验证的 `@cloudflare/vitest-pool-workers` + vitest。测试在真实 Workers 运行时里跑，DO 用本地 miniflare 模拟，不是 mock。

### 7.1 测试分层

**单元：纯函数**
- `verifyBrowserJwt`：正例（self-session）+ 各拒例（machine token、managed_session、owner≠sub、过期、签名错）。
- `nextEventId`：同毫秒递增保序、跨毫秒归零、跨次调用单调。
- 错误 envelope 构造、cursor 编解码、idempotency key hash。
- SigV4 presign 签名结构（不打网络）。

**DO 内逻辑：在 miniflare 里跑真实 DO**

用 `env.CHAT_CHANNEL` 拿真实 DO stub，直接调方法，DO 内 SQLite 是真的。每测试用 miniflare 重启隔离。

覆盖场景：
- 成员/权限：非成员读消息被拒（FORBIDDEN）、非 admin 删他人消息被拒、member 发消息成功、admin 删他人消息成功、降级最后一个 admin 被拒。
- 消息生命周期：发送→`message.created`、编辑（只自己的）、撤回（只自己的）、admin 删除、deleted/recalled 不出现在历史分页、deleted/recalled 的 event payload 不含原文。
- 幂等：重复 `message.send` 同 `client_message_id` 不重复建、重复 finalize 幂等返回、HTTP Idempotency-Key 重复返回同结果。
- 事件顺序：同毫秒内 `message.created` 后 `message.deleted`，event_id 严格递增，回放按 event_id 排序正确。
- read-state：mark-read 更新游标、unread 计算（非自己发的、event_id > last_read）。
- 附件：presign 写 pending、finalize 校验 owner、发送图片消息校验 attachment finalized + owner==sender、跨用户用别人 attachment 被拒。
- bot：command 注册名冲突（COMMAND_NAME_CONFLICT）、command.invoke 写 invocation + 事件、interaction.submit 校验 component 未 disabled + custom_id 一致。

**跨 DO（2PC）**：成员加入/离开，ChatChannel.members + UserDirectory.my_channels 同生共死。2PC 失败回滚两边。miniflare 支持多 DO + transaction。

**HTTP 端到端**：用 `fetch` 打 Hono app（整个 Worker），走完整中间件链。覆盖契约每个 HTTP 端点的成功 + 主要错误码。

**WebSocket 端到端**：用 Workers 运行时 WS 测试能力建连，验 subprotocol 握手（缺 `lilium.chat.v1` 拒、缺 bearer 拒、Origin 不符拒）、command_ack → event 顺序、隐式订阅（建连后自动收 my_channels 里频道的事件）、`since_event_id` 回放、断线重连不重复。

### 7.2 profile resolve 的测试

`resolveUserSummaries` 直读 Hyperdrive → PG。测试不连真 PG：
- 单元层：注入 fake Hyperdrive stub，验去重、截断、字段映射、missing user fallback。
- 契约层：标 `@skip` 的集成测试，只在有真 PG 时手动跑，CI 跳过。

### 7.3 测试数据与隔离

- 每个测试用独立 user_id / channel_id（测试工厂生成 UUIDv7），不共享 fixture 状态。
- 不测真实 SeaweedFS：presign/finalize 的 S3 调用用 fetch mock（`patchFetch`），验"发了 PUT 到 `s3.kuma.homes/{bucket}/chat/{id}` + SigV4 header"，不打真网络。

### 7.4 不测什么

- 不测 Cloudflare 平台本身（DO 事务、KV 一致性、Hyperdrive 连接池）。
- 不测 ToolBear JWT 签发（Python 侧职责）。
- 不做前端测试（lilium-chat 纯后端）。

### 7.5 CI

GitHub Actions：`typecheck (tsc --noEmit)` + `test (vitest run)`。package.json scripts：`dev` / `deploy` / `test` / `test:once` / `typecheck`，跟 game-worker 一致。

## 8. 阶段切分

对照 contract 第 12 节的 8 阶段，落到 lilium-chat repo 的交付节奏。每阶段可运行、可验收。

### 阶段 0：骨架与认证（contract 12.1 前置）

交付：Hono app + wrangler 配置 + 两个空 DO 类 + JWT 自验 + Hyperdrive profile resolve + 部署到 chat.kuma.homes。

- `GET /api/chat/bootstrap` 返回 `me`（resolve 自己）+ 空 `channels` + `active_channel=null` + `last_event_id=null`。
- machine token / managed session 被拒（contract 12.1 验收）。
- CORS + WS Origin 中间件就位。
- 部署到 chat.kuma.homes，curl 通。

验收：带真 ToolBear browser JWT curl bootstrap，返回 me；machine token 返回 `MACHINE_TOKEN_NOT_ALLOWED`；managed session 返回 `SESSION_NOT_ALLOWED`。

### 阶段 1：Worker/DO 最小聊天核心（contract 12.1）

交付：ChatChannel DO 完整表结构 + UserDirectory DO + 系统公共频道 + bootstrap 拉频道列表 + 历史消息分页。

- 系统公共频道：bootstrap 时若 UserDirectory 没有该频道，自动加入（2PC 写 members + my_channels）。
- `GET /api/chat/bootstrap?channel_id=` 返回 me + channels（含 active_channel）+ messages 分页 + last_event_id。
- `GET /api/chat/channels/{id}/messages` 分页，只返回可见消息。
- profile resolve 批量回填 sender。
- 事件日志 + 单调 UUIDv7 生成器就位（本阶段无 WS，事件只写不广播）。

验收：对应 contract 12.1——新用户首次进入自动有系统公共频道；bootstrap 形状正确；DO 不持久化 display_name/avatar。

### 阶段 2：WebSocket command/event 文本消息（contract 12.3）

交付：WS 端点 + message.send command + command_ack/event frame + 隐式订阅 + 事件回放。

- `wss://chat.kuma.homes/api/chat/ws?since_event_id=` subprotocol 握手。
- 隐式订阅 my_channels 全部频道。
- `message.send` → `command_ack` → `message.created` event 广播（含发送者自己）。
- `GET /api/chat/events` 回放。
- 两层幂等（client_message_id UNIQUE + idempotency_key）。
- 单调 event_id 顺序验证。

验收：对应 contract 12.3——重复发送不产生重复消息；重连不重复显示；Worker 短暂不可用前端保留 pending。

> contract 12.2（SPA 只读壳）是前端任务，在 dzmm_archive repo，不进 lilium-chat。本阶段后端交付后前端能接。

### 阶段 3：频道与成员基础管理（contract 12.4）

交付：频道 CRUD + 成员管理 + read-state。

- `GET /api/chat/channels`、`GET /api/chat/channels/{id}`、`PATCH`、members 增删改、`POST /read-state`。
- 2PC 跨 DO（成员加入/离开）。
- 至少保留一个 admin 规则。
- unread 计算（bootstrap 时查 channel DO）。
- HTTP Idempotency-Key + KV 幂等。

验收：对应 contract 12.4——成员列表显示头像/display_name/role；普通成员只读；至少一个 admin 后端保证；read-state 后 unread 归零。

### 阶段 4：消息生命周期（contract 12.5）

交付：回复 + 编辑 + 撤回 + 管理员删除。

- `message.send` 的 reply_to、`PATCH /messages/{id}`、`POST /recall`、`DELETE /messages/{id}`。
- `message.updated`/`message.recalled`/`message.deleted` 事件。
- deleted/recalled 原文保留审计，投影不含原文。
- 历史分页 + 事件回放都不重现 deleted/recalled 内容。

验收：对应 contract 12.5。

### 阶段 5：图片附件（contract 12.6）

交付：SeaweedFS presign + finalize + 图片消息。

- `POST /uploads/images/presign`（aws4fetch 签 SeaweedFS PUT）。
- `POST /uploads/images/{id}/finalize`（fetch HEAD SeaweedFS 确认）。
- pending_attachments 在 UserDirectory DO。
- `message.send` image command，校验 attachment owner + finalized。
- public read URL（`https://s3.kuma.homes/lilium-chat-attachments/chat/{id}`）。
- Cron GC pending 附件。

验收：对应 contract 12.6。

### 阶段 6：公开频道目录与邀请（contract 12.7）

交付：directory + join + invite 创建/接受。

- `GET /channels/directory`（只 public_listed + active）、`POST /channels/{id}/join`、`POST /channels/{id}/invites`、`POST /invites/{code}/accept`。
- 邀请码明文存储，创建时返回明文一次。

验收：对应 contract 12.7。

### 阶段 7：Bot slash command 与 rich interaction（contract 12.8）

交付：Bot API + command 注册 + command.invoke + interaction.submit + bot callback 签名 + effects + streaming。内部再拆：

- 7a：Bot token 认证 + bot app 注册 + command 注册（`PUT /bot/commands`）+ channel commands 查询。
- 7b：`command.invoke` WS command + invocation 状态 + bot callback 签名请求（HMAC `jose`）+ effects 校验 + `send_message`/`update_message` effect。
- 7c：`interaction.submit` + interaction 状态 + message_interaction callback。
- 7d：stream effects（`start_stream`/`append_stream`/`finalize_stream`）+ stream 事件。
- 7e：Bot 直接发消息（`POST /bot/channels/{id}/messages`）。

验收：对应 contract 12.8——/ask 不作为普通文本；参数按 schema 校验；命令按权限过滤；streaming delta 增量；interaction 失败不改写原消息。

### 关于 DM

contract 数据模型有 `kind=dm`，但 PRD 列 v1.1。第一版（阶段 0-7）只做 `kind=channel`，DM 表结构预留（DO 支持 `kind=dm`），不暴露创建入口。

### 关于前端阶段（contract 12.2）

不进 lilium-chat。每个后端阶段交付后，前端在 dzmm_archive 对应接入。
