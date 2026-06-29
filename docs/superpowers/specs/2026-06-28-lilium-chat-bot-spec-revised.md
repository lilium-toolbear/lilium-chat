# Lilium Chat Slash Command & Stateful Command Spec

**Status:** Greenfield implementation spec
**Audience:** implementation-planning agent
**Scope:** Bot runtime, slash command catalog, channel command allowlist, command manifest sync, command invocation, stateful command session
**Explicit constraint:** 数据库为空，不考虑迁移、兼容旧 Bot installation 数据、旧 event subscription 数据或旧 UI。

---

## 0. Existing Code Anchors

现有代码里已经有 `command.binding_updated`，本 spec 必须复用它，不新增 `channel.commands.updated`。

`command.binding_updated` 已在 `ChatEventType` 中定义，并且属于 domain timeline event。

它也已经被 replay management event 包含。

现有 payload 类型已经包含：

```ts
channel_id
bot_id
bot_command_id
binding_changes
actor
```

后端已有 `buildCommandBindingUpdatedPayload`。

---

# 1. Product Summary

Lilium Chat 的 Bot 产品面不暴露“安装 Bot”。

最终用户和频道管理员只理解一个对象：

```text
Slash Command
```

底层仍然保留 Bot 作为 runtime provider：

```text
Bot App
  → owns many slash commands
  → connects through Bot Gateway WS
  → receives command invocations and stateful session inputs
```

频道管理员只管理：

```text
允许哪些 command 在本频道使用
谁可以使用这些 command
stateful command 最长运行多久
当前 active stateful session 是否要停止
```

---

# 2. Goals

## 2.1 Product Goals

1. 一个 Bot 可以注册多个 slash commands。
2. 每个 command 有一个 canonical name 和多个 aliases。
3. canonical name + aliases 在全局唯一。
4. 频道管理员直接 allow/block command，不安装 Bot。
5. 频道初始化时读取完整 command manifest。
6. 用户输入 `/` 时前端只做本地过滤，不远端查询。
7. command binding 变更后，通过已有 `command.binding_updated` event 即时更新前端 manifest。
8. Stateful command 被用户显式调用后，创建频道级互斥 session。
9. Stateful session active 期间可以接收目标频道的新消息。
10. Stateful session 结束后立即停止接收消息。

## 2.2 Engineering Goals

1. 不做迁移。
2. 不保留旧 Bot installation 产品层。
3. 不引入 per-channel slash namespace。
4. 不在 slash palette 热路径查询 BotRegistry。
5. 不在每次输入 `/` 时查询远端 API。
6. `command.invoke` 仍由服务端做最终校验。
7. stateful session input 必须 durable，有 seq / ack / resume 语义。

---

# 3. Non-goals

v1 不做：

```text
Bot marketplace
Bot installation UI
Bot event subscription UI
Bot install link
per-channel command alias
per-channel command rename
per-channel slash token conflict resolution
Bot 常驻 message.created subscription
每次 slash prefix 输入都查 API
HTTP Bot 主动发消息主路径
多个 stateful command 同时监听同一频道
```

不新增：

```text
channel.commands.updated
bot_installations
channel_bot_event_subscriptions
channel_command_names
```

---

# 4. Core Model

## 4.1 Entity Model

```text
Bot App
  ├─ bot_id
  ├─ owner_user_id
  ├─ display profile
  ├─ tokens
  └─ commands[]

Bot Command
  ├─ bot_command_id
  ├─ bot_id
  ├─ canonical name
  ├─ aliases[]
  ├─ options schema
  ├─ default permission
  ├─ execution mode: stateless | stateful
  └─ stateful config if mode=stateful

Channel Command Binding
  ├─ channel_id
  ├─ bot_command_id
  ├─ status: allowed | blocked
  ├─ permission_override
  ├─ command_snapshot_json
  └─ stateful_max_ttl_seconds

Command Manifest
  ├─ channel_id
  ├─ version
  └─ allowed command items[]

Stateful Session
  ├─ session_id
  ├─ channel_id
  ├─ bot_id
  ├─ bot_command_id
  ├─ started_by_user_id
  ├─ status
  ├─ listen_rules
  ├─ input seq / ack
  └─ ttl / close reason
```

## 4.2 Product Invariants

```text
Bot 是 runtime provider。
Command 是频道和用户看到的产品对象。
一个 Bot 可以注册多个 commands。
Command slash token 全局唯一。
频道管理员只管理 command allow/block。
Stateful command 只有 active session 期间能读取目标频道新消息。
同一频道同一时间最多一个 active stateful session。
```

---

# 5. Slash Token Rules

## 5.1 Token Definition

`slash_token` 是 command 的 canonical name 或 alias。

存储时不带 `/`。

展示时前端加 `/`。

Example:

```text
stored token: ask
display: /ask
```

## 5.2 Normalization

所有 name 和 alias 在进入 BotRegistry 前必须 normalize。

Recommended normalization:

```ts
function normalizeSlashToken(input: string): string {
  return input
    .trim()
    .replace(/^\/+/, "")
    .normalize("NFKC")
    .toLowerCase()
}
```

Reject if:

```text
empty
length > 32 code points
contains whitespace
contains control characters
contains '/'
```

## 5.3 Global Uniqueness

`name + aliases` 共享同一个全局 namespace。

Examples:

```text
Bot A registers /ask
Bot B registers /ask
  → reject

Bot A registers /ask alias /ai
Bot B registers /ai
  → reject

Bot A registers /roll alias /dice
Bot B registers /random alias /dice
  → reject
```

Conflict error:

```json
{
  "error": {
    "code": "COMMAND_NAME_CONFLICT",
    "message": "Slash command name or alias is already registered.",
    "retryable": false,
    "conflict": {
      "slash_token": "ask",
      "existing_bot_command_id": "00000000-0000-7000-8000-000000000701",
      "existing_bot_id": "00000000-0000-7000-8000-000000000601"
    }
  }
}
```

---

# 6. Data Model

## 6.1 BotRegistry DO

### `bot_apps`

```sql
CREATE TABLE bot_apps (
  bot_id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  description TEXT,
  status TEXT NOT NULL,          -- active | disabled | deleted
  visibility TEXT NOT NULL,      -- private | unlisted | public | official
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### `bot_tokens`

```sql
CREATE TABLE bot_tokens (
  token_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
```

### `bot_commands`

```sql
CREATE TABLE bot_commands (
  bot_command_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  options_json TEXT NOT NULL,
  default_member_permission TEXT NOT NULL, -- member | admin | owner
  execution_mode TEXT NOT NULL,            -- stateless | stateful
  stateful_config_json TEXT,
  status TEXT NOT NULL,                    -- active | disabled | deleted
  schema_version INTEGER NOT NULL,
  definition_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### `bot_command_aliases`

```sql
CREATE TABLE bot_command_aliases (
  bot_command_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (bot_command_id, alias)
);
```

### `bot_command_names`

```sql
CREATE TABLE bot_command_names (
  slash_token TEXT PRIMARY KEY,
  bot_command_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- canonical | alias
  created_at TEXT NOT NULL
);
```

`bot_command_names` is the global slash namespace.

## 6.2 ChatChannel DO

### `channel_command_bindings`

```sql
CREATE TABLE channel_command_bindings (
  channel_id TEXT NOT NULL,
  bot_command_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  status TEXT NOT NULL,                    -- allowed | blocked
  permission_override TEXT,                -- member | admin | owner | NULL
  command_snapshot_json TEXT NOT NULL,
  stateful_max_ttl_seconds INTEGER,
  updated_by_user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, bot_command_id)
);
```

### `channel_meta` extension

```sql
ALTER TABLE channel_meta
ADD COLUMN command_manifest_version INTEGER NOT NULL DEFAULT 0;
```

## 6.3 Stateful Session Tables

### `stateful_command_sessions`

```sql
CREATE TABLE stateful_command_sessions (
  session_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  bot_command_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  started_by_user_id TEXT NOT NULL,
  status TEXT NOT NULL,                    -- starting | active | suspended | closing | closed | expired | failed
  listen_rules_json TEXT NOT NULL,
  input_next_seq INTEGER NOT NULL DEFAULT 1,
  input_last_acked_seq INTEGER NOT NULL DEFAULT 0,
  effect_last_acked_seq INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  summary_json TEXT
);
```

### Active session mutex

```sql
CREATE UNIQUE INDEX uniq_active_stateful_session_per_channel
ON stateful_command_sessions(channel_id)
WHERE status IN ('starting', 'active', 'suspended', 'closing');
```

### `stateful_session_inputs`

```sql
CREATE TABLE stateful_session_inputs (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_projection_json TEXT NOT NULL,
  status TEXT NOT NULL,                    -- pending | sent | acked | expired
  created_at TEXT NOT NULL,
  sent_at TEXT,
  acked_at TEXT,
  PRIMARY KEY (session_id, seq)
);
```

---

# 7. HTTP API Contract

## 7.1 Developer Bot API

Browser JWT required.

### Create Bot

```http
POST /api/chat/bots
Authorization: Bearer <browser_jwt>
Idempotency-Key: <uuidv7>
Content-Type: application/json
```

Request:

```json
{
  "display_name": "Lilium Bot",
  "avatar_url": null,
  "description": "Official assistant bot",
  "visibility": "private",
  "issue_initial_token": true,
  "initial_token_name": "local-dev"
}
```

Response:

```json
{
  "bot": {
    "bot_id": "00000000-0000-7000-8000-000000000601",
    "owner_user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "Lilium Bot",
    "avatar_url": null,
    "description": "Official assistant bot",
    "visibility": "private",
    "status": "active",
    "created_at": "2026-06-28T00:00:00Z",
    "updated_at": "2026-06-28T00:00:00Z"
  },
  "initial_token": {
    "token_id": "00000000-0000-7000-8000-000000000701",
    "name": "local-dev",
    "scopes": [
      "chat:runtime:connect",
      "chat:commands:manage"
    ],
    "plaintext": "lcbot_...",
    "created_at": "2026-06-28T00:00:00Z"
  }
}
```

Token plaintext is returned once.

### List My Bots

```http
GET /api/chat/bots
Authorization: Bearer <browser_jwt>
```

Response:

```json
{
  "items": [
    {
      "bot_id": "00000000-0000-7000-8000-000000000601",
      "display_name": "Lilium Bot",
      "avatar_url": null,
      "description": "Official assistant bot",
      "visibility": "private",
      "status": "active",
      "command_count": 3,
      "created_at": "2026-06-28T00:00:00Z",
      "updated_at": "2026-06-28T00:00:00Z"
    }
  ],
  "next_cursor": null
}
```

### Create Token

```http
POST /api/chat/bots/{bot_id}/tokens
Authorization: Bearer <browser_jwt>
Idempotency-Key: <uuidv7>
```

Request:

```json
{
  "name": "production",
  "scopes": [
    "chat:runtime:connect",
    "chat:commands:manage"
  ],
  "expires_at": null
}
```

Response:

```json
{
  "token": {
    "token_id": "00000000-0000-7000-8000-000000000702",
    "name": "production",
    "scopes": [
      "chat:runtime:connect",
      "chat:commands:manage"
    ],
    "plaintext": "lcbot_...",
    "created_at": "2026-06-28T00:00:00Z",
    "expires_at": null
  }
}
```

### Revoke Token

```http
DELETE /api/chat/bots/{bot_id}/tokens/{token_id}
Authorization: Bearer <browser_jwt>
Idempotency-Key: <uuidv7>
```

Response:

```json
{
  "token_id": "00000000-0000-7000-8000-000000000702",
  "revoked_at": "2026-06-28T00:00:00Z"
}
```

---

## 7.2 Bot Command Catalog Sync

Bot token required.

```http
PUT /api/chat/bot/commands
Authorization: Bearer <bot_token>
Idempotency-Key: <uuidv7>
Content-Type: application/json
```

Request:

```json
{
  "commands": [
    {
      "name": "ask",
      "aliases": ["ai"],
      "description": "Ask the assistant",
      "options": [
        {
          "name": "prompt",
          "type": "string",
          "required": true,
          "description": "Question"
        }
      ],
      "default_member_permission": "member",
      "execution": {
        "mode": "stateless"
      }
    },
    {
      "name": "werewolf",
      "aliases": ["ww", "狼人杀"],
      "description": "Start a werewolf game",
      "options": [
        {
          "name": "players",
          "type": "integer",
          "required": false,
          "min": 4,
          "max": 18,
          "description": "Expected player count"
        }
      ],
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
            "include_own_messages": false
          }
        }
      }
    }
  ]
}
```

Response:

```json
{
  "commands": [
    {
      "bot_command_id": "00000000-0000-7000-8000-000000000701",
      "name": "ask",
      "aliases": ["ai"],
      "schema_version": 1,
      "definition_hash": "sha256:..."
    },
    {
      "bot_command_id": "00000000-0000-7000-8000-000000000702",
      "name": "werewolf",
      "aliases": ["ww", "狼人杀"],
      "schema_version": 1,
      "definition_hash": "sha256:..."
    }
  ]
}
```

Catalog sync rules:

```text
Bot may register multiple commands.
Each command has one canonical name and zero or more aliases.
All canonical names and aliases are globally unique.
Any conflict rejects the entire request.
```

---

## 7.3 Command Directory

Browser JWT required.

Used by channel admins to search commands to allow.

```http
GET /api/chat/commands/directory?query=werewolf&limit=20&cursor=opaque
Authorization: Bearer <browser_jwt>
```

Response:

```json
{
  "items": [
    {
      "bot_command_id": "00000000-0000-7000-8000-000000000702",
      "name": "werewolf",
      "aliases": ["ww", "狼人杀"],
      "description": "Start a werewolf game",
      "bot": {
        "bot_id": "00000000-0000-7000-8000-000000000601",
        "display_name": "Lilium Bot",
        "avatar_url": null
      },
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
            "include_own_messages": false
          }
        }
      }
    }
  ],
  "next_cursor": null
}
```

---

## 7.4 Channel Bootstrap

Browser JWT required.

```http
GET /api/chat/channels/{channel_id}/bootstrap
Authorization: Bearer <browser_jwt>
```

Response includes:

```json
{
  "command_manifest": {
    "version": 12,
    "items": [
      {
        "bot_command_id": "00000000-0000-7000-8000-000000000701",
        "name": "ask",
        "aliases": ["ai"],
        "description": "Ask the assistant",
        "bot": {
          "bot_id": "00000000-0000-7000-8000-000000000601",
          "display_name": "Lilium Bot",
          "avatar_url": null
        },
        "options": [
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "description": "Question"
          }
        ],
        "effective_member_permission": "member",
        "execution": {
          "mode": "stateless"
        }
      }
    ]
  }
}
```

Bootstrap command manifest is built from `ChatChannel.channel_command_bindings`, not BotRegistry.

---

## 7.5 Get Full Channel Command Manifest

Browser JWT required.

```http
GET /api/chat/channels/{channel_id}/commands
Authorization: Bearer <browser_jwt>
```

Response:

```json
{
  "version": 12,
  "items": []
}
```

This endpoint returns the full manifest.

It must not be used as per-prefix search.

No `?prefix=` hot-path behavior is required.

---

## 7.6 Update Channel Command Binding

Browser JWT required. Channel owner/admin only.

```http
PATCH /api/chat/channels/{channel_id}/commands/{bot_command_id}
Authorization: Bearer <browser_jwt>
Idempotency-Key: <uuidv7>
Content-Type: application/json
```

Allow:

```json
{
  "status": "allowed",
  "permission_override": "member",
  "stateful_max_ttl_seconds": 3600
}
```

Block:

```json
{
  "status": "blocked"
}
```

Rules:

```text
Only channel owner/admin may update.
DM channels are not supported.
Allow reads command definition from BotRegistry.
Allow writes command_snapshot_json into ChatChannel.
Block removes item from command manifest.
Every update increments command_manifest_version.
Every update emits command.binding_updated with command_manifest_delta.
```

---

## 7.7 Stateful Session Status

```http
GET /api/chat/channels/{channel_id}/stateful-session
Authorization: Bearer <browser_jwt>
```

Response when no active session:

```json
{
  "active_session": null
}
```

Response with active session:

```json
{
  "active_session": {
    "session_id": "00000000-0000-7000-8000-000000000901",
    "bot_command_id": "00000000-0000-7000-8000-000000000702",
    "command_name": "werewolf",
    "status": "active",
    "started_by": {
      "user_id": "00000000-0000-7000-8000-000000000101",
      "display_name": "Alice",
      "avatar_url": null
    },
    "started_at": "2026-06-28T00:00:00Z",
    "expires_at": "2026-06-28T01:00:00Z"
  }
}
```

---

## 7.8 Stop Stateful Session

```http
POST /api/chat/channels/{channel_id}/stateful-session/stop
Authorization: Bearer <browser_jwt>
Idempotency-Key: <uuidv7>
Content-Type: application/json
```

Request:

```json
{
  "session_id": "00000000-0000-7000-8000-000000000901",
  "reason": "admin_stop"
}
```

Rules:

```text
Channel owner/admin may stop any session.
Session starter may request stop for own session.
Stop releases channel mutex.
Stop emits stateful_session.closed.
Stop notifies Bot Gateway WS.
```

---

# 8. Event Contract

## 8.1 `command.binding_updated`

Use existing event type.

Greenfield v1 makes `command_manifest_delta` required.

Payload:

```ts
type CommandBindingUpdatedEventPayload = {
  channel_id: ChatId
  bot_id: ChatId
  bot_command_id: ChatId
  binding_changes: Record<string, FieldChange<unknown>>
  actor?: UserSummary | null

  command_manifest_delta: {
    op: "upsert" | "remove"
    manifest_version: number
    item?: CommandManifestItem
  }
}
```

### Allow event

```json
{
  "frame_type": "event",
  "type": "command.binding_updated",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "event_id": "01J...",
  "payload": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "bot_id": "00000000-0000-7000-8000-000000000601",
    "bot_command_id": "00000000-0000-7000-8000-000000000701",
    "binding_changes": {
      "status": {
        "before": "blocked",
        "after": "allowed"
      }
    },
    "actor": {
      "user_id": "00000000-0000-7000-8000-000000000101",
      "display_name": "Alice",
      "avatar_url": null
    },
    "command_manifest_delta": {
      "op": "upsert",
      "manifest_version": 13,
      "item": {
        "bot_command_id": "00000000-0000-7000-8000-000000000701",
        "name": "ask",
        "aliases": ["ai"],
        "description": "Ask the assistant",
        "bot": {
          "bot_id": "00000000-0000-7000-8000-000000000601",
          "display_name": "Lilium Bot",
          "avatar_url": null
        },
        "options": [],
        "effective_member_permission": "member",
        "execution": {
          "mode": "stateless"
        }
      }
    }
  }
}
```

### Block event

```json
{
  "frame_type": "event",
  "type": "command.binding_updated",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "event_id": "01J...",
  "payload": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "bot_id": "00000000-0000-7000-8000-000000000601",
    "bot_command_id": "00000000-0000-7000-8000-000000000701",
    "binding_changes": {
      "status": {
        "before": "allowed",
        "after": "blocked"
      }
    },
    "actor": {
      "user_id": "00000000-0000-7000-8000-000000000101",
      "display_name": "Alice",
      "avatar_url": null
    },
    "command_manifest_delta": {
      "op": "remove",
      "manifest_version": 14
    }
  }
}
```

## 8.2 Stateful Session Events

Add new event types:

```text
stateful_session.started
stateful_session.updated
stateful_session.closed
```

These are channel-visible management events.

### `stateful_session.started`

```json
{
  "frame_type": "event",
  "type": "stateful_session.started",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "event_id": "01J...",
  "payload": {
    "session": {
      "session_id": "00000000-0000-7000-8000-000000000901",
      "bot_command_id": "00000000-0000-7000-8000-000000000702",
      "command_name": "werewolf",
      "status": "active",
      "started_by": {
        "user_id": "00000000-0000-7000-8000-000000000101",
        "display_name": "Alice",
        "avatar_url": null
      },
      "started_at": "2026-06-28T00:00:00Z",
      "expires_at": "2026-06-28T01:00:00Z"
    }
  }
}
```

### `stateful_session.closed`

```json
{
  "frame_type": "event",
  "type": "stateful_session.closed",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "event_id": "01J...",
  "payload": {
    "session_id": "00000000-0000-7000-8000-000000000901",
    "bot_command_id": "00000000-0000-7000-8000-000000000702",
    "command_name": "werewolf",
    "status": "closed",
    "reason": "completed",
    "closed_at": "2026-06-28T00:45:00Z"
  }
}
```

---

# 9. Browser WS Contract

## 9.1 `command.invoke`

Browser sends:

```json
{
  "frame_type": "command",
  "command": "command.invoke",
  "command_id": "00000000-0000-7000-8000-000000000812",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "bot_command_id": "00000000-0000-7000-8000-000000000702",
    "invoked_name": "ww",
    "command_manifest_version": 13,
    "options": {
      "players": {
        "type": "integer",
        "value": 8
      }
    }
  }
}
```

`bot_command_id` is the primary command locator.

`invoked_name` records which canonical name or alias the user typed.

## 9.2 Stateless Success Ack

```json
{
  "frame_type": "command_ack",
  "command": "command.invoke",
  "command_id": "00000000-0000-7000-8000-000000000812",
  "status": "committed",
  "payload": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "invocation_id": "00000000-0000-7000-8000-000000000811",
    "event_id": "01J..."
  }
}
```

## 9.3 Stateful Success Ack

```json
{
  "frame_type": "command_ack",
  "command": "command.invoke",
  "command_id": "00000000-0000-7000-8000-000000000812",
  "status": "committed",
  "payload": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "invocation_id": "00000000-0000-7000-8000-000000000811",
    "session_id": "00000000-0000-7000-8000-000000000901",
    "event_id": "01J..."
  }
}
```

## 9.4 Errors

### Command no longer allowed

```json
{
  "frame_type": "command_error",
  "command": "command.invoke",
  "command_id": "00000000-0000-7000-8000-000000000812",
  "error": {
    "code": "COMMAND_NOT_ALLOWED",
    "message": "This slash command is not allowed in this channel.",
    "retryable": false,
    "current_command_manifest_version": 14
  }
}
```

### Permission denied

```json
{
  "frame_type": "command_error",
  "command": "command.invoke",
  "command_id": "00000000-0000-7000-8000-000000000812",
  "error": {
    "code": "COMMAND_PERMISSION_DENIED",
    "message": "You do not have permission to use this command.",
    "retryable": false
  }
}
```

### Stateful busy

```json
{
  "frame_type": "command_error",
  "command": "command.invoke",
  "command_id": "00000000-0000-7000-8000-000000000812",
  "error": {
    "code": "STATEFUL_SESSION_BUSY",
    "message": "Another stateful command is active in this channel.",
    "retryable": false,
    "active_session": {
      "session_id": "00000000-0000-7000-8000-000000000901",
      "bot_command_id": "00000000-0000-7000-8000-000000000702",
      "command_name": "werewolf",
      "started_by": {
        "user_id": "00000000-0000-7000-8000-000000000101",
        "display_name": "Alice",
        "avatar_url": null
      },
      "started_at": "2026-06-28T00:00:00Z",
      "expires_at": "2026-06-28T01:00:00Z"
    }
  }
}
```

### Bot offline

```json
{
  "frame_type": "command_error",
  "command": "command.invoke",
  "command_id": "00000000-0000-7000-8000-000000000812",
  "error": {
    "code": "BOT_OFFLINE",
    "message": "The bot is currently offline.",
    "retryable": true
  }
}
```

---

# 10. Bot Gateway WS Contract

## 10.1 Connect

Bot connects:

```http
GET /api/chat/bot/ws
Authorization: Bearer <bot_token>
```

Bot token must have:

```text
chat:runtime:connect
```

## 10.2 Stateless Delivery

Chat sends:

```json
{
  "type": "delivery",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "00000000-0000-7000-8000-000000000901",
  "delivery_type": "command_invocation",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "bot_command": {
    "bot_command_id": "00000000-0000-7000-8000-000000000701",
    "name": "ask",
    "invoked_name": "ask",
    "schema_version": 1,
    "definition_hash": "sha256:..."
  },
  "invoker": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "Alice",
    "avatar_url": null
  },
  "options": {
    "prompt": {
      "type": "string",
      "value": "hello"
    }
  }
}
```

Bot replies:

```json
{
  "type": "delivery_result",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "00000000-0000-7000-8000-000000000901",
  "status": "ok",
  "effects": [
    {
      "type": "send_message",
      "client_effect_id": "00000000-0000-7000-8000-000000000991",
      "message": {
        "type": "text",
        "format": "markdown",
        "text": "Hello",
        "reply_to_message_id": null,
        "attachment_ids": [],
        "components": []
      }
    }
  ]
}
```

## 10.3 Stateful `session.start`

Chat sends:

```json
{
  "type": "session.start",
  "api_version": "lilium.chat.bot.v1",
  "session_id": "00000000-0000-7000-8000-000000000901",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "bot_command": {
    "bot_command_id": "00000000-0000-7000-8000-000000000702",
    "name": "werewolf",
    "invoked_name": "ww",
    "schema_version": 1,
    "definition_hash": "sha256:..."
  },
  "invoker": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "Alice",
    "avatar_url": null
  },
  "options": {
    "players": {
      "type": "integer",
      "value": 8
    }
  },
  "listen_rules": {
    "message_types": ["text"],
    "include_bot_messages": false,
    "include_own_messages": false
  },
  "input_seq_start": 1,
  "expires_at": "2026-06-28T01:00:00Z"
}
```

Bot replies:

```json
{
  "type": "session.start_ack",
  "api_version": "lilium.chat.bot.v1",
  "session_id": "00000000-0000-7000-8000-000000000901"
}
```

## 10.4 Stateful `session.input`

Chat sends one input for each matching new channel message:

```json
{
  "type": "session.input",
  "api_version": "lilium.chat.bot.v1",
  "session_id": "00000000-0000-7000-8000-000000000901",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "seq": 12,
  "event": {
    "event_id": "01J...",
    "type": "message.created",
    "occurred_at": "2026-06-28T00:05:00Z"
  },
  "message": {
    "message_id": "00000000-0000-7000-8000-000000000301",
    "sender": {
      "kind": "user",
      "user": {
        "user_id": "00000000-0000-7000-8000-000000000102",
        "display_name": "Bob",
        "avatar_url": null
      }
    },
    "type": "text",
    "text": "我加入",
    "created_at": "2026-06-28T00:05:00Z"
  }
}
```

Bot replies:

```json
{
  "type": "session.input_ack",
  "api_version": "lilium.chat.bot.v1",
  "session_id": "00000000-0000-7000-8000-000000000901",
  "last_received_seq": 12
}
```

## 10.5 Stateful `session.effects`

Bot sends:

```json
{
  "type": "session.effects",
  "api_version": "lilium.chat.bot.v1",
  "session_id": "00000000-0000-7000-8000-000000000901",
  "effect_seq": 7,
  "effects": [
    {
      "type": "send_message",
      "client_effect_id": "00000000-0000-7000-8000-000000000991",
      "message": {
        "type": "text",
        "format": "markdown",
        "text": "Bob joined the game.",
        "reply_to_message_id": null,
        "attachment_ids": [],
        "components": []
      }
    }
  ]
}
```

Chat replies:

```json
{
  "type": "session.effects_ack",
  "api_version": "lilium.chat.bot.v1",
  "session_id": "00000000-0000-7000-8000-000000000901",
  "effect_seq": 7,
  "status": "applied"
}
```

## 10.6 Stateful `session.close`

Bot sends:

```json
{
  "type": "session.close",
  "api_version": "lilium.chat.bot.v1",
  "session_id": "00000000-0000-7000-8000-000000000901",
  "reason": "completed",
  "summary": {
    "winner": "villagers"
  }
}
```

Chat replies:

```json
{
  "type": "session.closed",
  "api_version": "lilium.chat.bot.v1",
  "session_id": "00000000-0000-7000-8000-000000000901",
  "status": "closed",
  "reason": "completed"
}
```

---

# 11. Frontend Spec

## 11.1 Store

```ts
type ChannelCommandManifest = {
  channelId: string
  version: number
  items: CommandManifestItem[]
  loadedAt: string
  syncState: "ready" | "refreshing" | "failed"
}
```

## 11.2 Bootstrap

When entering a channel:

```text
GET /api/chat/channels/{channel_id}/bootstrap
store command_manifest
```

## 11.3 Slash Palette

When user types `/`:

```text
read manifest from store
filter locally
do not call remote API
```

Filter rules:

```text
canonical name startsWith(input)
alias startsWith(input)
optional fuzzy match allowed
```

## 11.4 Event Handling

On `command.binding_updated`:

```ts
function onCommandBindingUpdated(event) {
  const channelId = event.payload.channel_id
  const delta = event.payload.command_manifest_delta

  if (delta.op === "upsert") {
    upsertManifestItem(channelId, delta.manifest_version, delta.item)
    return
  }

  if (delta.op === "remove") {
    removeManifestItem(channelId, delta.manifest_version, event.payload.bot_command_id)
    return
  }
}
```

Version rules:

```text
delta.version == local.version + 1
  apply

delta.version <= local.version
  ignore

delta.version > local.version + 1
  immediately refresh full manifest
```

No defer behavior is allowed.

Do not wait until slash palette is opened again.

## 11.5 Active Stateful Session UI

Channel view should show a banner when active session exists:

```text
/werewolf is active
Started by Alice
Ends in 42m
This command can read new messages while active.
[View] [Stop]
```

Rules:

```text
Admin can stop.
Session starter can request stop.
Other members can view.
```

---

# 12. Backend Flow Spec

## 12.1 Bot Command Sync

Flow:

```text
Worker
  → verify bot token
  → route to BotRegistry
  → normalize all command names and aliases
  → validate request-local uniqueness
  → validate global bot_command_names uniqueness
  → write bot_commands
  → write bot_command_aliases
  → write bot_command_names
  → return command ids and definition hashes
```

## 12.2 Allow Command

Flow:

```text
Worker
  → verify Browser JWT
  → verify channel owner/admin
  → ChatChannel receives PATCH
  → ChatChannel calls BotRegistry to read command definition
  → ChatChannel writes channel_command_bindings
  → ChatChannel increments command_manifest_version
  → ChatChannel builds command manifest item from snapshot
  → ChatChannel emits command.binding_updated with upsert delta
  → ChannelFanout broadcasts event
```

## 12.3 Block Command

Flow:

```text
Worker
  → verify Browser JWT
  → verify channel owner/admin
  → ChatChannel updates binding status=blocked
  → ChatChannel increments command_manifest_version
  → ChatChannel emits command.binding_updated with remove delta
  → ChannelFanout broadcasts event
```

## 12.4 Bootstrap Manifest

Flow:

```text
Worker
  → verify Browser JWT
  → ChatChannel checks membership
  → ChatChannel reads allowed channel_command_bindings
  → ChatChannel projects command_manifest
  → returns bootstrap
```

No BotRegistry call.

## 12.5 Stateless Command Invoke

Flow:

```text
Browser WS command.invoke
  → UserConnection
  → ChatChannel
  → check idempotency
  → check channel membership
  → read binding by bot_command_id
  → require status=allowed
  → validate user role against permission
  → validate options against command_snapshot_json
  → check BotConnection online
  → create command invocation row
  → emit command.invoked
  → enqueue delivery to BotConnection
  → return committed ack
```

## 12.6 Stateful Command Invoke

Flow:

```text
Browser WS command.invoke
  → UserConnection
  → ChatChannel
  → check idempotency
  → check binding and permission
  → validate execution.mode=stateful
  → acquire channel mutex via unique active session constraint
  → create stateful_command_session status=starting
  → emit stateful_session.started or pending event
  → send session.start to BotConnection
  → return committed ack with session_id
```

When Bot sends `session.start_ack`:

```text
BotConnection
  → ChatChannel mark session active
  → fanout stateful_session.started if not already broadcast as active
```

## 12.7 New Message During Active Stateful Session

Flow:

```text
Browser WS message.send
  → ChatChannel writes normal message
  → ChatChannel emits message.created
  → ChatChannel checks active stateful session
  → if active and message matches listen_rules:
       insert stateful_session_inputs seq=input_next_seq
       increment input_next_seq
       enqueue session.input to BotConnection
```

Message remains visible in timeline.

No consume / hidden input behavior in v1.

## 12.8 Session Input Ack

Flow:

```text
BotConnection receives session.input_ack
  → ChatChannel updates input_last_acked_seq
  → marks inputs <= seq acked
```

## 12.9 Session Close

Flow:

```text
Bot sends session.close
or admin calls stop API
or TTL fires
or Bot offline grace expires
  → ChatChannel marks session closed/expired/failed
  → releases mutex by status transition
  → emits stateful_session.closed
  → notifies Bot if close was server initiated
```

---

# 13. Security and Permission Rules

## 13.1 Bot Developer

```text
Create bot: Browser JWT user
Update bot: owner_user_id only
Create/revoke token: owner_user_id only
Sync commands: bot token with chat:commands:manage
Connect gateway: bot token with chat:runtime:connect
```

## 13.2 Channel Admin

```text
Allow/block command: channel owner/admin
Set permission override: channel owner/admin
Set stateful max TTL: channel owner/admin
Stop any active stateful session: channel owner/admin
```

## 13.3 Member

```text
View command manifest: active channel member
Invoke command: active channel member + command permission
Stop own session: session starter
```

## 13.4 Stateful Privacy Rules

```text
No history access.
No DM access.
Only target channel.
Only messages after session start.
Only while session is active.
Only message types allowed by command listen_capability.
Bot may narrow listen_rules but not widen them.
Session close immediately stops input delivery.
```

## 13.5 Rate Limits

Recommended defaults:

```text
1 active stateful session per channel
default stateful TTL: 3600 seconds
max stateful TTL: 7200 seconds
Bot offline grace: 120 seconds
max pending inputs per session: 1000
per-user command.invoke rate limit
per-bot effects rate limit
```

---

# 14. Error Codes

```text
COMMAND_NAME_CONFLICT
COMMAND_NOT_FOUND
COMMAND_NOT_ALLOWED
COMMAND_PERMISSION_DENIED
COMMAND_OPTIONS_INVALID
COMMAND_MANIFEST_VERSION_STALE
BOT_NOT_FOUND
BOT_DISABLED
BOT_OFFLINE
STATEFUL_SESSION_BUSY
STATEFUL_SESSION_NOT_FOUND
STATEFUL_SESSION_NOT_ACTIVE
STATEFUL_SESSION_PERMISSION_DENIED
STATEFUL_SESSION_EXPIRED
STATEFUL_INPUT_BACKLOG_OVERFLOW
BOT_TOKEN_INVALID
BOT_TOKEN_REVOKED
BOT_SCOPE_DENIED
```

---

# 15. Testing Requirements

## 15.1 BotRegistry Tests

```text
[ ] Bot can register multiple commands.
[ ] name conflict rejects sync.
[ ] alias conflict rejects sync.
[ ] request-local duplicate token rejects sync.
[ ] same command can update aliases when no conflict.
[ ] bot_command_names is transactionally consistent.
```

## 15.2 Channel Binding Tests

```text
[ ] admin can allow command.
[ ] non-admin cannot allow command.
[ ] block removes command from manifest.
[ ] allow writes command_snapshot_json.
[ ] each binding update increments command_manifest_version.
[ ] binding update emits command.binding_updated.
[ ] event includes command_manifest_delta.
```

## 15.3 Manifest Tests

```text
[ ] bootstrap returns command_manifest.
[ ] GET /channels/{id}/commands returns full manifest.
[ ] slash prefix search is not required server-side.
[ ] manifest is built from ChatChannel local snapshot.
[ ] no BotRegistry call on bootstrap hot path.
```

## 15.4 Frontend Tests

```text
[ ] entering channel stores manifest.
[ ] typing / filters locally.
[ ] no API call during prefix typing.
[ ] command.binding_updated upsert adds/updates item immediately.
[ ] command.binding_updated remove removes item immediately.
[ ] version gap triggers immediate full manifest refresh.
[ ] no defer-until-palette-open behavior.
```

## 15.5 Stateless Command Tests

```text
[ ] allowed command invokes successfully.
[ ] blocked command returns COMMAND_NOT_ALLOWED.
[ ] insufficient role returns COMMAND_PERMISSION_DENIED.
[ ] invalid options return COMMAND_OPTIONS_INVALID.
[ ] offline bot returns BOT_OFFLINE.
[ ] successful invoke creates command.invoked event.
```

## 15.6 Stateful Command Tests

```text
[ ] stateful command creates session.
[ ] second stateful command in same channel returns STATEFUL_SESSION_BUSY.
[ ] stateless command can run while stateful session is active.
[ ] new channel messages create session.input.
[ ] session.input seq increments monotonically.
[ ] input_ack marks inputs acked.
[ ] admin stop closes session and releases mutex.
[ ] TTL expiry closes session and releases mutex.
[ ] closed session no longer receives messages.
```

---

# 16. Implementation Planning Notes for Agent

The implementation plan should be organized by modules, not by product discussion history.

Recommended task groups:

```text
1. Contract types
2. BotRegistry schema and routes
3. Channel command binding schema and routes
4. command.binding_updated delta payload
5. Bootstrap command manifest
6. Browser WS command.invoke validation
7. Bot Gateway stateless delivery/effects
8. Stateful session schema and mutex
9. Bot Gateway session frames
10. Frontend manifest store and slash palette
11. Channel Settings → Slash Commands UI
12. Active stateful session UI
13. Tests
```

Do not include migration tasks.

Do not include Bot installation tasks.

Do not include Bot event subscription tasks.

Do not include per-prefix command search tasks.

---

# 17. Final Normative Summary

```text
Lilium Chat Bot v1 exposes Slash Command as the product object.

A Bot may register many commands.
Each command has a globally unique canonical name and globally unique aliases.
Channel admins allow or block commands directly.
The channel command manifest is loaded during bootstrap.
Slash palette filtering is local.
Binding updates use existing command.binding_updated events.
The event directly carries manifest delta.
Frontend applies the delta immediately.
Stateful commands create explicit channel-level sessions.
A stateful session can read new target-channel messages only while active.
Only one stateful session may be active per channel.
No migration or compatibility layer is required because the database is empty.
```
