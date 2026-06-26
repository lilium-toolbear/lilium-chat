# UserConnection Live Fanout Redesign (Without WS Cursor Recovery)

状态：设计稿（v1.2）
日期：2026-06-27
范围：lilium-chat `UserConnection` / `ChannelFanout` WebSocket live push 架构重构
权威来源：

- 故障分析：`2026-06-26 UserConnection GB-sec / stale online_sessions` 调查结论
- API contract：`docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`（v2.11）
- 实施计划：`docs/superpowers/plans/2026-06-27-lilium-chat-phase-8-live-subscription.md`

## 0. 设计目标

### 0.1 v1 模型

```text
WS  = best-effort live push（用户全部 active 频道的新事件）
HTTP = authoritative bootstrap / history / replay / gap recovery
```

保留的产品行为：

```text
- Browser WebSocket 自动接收用户所有 active 成员频道的新事件
- 前端频道列表可在任意 joined 频道收到新消息时立即更新
- 当前打开频道的时间线可直接应用同一 WS event
```

移除的不安全行为：

```text
- UserConnection connect 期间不做 replay
- WS connect 不解析 per-channel cursor
- WS 内不做 gap repair
- 不使用 ctx.waitUntil() 做有副作用的 DO 连接初始化
- 不以 WebSocket attachment subscribed_channels 作为清理依据
```

### 0.2 根因（背景）

旧实现在 `acceptWebSocket()` 后通过 `ctx.waitUntil()` fire-and-forget 执行 `registerOnlineOnConnect()`：跨 DO 写 `ChannelFanout.online_sessions` 并 replay，而 `webSocketClose` 依赖 `attachment.subscribed_channels` 清理。连接在初始化期间 canceled/closed 时产生 stale fanout target，放大 DO duration 与 deliver 噪音。

本设计用 **`session.live_start`（同步 WS command）** 替代 connect 隐式注册，用 **`live_channel_leases` SQLite 表** 替代 attachment 清理，用 **lease TTL + deliver stale cleanup** 收敛 fanout cache。

## 1. DO 职责

```text
UserConnection DO(user_id)
  = 用户 WebSocket session 权威 owner
  = live_sessions + live_channel_leases 事实来源

ChannelFanout DO(channel_id)
  = per-channel live fanout delivery
  = fanout_leases（临时 cache，非权威在线状态）

ChatChannel DO(channel_id)
  = channel events / message projections 权威来源

UserDirectory DO(user_id)
  = my_channels / read-state / 用户本地频道投影
```

## 2. WebSocket Connect

`GET /api/chat/ws`（经 Worker 代理）**只做**：

1. 创建 `session_id`
2. 插入 `live_sessions(status='open')`
3. `acceptWebSocket(server)`
4. `serializeAttachment({ user_id, session_id })`
5. 返回 `101`，子协议 `lilium.chat.v2`

**禁止**在 connect 期间：

- 调用 `UserDirectory /my-channels`
- 调用 `ChannelFanout /register-online` 或 `/lease-upsert`
- 调用 `ChatChannel /internal/summary` 或 `/internal/replay`
- 发送 replay 事件
- 解析或应用 `?cursors=`（旧客户端传入则 **忽略**，不得用于 replay）
- 使用 `ctx.waitUntil()`

Live fanout 在客户端发送 `session.live_start` 后建立（见 §4）。

## 3. UserConnection Schema

```sql
CREATE TABLE IF NOT EXISTS live_sessions (
  session_id      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('open', 'live', 'closed')),
  opened_at       TEXT NOT NULL,
  live_started_at TEXT,
  last_seen_at    TEXT NOT NULL,
  closed_at       TEXT,
  close_reason    TEXT
);

CREATE TABLE IF NOT EXISTS live_channel_leases (
  session_id           TEXT NOT NULL,
  channel_id           TEXT NOT NULL,
  route_name           TEXT NOT NULL,
  lease_id             TEXT NOT NULL,
  membership_version   INTEGER NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  expires_at           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (session_id, channel_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_live_channel_leases_lease
  ON live_channel_leases(lease_id);

CREATE INDEX IF NOT EXISTS idx_live_channel_leases_session_status
  ON live_channel_leases(session_id, status);
```

规则：

- `live_channel_leases` 是 close 清理的本地权威来源；**不得**用 attachment 字段作订阅列表
- `lease_id` 对 `(session_id, channel_id)` 在单次 live session 内稳定；重复 `session.live_start` **复用**已有 lease 行

**不引入** `pending_live_events`、`syncing` 状态机、per-channel `channel.subscribe`（v1 non-goal）。

## 4. WS Commands

### 4.1 `session.live_start`

WebSocket `open` 后，socket manager **自动**发送（非用户可见、非 per-channel 操作）。

流程：

```text
Browser → UserConnection(session.live_start)
  ├─ 校验 live_sessions.status IN ('open', 'live')
  ├─ UserDirectory /my-channels（active memberships）
  ├─ 对每个 active channel：
  │    ├─ resolve route_name
  │    ├─ create or reuse live_channel_leases(session_id, channel_id, membership_version)
  │    └─ ChannelFanout(channel_id) /lease-upsert
  ├─ live_sessions.status = 'live', live_started_at = now
  └─ command_ack
```

规则：

- **不得**使用 `ctx.waitUntil`
- **不得**调用 ChatChannel replay API
- **不得**发送历史 event
- 对同一 session **幂等**；不同 `command_id` 重试不得为同一 `(session_id, channel_id)` 创建重复 lease
- 频道在 setup 时已非 active → skip，并删除该 channel 的本地 lease（若存在）
- 部分 channel lease 瞬态失败 → 返回 `CHAT_WORKER_UNAVAILABLE`（除非实现可证明确定性 partial retry）

Ack payload：`{ session_id, subscribed_channel_count, lease_expires_at }`

### 4.2 `session.heartbeat`

低频发送（推荐间隔 4 分钟；lease TTL 10 分钟）。

流程：

```text
Browser → UserConnection(session.heartbeat)
  ├─ 校验 session open/live
  ├─ 更新 live_sessions.last_seen_at
  ├─ 从 UserDirectory /my-channels 重载当前 active memberships
  ├─ 对本地 status='active' 的 live_channel_leases：
  │    ├─ 若 channel_id 不在 active set → 标 closed，best-effort /lease-revoke，不 upsert
  │    └─ 若仍 active → 延长 expires_at；若 membership_version 升高则写回本地行并 upsert
  └─ command_ack { session_id, lease_expires_at }
```

规则：

- **不得** blind refresh 全部本地 active lease；刷新/upsert 前 **必须** 以当前 active membership 集过滤（或仅处理未被 `/deliver` 标 closed 的 lease，且 **不得** re-upsert `status='closed'` 行）。
- 因 `membership_not_active` / `membership_stale` 被 ChannelFanout 删除的 lease，或本地已标 `closed` 的 lease，**不得**被 heartbeat 复活。
- 不 replay、不检查 cursor、不 gap repair。Session 未 live → `SESSION_NOT_LIVE`。

### 4.3 无 `channel.subscribe`（v1）

v1 **不暴露** `channel.subscribe` / `channel.unsubscribe`。连接并在 `session.live_start` 成功后，live WS 接收用户全部 active 成员频道的新事件。客户端按 `event.channel_id` 决定更新 sidebar 或 active timeline。

### 4.4 `channel.mark_read`（不变，语义澄清）

`channel.mark_read` 仍是用户 read-state mutation。`last_read_event_id` 表示用户已读到的 event，**不是** WS delivery cursor，**不用于** WS replay、重连恢复、fanout lease 刷新或 gap repair。服务端保持 `(user_id, channel_id)` 单调前进，并向该用户所有 live session 广播 `read_state_updated`。

## 5. ChannelFanout：`fanout_leases`

替换 `online_sessions`：

```sql
CREATE TABLE IF NOT EXISTS fanout_leases (
  channel_id          TEXT NOT NULL,
  lease_id            TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  membership_version  INTEGER NOT NULL,
  expires_at          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  last_error          TEXT,
  PRIMARY KEY (channel_id, lease_id)
);

CREATE INDEX IF NOT EXISTS idx_fanout_leases_session
  ON fanout_leases(session_id);

CREATE INDEX IF NOT EXISTS idx_fanout_leases_expires
  ON fanout_leases(channel_id, expires_at);
```

内部 API：

| 端点 | 说明 |
|---|---|
| `POST /lease-upsert` | 幂等 `(channel_id, lease_id)`；server cap `expires_at` |
| `POST /lease-revoke` | 按 `lease_id` 删除 |
| `POST /lease-revoke-session` | 按 `session_id` best-effort 批量删除 |

旧 `/register-online`、`/unregister-online` → `410 Gone`，不得再写 live target。

## 6. Deliver 与自愈

投递前删除过期 lease。对每个未过期 lease 调 `UserConnection /deliver`：

```json
{
  "lease_id": "...",
  "channel_id": "...",
  "session_id": "...",
  "event_id": "...",
  "membership_version_at_event": 12,
  "event_json": "..."
}
```

`/deliver` 规则：

- 查 `live_sessions`、`live_channel_leases`（`status='active'`）、WebSocket by `session_id`
- **不得**更新 replay cursor、不得 HTTP recovery、不得创建 lease
- 若 `membership_version_at_event > lease.membership_version`，**必须**在 `ws.send` 前 re-check 当前 membership（UserDirectory 或 ChatChannel summary）
- 若 membership **不** active：
  - `live_channel_leases(session_id, channel_id).status = 'closed'`
  - 返回 `{ delivered: false, reason: "membership_not_active" }`
- 若 membership 仍 active 但 version 落后：
  - 将本地 `live_channel_leases.membership_version` 更新为当前 version（并 upsert fanout lease 可选，下次 heartbeat 也会同步）
  - 通过 refreshed 授权检查后才 `ws.send`
- 成功 → `{ delivered: true }`；其它失败 → `{ delivered: false, reason: "..." }`

以下 `reason` 触发 ChannelFanout **删除 lease**：

`session_not_found`, `session_closed`, `lease_not_found`, `lease_closed`, `socket_not_found`, `socket_send_failed`, `membership_not_active`, `membership_stale`

## 7. Close / Error

`webSocketClose` / `webSocketError`：

1. 从 `live_channel_leases` 加载 `session_id` 行
2. `live_sessions.status = 'closed'`
3. 本地 leases `status = 'closed'`
4. Best-effort `ChannelFanout /lease-revoke` 每条

清理失败时靠 lease TTL、过期 prune、deliver stale cleanup 收敛。

## 8. 成员变更与 `membership_version`

`live_channel_leases.membership_version` 与 `fanout_leases.membership_version` 在 lease 创建/`session.live_start` 时取自 `UserDirectory /my-channels` 的 `membership_version`。

**Version 更新策略（normative）：**

| 场景 | 行为 |
|---|---|
| 成员仍 active，version 仅升高（role 变更等） | `/deliver` 或 `session.heartbeat` re-check 通过后 **写回** 本地 lease + fanout upsert 新 version |
| 成员已 leave/remove | `/deliver` 或 `session.heartbeat` **标 closed** + revoke；不得再 upsert |
| `session.live_start` 重试 | 复用 `(session_id, channel_id)` lease 行；若 version 变化则更新字段后 upsert |

成员 join/leave 后 UserDirectory 投影更新。在线 session：

- **新加入频道**：下次 `session.heartbeat`（重载 my-channels）或客户端重发 `session.live_start` 创建 lease
- **离开频道**：**不得**依赖 lease TTL 单独收敛——`session.heartbeat` 必须关闭非 active lease；`/deliver` membership 失败也必须关闭本地 lease，防止 heartbeat 复活

正确性不依赖即时 membership push；HTTP bootstrap 仍为权威。Live push 授权边界：**非 active 成员不得收到后续 live event**。

## 9. WS Live Event 语义

Browser WS live events 为 **best-effort**：

- 不保证 exactly-once
- 不保证 recover disconnect / tab suspend / DO restart / lease expiry 期间错过的事件
- 客户端按 `(channel_id, event_id)` dedupe
- 权威恢复走 HTTP bootstrap + channel history/events API

推荐恢复触发：initial load、WS reconnect、`session.live_start` ack、active channel route enter、tab resume、疑似 gap、分页。

## 10. 删除的旧路径

- `UserConnection.registerOnlineOnConnect`
- `UserConnection.getChannelReplayAfterCursor`
- Connect 期 ChatChannel replay/summary
- `ChannelFanout /register-online`、`/unregister-online`
- WS `?cursors=`
- Attachment `subscribed_channels` 作为权威清理源

## 11. 前端

启动顺序：

```text
1. Open WebSocket (lilium.chat.v2, 无 cursors)
2. Send session.live_start
3. After ack → HTTP bootstrap / refresh channel list
4. If active channel → HTTP channel sync (events or messages)
```

Event reducer：dedupe → 更新 sidebar；`channel_id === activeChannelId` 才写入 timeline。

## 12. 最终不变量

1. WS live delivery 是 best-effort，不是历史真相来源
2. HTTP read APIs 是 bootstrap / history / reconnect / gap recovery 的权威来源
3. `session.live_start` 后，live WS 自动接收用户全部 active 成员频道的新事件
4. UserConnection 不做 replay 或 cursor recovery
5. UserConnection 不用 `ctx.waitUntil` 做有副作用的连接初始化
6. ChannelFanout 存 leases，不是权威在线状态
7. Close/error 清理是 best-effort；TTL + deliver stale cleanup 提供收敛
8. WebSocket attachment 不是订阅列表的权威来源
9. 前端 dedupe `(channel_id, event_id)`，用 HTTP 恢复
10. 旧 live 路径（register-online、connect replay、WS cursor）已移除
11. `/deliver` 在 version 落后时 **必须** re-check membership；非 active 必须关闭本地 lease 并拒绝投递
12. `session.heartbeat` **不得** blind refresh 或复活 `closed`/membership 失败的 lease；必须对照当前 active memberships 过滤

## 13. 观测

Structured logs：`live_start_committed`、`fanout_lease_deleted`、`session_closed_cleanup`。

部署后期望：`GET /api/chat/ws` wall time 下降；idle tab 下 UserConnection GB-sec 不再线性上升；fanout lease 在 live/close/expiry/stale 间收敛。
