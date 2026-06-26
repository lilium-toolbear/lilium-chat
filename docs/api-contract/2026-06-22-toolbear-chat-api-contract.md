# ToolBear Chat Browser/Bot API Contract

状态：实现前 API contract（v2.10，v4.3-aligned —— 基于 2026-06-21 v1 + backend 设计 v4.0 delta + 2026-06-23 成员精确读补丁 + 2026-06-24 前端缺口收口 + 2026-06-24 幂等冲突语义收口 + 2026-06-24 频道创建端点 + 2026-06-24 v4.0 alignment + 2026-06-24 committed_ack canonical payload + 2026-06-25 Phase E delta：invite preview + owner transfer + 个人表情库 + sticker message + 2026-06-25 BlurHash：attachment metadata 补 blurhash 字段 + 2026-06-26 Phase 7 Bot Gateway WebSocket RPC：bot runtime transport 改为 bot 主动连 `/api/chat/bot/ws`，HTTP callback 降级为 future transport）
日期：2026-06-22
范围：lilium-chat 后端（Cloudflare Worker + Durable Object）的 browser/bot-facing wire shape
权威来源：

- 实现设计：`docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md`（v4.0）
- 前身 contract：`dzmm_archive/docs/plans/2026-06-21-toolbear-chat-api-contract.md`（v1）

本文件是 v1 contract 的**修订版**。所有与 v1 一致的部分保持原状；偏离处显式标注 `(v2 delta)`。前端与 bot 实现**以本文件为准**。

## v1 → v2 差异摘要

| 维度 | v1 | v2 |
|---|---|---|
| 事件 cursor | 单全局 `last_event_id` / `since_event_id` / `after_event_id` | **per-channel cursor**（`event_state.per_channel`、WS `?cursors=`、`GET /events` 双形态）(v2 delta) |
| `command_ack` 语义 | accepted-only："ack 只表已接收，不表消息已创建"（contract 10.2 v1） | **committed_ack**：ack 携带 `status="committed"` + `message_id`/`invocation_id`/`interaction_id` + `event_id` (v2 delta) | **v2.6 addendum superseded**：`message.*` ack 改为 payload-bearing `{payload:{channel_id,event_id,message}}`（`message` 为完整 Browser 投影）；`channel.mark_read` ack payload 为 read-state；详见 §10.2 |
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
- **v2.6 addendum (2026-06-24, WS committed_ack canonical payload)**：`committed_ack` 现携带 canonical mutation payload——`message.*` ack `payload = { channel_id, event_id, message }`，`message` 为完整 Browser-visible Message 投影（含 sender UserSummary、type、format、status、stream_state、text、reply_to、reply_snapshot、attachments、components、mentions、created/updated/edited/deleted/recalled）；`channel.mark_read` ack `payload = { channel_id, last_read_event_id, unread_count }`（无 `event_id`）。`message.*` event frame 的 `payload.message` 与 ack **同形**（同一 `projectMessageForBrowser` builder 产物，recalled/deleted 用安全投影不泄露原文）。幂等缓存存完整 ack payload。具体：§2.5 加幂等缓存完整 ack 说明；§5.5 ack 改 payload 形状；§6.2/§6.3/§6.4/§6.5 ack + event 改 payload 形状；§10.2 CommandAck 通用形状改写；§10.4 EventEnvelope 加 `message.*` payload 同形说明。新增 §13 v4.0 addendum 实现不变量。
- **v2.7 (2026-06-25)**：Phase E delta — invite preview; owner transfer; personal sticker library (list/save/delete); sticker message (type=sticker + sticker field)。具体：§1.1 路由总览补 4 个新端点；§3.4 Message model `type` 扩展为 `text` | `image` | `sticker` | `system`，新增 `sticker` 字段（sticker 消息投影 + deleted/recalled sticker 投影）；§6.2 `message.send` 新增 sticker payload 变体（`type:"sticker"` + `sticker_id`，服务端 resolve 为 canonical `attachment_id`）；§5.10 邀请预览（read-only，无 join 副作用）；§7.5 转让群主（原子，前端不得用多个 role PATCH 拼接）；§8.3 个人表情库（list/save/delete，复用 canonical image attachment，不复制二进制）；§11 错误码表补 `STICKER_NOT_FOUND`、`STICKER_LIBRARY_LIMIT_EXCEEDED`、`INVALID_STICKER_SOURCE`。Phase E 不引入 `AttachmentDirectory DO`，sticker save 用 `{channel_id, attachment_id}` 定位源附件。
- **v2.8 (2026-06-25)**：BlurHash delta — 前端生成 BlurHash 占位图编码，在 presign 请求中传给后端；后端保存为 attachment metadata，在 finalize 响应、attachment 投影、sticker 投影、PersonalSticker model 中返回。§8.1 presign 请求加 `blurhash` 字段（可选）；§8.2 finalize 响应 + sticker image projection + PersonalSticker model + Message model sticker 投影均补 `blurhash` 字段。
- **v2.9 (2026-06-26) Phase 6 tail — 公开频道目录 + 加入公开频道实现**：§1.1 路由表 `GET /api/chat/channels/{channel_id}/public-catalog` 纠正为 `GET /api/chat/channels/directory`（无 channel_id，与 §5.6 一致）；§5.6 directory row shape 定稿（`last_message_preview=null`、`unread_count=0`，`kind`/`visibility` 为常量 `channel`/`public_listed`）；directory 排序 = `COALESCE(last_message_at, updated_at) DESC, channel_id DESC`，cursor 为该 tuple 的 base64url keyset；join 幂等缓存例外 documented（缓存响应 = membership 结果 `{role, joined_at}`；`channel` 字段每次按调用重新 inflate，可能在 title/avatar 等瞬态字段上与首次不同，但 membership 稳定 —— 这是 join 对 v4.0「cache full ack payload」规则的特例，因为 ChannelDetail 在 join 后可变而 membership 不可变）；join 响应 `membership.role` 反映调用者当前实际角色（owner/admin/member），非硬编码 `'member'`。`role` 由 `ChatChannel/internal/summary.my_role`（注意字段名是 `my_role` 非 `role`）解析；active-membership set + `last_read_event_id` 来自现有 `UserDirectory/my-channels`，不扩展 UserDirectory schema。
- **v2.10 (2026-06-26)**：Phase 7 bot runtime transport 改为 Bot Gateway WebSocket RPC（不再以 HTTP callback 为主运行时）。具体：§9 头部 bullet 改写（bot runtime = bot 主动连 `/api/chat/bot/ws`，HTTP callback 降级为 future transport）；§9.1 bot token scope 新增 `chat:runtime:connect`；§9.3 `PUT /bot/commands` request 补 `aliases`/`default_enabled_on_install`/`event_capabilities`，明确 catalog sync 不 enable 任何频道、slash token 冲突在 channel binding 层；§9.4 查询响应补 `aliases`/`matched_name`/`matched_kind`/`effective_member_permission` + prefix 匹配规则；§9.5 `command.invoke` payload 补 `invoked_name`（optional，canonical|alias）；§9.7 整节重写为 Bot Gateway WS RPC（hello/ready → delivery → delivery_result → delivery_ack 帧协议，三类 delivery kind = `command_invocation` / `message_interaction` / `message_event`，at-least-once + `delivery_id` 去重 + `(channel_id, bot_id, client_effect_id)` effect 幂等，offline policy，`message_event` sender 完整投影）；新增 §9.9 passive `message_event` 订阅（`PATCH /api/chat/channels/{channel_id}/bot-installations/{bot_id}/event-subscriptions/message.created`，Phase 7 仅 `message.created`，observer/responder only，无 consume/stop-propagation）；§1.1 路由总览补 bot runtime + bot 管理 + 被动订阅端点；§11 错误码表补 `BOT_OFFLINE`、`BOT_EFFECT_INVALID`、`BOT_EFFECT_CONFLICT`，`BOT_CALLBACK_UNAVAILABLE` 语义收窄为 future HTTP transport 预留。`PUT /api/chat/bot/commands` 与 `POST /api/chat/bot/channels/{channel_id}/messages` 保留为 bot 主动 outbound HTTP（管理/主动发送），不要求 bot 暴露 HTTP endpoint。Browser WS（`/api/chat/ws` + ToolBear browser JWT + `UserConnection DO`）与 Bot WS（`/api/chat/bot/ws` + bot token + `BotConnection DO`）分离，不复用。

## 1. 边界

ToolBear 前端只调用 `/api/chat/*` Browser API。该路径由 Cloudflare Worker 承载在 `chat.kuma.homes`，ToolBear Python 后端不存储聊天消息，不代理聊天主路径，不读写聊天数据表。前端在 `lilium.kuma.homes`，**跨域**调用 `chat.kuma.homes`（CORS + WebSocket Origin 校验）(v2 delta)。

聊天 backend 使用 Cloudflare Worker + Durable Object。附件二进制存储在 SeaweedFS（`s3.kuma.homes`，S3 兼容）；后端只存 attachment metadata 和归属关系。Worker 直接验证现有 ToolBear browser JWT，得到当前 `user_id`。用户 profile 不写入后端存储：display name 和 avatar 由 Worker 按 `user_id` 调用只读数据源（ToolBear 生产 Postgres 的 `users` 表，经 Hyperdrive）补齐 (v2 delta)。

第一版前端可以先只接 `GET /api/chat/bootstrap` 渲染页面。发送消息、WebSocket、附件上传和成员管理必须按本文 contract 预留，不在前端发明第二套形状。

### 1.1 路由总览

| 方法 | 路径 | 说明 | 章节 |
|---|---|---|---|
| GET | `/api/chat/bootstrap` | 首屏聚合 | §4.1 |
| GET | `/api/chat/channels` | 频道列表 | §5.1 |
| GET | `/api/chat/channels/{channel_id}` | 频道详情 | §5.2 |
| POST | `/api/chat/channels` | 创建频道 (v2.4 delta) | §5.2b |
| POST | `/api/chat/channels/{channel_id}/dissolve` | 解散群聊 (v2.2 delta) | §5.4 |
| GET | `/api/chat/channels/directory` | 公开频道目录 (v2.9 delta：URL 由 `/channels/{channel_id}/public-catalog` 改为无 channel_id 的 `/channels/directory`) | §5.6 |
| POST | `/api/chat/channels/{channel_id}/join` | 加入公开频道 | §5.7 |
| POST | `/api/chat/channels/{channel_id}/invites` | 创建邀请 | §5.8 |
| GET | `/api/chat/invites/{invite_code}` | 邀请预览（read-only，无 join 副作用）(v2.7 delta) | §5.10 |
| POST | `/api/chat/invites/{invite_code}/accept` | 接受邀请 | §5.9 |
| POST | `/api/chat/channels/{channel_id}/owner-transfer` | 转让群主（原子）(v2.7 delta) | §7.5 |
| GET | `/api/chat/channels/{channel_id}/messages` | 历史消息分页 | §6.1 |
| GET | `/api/chat/channels/{channel_id}/messages/{message_id}/context` | 消息上下文 | §6.6 |
| GET | `/api/chat/channels/{channel_id}/members` | 成员列表（模糊搜索） | §7.1 |
| GET | `/api/chat/channels/{channel_id}/members/{user_id}` | 按用户 ID 精确读单成员 (v2 delta) | §7.1b |
| POST | `/api/chat/channels/{channel_id}/members` | 添加成员 | §7.2 |
| PATCH | `/api/chat/channels/{channel_id}/members/{user_id}` | 修改成员角色 | §7.3 |
| DELETE | `/api/chat/channels/{channel_id}/members/{user_id}` | 移除成员 / 离开频道 | §7.4 |
| POST | `/api/chat/uploads/images/presign` | 创建图片上传 | §8.1 |
| POST | `/api/chat/uploads/images/{attachment_id}/finalize` | 完成图片上传 | §8.2 |
| GET | `/api/chat/stickers` | 个人表情库列表 (v2.7 delta) | §8.3 |
| POST | `/api/chat/stickers` | 保存个人表情 (v2.7 delta) | §8.3 |
| DELETE | `/api/chat/stickers/{sticker_id}` | 删除个人表情 (v2.7 delta) | §8.3 |
| WS | `message.send` / `message.edit` / `message.recall` / `message.delete` | 消息生命周期 mutation | §6.2 / §6.3 / §6.4 / §6.5 |
| WS | `channel.mark_read` | 标记已读 | §5.5 |
| GET | `/api/chat/bot/ws` | Bot Gateway WebSocket RPC（bot token，outbound WS）(v2.10 delta) | §9.7 |
| PUT | `/api/chat/bot/commands` | Bot 注册全局 slash command catalog（bot token）(v2.10 delta) | §9.3 |
| POST | `/api/chat/bot/channels/{channel_id}/messages` | Bot 直接发消息（bot token）(v2.10 delta) | §9.8 |
| PATCH | `/api/chat/channels/{channel_id}/bot-installations/{bot_id}/event-subscriptions/message.created` | 启用/禁用 bot passive `message.created` 订阅（Browser admin）(v2.10 delta) | §9.9 |
| POST | `/api/chat/channels/{channel_id}/bot-installations` | 安装 bot 到频道（Browser admin）(v2.10 delta) | §9.3 |
| PATCH | `/api/chat/channels/{channel_id}/bot-installations/{bot_id}` | 更新 bot 安装/卸载（Browser admin）(v2.10 delta) | §9.3 |
| PATCH | `/api/chat/channels/{channel_id}/commands/{bot_command_id}` | 启用/禁用频道内 command binding（Browser admin）(v2.10 delta) | §9.3 |
| GET | `/api/chat/channels/{channel_id}/commands` | 查询当前用户可用 command（prefix suggest）(v2.10 delta) | §9.4 |
| WS | `command.invoke` / `interaction.submit` | slash command 调用 / rich UI interaction 提交（路由到 ChatChannel DO → Bot Gateway delivery）(v2.10 delta) | §9.5 / §9.6 |

`message.*` 与 `channel.mark_read` 为 WS command（channel-scoped，路由到 `ChatChannel DO`）。其余 HTTP 端点中，`/api/chat/invites/{invite_code}*` 不含 `channel_id`，服务端按 `invite_code` 路由，索引 lag 窗口返回 `409 ROUTE_INDEX_PENDING` (v2 delta)。

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

幂等缓存存储完整 ack payload（v4.0 addendum）：对所有 idempotent message mutation，`idempotency_keys.response_json`（`operation_id`-keyed）必须存**完整 committed ack payload**，不只存 ID。重复重试（同 `operation_id` + 同 `request_hash`）原样返回该缓存 ack payload。若事后 profile display 数据变更，重复重试仍可能返回旧的 `display_name`/`avatar_url`——可接受（idempotency replay 优先稳定提交结果；正常 history/event replay 按既有策略实时 resolve 新 profile）。

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

- `type`: `text` | `image` | `sticker` | `system` (v2.7 delta：新增 `sticker`)
- `format`: `plain` | `markdown`
- `status`: `normal` | `edited` | `deleted` | `recalled`
- `stream_state`: `none` | `streaming` | `final`

`format=markdown` 只允许 Bot 消息使用。前端按受限 Markdown 渲染，禁止原始 HTML。普通用户消息固定为 `format=plain`。

`command_id` 是发送方在 `message.send` 时提供的 durable operation id（见 §2.5），用于 optimistic UI 关联与调试。由客户端生成，作为 operation id 处理，不是服务端 message id。

Message model 新增 `sticker` 字段 (v2.7 delta)。非 sticker 消息 `sticker` 为 `null`；sticker 消息 `sticker` 为完整投影。在上方 base 投影中省略该字段，下方单独给出 sticker 消息投影。

Sticker 消息投影：

```json
{
  "message_id": "00000000-0000-7000-8000-000000000301",
  "command_id": "00000000-0000-7000-8000-000000000411",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "sender": {},
  "type": "sticker",
  "format": "plain",
  "status": "normal",
  "stream_state": "none",
  "text": null,
  "sticker": {
    "sticker_id": "00000000-0000-7000-8000-000000000901",
    "attachment_id": "00000000-0000-7000-8000-000000000501",
    "url": "https://s3.kuma.homes/lilium-chat-attachments/chat/00000000-0000-7000-8000-000000000501",
    "mime_type": "image/png",
    "width": 512,
    "height": 512,
    "size_bytes": 12345,
    "blurhash": "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB"
  },
  "reply_to": null,
  "reply_snapshot": null,
  "attachments": [],
  "components": [],
  "mentions": [],
  "created_at": "2026-06-25T00:00:00Z",
  "updated_at": "2026-06-25T00:00:00Z",
  "edited_at": null,
  "deleted_at": null,
  "recalled_at": null
}
```

Sticker 消息投影规则 (v2.7 delta)：

- `type="sticker"` 要求 `sticker != null`。
- `sticker.attachment_id` 是可复用的 canonical image id（跨用户共享）。
- `sticker.sticker_id` 是发送方在发送时的个人表情库 item id，**不属于接收方**；接收方不得假设 `sticker.sticker_id` 属于自己。
- 接收方把该 sticker 存入自己的表情库时，用 `sticker.attachment_id` + 当前 `channel_id`，**不**用 `sticker.sticker_id`，也**不**用 `message_id`。
- `attachments=[]` 以避免重复渲染图片。
- `text=null`、`format="plain"`、`components=[]`、`mentions=[]`。

Deleted/recalled sticker 投影（不泄露原图）：

```json
{
  "type": "sticker",
  "status": "deleted",
  "text": null,
  "sticker": null,
  "attachments": [],
  "components": [],
  "mentions": []
}
```

删除和撤回消息保留同一个 `message_id` 供审计和事件状态更新使用。Browser history 和 event replay 返回的是可见投影，不返回已删除/撤回消息的原始 `text`、`sticker`、`attachments`、`components`、`mentions` (v2.7 delta：sticker 投影同样清空)。

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

Committed ack (v4.0 addendum：ack 携带 read-state payload，不是 message 投影，不含 `event_id`)：

```json
{
  "frame_type": "command_ack",
  "command": "channel.mark_read",
  "command_id": "00000000-0000-7000-8000-000000000511",
  "status": "committed",
  "payload": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "last_read_event_id": "01J...",
    "unread_count": 0
  }
}
```

`payload` 只含 `{ channel_id, last_read_event_id, unread_count }`，无 `event_id`、无 message 投影、无 channel timeline event 追加；read-state 留在 user-local UserDirectory。

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

> v2.9 (2026-06-26) Phase 6 实现注：当前实现 `last_message_preview=null`（preview 文本未纳入 read model，避免 stale/profanity 问题，留待 future plan 回填）与 `unread_count=0`（discover 列表不计算真实未读，左侧 rail 已为已加入频道显示未读）。`kind`/`visibility` 为目录行的常量（`channel`/`public_listed`）。排序 = `COALESCE(last_message_at, updated_at) DESC, channel_id DESC`，cursor 为该 tuple 的 base64url keyset。`role` 由 `ChatChannel(channel_id)/internal/summary.my_role`（字段名 `my_role`）解析，仅对调用者已 active-member 的行非 null；`last_read_event_id` 来自 `UserDirectory/my-channels` 投影。

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
      "last_message_preview": null,
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

### 5.10 邀请预览 (v2.7 delta)

加入前预览邀请：展示群名、头像、邀请人、成员数等。**read-only，不产生任何 join 副作用**。预览与接受（§5.9）必须保持分离。

```http
GET /api/chat/invites/{invite_code}
```

响应（当前用户未加入）：

```json
{
  "invite": {
    "invite_code": "invite-code-abc123",
    "expires_at": "2026-06-28T05:30:00Z",
    "max_uses": null
  },
  "channel": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "kind": "channel",
    "visibility": "private",
    "title": "只想听你说",
    "avatar_url": null,
    "member_count": 1060,
    "status": "active"
  },
  "inviter": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "kuma",
    "avatar_url": null
  },
  "sample_members": [
    {
      "user_id": "00000000-0000-7000-8000-000000000102",
      "display_name": "alice",
      "avatar_url": null
    }
  ],
  "my_membership": {
    "status": "not_joined",
    "channel_id": null
  }
}
```

`my_membership.status` 取值：

- `not_joined`
- `active`
- `left`
- `removed`

当前用户已是 active 成员时：

```json
{
  "my_membership": {
    "status": "active",
    "channel_id": "00000000-0000-7000-8000-000000000201"
  }
}
```

语义：

- Read-only。
- 不增加邀请使用计数。
- 不创建 member row。
- 不写 channel event。
- 不暴露频道私有历史。
- `sample_members` 只返回 UserSummary 风格的展示数据；服务端应限制数量，建议上限 3。
- 邀请不存在 / 已过期 / 已撤销 / 不可见：`404 INVITE_NOT_FOUND`。
- invite-code 路由索引 lag：`409 ROUTE_INDEX_PENDING`（与 §5.9 接受邀请同一路由约束）。
- 频道已解散：`409 CHANNEL_DISSOLVED` 或 `channel.status="dissolved"`，实现需保持一致。

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

Sticker 消息 command (v2.7 delta)：`type:"sticker"` + `sticker_id`（发送方个人表情库 item id）。服务端把 `sticker_id` resolve 为 canonical `attachment_id`，消息投影同时返回 `sticker_id` 与 `attachment_id`（见 §3.4 sticker 投影）。

```json
{
  "frame_type": "command",
  "command": "message.send",
  "command_id": "00000000-0000-7000-8000-000000000411",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "type": "sticker",
    "text": "",
    "reply_to_message_id": null,
    "attachment_ids": [],
    "sticker_id": "00000000-0000-7000-8000-000000000901",
    "mentions": []
  }
}
```

Sticker send 规则 (v2.7 delta)：

- `sticker_id` 必须属于当前用户（发送方个人表情库 item）。
- 服务端 resolve `sticker_id` 为 canonical `attachment_id`；消息投影同时返回 sender-side `sticker_id` 与 canonical `attachment_id`。
- 接收方把该 sticker 存入自己表情库时用 `channel_id + attachment_id`（不用 `sticker_id`，不用 `message_id`）。
- 同一 `command_id` + 同一 payload 重发 → 返回同一 committed ack payload（幂等）。
- 同一 sticker + 新 `command_id` → 创建新消息。
- 发送前该 sticker 已从发送方表情库移除 → `STICKER_NOT_FOUND`。
- 发送后该 sticker 从发送方表情库移除，不影响已存在的 sticker 消息。

Worker 接受 command 并在事务提交后返回 committed_ack (v2 delta；v4.0 addendum：ack 携带 canonical mutation payload，`payload.message` 为完整 Browser 投影，与历史分页 / event frame 同一 `projectMessageForBrowser` builder 产物)：

```json
{
  "frame_type": "command_ack",
  "command": "message.send",
  "command_id": "00000000-0000-7000-8000-000000000411",
  "status": "committed",
  "payload": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "event_id": "01J...",
    "message": {
      "message_id": "00000000-0000-7000-8000-000000000301",
      "command_id": "00000000-0000-7000-8000-000000000411",
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
      "text": "hello @alice",
      "reply_to": null,
      "reply_snapshot": null,
      "attachments": [],
      "components": [],
      "mentions": [
        {
          "user_id": "00000000-0000-7000-8000-000000000101",
          "start": 6,
          "end": 12
        }
      ],
      "created_at": "2026-06-21T05:30:00Z",
      "updated_at": "2026-06-21T05:30:00Z",
      "edited_at": null,
      "deleted_at": null,
      "recalled_at": null
    }
  }
}
```

`payload.message.command_id` == 该 `message.send` 的 command_id（发送方 optimistic UI 关联）。`payload.message` 是 mutation 后的 Browser-visible Message 投影，与 §3.4 Message model、§6.1 历史分页、§10.4 event frame 同形。

前端收到 committed_ack 后即可把本地 pending 绑定到 server `message_id`，即使 event frame 延迟也能正确渲染占位。event frame 仍是最终 timeline 状态来源。

幂等行为（v2.6 delta；v4.0 addendum：幂等缓存存**完整 committed ack payload**）：

- 客户端用同一 `command_id` 重发 `message.send`（重试、丢包重传）且请求体一致 → 服务端命中 `idempotency_keys` 缓存（`operation_id` = `command_id`），返回与首次**完全相同的 committed ack payload**（完整 `payload.message` 投影），不创建新消息、不广播新 event。
- 客户端用同一 `command_id` 但改了 `text`/`reply_to`/`mentions` 等字段 → `command_error`，`code=IDEMPOTENCY_CONFLICT`，`retryable=false`。前端应视为编程错误（复用 key 改 body），不应自动重试。
- 客户端发新消息即使文本相同也必须用新的 `command_id`；同文本 + 新 `command_id` → 创建新消息。
- 重复重试返回的 ack payload 是首次提交时的快照；若事后 profile display_name/avatar_url 变更，幂等重放仍可能返回旧的 display 数据（idempotency replay 优先稳定提交结果；正常 history/event replay 按既有策略实时 resolve 新 profile）。可接受。
- `message.created` event payload 的 `sender` 是 Browser projection（实时 `resolveUserSummaries`），不持久化 UserSummary；详见 §10.3 与 §10.4。ack 与 event 共用同一 `projectMessageForBrowser` builder。

随后广播：

```json
{
  "frame_type": "event",
  "api_version": "lilium.chat.v1",
  "event_id": "01J...",
  "type": "message.created",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "occurred_at": "2026-06-21T05:30:00Z",
  "payload": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "event_id": "01J...",
    "message": {
      "message_id": "00000000-0000-7000-8000-000000000301",
      "command_id": "00000000-0000-7000-8000-000000000411",
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
      "text": "hello @alice",
      "reply_to": null,
      "reply_snapshot": null,
      "attachments": [],
      "components": [],
      "mentions": [
        {
          "user_id": "00000000-0000-7000-8000-000000000101",
          "start": 6,
          "end": 12
        }
      ],
      "created_at": "2026-06-21T05:30:00Z",
      "updated_at": "2026-06-21T05:30:00Z",
      "edited_at": null,
      "deleted_at": null,
      "recalled_at": null
    }
  }
}
```

`message.created` event 的 `payload.message` 与 ack 的 `payload.message` **同形**（同一 `projectMessageForBrowser` 投影）。前端 reducer 把 ack 与 event 视为按 `message_id` 的收敛 upsert：先收到 ack 用 `payload.message` 替换本地 pending；后收到 event frame 再 upsert 同一 `message_id`，不产生重复行；event frame 是最终 timeline 收敛来源。

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

committed_ack 携带 canonical mutation payload（v4.0 addendum）。注意 `command_ack.command_id` 是本次 edit 操作 id（`...0421`），而 `payload.message.command_id` 仍是原始 `message.send` 的 command id（`...0411`）——这是有意的区分：

```json
{
  "frame_type": "command_ack",
  "command": "message.edit",
  "command_id": "00000000-0000-7000-8000-000000000421",
  "status": "committed",
  "payload": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "event_id": "01J...",
    "message": {
      "message_id": "00000000-0000-7000-8000-000000000301",
      "command_id": "00000000-0000-7000-8000-000000000411",
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
      "status": "edited",
      "stream_state": "final",
      "text": "new text",
      "reply_to": null,
      "reply_snapshot": null,
      "attachments": [],
      "components": [],
      "mentions": [],
      "created_at": "2026-06-21T05:30:00Z",
      "updated_at": "2026-06-21T05:31:00Z",
      "edited_at": "2026-06-21T05:31:00Z",
      "deleted_at": null,
      "recalled_at": null
    }
  }
}
```

随后广播 `message.updated` 事件，`payload.message` 与 ack 同形（`status=edited`，`edited_at` 已置，同一 `projectMessageForBrowser` 投影）。event frame 是最终 timeline 收敛来源。

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

committed_ack 携带 canonical mutation payload（v4.0 addendum）。撤回后 `payload.message` 为安全投影：`status=recalled`、`text=null`、`attachments=[]`、`components=[]`、`mentions=[]`，**不泄露原文 / 附件 URL / components / mentions**：

```json
{
  "frame_type": "command_ack",
  "command": "message.recall",
  "command_id": "00000000-0000-7000-8000-000000000431",
  "status": "committed",
  "payload": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "event_id": "01J...",
    "message": {
      "message_id": "00000000-0000-7000-8000-000000000301",
      "command_id": "00000000-0000-7000-8000-000000000411",
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
      "status": "recalled",
      "stream_state": "final",
      "text": null,
      "reply_to": null,
      "reply_snapshot": null,
      "attachments": [],
      "components": [],
      "mentions": [],
      "created_at": "2026-06-21T05:30:00Z",
      "updated_at": "2026-06-21T05:32:00Z",
      "edited_at": null,
      "deleted_at": null,
      "recalled_at": "2026-06-21T05:32:00Z"
    }
  }
}
```

随后广播 `message.recalled` 事件，`payload.message` 与 ack 同形（同一安全投影，不泄露原文）。内部审计可保留原文，Browser API 永不返回。

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

committed_ack 携带 canonical mutation payload（v4.0 addendum）。删除后 `payload.message` 为安全投影：`status=deleted`、`text=null`、`attachments=[]`、`components=[]`、`mentions=[]`，**不泄露原文 / 附件 URL / components / mentions**：

```json
{
  "frame_type": "command_ack",
  "command": "message.delete",
  "command_id": "00000000-0000-7000-8000-000000000441",
  "status": "committed",
  "payload": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "event_id": "01J...",
    "message": {
      "message_id": "00000000-0000-7000-8000-000000000301",
      "command_id": "00000000-0000-7000-8000-000000000411",
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
      "status": "deleted",
      "stream_state": "final",
      "text": null,
      "reply_to": null,
      "reply_snapshot": null,
      "attachments": [],
      "components": [],
      "mentions": [],
      "created_at": "2026-06-21T05:30:00Z",
      "updated_at": "2026-06-21T05:33:00Z",
      "edited_at": null,
      "deleted_at": "2026-06-21T05:33:00Z",
      "recalled_at": null
    }
  }
}
```

随后广播 `message.deleted` 事件，`payload.message` 与 ack 同形（同一安全投影，不泄露原文）。管理员删除他人消息追加 `system.notice`（`notice_kind=message.deleted`）。内部审计可保留原文；管理员审计 API 若单独存在，可在更严格鉴权下暴露原文，但 Browser API 永不返回。

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

### 7.5 转让群主 (v2.7 delta)

原子地转让频道所有权。**前端不得用多个 role PATCH（§7.3）拼接"转让群主"**——会造成竞态（中间态出现零个或多个 owner）。该端点必须在服务端单事务内完成。

```http
POST /api/chat/channels/{channel_id}/owner-transfer
Idempotency-Key: <client-key>
```

请求：

```json
{
  "target_user_id": "00000000-0000-7000-8000-000000000102",
  "previous_owner_role": "admin"
}
```

`previous_owner_role` 取值：

- `admin`
- `member`

v1 建议：前端发送 `admin`；转让后原群主成为 admin。

响应：

```json
{
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "previous_owner": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "role": "admin"
  },
  "new_owner": {
    "user_id": "00000000-0000-7000-8000-000000000102",
    "role": "owner"
  }
}
```

语义：

- 当前用户必须是该频道 active owner。
- 目标用户必须是该频道 active 成员（member/admin）。
- 频道必须 active。
- v1 使用单 owner 不变量：
  - 提交后频道内恰好存在一个 active owner。
  - 目标用户成为 owner。
  - 原群主变为 `previous_owner_role`。
- 操作必须服务端原子（单 DO 事务）。
- 服务端按需广播 role-update 事件。
- 前端以 live/replay event 为最终状态来源。

错误：

- `403 FORBIDDEN`：当前用户不是 owner。
- `404 CHANNEL_NOT_FOUND`。
- `404 MEMBER_NOT_FOUND`：目标用户不是该频道成员。
- `409 CHANNEL_DISSOLVED`。
- `409 IDEMPOTENCY_CONFLICT`。
- `422 INVALID_MEMBER_ROLE`（或既有等价 code）：目标/原角色不合法。

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
  "height": 512,
  "blurhash": "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB"
}
```

`blurhash` 是前端从图片生成的 BlurHash 字符串（占位图编码），可选；后端保存为 attachment metadata。

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
    "blurhash": "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
    "url": "https://s3.kuma.homes/lilium-chat-attachments/chat/00000000-0000-7000-8000-000000000501"
  }
}
```

Worker 在 finalize 时确认 pending attachment 属于当前用户，并检查对象已存在（HEAD）+ 校验 Content-Type 与 Content-Length 一致 (v2 delta)。`url` 是浏览器可直接读取的长期公开附件访问 URL。对象存储 key 不暴露给前端。

### 8.3 个人表情库 (v2.7 delta)

用户个人的扁平表情列表：无 pack、无市场、无频道级表情包。一个用户的库 item 由 `sticker_id` 标识。多个用户可以保存同一个 canonical image attachment。保存 sticker **不复制二进制数据**，只存引用。删除库 item 不删除历史消息、底层 attachment 对象或其他用户的库行。

Phase E **不引入 `AttachmentDirectory DO`**。因此 sticker save 必须用 `{channel_id, attachment_id}` 定位源附件（`channel_id` 路由到源 `ChatChannel DO` 验证可见性并取得 canonical 投影），不接受 `message_id`，也不接受裸 `attachment_id` 作为主源定位符。若未来 API 接受裸 `attachment_id`，后端必须先引入 `AttachmentDirectory DO` 或其他全局附件定位符。

#### Sticker image projection

个人表情库复用既有 image attachment 身份。

```json
{
  "attachment_id": "00000000-0000-7000-8000-000000000501",
  "url": "https://s3.kuma.homes/lilium-chat-attachments/chat/00000000-0000-7000-8000-000000000501",
  "mime_type": "image/png",
  "width": 512,
  "height": 512,
  "size_bytes": 12345,
  "blurhash": "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB"
}
```

规则：

- `attachment_id` 是 sticker 的 canonical image 身份。
- `url` 是该 `attachment_id` 的 Browser-visible 稳定图片 URL。
- 同一 sticker 反复发送必须投影同一 `attachment_id` 和同一图片 URL。
- v1 不引入单独的 `asset_id`。

#### PersonalSticker model

```json
{
  "sticker_id": "00000000-0000-7000-8000-000000000901",
  "attachment": {
    "attachment_id": "00000000-0000-7000-8000-000000000501",
    "url": "https://s3.kuma.homes/lilium-chat-attachments/chat/00000000-0000-7000-8000-000000000501",
    "mime_type": "image/png",
    "width": 512,
    "height": 512,
    "size_bytes": 12345,
    "blurhash": "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB"
  },
  "created_at": "2026-06-25T00:00:00Z"
}
```

- `sticker_id` 是当前用户的个人库 item id，**跨用户不稳定**。
- `attachment.attachment_id` 是可复用的 canonical image id，可跨用户的个人表情库共享。

#### 列表

```http
GET /api/chat/stickers?limit=100&cursor=opaque
```

响应：

```json
{
  "items": [],
  "next_cursor": null
}
```

语义：

- 只返回当前用户的个人表情库。
- 默认排序：`created_at DESC`。
- 服务端限制 `limit` 上限。
- 已删除的库 item 不返回。
- 每个 item 返回 `sticker_id` + canonical `attachment` 投影。

#### 保存

```http
POST /api/chat/stickers
Idempotency-Key: <client-key>
```

请求：

```json
{
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "attachment_id": "00000000-0000-7000-8000-000000000501"
}
```

规则：

- `channel_id` 必填：后端据此路由到源 `ChatChannel DO` 验证可见性并取得 canonical attachment 投影。
- `attachment_id` 必填：即使一条消息含多个附件，也能唯一定位所选图片。
- `message_id` **不**要求，且不得作为主源定位符。
- Phase E 不引入 `AttachmentDirectory DO`（见本节开头说明）。

响应：

```json
{
  "sticker": {}
}
```

语义：

- `attachment_id` 必须标识一个已 finalize 的 image attachment。
- 当前用户必须能通过 `channel_id` 内一条可见的普通 image/sticker 消息看到该附件，或按既有附件规则拥有该 finalized attachment。
- Deleted/recalled 消息的附件不得通过 Browser API 保存为 sticker。
- 保存不复制二进制对象。
- 保存只创建或返回当前用户的个人库 item（引用 canonical `attachment_id`）。
- 同一用户重复保存同一 `attachment_id` 返回既有 sticker 或幂等等价结果。
- 不写 channel timeline event。
- 不改变原消息。

#### 删除

```http
DELETE /api/chat/stickers/{sticker_id}
Idempotency-Key: <client-key>
```

响应：

```json
{
  "sticker_id": "00000000-0000-7000-8000-000000000901",
  "deleted": true
}
```

语义：

- 只删除当前用户的库 item。
- 不删除 canonical attachment。
- 不影响历史 sticker 消息。
- 不影响其他用户保存的 sticker。
- 重复删除返回幂等等价结果。

## 9. Bot 迁移预留

当前 DZMM bot 需要迁移到聊天 backend。本文不设计完整 bot 市场，但 API 必须从第一天支持官方 bot 作为外置 bot app 接入，避免后续为 bot 单独开旁路。

Bot API 与 Browser API 分离：

- Browser API 使用 ToolBear browser JWT，走 Browser WS `/api/chat/ws` → `UserConnection DO(user_id)`。
- Bot API 使用 bot token。
- Bot runtime delivery 走 **Bot Gateway WebSocket RPC**：bot 主动 outbound 连 `/api/chat/bot/ws`（bot token 鉴权）→ `BotConnection DO(bot_id)`，Chat 向 bot 推 `delivery` 帧（`command_invocation` / `message_interaction` / `message_event`），bot 回 `delivery_result`（含 effects），Chat 回 `delivery_ack`（v2.10 delta）。
- Bot 管理/主动发送仍走 outbound HTTP：`PUT /api/chat/bot/commands`、`POST /api/chat/bot/channels/{channel_id}/messages`。这些是 bot → Chat 的 HTTP，**不要求 bot 暴露 HTTP endpoint**。
- HTTP callback（Chat → bot HTTP `POST <bot_callback_url>` + HMAC 签名）降级为 **future transport**，Phase 7 不实现（v2.10 delta）。
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
- `chat:runtime:connect` — 连接 Bot Gateway WS（`GET /api/chat/bot/ws`），接收 runtime delivery（v2.10 delta）

`GET /api/chat/bot/ws` 必须有 `chat:runtime:connect` scope（v2.10 delta）。`PUT /api/chat/bot/commands` 需 `chat:commands:manage`；`POST /api/chat/bot/channels/{channel_id}/messages` 需 `chat:messages:write`。

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

请求 (v2.10 delta：补 `aliases` / `default_enabled_on_install` / `event_capabilities`)：

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
      "default_member_permission": "member",
      "default_enabled_on_install": true
    }
  ],
  "event_capabilities": [
    {
      "event_type": "message.created",
      "default_enabled_on_install": false,
      "default_filters": {
        "message_types": ["text"],
        "include_bot_messages": false,
        "include_own_messages": false,
        "only_when_mentioned": false
      }
    }
  ]
}
```

`PUT /bot/commands` only syncs the **global bot command catalog** (BotRegistry)。它 **不 enable 任何频道的 command** —— channel 内是否启用由 `POST /channels/{channel_id}/bot-installations` + `PATCH /channels/{channel_id}/commands/{bot_command_id}` 的 channel binding 层决定 (v2.10 delta)。

字段：

- `commands[].aliases`: 同一 `bot_command_id` 的 alternate slash triggers（不是独立 command）；`command.invoke` 用 `bot_command_id`，payload 带 `invoked_name`（canonical name 或 alias，见 §9.5）。
- `commands[].default_member_permission`: 默认 `member`/`admin`/`owner`；channel binding 可用 `permission_override` 覆盖（见 §9.3 channel binding 段）。
- `commands[].default_enabled_on_install`: 安装该 bot 到频道时是否默认 enable 此 command（channel binding 层读此默认值创建 binding）。
- `event_capabilities[]`: bot 声明支持的被动 event 能力 + 默认 filters；Phase 7 仅 `event_type="message.created"`（见 §9.9）。安装时按 `default_enabled_on_install` 决定是否默认创建 `channel_bot_event_subscriptions` 行。

响应 (v2.10 delta)：

```json
{
  "commands": [
    {
      "bot_command_id": "00000000-0000-7000-8000-000000000701",
      "name": "ask",
      "aliases": ["ai", "chat"],
      "enabled": true,
      "default_enabled_on_install": true,
      "updated_at": "2026-06-21T05:30:00Z"
    }
  ],
  "event_capabilities": [
    {
      "event_type": "message.created",
      "default_enabled_on_install": false,
      "updated_at": "2026-06-21T05:30:00Z"
    }
  ]
}
```

同一频道内 enabled command 名称不能冲突。**此冲突在 channel binding 层（`channel_command_names`）创建/更新时校验，不在 catalog sync 时校验** —— `PUT /bot/commands` 只写 BotRegistry catalog，不感知任何频道；`POST /channels/{channel_id}/bot-installations` 与 `PATCH /channels/{channel_id}/commands/{bot_command_id}` 在写 `channel_command_names` 时检测冲突并返回 `COMMAND_NAME_CONFLICT` (v2.10 delta)。bot slash command 定义 id 字段名为 `bot_command_id`（与 Browser WS frame 的 `command_id` = durable operation id 区分）(v2.6 delta)。

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

响应 (v2.10 delta：补 `aliases` / `matched_name` / `matched_kind` / `effective_member_permission`)：

```json
{
  "items": [
    {
      "bot_command_id": "00000000-0000-7000-8000-000000000701",
      "name": "summarize",
      "aliases": ["sum", "tl_dr"],
      "matched_name": "sum",
      "matched_kind": "alias",
      "description": "Summarize recent messages",
      "bot": {
        "bot_id": "00000000-0000-7000-8000-000000000601",
        "display_name": "Lilium Bot",
        "avatar_url": null
      },
      "options": [],
      "effective_member_permission": "member"
    }
  ]
}
```

字段与匹配规则 (v2.10 delta)：

- `prefix` 匹配 canonical `name` 或 `aliases` 任一即返回该项。
- `name`: canonical name（来自 `bot_commands.name`）。
- `aliases`: 该 command 的 alternate slash triggers（来自 channel binding snapshot）。
- `matched_name`: 实际命中 `prefix` 的 slash token（canonical name 或某个 alias）。
- `matched_kind`: `canonical`（命中 canonical name）| `alias`（命中 alias）。
- `effective_member_permission`: `permission_override ?? default_member_permission`（channel binding 的 override 优先于 catalog 默认）；与 caller role 比较，caller role 不足的 command 被过滤掉，不出现在 `items`。
- `bot`: 来自 `bot_installations` snapshot（`bot_display_name`/`bot_avatar_url`），不为此查询回源 BotRegistry。

`GET .../commands` 是 read cache（channel binding snapshot，catalog sync 后可能短暂 stale）；`command.invoke` 的 correctness source 是当前 BotRegistry catalog，不受此 stale 影响（见 §9.5）。

### 9.5 调用 slash command

WebSocket command frame (v2.6 delta：payload 用 `bot_command_id`，移除 `client_invocation_id`；`command_id` 为 durable 幂等键。v2.10 delta：payload 补 `invoked_name`)：

```json
{
  "frame_type": "command",
  "command": "command.invoke",
  "command_id": "00000000-0000-7000-8000-000000000812",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "payload": {
    "bot_command_id": "00000000-0000-7000-8000-000000000701",
    "invoked_name": "sum",
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

`invoked_name` 规则 (v2.10 delta)：

- `invoked_name` 可选。如存在，必须是该 channel `channel_command_names` 中此 `bot_command_id` 的 canonical name 或 alias；不存在或不属于该 command → `COMMAND_NOT_FOUND`。
- 如省略，服务端按 canonical name 处理。
- `invoked_name` 参与 `request_hash` 计算（幂等冲突检测）：同 `command_id` + 异 `invoked_name` → `IDEMPOTENCY_CONFLICT`。
- `command.invoke` correctness source 是当前 BotRegistry catalog（非 channel binding snapshot）：服务端 fetch 当前 `bot_commands` 行校验，disabled/deleted → `BOT_COMMAND_DISABLED`，`definition_hash` drift 用当前定义校验 options 并刷新 binding snapshot。
- bot offline precheck：bot 未连接 Bot Gateway WS → `command_error` `BOT_OFFLINE`（`retryable=true`），不持久化 invocation。

Worker 接受 command 并在事务提交后返回 committed_ack (v2.6 delta：ack 改为 payload-bearing；`command_id` 为 durable 幂等键)：

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

Worker 接受 command 并在事务提交后返回 committed_ack (v2.6 delta：ack payload-bearing；`command_id` 为 durable 幂等键)：

```json
{
  "frame_type": "command_ack",
  "command": "interaction.submit",
  "command_id": "00000000-0000-7000-8000-000000000a31",
  "status": "committed",
  "payload": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "interaction_id": "00000000-0000-7000-8000-000000000a41",
    "event_id": "01J..."
  }
}
```

随后广播事件 (v2 delta)：

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

### 9.7 Bot Gateway WebSocket RPC

Bot runtime delivery 不再以 HTTP callback 为主。Bot 主动向 Chat 发起 outbound WebSocket，Chat 通过该 WS 向 bot 下发 runtime delivery，bot 回 `delivery_result`（含 effects），Chat 回 `delivery_ack`。HTTP callback（旧 §9.7 的 `POST <bot_callback_url>` + HMAC 签名）降级为 future transport，Phase 7 不实现。

```http
GET wss://chat.kuma.homes/api/chat/bot/ws
Authorization: Bearer <bot_token>
Sec-WebSocket-Protocol: lilium.chat.bot.v1
```

语义：

- Bot 主动发起 outbound WebSocket 连接到 Chat API。
- Worker 通过 singleton BotRegistry 验证 bot token（SHA-256 hash → `bot_tokens.token_hash`）。
- Worker 将 accepted socket 路由到 `BotConnection DO(bot_id)`。
- `BotConnection` 持有 bot runtime 连接状态 + delivery 队列。
- Runtime delivery 由 Chat 经此 WS 推送给 bot（server → bot 方向）。
- Bot 回 `delivery_result` 帧（含 effects），Chat 侧校验并应用 effects，写入 `ChatChannel` timeline。
- HTTP callback（Chat → bot HTTP `POST <bot_callback_url>` + HMAC 签名）降级为 **future transport**，Phase 7 不实现（v2.10 delta）。

不要让 bot 复用 Browser WS。Browser WS 仍是 `/api/chat/ws` + ToolBear browser JWT + `UserConnection DO(user_id)`；Bot 专用 WS 是 `/api/chat/bot/ws` + bot token + `BotConnection DO(bot_id)`。

#### 9.7.1 帧协议

Bot 建连后发 `hello`：

```json
{
  "type": "hello",
  "api_version": "lilium.chat.bot.v1",
  "last_received_delivery_id": null
}
```

Server 回 `ready`：

```json
{
  "type": "ready",
  "api_version": "lilium.chat.bot.v1",
  "bot_id": "00000000-0000-7000-8000-000000000601",
  "session_id": "00000000-0000-7000-8000-000000000901",
  "server_time": "2026-06-26T00:00:00Z"
}
```

Server 下发 command invocation：

```json
{
  "type": "delivery",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "kind": "command_invocation",
  "invocation_id": "00000000-0000-7000-8000-000000000811",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "command": {
    "bot_command_id": "00000000-0000-7000-8000-000000000701",
    "name": "ask",
    "invoked_name": "ask",
    "schema_version": 3,
    "definition_hash": "sha256:...",
    "options": {}
  },
  "invoker": {
    "user_id": "00000000-0000-7000-8000-000000000101",
    "display_name": "alice",
    "avatar_url": null
  }
}
```

Server 下发 rich UI interaction：

```json
{
  "type": "delivery",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "kind": "message_interaction",
  "interaction_id": "00000000-0000-7000-8000-000000000a21",
  "channel_id": "00000000-0000-7000-8000-000000000201",
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

Server 下发 passive message event（§9.9 订阅触发）。`message` 为完整 Browser-visible Message 投影（§3.4），`sender` 按消息来源取 user 或 bot 形状（loop prevention 默认排除 bot 自己的消息，故 bot listener 通常收到的是 user sender）：

```json
{
  "type": "delivery",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "kind": "message_event",
  "event": {
    "event_id": "01J...",
    "type": "message.created",
    "occurred_at": "2026-06-26T00:00:00Z"
  },
  "channel_id": "00000000-0000-7000-8000-000000000201",
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

若 sender 是 bot（如未设 `include_bot_messages=true` 且非订阅 bot 自己，但仍可能收到其它 bot 的消息），`sender` 形状为：

```json
"sender": {
  "kind": "bot",
  "bot": {
    "bot_id": "00000000-0000-7000-8000-000000000602",
    "display_name": "Other Bot",
    "avatar_url": null
  }
}
```

Bot 回 `delivery_result`：

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

`message_event` delivery：bot 通常不带 effects（observer/responder only），可回空 `effects: []`；若 bot 要响应，按同 effect 协议返回（effects 走 `command_invocation`/`message_interaction` 相同的应用管线）。

Server 应用 effects 后回 `delivery_ack`：

```json
{
  "type": "delivery_ack",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "status": "applied"
}
```

失败 ack：

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

规则：

- `delivery_id` 是 server 生成的 durable delivery id。
- Bot 必须把 delivery 视为 **at-least-once**，按 `delivery_id` 去重。
- Effects 按 `(channel_id, bot_id, client_effect_id)` 幂等。
- Server 可在 reconnect 后 redeliver 已发送但未完成 `delivery_result`/`delivery_ack` 的 delivery。
- Bot 可对同一 `delivery_id` 重发 `delivery_result`。
- 同一 `client_effect_id` 配不同 body → `BOT_EFFECT_CONFLICT`。

#### 9.7.2 Bot offline policy

首版 policy：

- `command_invocation`：command.invoke precheck 时 bot 离线 → `command_error` `BOT_OFFLINE`；invocation 已 commit 但 delivery 前 bot 断连 → 短 TTL 后 invocation 标 failed。
- `message_interaction`：interaction.submit precheck 时 bot 离线 → `command_error` `BOT_OFFLINE`；interaction 已 commit 但 delivery 前 bot 断连 → 短 TTL 后 interaction 标 failed。
- `message_event`：bot 离线时 drop / expire，不产生用户可见错误；Phase 7 不批量重放历史 passive event。

#### 9.7.3 Effects

Bot `delivery_result` 可返回的 effect（与 §9.7 旧 HTTP callback 响应同集）：

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

Chat 按 `(channel_id, bot_id, client_effect_id)` 对 effects 做幂等。`append_stream` 只能作用于同一 Bot 创建且仍为 `stream_state=streaming` 的消息。

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

### 9.9 Passive message_event 订阅

替代旧的 bot listener 能力。频道级 event subscription，由 channel owner/admin 为已安装的 bot 启用/禁用 `message.created` 被动投递。投递走 §9.7 Bot Gateway WS（`kind=message_event`）。

```http
PATCH /api/chat/channels/{channel_id}/bot-installations/{bot_id}/event-subscriptions/message.created
Authorization: Bearer <toolbear_browser_jwt>
Idempotency-Key: <key>
```

请求：

```json
{
  "enabled": true,
  "filters": {
    "message_types": ["text"],
    "include_bot_messages": false,
    "include_own_messages": false,
    "only_when_mentioned": false
  }
}
```

规则：

- owner/admin only（Browser API，channel admin 操作）。
- bot 必须已安装在该频道（`bot_installations.status=active`）。
- Phase 7 仅支持 `event_type="message.created"`。
- 默认 filters：`message_types=["text"]`、`include_bot_messages=false`、`include_own_messages=false`、`only_when_mentioned=false`。
- listener 是 observer/responder only：**无 consume / stop-propagation 语义**（Phase 7 不实现旧 `listen_rules` 的 consume/stop-propagation；如需完整 stateful session 见 Phase 7 plan 7g future note）。
- loop prevention：默认排除 bot 自己发的消息、默认排除该 bot 自己的消息；bot effect 生成的消息不触发同一 bot 的 `message_event` 订阅。
- bot 离线时 `message_event` delivery drop/expire，无用户可见错误；Phase 7 不批量重放历史 passive event。
- 响应：`{ subscription_id, channel_id, bot_id, event_type, status, filters }`，幂等由 `Idempotency-Key`。

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

Worker 收到 command frame 后做协议校验并执行业务事务。事务提交后返回 committed_ack (v2 delta；v4.0 addendum：ack 携带 command-specific canonical mutation payload)：

```json
{
  "frame_type": "command_ack",
  "command": "message.send",
  "command_id": "00000000-0000-7000-8000-000000000411",
  "status": "committed",
  "payload": {}
}
```

通用规则（v4.0 addendum）：

- `command_id` 从 command frame 回显。
- `status="committed"` 表示目标 DO 事务已提交。
- `payload` 包含该 command 的 canonical result（command-specific 形状）。
- 重复幂等重试返回**完全相同**的 committed ack payload。
- `payload` 必须包含客户端 reconcile 所需的服务端生成 ID。

`payload` 形状按 command 类型：

- `message.send` / `message.edit` / `message.recall` / `message.delete` → `{ channel_id, event_id, message }`，`message` 为完整 Browser-visible Message 投影（见 §6.2/§6.3/§6.4/§6.5、§3.4）。
- `channel.mark_read` → `{ channel_id, last_read_event_id, unread_count }`（无 `event_id`，见 §5.5）。
- `command.invoke` / `interaction.submit` → 含 `invocation_id` / `interaction_id` + `event_id` 等 reconcile 所需 ID。

`message.*` 的 ack `payload.message` 与对应 event frame 的 `payload.message` **同形**（同一 `projectMessageForBrowser` builder 产物）。前端 reducer 把 ack 与 event 视为按 `message_id` 的收敛 upsert：先收到 ack 用 `payload.message` 替换本地 pending；后收到 event frame 再 upsert 同一 `message_id`，不产生重复行；event frame 是最终 timeline 收敛来源，ack 是发起 command 的即时提交结果。

committed_ack 携带提交结果，前端可立即绑定本地 pending。event frame 仍是最终 timeline 状态。

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

`message.*` 事件 payload 形状（v4.0 addendum）：`message.created` / `message.updated` / `message.recalled` / `message.deleted` 的 `payload` 为 `{ channel_id, event_id, message }`，其中 `message` 为**完整 Browser-visible Message 投影**（sender UserSummary、type、format、status、stream_state、text、reply_to、reply_snapshot、attachments、components、mentions、created/updated/edited/deleted/recalled 时间戳），与对应 committed ack 的 `payload.message` **同形**——同一 `projectMessageForBrowser` builder 产物（完整 `message.created` event 示例见 §6.2）。`message.recalled` / `message.deleted` 的 event payload 必须用安全投影：`text=null`、`attachments=[]`、`components=[]`、`mentions=[]`，不泄露原文/附件/components/mentions。`events.payload_json`（DO storage）不持久化 UserSummary，只存 sender/actor 引用；`sender` 的 `display_name`/`avatar_url` 在输出时（live broadcast + replay）由 `resolveUserSummaries` 实时回填。

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
| 404 | STICKER_NOT_FOUND | sticker 不存在或不属于当前用户 (v2.7 delta) |
| 409 | STICKER_LIBRARY_LIMIT_EXCEEDED | 当前用户的表情库已达服务端上限 (v2.7 delta) |
| 422 | INVALID_STICKER_SOURCE | 源 channel/attachment 不可作为 image/sticker 保存 (v2.7 delta) |
| 409 | COMMAND_NAME_CONFLICT | 同一频道内 slash command 名称冲突 |
| 422 | INVALID_COMMAND_OPTIONS | command 参数不合法 |
| 404 | COMPONENT_NOT_FOUND | 组件不存在或不可见 |
| 409 | COMPONENT_DISABLED | 组件已禁用 |
| 422 | INVALID_INTERACTION_VALUE | interaction value 不合法 |
| 503 | BOT_OFFLINE | command.invoke/interaction.submit precheck 时 bot 未连接 Bot Gateway WS，可重试 (v2.10 delta) |
| 422 | BOT_EFFECT_INVALID | bot `delivery_result` 返回的 effect 校验失败（ownership/stream 不变量/components 非法）(v2.10 delta) |
| 409 | BOT_EFFECT_CONFLICT | 同一 `(channel_id, bot_id, client_effect_id)` 配不同 effect body (v2.10 delta) |
| 429 | RATE_LIMITED | 限流命中，可重试 (v2 delta) |
| 503 | BOT_CALLBACK_UNAVAILABLE | future HTTP callback transport 预留；Phase 7 Bot Gateway WS 为唯一 runtime transport，此码不返回 (v2.10 收窄) |
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

不进 lilium-chat。每后端阶段交付后，前端在 dzmm_archive 对应接入。前端开工前必须落地本 contract v2.7（per-channel cursor + committed_ack + transport-neutral operation_id 幂等 + ROUTE_INDEX_PENDING 仅 invite-code + WS message mutation/read-state + dissolve + system.notice + 资源级 not-found code + Phase E：invite preview / owner transfer / 个人表情库 / sticker message），否则前后端会引用不同 contract (v2 delta, v2.6 / v2.7 调整)。

### 12.10 阶段 E：管理 UX + 个人表情 (v2.7 delta)

邀请预览（§5.10，read-only）；转让群主（§7.5，原子）；个人表情库 list/save/delete（§8.3，复用 canonical image attachment，不复制二进制）；sticker message（§3.4 + §6.2，`type="sticker"` + `sticker` 字段，WS `message.send` 接受 `sticker_id`，服务端 resolve 为 canonical `attachment_id`）。复用既有成员 role/remove、invite create/accept、频道头像更新；不新增 pack / 市场 / 频道级表情包 / 好友私聊 / 频道标签 API。

## 13. v4.0 addendum 实现不变量（WS committed_ack canonical payload）

以下不变量对应 `docs/superpowers/specs/v4.0-patch.md` Part 3 addendum N，与本文 §2.5/§5.5/§6.2-§6.5/§10.2/§10.4 同步生效：

1. 每个 committed WS mutation ack 返回 command-specific 的 canonical result payload。
2. `message.*` committed ack payload 包含 `{ channel_id, event_id, message }`。
3. `payload.message` 是 mutation 后的 Browser-visible Message 投影。
4. `message.*` event payload 使用与 ack 相同的 Browser-visible Message 投影形状。
5. deleted/recalled 的 message 投影不得暴露原始 text、attachments、components、mentions。
6. `channel.mark_read` ack payload 包含 read-state，不包含 `event_id`。
7. 幂等缓存存完整 committed ack payload（不只 ID）。
8. ack 与 event reducer 必须是按 `message_id` / `event_id` 的幂等 upsert。

## 14. v2.10 addendum 实现不变量（Phase 7 Bot Gateway WS RPC）

以下不变量对应 Phase 7 bot runtime transport 改造（§9.7 / §9.9），与本文 §9 / §11 同步生效：

1. Bot runtime delivery 唯一 transport 为 Bot Gateway WebSocket RPC（`/api/chat/bot/ws`）；HTTP callback（`POST <bot_callback_url>` + HMAC 签名）Phase 7 不实现，列为 future transport。
2. Bot WS 与 Browser WS 物理分离：`/api/chat/bot/ws` + bot token + `BotConnection DO(bot_id)`；`/api/chat/ws` + ToolBear browser JWT + `UserConnection DO(user_id)`。Bot 不复用 Browser WS。
3. `BotRegistry` 为 singleton DO（`getByName("registry")`），因 token 原文→hash 不可反查 `bot_id`，token 验证需单点 `SELECT ... WHERE token_hash=?`。
4. `BotConnection DO(bot_id)` 持有 bot WS hibernation + delivery 队列；ChatChannel 通过 `bot_delivery_outbox` 异步 fan-out delivery 到 BotConnection，不在 `command.invoke` / `interaction.submit` 请求路径同步等 bot。
5. delivery 是 at-least-once：bot 按 `delivery_id` 去重；effects 按 `(channel_id, bot_id, client_effect_id)` 幂等；同 `client_effect_id` 异 body → `BOT_EFFECT_CONFLICT`。
6. ChatChannel 是 invocation / interaction / subscription / effect 应用 source-of-truth；BotConnection 只持有连接与 delivery 队列，effect 应用结果回写源 ChatChannel `/internal/bot-delivery-result`。
7. 两套 status 分开：outbox `pending | delivered | failed | dead_letter`；invocation/interaction lifecycle `pending | dispatched | completed | failed | expired`。
8. bot offline policy：`command_invocation` / `message_interaction` precheck 时 bot 离线 → `BOT_OFFLINE`；已 commit 后断连 → 短 TTL 标 failed；`message_event` 离线 drop/expire，无用户可见错误，Phase 7 不批量重放历史 passive event。
9. passive `message_event` listener observer/responder only：无 consume / stop-propagation 语义；loop prevention 默认排除 bot 自己的消息与该 bot 自己生成的消息。
10. Bot 管理/主动发送（`PUT /bot/commands`、`POST /bot/channels/{channel_id}/messages`）是 bot → Chat 的 outbound HTTP，不要求 bot 暴露 HTTP endpoint。
