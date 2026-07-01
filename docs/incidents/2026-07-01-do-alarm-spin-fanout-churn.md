# 故障说明：DO alarm 自旋与 Fanout 空转（2026-07-01）

## 摘要

2026-07-01 17:00（JST）起，生产环境出现两类可观测异常：

1. **ChannelFanout** storage 写入持续偏高（图：Rows written 升至约 3k–4k/interval），但并无对应消息量增长。
2. **UserConnection** billable duration 从约 25 GB-sec 跳升至 130–300+ GB-sec。

根因是 **三个独立的 alarm / 重试回路 bug** 在同一发布窗口被引入或激活，形成上下游级联。并非真实聊天流量驱动。

修复于当日 19:46–22:02 陆续上线；遗留的陈年 `pending` outbox 于当晚通过运维端点手动清理。

---

## 影响

| 维度 | 表现 |
|------|------|
| Fanout DO | `fanout_queue` 重试扫描导致 rows read/write 虚高；历史 delivered/dead_letter 累积 |
| UserConnection DO | lease 过期 alarm 死循环，bill time 飙升 |
| ChatChannel DO | `starting` dueTable 用 `started_at` 排 alarm，stateful session 接通后 alarm 每瞬触发 |
| 业务 | 无大规模消息丢失报告；部分 channel 存在 6/28 起卡住的 projection/archive outbox |
| 用户可见 | 可能偶发投递延迟；storage 账单与 DO 计费异常 |

---

## 时间线（JST）

| 时间 | Commit | 说明 |
|------|--------|------|
| 02:29 | `81b654b` | 埋下 ChatChannel `starting` dueTable 潜伏 bug（表空，未触发） |
| 17:38–17:52 | `f7ad832` / `653703b` / `cf5e244` | **引入故障**的发布窗口 |
| 17:48 | `653703b` | 接通 stateful bot session → 激活 `starting` dueTable；事件/outbox 增加 |
| 17:55 | `cf5e244` | UserConnection lease 过期 alarm **查询写错** → alarm 死循环 |
| 19:46 | `faf164b` | Fanout 串行改并发 16（缓解，未断根因） |
| 20:12 | `a0c2e34` | 修 UserConnection stale lease 查询 |
| 20:14 | 部署 | UserConnection fix 上线 |
| 22:02 | `0abfc58` | 删 `started_at`/`starting` dueTable，改用 `started_at + SESSION_START_TIMEOUT_MS` |
| 22:02+ | 部署 | ChatChannel alarm spin 应停止 |
| 当晚 | 运维 | 对问题 channel 手动 dead-letter / fail 陈年 pending outbox；新增 debug SQL 端点 |

---

## 症状与误判

### 图一：Fanout Rows written 升高

初看像 `653703b` 接通 stateful session 后消息量变大。但 **实际消息量并未显著增加**。

真实机制是 **重试回路自激**，不是新事件驱动：

```
UserConnection alarm 死循环 / ChatChannel alarm 每瞬触发
        ↓
outbox flush 反复执行 → fanoutEnqueue
        ↓
投递目标 DO 不健康 / 超时 → fanout_queue 入队
        ↓
fanout alarm 扫描 pending → bumpFanoutRetry → 再 scheduleFanoutAlarm
        ↓
Rows read > Rows written（重试扫描特征）
```

读大于写是「alarm 反复扫 `fanout_queue` + 回查 `fanout_events`」的典型特征，而非正常 fanout 投递。

### 图二：UserConnection bill time 升高

`cf5e244` 新增的 lease 过期 alarm 查询要求 `live_sessions.status='live'`：

```sql
-- 错误：session 已 closed 但 lease 仍 active+expired 时查不到
SELECT DISTINCT live_sessions.session_id
FROM live_sessions
JOIN live_channel_leases ON ...
WHERE live_sessions.status='live'
  AND live_channel_leases.status='active'
  AND live_channel_leases.expires_at <= ?
```

结果：过期 lease 清不掉 → `MIN(expires_at)` 在过去 → `setAlarm(过去)` → **立即再触发** → 死循环。

`a0c2e34` 改为直接查 `live_channel_leases`：

```sql
SELECT DISTINCT session_id
FROM live_channel_leases
WHERE status='active' AND expires_at <= ?
```

---

## 根因详解

### 1. UserConnection alarm 死循环（`cf5e244` → `a0c2e34`）

- **触发**：17:55 部署 lease 过期主动关 session。
- **机制**：JOIN 条件过严，closed session 上的 expired active lease 永远清不掉。
- **表现**：UserConnection billable duration 台阶式上升。
- **对 Fanout 的影响**：`deliver()` RPC 目标 DO 被打满 → 投递失败 → `fanout_queue` 重试。

### 2. ChatChannel `starting` dueTable 自旋（`81b654b` 潜伏 → `653703b` 激活 → `0abfc58` 修复）

- **潜伏**：`isoDueTable("stateful_command_sessions", "started_at", "status", "starting", flush)` 用 **开始时间** 当 due 列。
- **激活**：17:48 `653703b` 接通 stateful session，开始有 `starting` 行写入。
- **机制**：`MIN(started_at)` 永远在过去 → alarm 每瞬重排 → 每次 alarm 都跑 outbox flush → 反复 `fanoutEnqueue`。
- **修复**：删除该 dueTable；用 `extraDueMs = MIN(started_at) + SESSION_START_TIMEOUT_MS` 排真正的超时时刻。

### 3. Fanout 串行投递放大延迟（pre-existing → `faf164b` 缓解）

- **机制**：`fanoutEnqueue` 对每个 lease 串行 `deliverToLease`；lease 多时单次 fanout 耗时长 → 误判失败入 `fanout_queue`。
- **修复**：`runBounded` 并发 16。
- **说明**：这是性能债，在 DO 不健康时被放大；不是唯一根因。

### 4. 陈年 pending outbox 持续撑 alarm（事故后残留）

个别 channel（例：`019f0ddd-7610-79f2-9c0f-6738a6d2f88d`）自 **2026-06-28** 起卡住：

| 表 | 数量 | 典型 `last_error` |
|----|------|-------------------|
| `projection_outbox` | 40 pending | `Exceeded allowed rows written in Durable Objects free tier.` |
| `archive_outbox` | 16 pending | — |

即使代码 fix 上线，`MIN(next_attempt_at)` 仍在过去 → ChatChannel alarm 继续转。

**清理方式**（当晚运维）：

```bash
POST /internal/debug/outbox/dead-letter
{ "class": "ChatChannel", "name": "<channel_id>", "reason": "stale_pending_cleared" }
```

- `projection_outbox` / `bot_delivery_outbox` → `dead_letter`
- `archive_outbox` → `failed`（该表终态为 `failed`，非 `dead_letter`）
- 执行后 `scheduleOutboxAlarm()` 重排；无 pending 时 `alarm_ms` 应为 `null`

---

## 修复清单

| Commit | 修复内容 |
|--------|----------|
| `a0c2e34` | UserConnection：去掉 JOIN，直接清理 expired active lease |
| `faf164b` | ChannelFanout：并发投递上限 16 |
| `0abfc58` | ChatChannel：移除 `started_at`/`starting` dueTable，正确排 session 启动超时 |
| `40d706d` | Debug：`sql-all` 对 `listAllChannelIds()` 补 `await` |
| 当晚部署 | `POST /internal/debug/outbox/dead-letter` 运维清理端点 |

---

## 诊断工具（事后新增）

鉴权：`Authorization: Bearer $DEBUG_TOKEN`（`wrangler secret put DEBUG_TOKEN`）

| 端点 | 用途 |
|------|------|
| `GET /internal/debug/classes` | 支持的 DO 类与枚举方式 |
| `POST /internal/debug/sql` | 单实例只读 `SELECT` |
| `POST /internal/debug/sql-all` | 按 channel 枚举 fan-out 查询 |
| `POST /internal/debug/outbox/dead-letter` | 清理陈年 pending outbox |

**判断 alarm 是否还在转**：任意 `debugSql` 响应中 `alarm_ms < now_ms` 即仍在过去排期。

**快速巡检**：

```bash
# 全 channel：pending outbox 汇总
curl -X POST .../internal/debug/sql-all \
  -d '{"class":"ChatChannel","query":"SELECT (SELECT COUNT(*) FROM projection_outbox WHERE status='\''pending'\'') AS proj, (SELECT COUNT(*) FROM archive_outbox WHERE status='\''pending'\'') AS arch"}'

# Fanout 队列
curl -X POST .../internal/debug/sql-all \
  -d '{"class":"ChannelFanout","query":"SELECT status, COUNT(*) AS c FROM fanout_queue GROUP BY status"}'
```

---

## 教训与预防

### dueTable 语义

- **due 列必须是「到期时间」**，不能用 `started_at`、`created_at` 等事件时间。
- `scheduleNextAlarm` 取 `MIN(due)`；若 due 在过去 → alarm 立即重排 → spin。
- 超时类任务应使用 `extraDueMs = event_time + TIMEOUT`（见 `0abfc58`）。

### DO stub RPC

- 从 Worker 调 DO 方法 **一律 `await`**，即使 DO 内方法是 sync。
- 反例：`dir.listAllChannelIds().channel_ids` 未 await → `sql-all` 枚举 0 个 channel。

### alarm + 复杂 SQL

- 新增 alarm 路径必须覆盖竞态：**session 已 closed、lease 仍 active+expired** 时仍能清理并 `deleteAlarm`。
- 回归测试：`test/do/user-connection-live-start.test.ts`「closes expired active leases for non-live sessions」。

### 重试回路熔断

- 下游 DO 不健康时，fanout / outbox 会无限 churn 直到 dead_letter。
- 建议：channel 级连续失败熔断；监控 `fanout_queue` pending 行数与 `alarm_ms < now_ms` 的 DO 数量。

### 运维清理原则

- **不要 DELETE** 卡住行；标为 `dead_letter` / `failed` 保留审计。
- 清理前 `dry_run: true` 确认数量。
- 6/28 级陈年 pending 清掉意味着对应 fanout/archive 不再投递，对旧事件可接受。

---

## 关联文件

| 区域 | 路径 |
|------|------|
| UserConnection alarm | `src/do/user-connection/object.ts` |
| ChatChannel alarm / outbox | `src/do/chat-channel/core.ts` |
| Fanout 投递 | `src/do/channel-fanout/object.ts` |
| Scheduler | `src/do/shared/scheduler.ts` |
| Debug SQL | `src/do/shared/debug-sql.ts`, `src/routes/debug-sql.ts` |
| Outbox 清理 | `src/do/shared/debug-dead-letter.ts` |

---

## 状态（文档编写时）

- 代码 fix：`a0c2e34`、`faf164b`、`0abfc58` 已合入 `master`。
- 问题 channel `019f0ddd-…`：40 projection + 16 archive pending 已清理，`alarm_ms: null`。
- 若监控在 fix 部署后仍偏高：用 debug 端点查是否还有其他 channel 存在 pending outbox 或 spinning alarm。
