# DM API Contract Addendum

状态：已合并进主 contract v2.13 — **非权威** patch trace
日期：2026-06-27
范围：`POST /api/chat/dms`、`ChannelSummary.dm_peer`、DM 禁用矩阵、错误码、权限
权威 contract：`docs/api-contract.md`（v2.13+）
权威来源：

- 主 contract（已合并）：`docs/api-contract.md`（v2.13+）
- 后端设计：`docs/plans/2026-06-27-dm-channel-design.md`
- 前端 spec：`dzmm_archive/docs/plans/2026-06-27-lilium-chat-dm-frontend-spec.md`

本 addendum 内容已合并进 `docs/api-contract.md` v2.13；保留本文件仅供历史 trace。

## 修订摘要

| 维度 | 合并前 (v2.12) | DM addendum (v1.1) |
|---|---|---|
| DM 创建 | 不暴露 | **`POST /api/chat/dms`** get-or-create |
| 可见性证明 | — | **v1 不要求**共同频道、`source_channel_id`、隐私开关、黑名单 |
| Pair 唯一性 | — | `DMDirectory(pair_key)`；A↔B 同一 `channel_id` |
| `dm.open` 幂等 | — | **`UserDirectory(current_user_id)`**；同 key 异 recipient → `IDEMPOTENCY_CONFLICT` |
| `POST /dms` 响应 | — | **完整 `ChannelSummary`**（含 unread / last_message_*，禁止省略） |
| `ChannelSummary` | `kind: channel \| dm` 枚举已有，无 `dm_peer` | 新增 **`dm_peer?: UserSummary`** |
| 频道管理 on DM | 部分隐式（join 已 403） | **`409 UNSUPPORTED_CHANNEL_KIND`**（唯一 HTTP status） |
| Bot on DM | 未收口 | commands 空列表；invoke/interaction/bot-send 禁用 |
| 错误码 | — | `INVALID_DM_TARGET`, `DM_TARGET_NOT_FOUND`, `UNSUPPORTED_CHANNEL_KIND` |

## 1. 路由总览（增量）

| 方法 | 路径 | 说明 | 章节 |
|---|---|---|---|
| POST | `/api/chat/dms` | get-or-create 一对一 DM | §2 |

## 2. `POST /api/chat/dms`

打开或获取当前用户与目标用户之间的一对一 DM。不是普通频道创建。

```http
POST /api/chat/dms
Authorization: Bearer <toolbear_browser_jwt>
Idempotency-Key: client-key-dm-open
Content-Type: application/json
```

### 2.1 请求

```json
{
  "recipient_user_id": "00000000-0000-7000-8000-000000000102"
}
```

字段：

- `recipient_user_id`：必填。目标用户的 ToolBear `user_id`（UUID 字符串）。

v1 语义：

```text
- 任意已认证 Browser 用户可以向任意存在的 ToolBear 用户打开 DM。
- 不要求双方有共同频道。
- 不检查对方隐私设置。
- 不检查黑名单。
- 不做 DM 专用 rate limit（仅沿用全局基础限流）。
- recipient_user_id 必须存在于 ToolBear users 数据源。
- recipient_user_id 不得等于 current_user_id。
```

### 2.2 响应

```json
{
  "channel": {
    "channel_id": "00000000-0000-7000-8000-000000000301",
    "kind": "dm",
    "visibility": "private",
    "title": "Alice",
    "topic": null,
    "avatar_url": "https://example.com/avatar.png",
    "member_count": 2,
    "role": "member",
    "status": "active",
    "dm_peer": {
      "user_id": "00000000-0000-7000-8000-000000000102",
      "display_name": "Alice",
      "avatar_url": "https://example.com/avatar.png"
    },
    "unread_count": 0,
    "last_read_event_id": null,
    "last_message_preview": null,
    "last_message_at": null,
    "last_event_id": null,
    "created_at": "2026-06-27T12:00:00Z",
    "updated_at": "2026-06-27T12:00:00Z"
  },
  "membership": {
    "role": "member",
    "joined_at": "2026-06-27T12:00:00Z"
  }
}
```

`channel` 形状与主 contract §3.2 `ChannelSummary` **完全一致**（见 §3）。对 `kind="dm"`：

- `role` 恒为 `member`（双方无 owner/admin）。
- `title` 与 `avatar_url` 为 **viewer-specific 投影**：等于 `dm_peer` 的 `display_name` / `avatar_url`，由服务端按当前 JWT `user_id` 实时 resolve，**不**把某一方看到的标题持久化为公共频道标题。
- `visibility` 恒为 `private`。
- `member_count` 恒为 `2`。
- **`unread_count` / `last_read_event_id` / `last_message_preview` / `last_message_at` / `last_event_id` 必须存在**（新建 DM 时分别为 `0` / `null` / `null` / `null` / `null` 或 `last_event_id` 为 `channel.created` event id）。禁止按「首次创建 / 重开」省略字段。幂等缓存 `response_json` 存此完整形状。

### 2.3 Pair 唯一性与幂等

```text
pair_key = canonical(min(current_user_id, recipient_user_id), max(...))
```

- A 向 B 打开与 B 向 A 打开 **必须返回同一 `channel_id`**。
- 已存在 active DM 时返回已有 channel（get-or-create），不创建第二个。

**两层职责（不可合并到单一 DO）：**

```text
UserDirectory(current_user_id)
  operation=dm.open idempotency (HTTP Idempotency-Key)
  same key + same recipient -> cached full response
  same key + different recipient -> 409 IDEMPOTENCY_CONFLICT

DMDirectory(pair_key)
  pair uniqueness + A<->B concurrent get-or-create
  does NOT see cross-recipient idempotency keys
```

原因：同 `Idempotency-Key` 换 `recipient_user_id` 会路由到不同 `DMDirectory`，pair-scoped DO 无法检测冲突——与 `POST /channels` 无 `channel_id` 时不能把 create 幂等放在 `ChatChannel` 是同类结构性问题。

幂等规则（与主 contract §2.5 一致）：

- `principal_kind=user`, `principal_id=current_user_id`, `operation=dm.open`, `operation_id=Idempotency-Key`
- 同 key + 同 `request_hash`（同 `recipient_user_id`）→ 返回 `UserDirectory` 缓存的完整 `response_json`
- 同 key + 异 `request_hash`（换了 `recipient_user_id`）→ `409 IDEMPOTENCY_CONFLICT`（由 `UserDirectory` 检测）

### 2.4 创建副作用

同事务或 saga 内（见后端设计）：

- `ChatChannel(channel_id).createDm`：写 `channel_meta` + 2×`members` + audit + `projection_outbox` → 双方 `UserDirectory`
- 双方 `my_channels` 出现 `kind=dm` active row
- 在线 session 收到 `user_event` `my_channels_changed` hint（Phase 8 live 语义）
- **不**写 `ChannelDirectory`；**不**产生可见 `system.notice`

### 2.5 错误

| HTTP | code | 条件 |
|---:|---|---|
| 422 | `INVALID_DM_TARGET` | `recipient_user_id == current_user_id` 或 UUID 格式非法 |
| 404 | `DM_TARGET_NOT_FOUND` | `recipient_user_id` 在 users 源不存在 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同 Idempotency-Key，body 与首次请求不一致 |

## 3. 数据模型扩展

### 3.1 `ChannelSummary` / `ChannelDetail` delta

在主 contract §3.2 / §3.3 基础上扩展：

```json
{
  "channel_id": "...",
  "kind": "dm",
  "visibility": "private",
  "title": "Alice",
  "avatar_url": "...",
  "member_count": 2,
  "role": "member",
  "status": "active",
  "dm_peer": {
    "user_id": "...",
    "display_name": "Alice",
    "avatar_url": null
  }
}
```

类型（TypeScript 参考）：

```ts
type ChatChannelKind = 'channel' | 'dm'

type ChannelSummary = {
  channel_id: string
  kind: ChatChannelKind
  visibility: 'private' | 'public_unlisted' | 'public_listed'
  title: string
  avatar_url: string | null
  member_count: number
  role: 'owner' | 'admin' | 'member' | null
  status: 'active' | 'archived' | 'dissolved'
  dm_peer?: UserSummary | null   // kind=dm 时必填；kind=channel 时省略或 null
  // ... unread / last_message fields unchanged
}

type UserSummary = {
  user_id: string
  display_name: string
  avatar_url: string | null
}
```

规则：

- `kind="channel"`：`dm_peer` 省略或为 `null`；`title`/`avatar_url` 来自 `channel_meta`。
- `kind="dm"`：`dm_peer` 为对方用户；`title`/`avatar_url` 由 `dm_peer` 派生（viewer-specific）。
- `GET /api/chat/bootstrap`、`GET /api/chat/channels`、`GET /api/chat/channels/{id}` 对 DM 均带 `dm_peer`。

### 3.2 Message / Event / WS

**不新增** DM 专用 message API。以下路径对 `kind=dm` 的 `channel_id` 完全复用：

```text
WS  message.send / message.edit / message.recall / message.delete
WS  channel.mark_read
WS  session.live_start / session.heartbeat
HTTP GET .../messages
HTTP GET .../events
HTTP GET .../messages/{id}/context
```

ack / event payload 形状不变：`{ channel_id, event_id, message }`。

附件、sticker：`channel_id + attachment_id` 定位，不退回 `message_id` 或新 `asset_id`。

## 4. DM 禁用端点矩阵

对 `channel_meta.kind="dm"` 的 `channel_id`，以下 HTTP mutation **必须** 返回 **`409 UNSUPPORTED_CHANNEL_KIND`**（`retryable: false`）。**禁止** 使用 422。

频道管理：

```text
PATCH  /api/chat/channels/{channel_id}
POST   /api/chat/channels/{channel_id}/dissolve
POST   /api/chat/channels/{channel_id}/join
POST   /api/chat/channels/{channel_id}/invites
POST   /api/chat/channels/{channel_id}/members
PATCH  /api/chat/channels/{channel_id}/members/{user_id}
DELETE /api/chat/channels/{channel_id}/members/{user_id}
POST   /api/chat/channels/{channel_id}/owner-transfer
POST   /api/chat/channels/{channel_id}/bot-installations
PATCH  /api/chat/channels/{channel_id}/bot-installations/{bot_id}
PATCH  /api/chat/channels/{channel_id}/commands/{bot_command_id}
PATCH  .../bot-installations/{bot_id}/event-subscriptions/message.created
```

Bot Gateway WS（v1 不进 DM）：

```text
delivery_result / session.effects（发消息类 effect）
     -> delivery_ack.failed { code: "UNSUPPORTED_CHANNEL_KIND", retryable: false }
```

Slash / interaction（v1 不进 DM）：

```text
GET  /api/chat/channels/{channel_id}/commands
     -> 200 { "items": [] }   （不是 409）

WS   command.invoke
     -> command_error { code: "UNSUPPORTED_CHANNEL_KIND", retryable: false }

WS   interaction.submit
     -> command_error { code: "UNSUPPORTED_CHANNEL_KIND", retryable: false }
```

读端点仍可用（成员列表在 DM 中返回 2 人；用于 @mention suggest）：

```text
GET /api/chat/channels/{channel_id}/members
GET /api/chat/channels/{channel_id}/members/{user_id}
```

`GET /api/chat/channels/directory` **永远不返回** `kind=dm`。

`POST /api/chat/channels` 仍只创建 `kind="channel"`；不接受 `kind=dm`。

## 5. 权限矩阵（Browser）

### 5.1 DM 允许

- 发送消息（text / image / sticker）、回复、编辑自己的消息、撤回自己的消息
- mark_read、history、events、bootstrap、附件上传、个人 sticker 库
- @mention（成员仅 2 人）

### 5.2 DM 禁止

- 修改频道 title / topic / avatar / visibility
- 邀请链接、公开 join、成员 add/remove/role、owner transfer、dissolve
- **管理员删除他人消息**：`message.delete` 仅 sender 本人；`kind=dm` 时 owner/admin 路径关闭
- Bot install / command binding / passive subscription / invoke / interaction / bot direct message（v1）
- 公开目录曝光

## 6. 错误码（增量）

加入主 contract §11：

| HTTP | code | 含义 |
|---:|---|---|
| 422 | `INVALID_DM_TARGET` | 给自己发 DM，或 `recipient_user_id` 格式非法 |
| 404 | `DM_TARGET_NOT_FOUND` | 目标用户不存在 |
| 409 | `UNSUPPORTED_CHANNEL_KIND` | 对 `kind=dm` 调用了 §4 禁用 HTTP mutation；`retryable: false` |

`DM_NOT_ALLOWED`：**v1 不定义**（预留给未来隐私/黑名单 phase）。

`IDEMPOTENCY_CONFLICT`：语义不变，适用于 `POST /dms`。

## 7. 实施与合并

### Phase DM-0（本文件）

合约补丁就绪后，将 §1–§6 合并进 `docs/api-contract.md` 作为 **v2.13** revision entry，并更新 §1.1 路由表、§3.2/§3.3、§11、§12 阶段列表。

### 验收（contract 层）

```text
[ ] POST /dms 请求/响应形状与 §2 一致（含完整 ChannelSummary 列表字段）
[ ] 同 Idempotency-Key 异 recipient -> IDEMPOTENCY_CONFLICT（UserDirectory 层）
[ ] ChannelSummary.dm_peer 在 bootstrap/list/detail 出现
[ ] §4 禁用矩阵有对应集成测试（含 bot/slash）
[ ] §6 错误码在 errors.ts + HTTP_STATUS_BY_CODE 注册
[ ] 主 contract v2.13 修订记录与路由表已指向本 addendum
```
