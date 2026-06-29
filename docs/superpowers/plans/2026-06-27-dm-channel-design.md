# DM Channel Design (`kind="dm"`)

状态：设计稿 v1.1  
日期：2026-06-27  
范围：lilium-chat 一对一私聊（DM）后端实现设计  
权威来源：

- API contract addendum：`docs/api-contract/2026-06-27-dm-api-contract-addendum.md`
- 主 contract：`docs/api-contract.md`（v2.12+）
- 后端基线：`docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md`（v4.4）
- 前端 spec：`dzmm_archive/docs/plans/2026-06-27-lilium-chat-dm-frontend-spec.md`

## 0. 设计结论

DM **不是**独立 timeline 或新消息模型。DM 是 `ChatChannel` 上 `channel_meta.kind = 'dm'` 的双人私有频道特例。

新增 **`DMDirectory` DO**（按 canonical user pair 分片）负责 pair 唯一性与 A↔B 并发 get-or-create。**`UserDirectory(current_user_id)`** 负责 `operation=dm.open` 的 operation idempotency（与 `POST /channels` create 同类问题：`recipient_user_id` 不在 URL，不能把幂等 solely 放在 pair-scoped DO）。

消息、附件、read-state、history、events、fanout、WS live 全部复用现有 channel-scoped 路径。`UserDirectory.my_channels` 已预留 `kind` 字段，继续承载 DM 列表与 read-state。

### 0.1 v1 明确不做

- `source_channel_id` 与共同频道可见性证明
- 用户隐私开关、黑名单、message request
- DM 专用限流（仅沿用全局基础限流）
- 全局用户搜索 UI（由前端入口决定；后端只校验 `recipient_user_id` 在 ToolBear users 源存在）
- Bot 进入 DM（slash command 默认关闭，除非后续 phase 明确放开）

### 0.2 v1 明确要做

- 任意已认证 Browser 用户可向任意存在的 ToolBear 用户打开 DM
- canonical pair get-or-create：同一对用户只存在一个 `kind=dm` channel
- viewer-specific `title` / `avatar_url` / `dm_peer` 投影（不持久化 UserSummary 到 DO）
- 双方 `my_channels` projection + 在线 session `my_channels_changed` / live membership resync
- 对 DM 拒绝频道管理、邀请、成员 mutation、公开目录暴露

## 1. DO 拓扑变更

现有 8 个 DO class + `BotConnection`。DM 新增第 9 个：

```text
DMDirectory(pair_key)   -- 新增，按 canonical pair 命名
```

`pair_key` 计算：

```text
user_low  = min(current_user_id, recipient_user_id)   -- 字典序 UUID 字符串比较
user_high = max(current_user_id, recipient_user_id)
pair_key  = `${user_low}:${user_high}`
```

路由：`env.DM_DIRECTORY.getByName(pair_key)`。

**职责拆分（P0-1）：**

```text
UserDirectory(current_user_id)
  owns operation idempotency for operation=dm.open
  catches same Idempotency-Key + different recipient_user_id -> IDEMPOTENCY_CONFLICT

DMDirectory(pair_key)
  owns pair uniqueness and A<->B concurrent get-or-create
  does NOT own cross-recipient idempotency
```

不能把 pair 唯一性移到 `UserDirectory`：A→B 与 B→A 会路由到不同 `UserDirectory`，仍需要 `DMDirectory(pair_key)` 收敛到同一 `channel_id`。

### 1.1 Wrangler / 迁移

- `wrangler.jsonc` / `wrangler.test.jsonc`：新增 `DM_DIRECTORY` binding，`class_name: "DMDirectory"`
- `migrations[]`：新增 tag（如 `v3`），`new_sqlite_classes: ["DMDirectory"]`
- `wrangler.test.jsonc` 的 `SCHEDULER_PROBE` 等 test-only 绑定保持独立

## 2. DMDirectory Schema

```sql
CREATE TABLE dm_pairs (
  pair_key    TEXT PRIMARY KEY,
  user_low    TEXT NOT NULL,
  user_high   TEXT NOT NULL,
  channel_id  TEXT NOT NULL UNIQUE,
  created_by  TEXT NOT NULL,
  status      TEXT NOT NULL,   -- creating | active
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

索引建议：

```sql
CREATE INDEX idx_dm_pairs_channel_id ON dm_pairs(channel_id);
```

`DMDirectory` **不**存放 `operation=dm.open` 的 `idempotency_keys`。该表复用现有 `UserDirectory.idempotency_keys`（与 `channel.create` 同 DO）。

`dm_pairs.status=creating` 崩溃窗口：retry 重调同一 `ChatChannel(channel_id).createDm`（`channel_meta` 存在性即幂等 guard），再标 `active`。完整 HTTP 响应缓存在 **UserDirectory** 的 idempotency 行 `response_json`。

内部保护：若 `pair_key` 已绑定 `channel_id` A，并发另一路径试图绑定 `channel_id` B → 返回 `500` 或内部 `DM_PAIR_CONFLICT`（不暴露给 Browser；实现层 assert + dead-letter 日志）。

## 3. 创建流程

```text
Worker POST /api/chat/dms
  └─ verify Browser JWT → current_user_id
  └─ parse body { recipient_user_id }
  └─ reject recipient_user_id == current_user_id → 422 INVALID_DM_TARGET
  └─ UserDirectory(current_user_id).openDmWithIdempotency(operation_id, recipient_user_id)
       ├─ idempotency check (operation=dm.open)
       │    ├─ same key + different recipient -> 409 IDEMPOTENCY_CONFLICT
       │    ├─ same key + same recipient completed -> cached response_json
       │    └─ reserve processing row (status=creating)
       ├─ resolve recipient via Hyperdrive users table
       │    └─ not found -> 404 DM_TARGET_NOT_FOUND (fail idempotency row)
       ├─ pair_key = canonical(current_user_id, recipient_user_id)
       ├─ DMDirectory(pair_key).getOrCreateDm(...)
       │    ├─ if dm_pairs active: return channel_id
       │    ├─ if status=creating: resume same channel_id path
       │    ├─ mint channel_id (UUIDv7)
       │    ├─ insert dm_pairs (status=creating)
       │    ├─ ChatChannel(channel_id).createDm({ user_a, user_b, created_by })
       │    └─ mark dm_pairs status=active
       ├─ Worker inflate full ChannelSummary (§3.3) for current_user_id
       ├─ store response_json in UserDirectory idempotency row -> completed
       └─ return { channel, membership }
```

`UserDirectory` 内部路径建议：`POST /internal/open-dm`。  
`DMDirectory` 内部路径建议：`POST /internal/get-or-create-dm`。

### 3.1 ChatChannel.createDm

`ChatChannel(channel_id)` 单事务（`storage.transaction` / `transactionSync`）：

```text
1. channel_meta 不存在 guard（幂等：已存在则返回已有 meta）
2. INSERT channel_meta:
     kind='dm'
     visibility='private'
     title=''                    -- 不持久化 viewer-specific 标题
     topic=NULL
     avatar_url=NULL             -- 不持久化 viewer-specific 头像
     status='active'
     created_by=<created_by>
     member_count=2
     membership_version=1
3. INSERT members (exactly 2):
     user_a  role='member'
     user_b  role='member'
     -- 无 owner / admin
4. audit_logs (action='channel.create_dm' 或等价)
5. projection_outbox → UserDirectory(user_a)  my_channels upsert kind=dm
6. projection_outbox → UserDirectory(user_b)  my_channels upsert kind=dm
7. 可选：channel.created state event（无可见 system.notice）
```

**不**写 `channel_directory` projection（DM 不进公开目录）。  
**不**写 `invite_directory`。  
Fanout：首条 message 之前无需 fanout；若写 `channel.created` event 则按现有 outbox → `channel_fanout` 路径。

### 3.2 Viewer-specific 投影

`ChatChannel/internal/summary` 对 `kind=dm` 在 Worker 层 inflate，不在 DO 内 resolve profile：

```text
dm_peer_user_id = the other member relative to X-Verified-User-Id
resolveUserSummaries([dm_peer_user_id]) via Hyperdrive
title      = dm_peer.display_name
avatar_url = dm_peer.avatar_url
dm_peer    = UserSummary
role       = 'member'   -- 双方恒为 member
```

`channel_meta.title` / `avatar_url` 列对 DM 保持空或占位；Browser 永远以 Worker 投影为准。这与现有「DO 不持久化 UserSummary」边界一致。

bootstrap / `GET /channels` / `GET /channels/{id}` / `POST /dms` 响应均走同一 inflate 逻辑。

### 3.3 `POST /dms` 响应必须完整 `ChannelSummary`

`POST /dms` 的 `channel` 对象 **必须** 包含主 contract `ChannelSummary` 的全部列表字段，禁止省略：

```json
{
  "unread_count": 0,
  "last_read_event_id": null,
  "last_message_preview": null,
  "last_message_at": null,
  "last_event_id": null
}
```

新建 DM、重开已有 DM、幂等缓存重放三种路径返回同形。若写了不可见 `channel.created` event，可令 `last_event_id` 为该 event；否则 `null`。`unread_count` 新建时为 `0`。

## 4. 权限矩阵

### 4.1 DM 允许

| 能力 | 路径 |
|---|---|
| 发送消息 | WS `message.send` |
| 回复 / 图片 / sticker | 同上 |
| 编辑自己的消息 | WS `message.edit` |
| 撤回自己的消息 | WS `message.recall` |
| 删除自己的消息 | WS `message.delete`（若 contract 允许 self-delete） |
| mark_read | WS `channel.mark_read` |
| history / events / context | HTTP `GET .../messages`, `GET .../events`, `GET .../context` |
| bootstrap / channel list / detail | 现有 HTTP |
| 附件 presign/finalize | 现有 HTTP（`channel_id` 定位） |
| sticker 库 | 现有 HTTP |
| @mention suggest | `GET .../members?query=`（DM 仅 2 人） |

### 4.2 DM 禁止 → `UNSUPPORTED_CHANNEL_KIND`

对 `channel_meta.kind='dm'` 的 channel，禁用 mutation **统一** 返回 **`409 UNSUPPORTED_CHANNEL_KIND`**，`retryable=false`。不使用 422。

频道管理 mutation：

```text
PATCH  /api/chat/channels/{dm_id}
POST   /api/chat/channels/{dm_id}/dissolve
POST   /api/chat/channels/{dm_id}/join
POST   /api/chat/channels/{dm_id}/invites
POST   /api/chat/channels/{dm_id}/members
PATCH  /api/chat/channels/{dm_id}/members/{user_id}
DELETE /api/chat/channels/{dm_id}/members/{user_id}
POST   /api/chat/channels/{dm_id}/owner-transfer
POST   /api/chat/channels/{dm_id}/bot-installations
PATCH  /api/chat/channels/{dm_id}/bot-installations/{bot_id}
PATCH  /api/chat/channels/{dm_id}/commands/{bot_command_id}
PATCH  .../bot-installations/{bot_id}/event-subscriptions/message.created
```

Bot Gateway WS effects on DM（v1 不进 DM）：

```text
delivery_result / session.effects
     -> UNSUPPORTED_CHANNEL_KIND
```

Bot / slash（v1 不进 DM，即使残留 binding 也须收口）：

```text
GET  /api/chat/channels/{dm_id}/commands
     -> 200 { "items": [] }

WS   command.invoke   (channel_id 为 dm)
     -> command_error { code: "UNSUPPORTED_CHANNEL_KIND", retryable: false }

WS   interaction.submit (channel_id 为 dm)
     -> command_error { code: "UNSUPPORTED_CHANNEL_KIND", retryable: false }
```

`GET /api/chat/channels/directory` **永远不返回** `kind=dm`（`ChannelDirectory` 只索引 `public_listed` + `kind=channel`）。

### 4.3 Admin delete others 关闭

现有逻辑：`owner`/`admin` 可删除他人消息。对 `kind=dm`：

```text
message.delete：仅 sender 本人可删自己的消息
禁止 owner/admin 删除对方消息（DM 无 owner/admin 角色，但须显式 kind 门禁防御）
```

`message.edit` / `message.recall` 本就仅限 sender；保持不变。

## 5. 实时与列表

DM 创建后双方必须有 `UserDirectory.my_channels` active row（projection outbox flush）。

Membership projection 成功后，按 Phase 8 live 设计：

```text
UserDirectory flush → notify UserConnection /internal/live-memberships-changed
  → affected_user_id 的在线 session 收到 user_event my_channels_changed
  → session.live_start 已 live 的 session 为新 DM 建立 fanout lease
```

被动收到 DM 的一方若在线，必须能尽快在 ChannelList 看到新 DM，而不必等 HTTP bootstrap 全量刷新。HTTP bootstrap 仍是权威恢复来源。

## 6. 错误码

| code | HTTP | 场景 |
|---|---:|---|
| `INVALID_DM_TARGET` | 422 | `recipient_user_id == current_user_id` 或 UUID 格式非法 |
| `DM_TARGET_NOT_FOUND` | 404 | `recipient_user_id` 在 ToolBear users 源不存在 |
| `IDEMPOTENCY_CONFLICT` | 409 | 同 Idempotency-Key 不同 body |
| `UNSUPPORTED_CHANNEL_KIND` | 409 | 对 DM 调用 §4.2 所列频道管理 API |

`DM_NOT_ALLOWED` **v1 不定义**，预留给未来隐私/黑名单/限流 phase。

## 7. 实施阶段

### Phase DM-0：合约补丁

- 新增 `docs/api-contract/2026-06-27-dm-api-contract-addendum.md`
- 主 contract 修订记录指向 addendum
- 错误码、权限矩阵、`ChannelSummary.dm_peer` 形状

### Phase DM-1：后端核心

- `DMDirectory` DO + migration + binding
- `UserDirectory.openDmWithIdempotency`（`operation=dm.open` 幂等 + 完整响应缓存）
- `POST /api/chat/dms` Worker route
- `ChatChannel.createDm`
- pair 并发去重测试（A→B / B→A / 双并发）
- 同 Idempotency-Key 异 recipient → `IDEMPOTENCY_CONFLICT` 测试
- `UserDirectory` projection flush
- live `my_channels_changed` 通知

### Phase DM-2：消息链路验收

- 在 `kind=dm` 跑现有 message.send/edit/recall/read-state/history/events 测试
- admin delete 禁止
- settings/member/invite/dissolve 禁止
- directory 不暴露 DM

### Phase DM-3：前端入口

见 `dzmm_archive/docs/plans/2026-06-27-lilium-chat-dm-frontend-spec.md`

### Phase DM-4：隐私与滥用（后续，非 v1）

- 用户隐私偏好
- 黑名单 / block
- message request
- DM 专用 rate limit
- push notification

## 8. 验收清单

```text
[ ] A POST /dms B → 创建 kind=dm channel，双方 member
[ ] B POST /dms A → 返回同一 channel_id
[ ] A 并发两次 POST /dms B → 单一 channel_id
[ ] 同 Idempotency-Key 同 body 重试 → 同响应
[ ] 同 Idempotency-Key 不同 recipient → IDEMPOTENCY_CONFLICT
[ ] POST /dms self → INVALID_DM_TARGET
[ ] POST /dms nonexistent user → DM_TARGET_NOT_FOUND
[ ] DM 出现在双方 GET /channels / bootstrap
[ ] recipient 在线 → my_channels_changed + live resync
[ ] DM 中 message.send fanout 双方
[ ] GET /channels/directory 不含 kind=dm
[ ] PATCH/dissolve/join/invites/members on DM → 409 UNSUPPORTED_CHANNEL_KIND
[ ] GET .../commands on DM -> { items: [] }
[ ] WS command.invoke / interaction.submit on DM -> UNSUPPORTED_CHANNEL_KIND
[ ] Bot Gateway delivery_result / session.effects on DM -> UNSUPPORTED_CHANNEL_KIND
[ ] DM 中不能 admin delete 对方消息
[ ] POST /dms 响应含完整 ChannelSummary 列表字段
[ ] ChannelSummary title/avatar/dm_peer 为 viewer-specific 投影
[ ] channel_meta 不持久化对方 display name
```

## 9. 与既有「关于 DM」段落的取代关系

`docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md` §「关于 DM」原文为「只做 kind=channel，DM 表结构预留，不暴露创建」。本设计 **取代** 该段落：DM 创建通过 `POST /api/chat/dms` 暴露；`channel_meta.kind=dm` 与 `members` 表复用，不新建消息/事件表。

主 API contract 中「DM 创建不暴露，见关于 DM」的表述在 addendum 合并后更新为指向 `POST /api/chat/dms`。
