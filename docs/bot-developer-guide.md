# Lilium Chat Bot 开发者指南

面向外置 Bot 应用开发者的 API 说明。Bot 通过 **Bot Token** 主动连接 Chat 后端；**不需要** Bot 暴露公网 HTTP 回调地址。

| 项目 | 值 |
|---|---|
| 生产 API Base | `https://chat.kuma.homes` |
| Bot Gateway WS | `wss://chat.kuma.homes/api/chat/bot/ws` |
| 协议版本 | `lilium.chat.bot.v1` |
| 权威 Contract | [`docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`](./api-contract/2026-06-22-toolbear-chat-api-contract.md) §9 |

---

## 1. 架构概览

```
Bot 开发者 (Browser JWT)
  └─ POST /api/chat/bots 注册 Bot、管理 Token

频道管理员 (Browser JWT)
  └─ PATCH /channels/{id}/commands/{bot_command_id}  allow/block 单条 slash command

Bot 进程 (Bot Token)
  ├─ PUT  /api/chat/bot/commands          同步全局 slash command catalog
  └─ WS   /api/chat/bot/ws                常驻连接；delivery / session 帧；消息 mutation 经 effects

频道用户 (Browser JWT + Browser WS)
  └─ command.invoke  → stateless delivery 或 stateful session.start
```

**三条路径分离，不可混用：**

| 路径 | 认证 | 用途 |
|---|---|---|
| Browser API | ToolBear browser JWT | 用户聊天、频道管理、command allow/block |
| Bot HTTP API | `Authorization: Bearer <bot_token>` | Bot 同步 catalog（`PUT /api/chat/bot/commands`） |
| Bot Gateway WS | 同上 + `Sec-WebSocket-Protocol: lilium.chat.bot.v1` | 接收 delivery、`session.*`；消息 mutation 经 `delivery_result` / `session.effects` |

Bot 与 Browser **不复用** WebSocket。Browser 走 `/api/chat/ws`（`lilium.chat.v2`），Bot 走 `/api/chat/bot/ws`（`lilium.chat.bot.v1`）。

**Slash Command 模型要点：**

- **全局命名空间**：`BotRegistry.bot_command_names` 保证全站 slash 名称唯一；Bot 通过 `PUT /bot/commands` 声明 catalog。
- **频道 allow/block**：`ChatChannel.channel_command_bindings` 记录每条 command 在频道内是 `allowed` 还是 `blocked`；不再使用 per-channel 安装表。
- **Stateful 会话**：`execution.mode=stateful` 的 command 在频道内互斥占用 mutex；Bot 通过 `session.start` / `session.input` / `session.close` 帧驱动会话。

---

## 2. 接入前置条件

Bot 开发者需要完成：

1. **注册 Bot 应用**：Browser JWT 调用 `POST /api/chat/bots` 创建 `bot_id` 并签发 Token（明文只返回一次）。
2. **同步 catalog**：Bot 进程 `PUT /api/chat/bot/commands` 写入全局 command 定义（含 `execution.mode` / `execution.stateful`）。
3. **频道 allow**：频道 owner/admin 对目标 command 调用 `PATCH .../commands/{bot_command_id}`，`status: "allowed"` 并携带 `command_snapshot`。
4. **保持 Gateway 在线**：stateless invoke 与 stateful session 启动前都会检查 `BotConnection` 连接状态；离线返回 `BOT_OFFLINE`。

Bot 只能在 **`kind=channel` 群聊频道**内工作，且 command 必须被 allow。DM 不支持 slash command（返回 `409 UNSUPPORTED_CHANNEL_KIND`）。

已移除的旧模型：`POST/PATCH .../bot-installations`、`channel_command_names`（频道级索引）、`bot_event_capabilities`（被动订阅 catalog）。

---

## 3. 认证

所有 Bot API 使用：

```http
Authorization: Bearer <bot_token>
```

### 3.1 Token Scopes

| Scope | 用途 |
|---|---|
| `chat:runtime:connect` | 连接 Bot Gateway WebSocket |
| `chat:commands:manage` | `PUT /api/chat/bot/commands` |
| `chat:messages:write` | Bot Gateway WS 上 `delivery_result` / `session.effects` 中的 `send_message` 等 |
| `chat:messages:read` | 预留 |
| `chat:channels:read` | 预留 |
| `chat:members:read` | 预留 |

Scope 不足时返回 `403 Forbidden`，body 形如：

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Missing scope: chat:runtime:connect",
    "retryable": false
  },
  "request_id": "req_..."
}
```

### 3.2 通用 HTTP 约定

- **Base URL**：`https://chat.kuma.homes`
- **幂等**：所有 mutating HTTP 请求必须带 `Idempotency-Key` header（client-generated UUIDv7 字符串）。同一 key + 不同 body → `409 IDEMPOTENCY_CONFLICT`。
- **Request ID**：响应头 `X-Request-Id`；也可在请求中传 `X-Request-Id`。
- **错误信封**：

```json
{
  "error": {
    "code": "BOT_EFFECT_INVALID",
    "message": "human readable",
    "retryable": false
  },
  "request_id": "req_..."
}
```

- **时间**：ISO 8601 UTC，如 `"2026-06-21T05:30:00Z"`。
- **ID**：不透明字符串，不要解析前缀或类型。

---

## 4. Bot HTTP API

以下为 Bot Token 可直接调用的端点。

### 4.1 同步 Slash Command 目录

```http
PUT /api/chat/bot/commands
Authorization: Bearer <bot_token>
Idempotency-Key: <uuidv7>
Content-Type: application/json
```

**Scope**：`chat:commands:manage`

**请求体**：

```json
{
  "commands": [
    {
      "name": "ask",
      "aliases": ["ai", "chat"],
      "description": "Ask the assistant",
      "options": [
        {
          "name": "prompt",
          "type": "string",
          "required": true,
          "description": "Question"
        },
        {
          "name": "target",
          "type": "user",
          "required": false,
          "description": "Target user"
        },
        {
          "name": "count",
          "type": "integer",
          "required": false,
          "min": 1,
          "max": 10
        }
      ],
      "default_member_permission": "member",
      "execution": {
        "mode": "stateless"
      }
    },
    {
      "name": "werewolf",
      "aliases": [],
      "description": "Start a stateful game session",
      "options": [],
      "default_member_permission": "member",
      "execution": {
        "mode": "stateful",
        "stateful": {
          "mutex_scope": "channel",
          "default_ttl_seconds": 3600,
          "max_ttl_seconds": 7200,
          "listen_capability": {
            "message_types": ["text"],
            "include_bot_messages": false,
            "include_own_messages": true
          }
        }
      }
    }
  ]
}
```

**字段说明**：

| 字段 | 说明 |
|---|---|
| `commands[].name` | Canonical slash 名称（不含 `/`） |
| `commands[].aliases` | 同一 command 的别名；`command.invoke` 时通过 `invoked_name` 区分 |
| `commands[].options[].type` | `string` \| `integer` \| `number` \| `boolean` \| `user` \| `channel` \| `role` |
| `commands[].default_member_permission` | `member` \| `admin` \| `owner`；频道 binding 可用 `permission_override` 覆盖 |
| `commands[].execution.mode` | `stateless`（一次性 delivery）或 `stateful`（频道 mutex 会话） |
| `commands[].execution.stateful` | stateful 模式必填：`mutex_scope`、`default_ttl_seconds`、`max_ttl_seconds`、`listen_capability` |

**响应** `200`：

```json
{
  "commands": [
    {
      "bot_command_id": "00000000-0000-7000-8000-000000000701",
      "name": "ask",
      "definition_hash": "sha256:...",
      "schema_version": 1,
      "updated_at": "2026-06-21T05:30:00Z"
    }
  ]
}
```

**重要语义**：

- 此接口只写 **全局 catalog**（`BotRegistry` + `bot_command_names`），**不会**自动 allow 到任何频道。
- 频道内 command 是否可用，由频道 admin 对单条 command 执行 allow/block 决定。
- 全局 slash 名称冲突在 catalog sync 时返回 `COMMAND_NAME_CONFLICT`。
- `bot_command_id` 是 command 定义 ID，与 WS 帧顶层的 `command_id`（幂等 operation id）**不是同一概念**。

**实现状态**：✅ 已实现

---

## 5. Bot Gateway WebSocket

Bot 运行时 **必须** 保持与 Chat 的长连接，才能接收 slash command 调用、UI 交互和被动消息事件。

### 5.1 连接

```http
GET wss://chat.kuma.homes/api/chat/bot/ws
Authorization: Bearer <bot_token>
Sec-WebSocket-Protocol: lilium.chat.bot.v1
```

**Scope**：`chat:runtime:connect`

连接成功后 Worker 将 socket 路由到 `BotConnection DO(bot_id)`。

**实现状态**：✅ WS upgrade + hello/ready + delivery 推送已实现

---

### 5.2 握手流程

Bot 建连后 **必须** 发送 `hello`：

```json
{
  "type": "hello",
  "api_version": "lilium.chat.bot.v1",
  "last_received_delivery_id": null
}
```

| 字段 | 说明 |
|---|---|
| `last_received_delivery_id` | 重连时填入上次成功处理的 `delivery_id`；首连为 `null` |

Server 回复 `ready`：

```json
{
  "type": "ready",
  "api_version": "lilium.chat.bot.v1",
  "bot_id": "00000000-0000-7000-8000-000000000601",
  "session_id": "00000000-0000-7000-8000-000000000901",
  "server_time": "2026-06-26T00:00:00Z"
}
```

可选心跳：Bot 发 `{"type":"ping"}`，Server 回 `{"type":"pong","api_version":"lilium.chat.bot.v1"}`。

---

### 5.3 Delivery 帧（Server → Bot）

所有 runtime 事件以 `delivery` 帧推送：

```json
{
  "type": "delivery",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "kind": "<delivery_kind>",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  ...
}
```

| `kind` | 触发来源 | 说明 |
|---|---|---|
| `command_invocation` | 用户在频道输入 `/command` | Slash command 调用 |
| `message_interaction` | 用户点击 Bot 消息的 button/select | Rich UI 交互 |
| `message_event` | 频道内新消息（被动订阅） | 仅 `message.created`，observer/responder |

#### `command_invocation`

```json
{
  "type": "delivery",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "kind": "command_invocation",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "invocation_id": "00000000-0000-7000-8000-000000000811",
  "command": {
    "bot_command_id": "00000000-0000-7000-8000-000000000701",
    "name": "ask",
    "invoked_name": "ai",
    "schema_version": 3,
    "definition_hash": "sha256:...",
    "options": {
      "prompt": { "type": "string", "value": "hello" }
    }
  },
  "invoker": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "alice",
    "avatar_url": null
  }
}
```

#### `message_interaction`

```json
{
  "type": "delivery",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "kind": "message_interaction",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "interaction_id": "00000000-0000-7000-8000-000000000a21",
  "message_id": "00000000-0000-7000-8000-000000000301",
  "component": {
    "component_id": "00000000-0000-7000-8000-000000000a01",
    "custom_id": "confirm",
    "value": true
  },
  "actor": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "alice",
    "avatar_url": null
  }
}
```

`custom_id` 是 Bot 私有标识，前端原样回传，Bot 自行解析。

#### `message_event`

```json
{
  "type": "delivery",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "kind": "message_event",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "event": {
    "event_id": "01J...",
    "type": "message.created",
    "occurred_at": "2026-06-26T00:00:00Z"
  },
  "message": {
    "message_id": "00000000-0000-7000-8000-000000000301",
    "sender": {
      "kind": "user",
      "user": {
        "user_id": "00000000-0000-7000-8000-000000000101",
        "display_name": "alice",
        "avatar_url": null
      }
    },
    "type": "text",
    "format": "plain",
    "status": "normal",
    "text": "hello",
    "attachments": [],
    "components": [],
    "mentions": [],
    "created_at": "2026-06-26T00:00:00Z"
  }
}
```

Bot sender 时 `sender.kind=bot`，`sender.bot` 含 `bot_id` / `display_name` / `avatar_url`。

**投递语义**：

- **At-least-once**：按 `delivery_id` 去重。
- 重连后 Server 可能重发未完成 ack 的 delivery。
- `message_event` 在 Bot 离线时 **drop/expire**，不批量补发历史。

**实现状态**：

| 能力 | 状态 |
|---|---|
| delivery 入队与 WS 推送 | ✅ |
| `command_invocation` 端到端（用户 invoke → delivery） | ⏳ `command.invoke` 路由尚未实现 |
| `message_interaction` 端到端 | ⏳ `interaction.submit` 路由尚未实现 |
| `message_event` 端到端 | ⏳ 被动订阅 Browser API + outbox 尚未完整接线 |

---

### 5.4 Delivery Result（Bot → Server）

Bot 处理完 delivery 后回复：

```json
{
  "type": "delivery_result",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "status": "ok",
  "effects": [
    {
      "type": "send_message",
      "client_effect_id": "00000000-0000-7000-8000-000000000901",
      "message": {
        "type": "text",
        "format": "markdown",
        "text": "bot response",
        "reply_to_message_id": null,
        "attachment_ids": [],
        "components": []
      }
    }
  ]
}
```

`message_event` 通常回 `effects: []`（纯观察）；若要响应，使用与 invocation 相同的 effect 类型。

Server 应用 effects 后回复 `delivery_ack`：

```json
{
  "type": "delivery_ack",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "status": "applied"
}
```

失败：

```json
{
  "type": "delivery_ack",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "status": "failed",
  "error": {
    "code": "BOT_EFFECT_INVALID",
    "message": "..."
  }
}
```

**幂等规则**：

| 键 | 语义 |
|---|---|
| `delivery_id` | Bot 侧去重 delivery |
| `(channel_id, bot_id, client_effect_id)` | Server 侧 effect 幂等 |
| 同 `client_effect_id` 不同 body | `BOT_EFFECT_CONFLICT` |

**实现状态**：⏳ `delivery_result` 解析已实现，**effect 应用管线尚未完成**（当前固定返回 `BOT_EFFECT_INVALID: delivery_result not implemented yet`）

---

### 5.5 Effects 参考

Bot 通过 `delivery_result.effects` 改变频道状态。所有 effect 需要 `client_effect_id`（client-generated UUIDv7）。

| Effect | 说明 |
|---|---|
| `send_message` | 发送 Bot 消息，可带 `components` |
| `update_message` | 更新 Bot 自己发送的消息（text、attachments、components） |
| `disable_components` | 禁用 Bot 自己消息上的交互组件 |
| `start_stream` | 创建 `stream_state=streaming` 的 Bot 消息 |
| `append_stream` | 向自己的 streaming 消息追加 `delta` 文本 |
| `finalize_stream` | 将 streaming 消息标为 `stream_state=final` |

流式示例：

```json
{
  "effects": [
    {
      "type": "start_stream",
      "client_effect_id": "00000000-0000-7000-8000-000000000910",
      "message": {
        "type": "text",
        "format": "markdown",
        "text": "",
        "reply_to_message_id": null,
        "attachment_ids": [],
        "components": []
      }
    },
    {
      "type": "append_stream",
      "client_effect_id": "00000000-0000-7000-8000-000000000911",
      "message_id": "00000000-0000-7000-8000-000000000301",
      "delta": "**hello**"
    },
    {
      "type": "finalize_stream",
      "client_effect_id": "00000000-0000-7000-8000-000000000912",
      "message_id": "00000000-0000-7000-8000-000000000301"
    }
  ]
}
```

约束：

- `append_stream` / `update_message` / `disable_components` 只能操作 **本 Bot 创建** 的消息。
- `append_stream` 要求目标消息 `stream_state=streaming`。

---

### 5.6 Bot 离线策略

| Delivery kind | Bot 离线时 |
|---|---|
| `command_invocation` | 用户 invoke 前检测：返回 `BOT_OFFLINE`（`retryable=true`）。已 commit 后断连：短 TTL 标 failed |
| `message_interaction` | 同上 |
| `message_event` | Drop/expire，无用户可见错误 |

**Bot 必须保持 WS 常驻**，否则用户 slash command 会失败。

---

## 6. 消息 Components（Rich UI）

Bot 消息可携带交互组件。普通用户消息 **不能** 带 `components`。

### 6.1 Button

```json
{
  "component_id": "00000000-0000-7000-8000-000000000a01",
  "kind": "button",
  "style": "primary",
  "label": "确认",
  "custom_id": "confirm",
  "disabled": false
}
```

### 6.2 Select

```json
{
  "component_id": "00000000-0000-7000-8000-000000000a02",
  "kind": "select",
  "label": "选择装备",
  "custom_id": "pick_item",
  "disabled": false,
  "options": [
    { "value": "sword", "label": "长剑" }
  ]
}
```

| 枚举 | 值 |
|---|---|
| `kind` | `button` \| `select` |
| `style`（button） | `primary` \| `secondary` \| `danger` |

用户点击后，Chat 向 Bot 推送 `message_interaction` delivery，`component.value` 为按钮的 `true` 或 select 的选中 `value`。

---

## 7. Bot Actor 模型

Bot 发送的消息使用独立 actor，不伪装成普通用户：

```json
{
  "kind": "bot",
  "bot": {
    "bot_id": "00000000-0000-7000-8000-000000000601",
    "display_name": "Lilium Bot",
    "avatar_url": "https://example.com/bot.png"
  }
}
```

`display_name` / `avatar_url` 来自 `BotRegistry`（Chat 自有数据），不查 ToolBear 用户表。

---

## 8. 用户侧触发流程（Bot 开发者需了解）

以下 API **不是** Bot Token 调用，但决定 Bot 何时收到 delivery。

### 8.1 Slash Command 调用

用户在 Browser 客户端输入 `/ask` 后，前端发 Browser WS command：

```json
{
  "frame_type": "command",
  "command": "command.invoke",
  "command_id": "00000000-0000-7000-8000-000000000812",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "bot_command_id": "00000000-0000-7000-8000-000000000701",
    "invoked_name": "ai",
    "options": {
      "prompt": { "type": "string", "value": "hello" }
    }
  }
}
```

成功后 Chat 向 Bot WS 推 `command_invocation` delivery。Bot 离线时用户收到 `BOT_OFFLINE`。

### 8.2 UI Interaction 提交

```json
{
  "frame_type": "command",
  "command": "interaction.submit",
  "command_id": "00000000-0000-7000-8000-000000000a31",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "message_id": "00000000-0000-7000-8000-000000000301",
    "component_id": "00000000-0000-7000-8000-000000000a01",
    "custom_id": "confirm",
    "value": true
  }
}
```

### 8.3 查询可用 Command（Browser API）

频道成员可查询 prefix 补全（Bot 开发者调试时可用 browser JWT）：

```http
GET /api/chat/channels/{channel_id}/commands?prefix=as
Authorization: Bearer <browser_jwt>
```

---

## 9. 频道管理 API（Browser JWT，非 Bot Token）

Bot 开发者需协调频道管理员完成 command allow/block。

### 9.1 Allow / Block Command Binding

```http
PATCH /api/chat/channels/{channel_id}/commands/{bot_command_id}
Authorization: Bearer <browser_jwt>
Idempotency-Key: <uuidv7>
```

Allow：

```json
{
  "status": "allowed",
  "permission_override": "admin",
  "stateful_max_ttl_seconds": 3600
}
```

Block：

```json
{
  "status": "blocked"
}
```

每次更新递增 `command_manifest_version` 并 fanout `command.binding_updated`。

**实现状态**：✅

### 9.2 查询频道 Command Manifest

```http
GET /api/chat/channels/{channel_id}/commands?prefix=as
Authorization: Bearer <browser_jwt>
```

**实现状态**：✅

### 9.3 Stateful Session 状态与停止

```http
GET /api/chat/channels/{channel_id}/stateful-session
POST /api/chat/channels/{channel_id}/stateful-session/stop
```

Stop 请求体：`{ "session_id": "...", "reason": "admin_stop" }`。频道 owner/admin 或 session 发起者可 stop。

**实现状态**：✅

### 9.4 已移除：Bot 安装与被动订阅 API

以下端点已删除，请勿再集成：

- `POST/PATCH /api/chat/channels/{channel_id}/bot-installations`
- `PATCH .../bot-installations/{bot_id}/event-subscriptions/message.created`

Stateful command 的 `listen_capability` 取代独立的 `message.created` 被动订阅配置。

---

## 10. 错误码（Bot 相关）

| HTTP | Code | 说明 | Retryable |
|---|---|---|---|
| 401 | `UNAUTHORIZED` | Token 无效或已撤销 | 否 |
| 403 | `FORBIDDEN` | Scope 不足或非频道 admin | 否 |
| 404 | `BOT_NOT_FOUND` | Bot 不存在或未安装 | 否 |
| 404 | `COMMAND_NOT_FOUND` | Command binding 不存在或 `invoked_name` 不命中 | 否 |
| 409 | `BOT_COMMAND_DISABLED` | Catalog 中 command 已 disabled/deleted | 否 |
| 409 | `COMMAND_NAME_CONFLICT` | 频道内 slash 名称冲突 | 否 |
| 409 | `BOT_EFFECT_CONFLICT` | 同 `client_effect_id` 不同 effect body | 否 |
| 409 | `UNSUPPORTED_CHANNEL_KIND` | DM 等不支持的频道类型 | 否 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同幂等键不同请求体 | 否 |
| 422 | `INVALID_COMMAND_OPTIONS` | Command 参数校验失败 | 否 |
| 422 | `BOT_EFFECT_INVALID` | Effect 校验失败 | 否 |
| 503 | `BOT_OFFLINE` | Bot 未连接 Gateway WS | **是** |
| 503 | `CHAT_WORKER_UNAVAILABLE` | Worker 暂不可用 | **是** |

---

## 11. 推荐 Bot 进程架构

```
┌─────────────────────────────────────────┐
│ Bot Process                              │
│                                          │
│  1. 启动时 PUT /bot/commands 同步 catalog │
│  2. 连接 wss://.../api/chat/bot/ws       │
│  3. 发 hello → 收 ready                    │
│  4. 循环:                                 │
│     - 收 delivery → 处理 → delivery_result│
│     - 收 delivery_ack                      │
│     - 定期 ping                            │
│  5. 断线指数退避重连（带 last_received_   │
│     delivery_id）                          │
└─────────────────────────────────────────┘
```

**最小可用路径（当前实现）**：

1. ✅ 同步 command catalog
2. ✅ 建立并保持 Bot Gateway WS
3. ⏳ 等待 `command.invoke` 管线完成后才能响应用户 slash command
4. ⏳ 等待 `delivery_result` effect 管线完成后才能回复消息

---

## 12. 实现状态总览

| 端点 / 能力 | 状态 |
|---|---|
| `PUT /api/chat/bot/commands`（含 stateful execution） | ✅ |
| `GET /api/chat/bot/ws`（hello/ready + session 帧） | ✅ |
| Stateless `command.invoke` → bot delivery | ✅ |
| Stateful `command.invoke` → `session.start` / `session.input` | ✅ |
| `GET/POST .../stateful-session`（Browser） | ✅ |
| `PATCH .../commands/{bot_command_id}` allow/block | ✅ |
| `POST /api/chat/bots` Bot 开发者 API | ✅ |
| `GET /api/chat/commands/directory` | ✅ |
| `delivery_result` / `session.effects` → effect 应用 | ⏳ |
| `POST/PATCH .../bot-installations` | ❌ 已移除 |

Slash Command 后端 spec：[`docs/superpowers/specs/2026-06-28-lilium-chat-bot-spec-revised.md`](./superpowers/specs/2026-06-28-lilium-chat-bot-spec-revised.md)

---

## 13. 参考

- API Contract §9：[`docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`](./api-contract/2026-06-22-toolbear-chat-api-contract.md)
- 后端设计 § Bot：[`docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md`](./superpowers/specs/2026-06-22-lilium-chat-backend-design.md)
- Bot Gateway 协议常量：`src/contract/bot-gateway.ts`（`BOT_GATEWAY_API_VERSION = "lilium.chat.bot.v1"`）
- TypeScript 类型：`src/contract/bot-api.ts`
