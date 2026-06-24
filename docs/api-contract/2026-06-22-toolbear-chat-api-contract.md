# ToolBear Chat Browser/Bot API Contract

状态：实现前 API contract（v2.6，基于 2026-06-21 v1 + backend 设计 v3.3 delta + 2026-06-23 成员精确读补丁 + 2026-06-24 前端缺口收口 + 2026-06-24 幂等冲突语义收口 + 2026-06-24 频道创建端点 + 2026-06-24 v4.0 alignment）
日期：2026-06-22
范围：lilium-chat 后端（Cloudflare Worker + Durable Object）的 browser/bot-facing wire shape
权威来源：

- 实现设计：`docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md`（v3.3）
- 前身 contract：`dzmm_archive/docs/plans/2026-06-21-toolbear-chat-api-contract.md`（v1）

本文件是 v1 contract 的**修订版**。所有与 v1 一致的部分保持原状；偏离处显式标注 `(v2 delta)`。前端与 bot 实现**以本文件为准**。

## v1 → v2 差异摘要

| 维度 | v1 | v2 |
|---|---|---|
| 事件 cursor | 单全局 `last_event_id` / `since_event_id` / `after_event_id` | **per-channel cursor**（`event_state.per_channel`、WS `?cursors=`、`GET /events` 双形态）(v2 delta) |
| `command_ack` 语义 | accepted-only："ack 只表已接收，不表消息已创建"（contract 10.2 v1） | **committed_ack**：ack 携带 `status="committed"` + `message_id`/`invocation_id`/`interaction_id` + `event_id` (v2 delta) |
| `message.send` 幂等键 | 同时要求 `command_id` + `idempotency_key` + `payload.client_message_id` | **只强制 `payload.client_message_id`**；`idempotency_key` 缺省映射为 `client_message_id`，`command_id` 降级为 ack 关联 id (v2 delta) | **v2.6 superseded**：payload 移除 `client_message_id`，`command_id` 重新升为 durable 幂等键（≡ HTTP `Idempotency-Key`，归一为 `operation_id`） |
| `command.invoke` / `interaction.submit` 幂等 | `idempotency_key` | 保留 `idempotency_key`，或用 `client_invocation_id` / `client_interaction_id` 作业务幂等键 (v2 delta) | **v2.6 superseded**：移除 payload-level `client_invocation_id` / `client_interaction_id`，统一用 `command_id` 作 durable 幂等键；`command.invoke` payload 的 bot 定义 id 改名 `bot_command_id` |
| 路由索引 lag 行为 | 未定义 | `/messages/{id}`、`/invites/{code}` 在索引 lag 窗口返回 **`409 ROUTE_INDEX_PENDING`** (v2 delta) | **v2.6 superseded**：移除 `/messages/{id}` 路由索引；`ROUTE_INDEX_PENDING` 仅 `/invites/{code}` 保留，消息操作永不返回 |
| 域名示例 | `toolbear.example` | `chat.kuma.homes`（SPA 在 `lilium.kuma.homes`，跨域）(v2 delta) |
| 附件 access URL | 长期公开（未显式登记风险） | 长期公开，**显式 risk acceptance**：private 频道附件也公开 (v2 delta) |
| 成员精确读 | 无（仅 `GET /members?query=` 模糊搜索） | **`GET /channels/{id}/members/{user_id}`** 按 user_id 精确读单成员 (v2 delta, Phase 3) |
| 解散群聊 | `ChannelSummary.status` 有 `dissolved`，但没有 mutation / event / error | **`POST /channels/{id}/dissolve`** + `channel.dissolved` + `CHANNEL_DISSOLVED` (v2.2 delta, Phase 3) |
| 系统弱提示行 | 前端消费 `system.notice`，contract 未列事件 | **`system.notice`** 作为服务端生成的 timeline notice event (v2.2 delta) |
| Not found 错误 | 资源级 not found 不完整 | 不定义通用 `NOT_FOUND`；使用 `CHANNEL_NOT_FOUND` / `MESSAGE_NOT_FOUND` / `MEMBER_NOT_FOUND` / `INVITE_NOT_FOUND` (v2.2 delta) |
| 前端占位设置 | 未声明 | 群聊标签无 Browser API；免打扰是 browser local-only non-server state (v2.2 delta) |
| 幂等冲突语义 | `IDEMPOTENCY_CONFLICT` 列于错误表但未点明 WS `message.send` 触发条件 | **`message.send` 同 `client_message_id` 异请求体 → `409 IDEMPOTENCY_CONFLICT`**；幂等响应来自 `idempotency_keys` 缓存的 `response_json`，不扫 `events` (v2.3 delta) | **v2.6 superseded**：触发键改为 `command_id`（≡ `Idempotency-Key` / `operation_id`），缓存表为 transport-neutral `idempotency_keys` |
| `system.notice` payload | 列出 `actor.display_name`/`avatar_url` 但未区分 storage 与 wire | 明确该 payload 为 **Browser projection**；storage 只存 actor/target refs + `notice_kind` (v2.3 delta) |
| 频道创建 | 无 `POST /channels` 端点（design §8 提"频道 CRUD"但 contract §5 缺失） | **`POST /api/chat/channels`**（§5.2b）：创建 `kind="channel"` 频道，创建者=owner，可带 `initial_members`，同事务发 `channel.created`+`member.joined`+`system.notice`；任意已认证 Browser 用户可创建 (v2.4 delta, Phase 3) |
| Phase 3 范围 | §12.4 写"频道与成员管理 + read-state"（含糊，无创建） | §12.4 改为"Channel CRUD + Member Management + Read State"，明确含创建；公开目录/join/invites/DM/bot 留 Phase 6/7 (v2.4 delta) |

> 幂等章节的修订结论（v2.6 最终）：所有 mutating operation 使用单一 client-generated durable operation id。HTTP 用 `Idempotency-Key`，WS 用 `command_id`，二者同一语义层，内部归一为 `operation_id`。payload-level 的 `client_message_id` / `client_mutation_id` / `client_invocation_id` / `client_interaction_id` 全部移除。详见 §2.5。

## 修订记录

- **v1 (2026-06-21)**：原始 contract，`dzmm_archive/docs/plans/2026-06-21-toolbear-chat-api-contract.md`。
- **v2 (2026-06-22)**：基于 backend 设计 v3.2 的重定向 + delta。per-channel cursor、committed_ack、`message.send` 幂等简化、`ROUTE_INDEX_PENDING`、`chat.kuma.homes` 跨域、附件 public-read risk acceptance。见上方差异摘要表。
- **v2.1 (2026-06-23)**：补 `GET /api/chat/channels/{channel_id}/members/{user_id}`（§7.1b）按 user_id 精确读单成员资料。原因：前端 profile sheet（`useChatUserProfile`）cache miss 需按 user_id 精确读 role/joined_at，现有 `GET /members?query=` 是模糊搜索不可靠命中。实现时机 Phase 3。差异摘要表同步加一行。
- **v2.2 (2026-06-24)**：按前端 spec 缺口收口：补 `POST /api/chat/channels/{channel_id}/dissolve`、`channel.dissolved`、`system.notice`、`CHANNEL_DISSOLVED`、`INVITE_NOT_FOUND`；明确不定义通用 `NOT_FOUND`；将群聊标签列为 v1 无 Browser API 占位，将免打扰列为 browser local-only non-server state。
- **v2.3 (2026-06-24)**：幂等冲突语义收口（与 backend 设计 v3.3 §3.6 + Phase 2 plan 对齐）：§2.5 明确 `message.send` 同 `client_message_id` 异请求体 → `409 IDEMPOTENCY_CONFLICT`，幂等响应来自 `idempotency_keys` 缓存（不扫 `events`）；§6.2 补 committed_ack 的幂等命中/冲突行为；`system.notice` payload 标注为 Browser projection（storage 只存 actor/target refs + `notice_kind`）。
- **v2.4 (2026-06-24)**：Phase 3 范围收口 + 频道创建端点。补 `POST /api/chat/channels`（§5.2b）：创建 `kind="channel"` 频道，创建者自动成为 owner，可带 `initial_members`，同事务发 `channel.created` + `member.joined`（创建者及每个 initial_member）+ `system.notice`；任意已认证 Browser 用户可创建，`kind` 固定 `channel`（DM 不暴露）。§12.4 改为"Channel CRUD + Member Management + Read State"。原因：design §8 阶段 3 写"频道 CRUD"但 contract §5 缺创建端点，admin UI / 初始化工具 / 测试 fixture 无正式入口。
- **v2.5 (2026-06-24)**：补 `POST /api/chat/channels` 创建幂等规则（§5.2b 路由与幂等段）：create 幂等由 `UserDirectory(creator_user_id)` 协调（状态机 `creating`→`completed` + 持久化 `channel_id`），`ChatChannel(channel_id).createChannel` 单事务原子写入。原因：create 端点 URL 无 `channel_id`，Worker 现场 `uuidv7()` 会使重试路由到不同 DO，in-DO `idempotency_keys` 失效，结构性重复建群。其余 6 个 mutation 端点 `channel_id` 在 URL，DO 地址稳定，沿用 Phase 2 in-DO 幂等。
- **v2.6 (2026-06-24)**：v4.0 alignment — message mutations + read-state moved to WS commands; MessageIndex/ROUTE_INDEX_PENDING-for-messages removed; client_message_id → command_id; HTTP Idempotency-Key ≡ WS command_id (operation_id)。具体：§2.5 幂等改写为 transport-neutral operation_id（HTTP `Idempotency-Key` ≡ WS `command_id`，内部归一为 `operation_id`）；新增 `MessageLocator`（`{channel_id, message_id}`，`message_id` 单独不是合法 locator）；§3.4 Message model 移除 `client_message_id`、加 `command_id`；§6.2 `message.send` payload 移除 `client_message_id`，ack + event payload 含 `command_id`；§6.3/§6.4/§6.5 编辑/撤回/删除改为 WS `message.edit`/`message.recall`/`message.delete`（不再暴露 HTTP 端点）；§5.5 标记已读改为 WS `channel.mark_read`（不写 channel timeline event），多端同步用 user-local `read_state_updated` WS frame（非 channel event）；新增 §6.6 读取消息上下文 HTTP `GET .../context`；§6.3 移除 `ROUTE_INDEX_PENDING` 语义（`ROUTE_INDEX_PENDING` 仅 invite-code 路由保留，消息操作永不返回）；§9.5 `command.invoke` payload 用 `bot_command_id`，§9.6 `interaction.submit` 用 `command_id`，移除 `client_invocation_id`/`client_interaction_id`；全文移除 `MessageIndex`/`client_message_id` 等过时术语。

## 1. 边界

ToolBear 前端只调用 `/api/chat/*` Browser API。该路径由 Cloudflare Worker 承载在 `chat.kuma.homes`，ToolBear Python 后端不存储聊天消息，不代理聊天主路径，不读写聊天数据表。前端在 `lilium.kuma.homes`，**跨域**调用 `chat.kuma.homes`（CORS + WebSocket Origin 校验）(v2 delta)。

聊天 backend 使用 Cloudflare Worker + Durable Object。附件二进制存储在 SeaweedFS（`s3.kuma.homes`，S3 兼容）；后端只存 attachment metadata 和归属关系。Worker 直接验证现有 ToolBear browser JWT，得到当前 `user_id`。用户 profile 不写入后端存储：display name 和 avatar 由 Worker 按 `user_id` 调用只读数据源（ToolBear 生产 Postgres 的 `users` 表，经 Hyperdrive）补齐 (v2 delta)。

第一版前端可以先只接 `GET /api/chat/bootstrap` 渲染页面。发送消息、WebSocket、附件上传和成员管理必须按本文 contract 预留，不在前端发明第二套形状。

## 2. 通用约定

### 2.1 认证

Browser API 使用现有 ToolBear browser JWT。Worker 直接验证 JWT：

```http
Authorization: Bearer <toolbear_browser_jwt>
```

Worker 验证：

- JWT 签名有效（HS256）。
- `exp` 未过期。
- subject 对应现有 ToolBear user UUID。
- token type 是 browser user session。
- machine token（带 `client_id`）拒绝。
- delegated / managed session 拒绝：`managed_session=true`，或 `owner_user_id != sub`，或 `effective_account_user_id != sub`（任一即拒）(v2 delta)。

拒绝 delegated / managed session 的错误码固定为：

```json
{
  "error": {
    "code": "SESSION_NOT_ALLOWED",
    "message": "Chat requires a direct user session",
    "retryable": false
  },
  "request_id": "req_..."
}
```

WebSocket 连接不能设置 `Authorization` header。前端必须用 WebSocket subprotocol 传递同一个 browser JWT：

```js
new WebSocket("wss://chat.kuma.homes/api/chat/ws?cursors=<base64url-json>", [
  "lilium.chat.v1",
  "bearer.<toolbear_browser_jwt>"
])
```

Worker 只接受 `lilium.chat.v1` + `bearer.<jwt>` subprotocol。JWT 验证规则与 HTTP Browser API 一致。WS upgrade 时校验 `Origin` ∈ {`https://lilium.kuma.homes`, 本地开发 origin}，不匹配拒绝 (v2 delta)。

### 2.2 ID

ID 是不透明字符串。前端不得解析 ID。

规则：

- 用户 ID 使用现有 ToolBear user UUID 字符串。
- 频道、消息、附件、Bot、command、invocation、event ID 使用聊天后端定义的 UUIDv7 字符串。
- event_id 是 per-channel 单调 UUIDv7（同频道内严格单调，跨频道顺序任意）(v2 delta)。
- API contract 只要求这些 ID 作为 opaque string 传输；前端不得解析、拼接、校验前缀或从前缀推断类型。对 event_id 做字符串字典序比较是允许的（单调 UUIDv7 字典序 = 时间序）。

### 2.3 时间

所有时间字段使用 ISO 8601 UTC 字符串：

```json
"2026-06-21T05:30:00Z"
```

前端负责按浏览器本地时区显示。

### 2.4 分页

列表接口使用 cursor：

```text
?limit=50&cursor=opaque-cursor
```

响应：

```json
{
  "items": [],
  "next_cursor": "opaque-cursor"
}
```

`next_cursor: null` 表示没有下一页。

### 2.5 幂等
All mutating operations use a client-generated durable operation id. HTTP carries it in the `Idempotency-Key` header; WS carries it in the top-level `command_id` field. `Idempotency-Key` and `command_id` are the same semantic layer; they differ only by transport.

Rules: client generates the operation id before sending; retrying the same operation reuses it; a new operation uses a new id; same id + same body → same committed result; same id + different body → `IDEMPOTENCY_CONFLICT`; scoped by `(principal_kind, principal_id, operation, operation_id)`; service stores `request_hash` + `response_json` with the business mutation in the same target DO transaction.

Internal mapping: `HTTP Idempotency-Key -> operation_id`; `WS command_id -> operation_id`.

Conflict (WS):
```json
{
  "frame_type": "command_error",
  "command_id": "01JBBB...",
  "error": { "code": "IDEMPOTENCY_CONFLICT", "message": "idempotency key reused with different request body", "retryable": false }
}
```
HTTP conflict returns the error envelope with HTTP 409.

`command_id` is generated by the client and is the WebSocket transport form of the same durable operation id represented by HTTP `Idempotency-Key`. For WS commands, `command_id` is not merely an ack correlation id — it is also the idempotency key. For HTTP mutations, the equivalent field is `Idempotency-Key`. Do not introduce payload-level duplicate operation ids (`client_message_id` / `client_mutation_id` / `client_invocation_id` / `client_interaction_id`).

### 2.6 错误 envelope

所有错误返回：

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "not a channel member",
    "retryable": false
  },
  "request_id": "req_..."
}
```

`code` 是稳定机器码，`message` 是给前端和日志看的英文短句。每个 HTTP 响应带 `X-Request-Id` 头 (v2 delta)。

本 contract 不定义通用 `NOT_FOUND`。Browser client 必须识别资源级 not-found code：`CHANNEL_NOT_FOUND`、`MESSAGE_NOT_FOUND`、`MEMBER_NOT_FOUND`、`INVITE_NOT_FOUND` (v2.2 delta)。

### 2.7 Mutation 与事件边界

高频实时写操作使用 WebSocket command frame。WebSocket 同时承载两类 frame：

- `command`：浏览器发给 Worker 的请求。
- `event`：Worker 已经接受并写入后端后广播出来的事实。

规则：

- 用户发送消息、调用 slash command、点击 Bot component 都是 command request，不是 event。
- command request 带 `command_id`（既是 ack 关联，也是 durable 幂等键，见 2.5）(v2 delta, v2.6 调整)。
- Worker 写入后端后产生 `message.created`、`command.invoked`、`interaction.created` 等事件。
- WebSocket 向频道订阅者广播这些事件。
- 当前用户也通过同一条事件流确认最终状态。

HTTP API 保留给首屏 bootstrap、历史分页、频道/成员管理、附件上传、公开目录、邀请、事件回放。实时消息发送、slash command invocation、Bot rich UI interaction 不走 HTTP mutation。

## 3. 数据对象

### MessageLocator

Browser-facing message references must use:
```json
{ "channel_id": "...", "message_id": "..." }
```
`message_id` alone is not a valid Browser API locator. Applies to: timeline operations; edit/recall/delete; reply targets; notification deep links; search result deep links; message context loading.

### 3.1 UserSummary

用户展示必须包含 display name 和 avatar。`avatar_url` 可以为 `null`，前端使用标准 fallback。**`display_name` 类型为 `string`（非 null）** (v2 delta)。

后端只在持久化层内保存 `user_id`。返回 `UserSummary` 前，Worker 只读 ToolBear `users` 表批量解析 `user_id` (v2 delta)。display name 不可为空（如解析不到，使用 fallback 显示名（形如 `user-<前8位>`），**不展示裸 user_id 作为主身份**）。

```json
{
  "user_id": "00000000-0000-7000-8000-000000000101",
  "display_name": "alice",
  "avatar_url": "https://example.com/avatar.png"
}
```

### 3.2 ChannelSummary

```json
{
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "kind": "channel",
  "visibility": "private",
  "title": "克利夫兰先导报",
  "avatar_url": "https://example.com/channel.png",
  "member_count": 11,
  "role": "member",
  "status": "active",
  "unread_count": 3,
  "last_read_event_id": "01J...",
  "last_message_preview": "Zemo: 我也不行",
  "last_message_at": "2026-06-21T05:24:00Z",
  "last_event_id": "01J..."
}
```

`last_event_id` 是该频道最后事件的 per-channel 单调 UUIDv7，用于 per-channel cursor (v2 delta)。`last_read_event_id` 同样 per-channel。

枚举：

- `kind`: `channel` | `dm`
- `visibility`: `private` | `public_unlisted` | `public_listed`
- `role`: `owner` | `admin` | `member`
- `status`: `active` | `archived` | `dissolved`

### 3.3 ChannelDetail

```json
{
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "kind": "channel",
  "visibility": "private",
  "title": "克利夫兰先导报",
  "topic": "频道说明",
  "avatar_url": "https://example.com/channel.png",
  "member_count": 11,
  "role": "member",
  "status": "active",
  "created_at": "2026-06-20T12:00:00Z",
  "updated_at": "2026-06-21T05:00:00Z"
}
```

### 3.4 Message

```json
{
  "message_id": "00000000-0000-7000-8000-000000000301",
  "command_id": "00000000-0000-7000-8000-000000000401",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "sender": {
    "kind": "user",
    "user": {
      "user_id": "00000000-0000-7000-8000-000000000101",
      "display_name": "Zemo",
      "avatar_url": null
    }
  },
  "type": "text",
  "format": "plain",
  "status": "normal",
  "stream_state": "final",
  "text": "多探索搜装备吧",
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
```

枚举：

- `type`: `text` | `image` | `system`
- `format`: `plain` | `markdown`
- `status`: `normal` | `edited` | `deleted` | `recalled`
- `stream_state`: `none` | `streaming` | `final`

`format=markdown` 只允许 Bot 消息使用。前端按受限 Markdown 渲染，禁止原始 HTML。普通用户消息固定为 `format=plain`。

`command_id` 是发送方在 `message.send` 时提供的 durable operation id（见 §2.5），用于 optimistic UI 关联与调试。由客户端生成，作为 operation id 处理，不是服务端 message id。

删除和撤回消息保留同一个 `message_id` 供审计和事件状态更新使用。Browser history 和 event replay 返回的是可见投影，不返回已删除/撤回消息的原始 `text`、`attachments`、`components`、`mentions`。

历史分页中的已删除/撤回消息处理规则：

- `GET /api/chat/channels/{channel_id}/messages` 不返回 `status=deleted` 或 `status=recalled` 的消息项。
- `ReplySnapshot` 引用已删除/撤回消息时，只返回 `message_id` 和 `status`，`text_preview` 为空字符串。
- 管理员审计读取原始内容使用单独审计 API，不属于 Browser API。

### 3.5 ReplySnapshot

```json
{
  "message_id": "00000000-0000-7000-8000-000000000301",
  "sender_display_name": "alice",
  "text_preview": "上一条消息摘要",
  "status": "normal"
}
```

发送回复消息时，服务端在同一操作内生成 snapshot 存储并随消息返回 (v2 delta)。replay/history 投影时根据被引用消息当前 status 决定是否清空 `text_preview`。

### 3.6 Attachment

```json
{
  "attachment_id": "00000000-0000-7000-8000-000000000501",
  "kind": "image",
  "filename": "image.png",
  "mime_type": "image/png",
  "size_bytes": 12345,
  "width": 512,
  "height": 512,
  "url": "https://s3.kuma.homes/lilium-chat-attachments/chat/00000000-0000-7000-8000-000000000501"
}
```

第一版只允许 `kind=image`。`url` 是长期公开 URL，public read，不需签名 (v2 delta)。对象存储 key 不暴露给前端（`url` 路径只含高熵 `attachment_id`，不含 filename/user/channel）。

**风险登记（v2 delta）**：private 频道附件也使用公开 URL。这是显式产品决策（与旧 PRD "私有频道附件不长期公开"相反）。缓解：storage key 高熵（`chat/{attachment_id}`，不可猜）；filename 仅在 JSON 返回、前端须转义；deleted/recalled 消息不再通过 Browser API 返回附件 URL（对象是否保留用于审计另定）；`url` 保持为字段，未来切 signed GET/proxy 可迁移。

### 3.7 Mention

```json
{
  "user_id": "00000000-0000-7000-8000-000000000101",
  "start": 6,
  "end": 12
}
```

`start` 和 `end` 使用 JavaScript string index。一条消息内同一用户可在多个不同 range 被 mention (v2 delta)。

### 3.8 MessageComponent

Bot 消息可以携带 rich interactive UI。组件由 Bot 生成，Worker 校验后随消息持久化。普通用户消息不能携带 components。

按钮组件：

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

选择组件：

```json
{
  "component_id": "00000000-0000-7000-8000-000000000a02",
  "kind": "select",
  "label": "选择装备",
  "custom_id": "pick_item",
  "disabled": false,
  "options": [
    {
      "value": "sword",
      "label": "长剑"
    }
  ]
}
```

枚举：

- `kind`: `button` | `select`
- `style`: `primary` | `secondary` | `danger`

`custom_id` 是 Bot 私有 payload，前端只原样回传，不解析。

## 4. 首屏

### 4.1 Bootstrap

```http
GET /api/chat/bootstrap?channel_id=00000000-0000-7000-8000-000000000201
```

`channel_id` 可选。未传时后端选择最近活跃且当前用户可访问的频道。

响应：

```json
{
  "me": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "alice",
    "avatar_url": "https://example.com/avatar.png"
  },
  "channels": [
    {
      "channel_id": "00000000-0000-7000-8000-000000000201",
      "kind": "channel",
      "visibility": "private",
      "title": "克利夫兰先导报",
      "avatar_url": "https://example.com/channel.png",
      "member_count": 11,
      "role": "member",
      "status": "active",
      "unread_count": 3,
      "last_read_event_id": "01J...",
      "last_message_preview": "Zemo: 我也不行",
      "last_message_at": "2026-06-21T05:24:00Z",
      "last_event_id": "01J..."
    }
  ],
  "active_channel": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "kind": "channel",
    "visibility": "private",
    "title": "克利夫兰先导报",
    "topic": "频道说明",
    "avatar_url": "https://example.com/channel.png",
    "member_count": 11,
    "role": "member",
    "status": "active",
    "created_at": "2026-06-20T12:00:00Z",
    "updated_at": "2026-06-21T05:00:00Z"
  },
  "messages": {
    "items": [],
    "next_cursor": null
  },
  "event_state": {
    "per_channel": {
      "00000000-0000-7000-8000-000000000201": "01J..."
    }
  }
}
```

`event_state.per_channel` 是 per-channel cursor map：`{ channel_id: last_event_id }` (v2 delta)。每个 channel_summary 项也带自身 `last_event_id`，二者一致。WS 建连用此 map 作 `cursors` 参数。

空频道列表：

```json
{
  "me": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "user-00000000",
    "avatar_url": null
  },
  "channels": [],
  "active_channel": null,
  "messages": {
    "items": [],
    "next_cursor": null
  },
  "event_state": { "per_channel": {} }
}
```

## 5. 频道

### 5.1 获取频道列表

```http
GET /api/chat/channels
```

响应：

```json
{
  "items": [],
  "next_cursor": null
}
```

### 5.2 获取频道详情

```http
GET /api/chat/channels/{channel_id}
```

响应：

```json
{
  "channel": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "kind": "channel",
    "visibility": "private",
    "title": "克利夫兰先导报",
    "topic": "频道说明",
    "avatar_url": null,
    "member_count": 11,
    "role": "member",
    "status": "active",
    "created_at": "2026-06-20T12:00:00Z",
    "updated_at": "2026-06-21T05:00:00Z"
  }
}
```

### 5.2b 创建频道 (v2.4 delta, Phase 3)

```http
POST /api/chat/channels
Idempotency-Key: client-key-channel-create
```

请求：

```json
{
  "title": "新频道",
  "topic": null,
  "avatar_attachment_id": null,
  "visibility": "private",
  "initial_members": [
    {
      "user_id": "00000000-0000-7000-8000-000000000102",
      "role": "member"
    }
  ]
}
```

字段：

- `title`：必填，非空。
- `topic`、`avatar_attachment_id`：可选，默认 `null`。`avatar_attachment_id` 的 owner/finalized 校验在 Phase 5（附件）落地前接受 `null`；Phase 3 不接受非空 `avatar_attachment_id`（返回 `422 INVALID_MESSAGE`）。
- `visibility`：`private` | `public_unlisted` | `public_listed`，默认 `private`。`public_listed` 的目录可见性在 Phase 6（ChannelDirectory）才对外暴露；Phase 3 接受该值并落库，但目录查询端点尚未提供。
- `initial_members`：可选，创建时一并加入的成员（不含创建者）。每项 `{ user_id, role }`，`role` ∈ `member` | `admin`（不允许 `owner`，owner 固定为创建者）。

响应：

```json
{
  "channel": {},
  "membership": {
    "role": "owner",
    "joined_at": "2026-06-24T03:00:00Z"
  }
}
```

事件（同事务追加，经 fanout 广播给在线成员）：

- `channel.created`（actor=创建者，payload 含 channel_id/kind/visibility/title）
- `member.joined`（创建者，actor=system）
- 对每个 `initial_members`：`member.joined`（actor=system）
- `system.notice`（notice_kind=`channel.created`，actor=创建者）

权限：

- **创建者自动成为 `owner`**，并写入 `members` + UserDirectory.my_channels projection（同事务 outbox）。
- 是否允许普通用户创建频道由 contract 写死：**Phase 3 允许任意已认证 Browser 用户创建 `kind="channel"` 频道**（DM 创建不暴露，见"关于 DM"）。`kind` 固定为 `channel`，请求不接受 `kind` 字段。
- endpoint 必须存在——后续 admin UI / 初始化工具 / 测试 fixture 都经此正式入口，不靠 `/internal/*` 旁路。

路由与幂等（v2.5 delta）：创建频道的幂等由 `UserDirectory(creator_user_id)` 协调，不由 Worker 现场 mint 的 `ChatChannel` DO 承担。Worker 路由到 `UserDirectory(user_id)`，后者在其 `idempotency_keys` 事务内 mint `channel_id`（UUIDv7，即 `ChatChannel` DO name；系统频道例外，DO name=`system-general`），状态机 `creating`→`completed`，持久化 `channel_id`，再调用 `ChatChannel(channel_id).createChannel`（单事务原子写入，`channel_meta` 存在性即幂等 guard）。同一 `(user, operation=channel.create, key)` + 相同 `request_hash` 重试命中同一 `UserDirectory` DO → 同一 `channel_id` → 同一 `ChatChannel` DO → 缓存结果；不同 `request_hash` 返回 `409 IDEMPOTENCY_CONFLICT`。崩溃窗口：`status=creating` 时 retry 重新调用同一 `ChatChannel(channel_id).createChannel`（幂等返回已提交行）后标 `completed`，不重复建群。跨 DO 仍为 best-effort（无 2PC）。



```http
PATCH /api/chat/channels/{channel_id}
Idempotency-Key: client-key-channel-update
```

请求：

```json
{
  "title": "新标题",
  "topic": "新说明",
  "avatar_attachment_id": "00000000-0000-7000-8000-000000000501",
  "visibility": "private"
}
```

字段均可选；未传字段不变。

响应：

```json
{
  "channel": {}
}
```

### 5.4 解散群聊

```http
POST /api/chat/channels/{channel_id}/dissolve
Idempotency-Key: client-key-channel-dissolve
```

仅 `kind="channel"` 的 owner 可调用。事务提交后频道 `status` 固定为 `dissolved`，服务端生成 `channel.dissolved` 和 `system.notice` 事件。已解散频道仍可通过频道列表/详情向当前成员返回 `status="dissolved"` 作为 tombstone；所有后续写入类操作和 WebSocket command 返回 `409 CHANNEL_DISSOLVED`，同一 Idempotency-Key 的重复 dissolve 返回同一结果 (v2.2 delta)。

响应：

```json
{
  "channel": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "status": "dissolved",
    "updated_at": "2026-06-21T05:30:00Z"
  }
}
```

### 5.5 标记已读

WebSocket command frame (v2.6 delta：由 HTTP `POST /channels/{id}/read-state` 改为 WS `channel.mark_read`)：

```json
{
  "frame_type": "command",
  "command": "channel.mark_read",
  "command_id": "00000000-0000-7000-8000-000000000511",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "last_read_event_id": "01J..."
  }
}
```

`last_read_event_id` 是 per-channel 单调 UUIDv7，只允许单调前进（新值 > 旧值才接受）(v2 delta)。要求当前用户在该频道是 active 成员。

Committed ack：

```json
{
  "frame_type": "command_ack",
  "command": "channel.mark_read",
  "command_id": "00000000-0000-7000-8000-000000000511",
  "status": "committed",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "last_read_event_id": "01J...",
  "unread_count": 0
}
```

Semantics: handled by UserConnection; state written to UserDirectory; requires active `my_channels` row; monotonic (older cursor → return stored); **read-state does not create channel timeline event**; `command_id` echoed; durable idempotency via monotonic cursor。

Multi-session note: if the same user has multiple active WS sessions, UserConnection may broadcast a non-timeline `read_state_updated` frame to the user's other sessions：

```json
{
  "frame_type": "read_state_updated",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "last_read_event_id": "01J...",
  "unread_count": 0
}
```

This frame is user-local state, not a channel event, and must not be written to `ChatChannel.events`。

### 5.6 公开频道目录

```http
GET /api/chat/channels/directory?q=game&limit=50&cursor=opaque-cursor
```

只返回 `visibility=public_listed` 且 `status=active` 的频道。

响应：

```json
{
  "items": [
    {
      "channel_id": "00000000-0000-7000-8000-000000000201",
      "kind": "channel",
      "visibility": "public_listed",
      "title": "公开频道",
      "avatar_url": null,
      "member_count": 42,
      "role": null,
      "status": "active",
      "unread_count": 0,
      "last_read_event_id": null,
      "last_message_preview": "最近消息摘要",
      "last_message_at": "2026-06-21T05:24:00Z"
    }
  ],
  "next_cursor": null
}
```

### 5.7 加入公开频道

```http
POST /api/chat/channels/{channel_id}/join
Idempotency-Key: client-key-channel-join
```

响应：

```json
{
  "channel": {},
  "membership": {
    "role": "member",
    "joined_at": "2026-06-21T05:30:00Z"
  }
}
```

### 5.8 创建邀请

```http
POST /api/chat/channels/{channel_id}/invites
Idempotency-Key: client-key-invite-create
```

请求：

```json
{
  "expires_in_seconds": 604800,
  "max_uses": null
}
```

响应：

```json
{
  "invite_code": "invite-code-abc123",
  "invite_url": "https://chat.kuma.homes/chat/invites/invite-code-abc123",
  "expires_at": "2026-06-28T05:30:00Z",
  "max_uses": null
}
```

邀请码原文只返回一次。邀请码明文存储在服务端（可重复使用），按 principal 不命名空间化（邀请码是频道级凭据）(v2 delta)。

### 5.9 接受邀请

```http
POST /api/chat/invites/{invite_code}/accept
Idempotency-Key: client-key-invite-accept
```

该 endpoint 的 URL 不含 `channel_id`，服务端内部按 `invite_code` 定位频道 (v2 delta)。索引 lag 窗口内返回 `409 ROUTE_INDEX_PENDING`。邀请码不存在、不可见、已撤销或已过期返回 `404 INVITE_NOT_FOUND` (v2.2 delta)。

响应：

```json
{
  "channel": {},
  "membership": {
    "role": "member",
    "joined_at": "2026-06-21T05:30:00Z"
  }
}
```

## 6. 消息

### 6.1 拉取历史消息

```http
GET /api/chat/channels/{channel_id}/messages?before=00000000-0000-7000-8000-000000000301&limit=50
```

`before` 可选。未传时返回最新消息页。

响应：

```json
{
  "items": [],
  "next_cursor": "opaque-cursor"
}
```

响应只包含当前用户可见的非 deleted / non recalled 消息。已删除或撤回的消息不出现在历史分页中。

### 6.2 发送消息

WebSocket command frame (v2.6 delta：payload 不含 `client_message_id`；`command_id` 既是 ack 关联又是 durable 幂等键)：

```json
{
  "frame_type": "command",
  "command": "message.send",
  "command_id": "00000000-0000-7000-8000-000000000411",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "type": "text",
    "text": "hello @alice",
    "reply_to_message_id": null,
    "attachment_ids": [],
    "mentions": [
      {
        "user_id": "00000000-0000-7000-8000-000000000101",
        "start": 6,
        "end": 12
      }
    ]
  }
}
```

图片消息 command：

```json
{
  "frame_type": "command",
  "command": "message.send",
  "command_id": "00000000-0000-7000-8000-000000000412",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "type": "image",
    "text": "",
    "reply_to_message_id": null,
    "attachment_ids": ["00000000-0000-7000-8000-000000000501"],
    "mentions": []
  }
}
```

Worker 接受 command 并在事务提交后返回 committed_ack (v2 delta)：

```json
{
  "frame_type": "command_ack",
  "command_id": "00000000-0000-7000-8000-000000000411",
  "status": "committed",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "message_id": "00000000-0000-7000-8000-000000000301",
  "event_id": "01J..."
}
```

前端收到 committed_ack 后即可把本地 pending 绑定到 server `message_id`，即使 event frame 延迟也能正确渲染占位。event frame 仍是最终 timeline 状态来源。

幂等行为（v2.6 delta）：

- 客户端用同一 `command_id` 重发 `message.send`（重试、丢包重传）且请求体一致 → 服务端命中 `idempotency_keys` 缓存（`operation_id` = `command_id`），返回与首次**相同的 `message_id` + `event_id`** 的 `committed_ack`，不创建新消息、不广播新 event。
- 客户端用同一 `command_id` 但改了 `text`/`reply_to`/`mentions` 等字段 → `command_error`，`code=IDEMPOTENCY_CONFLICT`，`retryable=false`。前端应视为编程错误（复用 key 改 body），不应自动重试。
- 客户端发新消息即使文本相同也必须用新的 `command_id`；同文本 + 新 `command_id` → 创建新消息。
- `message.created` event payload 的 `sender` 是 Browser projection（实时 `resolveUserSummaries`），不持久化 UserSummary；详见 §10.3 与 §10.4。

随后广播：

```json
{
  "frame_type": "event",
  "event_id": "01J...",
  "type": "message.created",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "occurred_at": "2026-06-21T05:30:00Z",
  "payload": {
    "message": {
      "message_id": "00000000-0000-7000-8000-000000000301",
      "command_id": "00000000-0000-7000-8000-000000000411",
      "status": "normal",
      "created_at": "2026-06-21T05:30:00Z"
    }
  }
}
```

协议校验失败返回 `command_error`（与 v1 一致）：

```json
{
  "frame_type": "command_error",
  "command_id": "00000000-0000-7000-8000-000000000411",
  "error": {
    "code": "INVALID_MESSAGE",
    "message": "message text is empty",
    "retryable": false
  }
}
```

`command_ack` 现携带提交结果（committed 语义，取代 v1 contract "ack 只表已接收"）。event frame 仍是最终 timeline 状态 (v2 delta)。

### 6.3 编辑消息

WebSocket command frame (v2.6 delta：由 HTTP `PATCH /messages/{id}` 改为 WS `message.edit`)：

```json
{
  "frame_type": "command",
  "command": "message.edit",
  "command_id": "00000000-0000-7000-8000-000000000421",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "message_id": "00000000-0000-7000-8000-000000000301",
    "text": "new text"
  }
}
```

committed_ack 回显 `command_id` + `message_id` + `event_id`：

```json
{
  "frame_type": "command_ack",
  "command_id": "00000000-0000-7000-8000-000000000421",
  "status": "committed",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "message_id": "00000000-0000-7000-8000-000000000301",
  "event_id": "01J..."
}
```

随后广播 `message.updated` 事件（payload 含 `message_id` + `command_id` + `status=edited` + `updated_at`）。

### 6.4 撤回自己的消息

WebSocket command frame (v2.6 delta：由 HTTP `POST /messages/{id}/recall` 改为 WS `message.recall`)：

```json
{
  "frame_type": "command",
  "command": "message.recall",
  "command_id": "00000000-0000-7000-8000-000000000431",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "message_id": "00000000-0000-7000-8000-000000000301"
  }
}
```

committed_ack 回显 `command_id` + `message_id` + `event_id`。随后广播 `message.recalled` 事件。

### 6.5 管理员删除消息

WebSocket command frame (v2.6 delta：由 HTTP `DELETE /messages/{id}` 改为 WS `message.delete`)：

```json
{
  "frame_type": "command",
  "command": "message.delete",
  "command_id": "00000000-0000-7000-8000-000000000441",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "message_id": "00000000-0000-7000-8000-000000000301",
    "reason": "spam"
  }
}
```

committed_ack 回显 `command_id` + `message_id` + `event_id`。随后广播 `message.deleted` 事件。管理员删除他人消息追加 `system.notice`（`notice_kind=message.deleted`）。

Browser API does not expose HTTP endpoints for message edit/recall/delete. Internal DO-to-DO endpoints may exist for implementation, but they are not public Browser API. 所有 message mutation 的 locator 必须是 `{channel_id, message_id}`（见 `MessageLocator`），直接路由到 `ChatChannel DO`，不存在 message-id-only 路由索引，因此消息操作永不返回 `ROUTE_INDEX_PENDING`。

### 6.6 读取消息上下文

```http
GET /api/chat/channels/{channel_id}/messages/{message_id}/context?before=30&after=30
```

Returns a timeline window around a message. Channel-scoped. Search/notification deep links must carry both `channel_id` and `message_id`. Read endpoint, remains HTTP.

## 7. 成员

### 7.1 获取成员列表

```http
GET /api/chat/channels/{channel_id}/members?query=ali&limit=50&cursor=opaque-cursor
```

`query` 是 display_name / user_id 的模糊搜索（前缀匹配），适合成员列表补全。**不适合按 user_id 精确读单成员资料**——精确读用 7.1b。

响应：

```json
{
  "items": [
    {
      "user": {
        "user_id": "00000000-0000-7000-8000-000000000101",
        "display_name": "alice",
        "avatar_url": null
      },
      "role": "member",
      "joined_at": "2026-06-20T12:00:00Z"
    }
  ],
  "next_cursor": null
}
```

### 7.1b 按用户 ID 读取单成员 (v2 delta)

精确读取某用户在某频道的成员资料。供前端 profile sheet（`useChatUserProfile(user_id, channel_id)`）cache miss 时按 user_id 回源，拿 `role` / `joined_at` / 离开状态。`GET /members?query=` 是模糊搜索，不能可靠按 user_id 命中，故单独提供此端点。

```http
GET /api/chat/channels/{channel_id}/members/{user_id}
```

响应（当前用户必须是该频道 active 成员；否则 403）：

```json
{
  "user": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "alice",
    "avatar_url": null
  },
  "role": "member",
  "joined_at": "2026-06-20T12:00:00Z",
  "status": "active"
}
```

- `status`: `active` | `left` | `removed`。已离开/被移除的成员仍可读（用于历史消息发送者的资料展示），但 `status` 反映其当前成员状态。
- 用户从未加入该频道 → `404 MEMBER_NOT_FOUND`。
- 实现时机：Phase 3（频道与成员管理）。Phase 1/2 不提供此端点。


### 7.2 添加成员

```http
POST /api/chat/channels/{channel_id}/members
Idempotency-Key: client-key-member-add
```

请求：

```json
{
  "user_id": "00000000-0000-7000-8000-000000000101",
  "role": "member"
}
```

响应：

```json
{
  "member": {}
}
```

### 7.3 修改成员角色

```http
PATCH /api/chat/channels/{channel_id}/members/{user_id}
Idempotency-Key: client-key-member-role
```

请求：

```json
{
  "role": "admin"
}
```

响应：

```json
{
  "member": {}
}
```

### 7.4 移除成员 / 离开频道

```http
DELETE /api/chat/channels/{channel_id}/members/{user_id}
Idempotency-Key: client-key-member-remove
```

响应：

```json
{
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "user_id": "00000000-0000-7000-8000-000000000101",
  "removed": true
}
```

## 8. 附件

### 8.1 创建图片上传

```http
POST /api/chat/uploads/images/presign
Idempotency-Key: client-key-attachment-presign
```

Worker 校验当前用户、文件类型和大小，创建 pending attachment metadata，并返回 SeaweedFS（S3 兼容对象存储）的 presigned PUT URL。Worker 不接收图片二进制。

请求：

```json
{
  "filename": "image.png",
  "mime_type": "image/png",
  "size_bytes": 12345,
  "width": 512,
  "height": 512
}
```

响应：

```json
{
  "attachment_id": "00000000-0000-7000-8000-000000000501",
  "upload_url": "https://s3.kuma.homes/lilium-chat-attachments/chat/00000000-0000-7000-8000-000000000501?X-Amz-Signature=...",
  "upload_method": "PUT",
  "upload_headers": {
    "Content-Type": "image/png"
  },
  "expires_at": "2026-06-21T05:35:00Z"
}
```

`upload_url` 是 SeaweedFS presigned PUT，浏览器直传 (v2 delta)。presigned PUT 5 分钟过期，约束 `Content-Type` 必须与 `mime_type` 一致、`Content-Length` 上限 = `size_bytes`。

### 8.2 完成图片上传

浏览器使用 presigned URL 直传对象存储后，调用 finalize：

```http
POST /api/chat/uploads/images/{attachment_id}/finalize
Idempotency-Key: client-key-attachment-finalize
```

请求：

```json
{
  "etag": "\"object-etag\""
}
```

响应：

```json
{
  "attachment": {
    "attachment_id": "00000000-0000-7000-8000-000000000501",
    "kind": "image",
    "filename": "image.png",
    "mime_type": "image/png",
    "size_bytes": 12345,
    "width": 512,
    "height": 512,
    "url": "https://s3.kuma.homes/lilium-chat-attachments/chat/00000000-0000-7000-8000-000000000501"
  }
}
```

Worker 在 finalize 时确认 pending attachment 属于当前用户，并检查对象已存在（HEAD）+ 校验 Content-Type 与 Content-Length 一致 (v2 delta)。`url` 是浏览器可直接读取的长期公开附件访问 URL。对象存储 key 不暴露给前端。

## 9. Bot 迁移预留

当前 DZMM bot 需要迁移到聊天 backend。本文不设计完整 bot 市场，但 API 必须从第一天支持官方 bot 作为外置 bot app 接入，避免后续为 bot 单独开旁路。

Bot API 与 Browser API 分离：

- Browser API 使用 ToolBear browser JWT。
- Bot API 使用 bot token。
- Bot callback 使用签名请求。
- 官方 bot 和第三方 bot 走同一套 token、installation、command、effect 机制。

### 9.1 Bot token 认证

```http
Authorization: Bearer <bot_token>
```

Bot token 原文只返回一次，服务端只存 hash (v2 delta)。

Bot token scope：

- `chat:messages:write`
- `chat:messages:read`
- `chat:commands:manage`
- `chat:channels:read`
- `chat:members:read`

### 9.2 Bot actor

Bot 发送的消息必须有独立 actor，不伪装成普通用户。

```json
{
  "bot_id": "00000000-0000-7000-8000-000000000601",
  "display_name": "Lilium Bot",
  "avatar_url": "https://example.com/bot.png"
}
```

Message sender 支持两种形状：

```json
{
  "kind": "user",
  "user": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "alice",
    "avatar_url": null
  }
}
```

```json
{
  "kind": "bot",
  "bot": {
    "bot_id": "00000000-0000-7000-8000-000000000601",
    "display_name": "Lilium Bot",
    "avatar_url": null
  }
}
```

Bot actor 的 display_name / avatar_url 来自 BotRegistry（chat 自有数据），不查 ToolBear profile (v2 delta)。Browser UI 必须按 `kind` 渲染，不得把 bot id 当用户 id 展示。

### 9.3 注册 slash command

```http
PUT /api/chat/bot/commands
Authorization: Bearer <bot_token>
Idempotency-Key: client-key-bot-command-sync
```

请求：

```json
{
  "commands": [
    {
      "name": "ask",
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
          "description": "Repeat count",
          "min": 1,
          "max": 10
        },
        {
          "name": "channel",
          "type": "channel",
          "required": false,
          "description": "Target channel"
        }
      ],
      "default_member_permission": "member"
    }
  ]
}
```

响应：

```json
{
  "commands": [
    {
      "bot_command_id": "00000000-0000-7000-8000-000000000701",
      "name": "ask",
      "enabled": true,
      "updated_at": "2026-06-21T05:30:00Z"
    }
  ]
}
```

同一频道内 enabled command 名称不能冲突。冲突返回 `COMMAND_NAME_CONFLICT`。bot slash command 定义 id 字段名为 `bot_command_id`（与 Browser WS frame 的 `command_id` = durable operation id 区分）(v2.6 delta)。

slash command option 类型：

- `string`: 普通文本。
- `integer`: 整数，支持 `min` 和 `max`。
- `number`: 小数，支持 `min` 和 `max`。
- `boolean`: 布尔值。
- `user`: 当前频道成员 user ID，前端使用成员列表补全。
- `channel`: 当前用户可见 channel ID，前端使用频道列表补全。
- `role`: 频道角色，值为 `owner`、`admin`、`member`。

前端按 `type` 渲染输入控件和补全。Worker 在执行 `command.invoke` 前按注册 schema 校验 required、type、range、可见性和成员关系。

### 9.4 查询频道可用命令

Browser API：

```http
GET /api/chat/channels/{channel_id}/commands?prefix=as
```

响应：

```json
{
  "items": [
    {
      "bot_command_id": "00000000-0000-7000-8000-000000000701",
      "name": "ask",
      "description": "Ask the assistant",
      "bot": {
        "bot_id": "00000000-0000-7000-8000-000000000601",
        "display_name": "Lilium Bot",
        "avatar_url": null
      },
      "options": []
    }
  ]
}
```

### 9.5 调用 slash command

WebSocket command frame (v2.6 delta：payload 用 `bot_command_id`，移除 `client_invocation_id`；`command_id` 为 durable 幂等键)：

```json
{
  "frame_type": "command",
  "command": "command.invoke",
  "command_id": "00000000-0000-7000-8000-000000000812",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "bot_command_id": "00000000-0000-7000-8000-000000000701",
    "options": {
      "prompt": {
        "type": "string",
        "value": "hello"
      },
      "target": {
        "type": "user",
        "value": "00000000-0000-7000-8000-000000000101"
      },
      "count": {
        "type": "integer",
        "value": 3
      },
      "channel": {
        "type": "channel",
        "value": "00000000-0000-7000-8000-000000000201"
      }
    }
  }
}
```

Worker 接受 command 并在事务提交后返回 committed_ack (v2 delta)：

```json
{
  "frame_type": "command_ack",
  "command_id": "00000000-0000-7000-8000-000000000812",
  "status": "committed",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "invocation_id": "00000000-0000-7000-8000-000000000811",
  "event_id": "01J..."
}
```

随后广播：

```json
{
  "frame_type": "event",
  "event_id": "01J...",
  "type": "command.invoked",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "occurred_at": "2026-06-21T05:30:00Z",
  "payload": {
    "invocation": {
      "invocation_id": "00000000-0000-7000-8000-000000000811",
      "status": "pending",
      "created_at": "2026-06-21T05:30:00Z"
    }
  }
}
```

Slash command 是 command invocation，不是普通 text message。前端输入以 `/` 开头并选中命令后必须发送 `command.invoke` frame。

### 9.6 提交 rich UI interaction

WebSocket command frame (v2.6 delta：移除 `client_interaction_id`；`command_id` 为 durable 幂等键)：

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

select command：

```json
{
  "frame_type": "command",
  "command": "interaction.submit",
  "command_id": "00000000-0000-7000-8000-000000000a32",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "message_id": "00000000-0000-7000-8000-000000000301",
    "component_id": "00000000-0000-7000-8000-000000000a02",
    "custom_id": "pick_item",
    "value": "sword"
  }
}
```

Worker 接受 command 后广播：

```json
{
  "frame_type": "event",
  "event_id": "01J...",
  "type": "interaction.created",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "occurred_at": "2026-06-21T05:30:00Z",
  "payload": {
    "interaction": {
      "interaction_id": "00000000-0000-7000-8000-000000000a21",
      "status": "pending",
      "created_at": "2026-06-21T05:30:00Z"
    }
  }
}
```

Worker 校验当前用户能看见该消息、消息来自 Bot、component 未 disabled、`custom_id` 与持久化组件一致。前端不解析 `custom_id`，只原样提交。

### 9.7 Bot callback

Chat Worker 调用 bot callback：

```http
POST <bot_callback_url>
X-Lilium-Timestamp: 1778395200
X-Lilium-Signature: v1=<base64-hmac>
Content-Digest: sha-256=:...:
Idempotency-Key: client-key-command-invoke
```

请求：

```json
{
  "api_version": "lilium.chat.bot.v1",
  "kind": "command_invocation",
  "invocation_id": "00000000-0000-7000-8000-000000000811",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "command": {
    "name": "ask",
    "options": {
      "prompt": {
        "type": "string",
        "value": "hello"
      },
      "target": {
        "type": "user",
        "value": "00000000-0000-7000-8000-000000000101"
      },
      "count": {
        "type": "integer",
        "value": 3
      },
      "channel": {
        "type": "channel",
        "value": "00000000-0000-7000-8000-000000000201"
      }
    }
  },
  "invoker": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "alice",
    "avatar_url": null
  }
}
```

rich UI interaction callback：

```json
{
  "api_version": "lilium.chat.bot.v1",
  "kind": "message_interaction",
  "interaction_id": "00000000-0000-7000-8000-000000000a21",
  "message_id": "00000000-0000-7000-8000-000000000301",
  "channel_id": "00000000-0000-7000-8000-000000000201",
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

响应：

```json
{
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

Bot callback 可以返回的 effect：

- `send_message`: 发送 Bot 消息。
- `update_message`: 更新 Bot 自己发送的消息文本、附件和 components。
- `disable_components`: 禁用 Bot 自己发送的消息组件。
- `start_stream`: 创建一条 `stream_state=streaming` 的 Bot 消息。
- `append_stream`: 向 Bot 自己的 streaming message 追加文本 delta。
- `finalize_stream`: 将 Bot 自己的 streaming message 标记为 `stream_state=final`。

流式输出 effect 示例：

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

Worker 按 `client_effect_id` 对 stream effects 做幂等。`append_stream` 只能作用于同一 Bot 创建且仍为 `stream_state=streaming` 的消息。

Chat Worker 校验 effects 后写入后端内的消息、审计记录和事件流。ToolBear Python 后端不执行 bot effects。

### 9.8 Bot 直接发消息

```http
POST /api/chat/bot/channels/{channel_id}/messages
Authorization: Bearer <bot_token>
Idempotency-Key: client-key-bot-message
```

请求：

```json
{
  "type": "text",
  "text": "system notice",
  "reply_to_message_id": null,
  "attachment_ids": [],
  "components": []
}
```

响应：

```json
{
  "message": {},
  "event": {
    "event_id": "01J...",
    "type": "message.created"
  }
}
```

Bot 只能向已安装且 scope 允许的频道发消息。Bot 直接发消息可以携带 components。

## 10. 实时与事件回放

### 10.1 WebSocket 连接

```text
wss://chat.kuma.homes/api/chat/ws?cursors=<base64url(JSON {channel_id: since_event_id})>
```

前端通过 WebSocket subprotocol 携带 ToolBear browser JWT：

```js
new WebSocket("wss://chat.kuma.homes/api/chat/ws?cursors=<base64url-json>", [
  "lilium.chat.v1",
  "bearer.<toolbear_browser_jwt>"
])
```

`cursors` 是 per-channel cursor 的 base64url 编码 JSON map（`{ channel_id: since_event_id }`），用于建连时回放各频道的缺失事件 (v2 delta)。`cursors` 可为空（首次建连，全部从最新开始）。Worker 验证 JWT 后升级 WebSocket，并对当前用户已加入的频道隐式订阅（无需前端逐个发订阅帧）。

### 10.2 CommandAck

Worker 收到 command frame 后做协议校验并执行业务事务。事务提交后返回 committed_ack (v2 delta)：

```json
{
  "frame_type": "command_ack",
  "command_id": "00000000-0000-7000-8000-000000000411",
  "status": "committed",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "message_id": "00000000-0000-7000-8000-000000000301",
  "event_id": "01J..."
}
```

`message_id` / `invocation_id` / `interaction_id` 字段按 command 类型出现。committed_ack 携带提交结果，前端可立即绑定本地 pending。event frame 仍是最终 timeline 状态。

协议校验失败返回 `command_error`：

```json
{
  "frame_type": "command_error",
  "command_id": "00000000-0000-7000-8000-000000000411",
  "error": {
    "code": "INVALID_MESSAGE",
    "message": "message text is empty",
    "retryable": false
  }
}
```

### 10.3 事件回放

```http
GET /api/chat/events?channel_id=00000000-0000-7000-8000-000000000201&after_event_id=01J...
```

或 per-channel cursor map 取用户所有频道（UserDirectory 拿列表 → 并行查各频道 → 归并）(v2 delta)：

```http
GET /api/chat/events?cursors=<base64url(JSON {channel_id: after_event_id})>
```

响应：

```json
{
  "items": [],
  "next_cursor": null,
  "last_event_id_per_channel": {
    "00000000-0000-7000-8000-000000000201": "01J..."
  }
}
```

`last_event_id_per_channel` 取代 v1 的单 `last_event_id` (v2 delta)。

事件回放返回的是 Browser 可见事件投影：

- `message.created` replay 只返回当前仍可见的消息；已被删除/撤回的不会以 `message.created` 返回。
- **所有 content-bearing event replay（message.created / message.updated / message.stream_* / interaction.completed / command.completed）都通过当前 message status 过滤** (v2 delta)。deleted/recalled 的消息，其 created/updated/stream_* event 不重放；deleted/recalled event 只返回 tombstone。
- `message.deleted` 和 `message.recalled` replay 只返回 `message_id`、`channel_id`、`status`、操作时间和操作者摘要，不返回原始 `text`、`attachments`、`components`、`mentions`。
- event payload 不持久化 UserSummary profile，只存 actor 引用；UserSummary 在输出时实时 resolve (v2 delta)。
- 前端收到 `message.deleted` 或 `message.recalled` 后，从本地时间线移除该消息项。

### 10.4 EventEnvelope

```json
{
  "frame_type": "event",
  "api_version": "lilium.chat.v1",
  "event_id": "01J...",
  "type": "message.created",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "occurred_at": "2026-06-21T05:30:00Z",
  "payload": {}
}
```

事件类型：

- `channel.created`
- `channel.updated`
- `channel.archived`
- `channel.dissolved`
- `member.joined`
- `member.left`
- `member.role_updated`
- `system.notice`
- `message.created`
- `message.updated`
- `message.deleted`
- `message.recalled`
- `message.stream_started`
- `message.stream_delta`
- `message.stream_finalized`
- `command.invoked`
- `command.completed`
- `command.failed`
- `interaction.created`
- `interaction.completed`
- `interaction.failed`

> `read_state_updated`（见 §5.5）是 user-local WS frame，**不是** channel timeline event，不写入 `ChatChannel.events`，不列入上方 channel event 类型表 (v2.6 delta)。

`system.notice` 是服务端生成的弱提示行事件，不替代 domain event。服务端在同一 ChatChannel 事务中为 timeline-visible 管理动作追加 `system.notice`：成员加入/离开/角色变更、频道更新/归档/解散、管理员删除他人消息。前端按 `notice_kind` 渲染文案，服务端不下发展示文案 (v2.2 delta)。

`system.notice` payload：

```json
{
  "notice_kind": "channel.dissolved",
  "actor": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "alice",
    "avatar_url": null
  },
  "target_user": null,
  "message_id": null,
  "channel_changes": null
}
```

字段规则：

- `notice_kind`: `member.joined` | `member.left` | `member.role_updated` | `channel.updated` | `channel.archived` | `channel.dissolved` | `message.deleted`
- `actor`: 触发动作的用户；system actor 时为 `null`。
- `target_user`: 成员相关 notice 的目标用户，其余为 `null`。
- `message_id`: `message.deleted` notice 的目标消息，其余为 `null`。
- `channel_changes`: `channel.updated` 的字段级变更摘要，其余为 `null`。形状为 `{ "<field>": { "before": <old>, "after": <new> } }`，`field` 仅允许 `title`、`topic`、`avatar_url`、`visibility`。

> **Storage vs wire projection（v2.3 delta）**：以上 `system.notice` payload 是 **Browser projection**。`events.payload_json`（DO storage）**不持久化 UserSummary**，只存 `actor_user_id` / `target_user_id` / `notice_kind` / `message_id` / `channel_changes` 等引用与结构字段。`actor.display_name` / `actor.avatar_url` / `target_user` 的 UserSummary 在输出时（live broadcast + replay）由 `resolveUserSummaries` 实时回填，与 `message.created` 的 sender 解析规则一致（§10.3）。实现时切勿把 display_name/avatar_url 落进 DO storage。

前端规则 (v2 delta)：

- 按 `event_id` 在**对应频道内**去重。
- 只接受大于本地该频道的 `last_event_id` 的事件。
- 事件落入本地状态后再更新该频道的 `last_event_id`。
- 收到 gap 错误后重新调用 `GET /api/chat/bootstrap?channel_id=...`。

## 11. 错误码

HTTP error envelope 和 WebSocket `command_error.error` 使用同一套 `code`。

| HTTP | code | 含义 |
|---:|---|---|
| 401 | UNAUTHORIZED | 未登录或 token 失效 |
| 401 | MACHINE_TOKEN_NOT_ALLOWED | machine token 不允许访问 Browser API |
| 403 | SESSION_NOT_ALLOWED | delegated / managed session 不允许进入聊天 |
| 403 | FORBIDDEN | 当前用户无权执行该 action |
| 404 | CHANNEL_NOT_FOUND | 频道不存在或不可见 |
| 404 | MESSAGE_NOT_FOUND | 消息不存在或不可见 |
| 404 | MEMBER_NOT_FOUND | 用户不是该频道成员（从未加入）(v2 delta, Phase 3) |
| 404 | INVITE_NOT_FOUND | 邀请不存在、不可见、已撤销或已过期 (v2.2 delta) |
| 409 | CHANNEL_ARCHIVED | 频道已归档，不允许写入 |
| 409 | CHANNEL_DISSOLVED | 频道已解散，不允许写入或成员变更 (v2.2 delta) |
| 409 | MESSAGE_NOT_EDITABLE | 消息类型或状态不允许编辑 |
| 409 | IDEMPOTENCY_CONFLICT | 同一 operation id（HTTP `Idempotency-Key` / WS `command_id`）请求体不一致 |
| 409 | ROUTE_INDEX_PENDING | invite-code 路由索引 lag 窗口，重试可路由到 (v2 delta, v2.6 收窄：仅 invite-code 路由保留；消息操作永不返回) |
| 413 | ATTACHMENT_TOO_LARGE | 附件超出大小限制 |
| 415 | UNSUPPORTED_ATTACHMENT_TYPE | 附件 MIME type 不允许 |
| 422 | INVALID_MESSAGE | 消息请求不合法 |
| 409 | COMMAND_NAME_CONFLICT | 同一频道内 slash command 名称冲突 |
| 422 | INVALID_COMMAND_OPTIONS | command 参数不合法 |
| 404 | COMPONENT_NOT_FOUND | 组件不存在或不可见 |
| 409 | COMPONENT_DISABLED | 组件已禁用 |
| 422 | INVALID_INTERACTION_VALUE | interaction value 不合法 |
| 429 | RATE_LIMITED | 限流命中，可重试 (v2 delta) |
| 503 | BOT_CALLBACK_UNAVAILABLE | bot callback 暂不可用，可重试 |
| 503 | CHAT_WORKER_UNAVAILABLE | worker 暂不可用，可重试 |
| 409 | EVENT_GAP | 事件断层，需要重新拉取 bootstrap |

`CHAT_WORKER_UNAVAILABLE` 的 `retryable` 必须为 `true`。`ROUTE_INDEX_PENDING`、`RATE_LIMITED` 的 `retryable` 必须为 `true` (v2 delta)。`RATE_LIMITED` 响应带 `Retry-After` 头。

`ROUTE_INDEX_PENDING` must never be returned for message operations because Browser message operations are always channel-scoped and routed directly to `ChatChannel DO`。`ROUTE_INDEX_PENDING` 只用于 invite-code 路由（`POST /api/chat/invites/{invite_code}/accept`），因 invite URL 天然不含 `channel_id`。

### 11.1 No Browser API in v1

以下前端设置项不进入 Browser API v1，不要求 Worker / DO schema：

- 群聊标签：Phase A disabled 只读占位，无读取端点，无 mutation。
- 免打扰：browser local-only UI state，不写入 chat API，不跨设备同步。

## 12. 从零落地阶段

本聊天系统没有旧聊天数据。阶段按可运行的端到端能力切分：先建立 Cloudflare Worker + Durable Object 数据源，再把 ToolBear SPA 接入同一套 API。

每个阶段对应实现设计的同名阶段（见设计文档第 8 节）。前端任务（contract 12.2 只读壳）在 dzmm_archive repo，不进 lilium-chat。

### 12.1 阶段 0：骨架 + 平台 spike + 全局索引空壳

目标：7 个 DO 类壳 + JWT 自验 + Hyperdrive profile resolve + 部署 chat.kuma.homes + 平台 spike 跑通（hibernation、Hyperdrive、SeaweedFS、replay-after-delete、invite_code 路由、单 alarm earliest-wins、projection outbox flush）(v2.6 delta：移除 MessageIndex DO 与 message_id 路由索引)。

`GET /api/chat/bootstrap` 返回 `me` + 空 `channels` + `event_state.per_channel={}` + `active_channel=null`。

### 12.2 阶段 1：Worker/DO 最小聊天核心

目标：系统公共频道 + bootstrap + 历史分页 + per-channel cursor。

### 12.3 阶段 2：WebSocket command/event 文本消息

目标：WS 端点 + committed_ack + message.created event + 隐式订阅 + per-channel replay。

### 12.4 阶段 3：Channel CRUD + Member Management + Read State

频道创建、读取、更新、解散；成员列表、精确读、添加、角色修改、移除/退出；read-state（WS `channel.mark_read`，不写 channel timeline event，多端同步用 user-local `read_state_updated` frame）；相关事件包含 `channel.created`、`channel.updated`、`channel.dissolved`、`member.*`、`system.notice` (v2.6 delta)。

不在本阶段：公开目录 / discovery、`POST /channels/{id}/join`、invite create/accept、DM 创建、bot command（留 Phase 6/7）。

### 12.5 阶段 4：消息生命周期

回复 + 编辑 + 撤回 + 管理员删除（WS `message.edit` / `message.recall` / `message.delete`，channel-scoped，无 `ROUTE_INDEX_PENDING`）(v2.6 delta)；管理员删除他人消息追加 `system.notice`。

### 12.6 阶段 5：图片附件

SeaweedFS presign + finalize + 图片消息。

### 12.7 阶段 6：公开频道目录与邀请

### 12.8 阶段 7：Bot slash command 与 rich interaction

### 12.9 阶段：前端只读壳（contract v1 12.2）

不进 lilium-chat。每后端阶段交付后，前端在 dzmm_archive 对应接入。前端开工前必须落地本 contract v2.6（per-channel cursor + committed_ack + transport-neutral operation_id 幂等 + ROUTE_INDEX_PENDING 仅 invite-code + WS message mutation/read-state + dissolve + system.notice + 资源级 not-found code），否则前后端会引用不同 contract (v2 delta, v2.6 调整)。
