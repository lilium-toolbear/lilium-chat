# ToolBear Chat Browser/Bot API Contract

状态：实现前 API contract（v2.20，v4.4-aligned —— … + 2026-06-27 DM：`POST /api/chat/dms`（v2.13）；+ 2026-06-30 internal addendum：Bot streaming + internal API，§16–§17）
日期：2026-06-22（权威文件：`docs/api-contract.md`）
范围：lilium-chat 后端（Cloudflare Worker + Durable Object）的 browser/bot-facing wire shape
权威来源：

- **本文件**（`docs/api-contract.md`）是 Browser/Bot API contract 的 **唯一 source of truth**
- 实现设计：`docs/superpowers/specs/2026-06-22-lilium-chat-backend-design.md`（v4.0）
- 前身 contract：`dzmm_archive/docs/plans/2026-06-21-toolbear-chat-api-contract.md`（v1）
- 历史 patch / 讨论：`docs/api-contract/`（**非**权威；见该目录 `README.md`）

本文件是 v1 contract 的**修订版**。所有与 v1 一致的部分保持原状；偏离处显式标注 `(v2 delta)`。前端与 bot 实现**以本文件为准**。任何 API 变更必须修改本文件并追加修订记录条目；**不要**为追平 spec 去改历史 addendum、phase plan、gap tracker 等归档文档。

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
| Browser WS 子协议 | `lilium.chat.v1`；connect 隐式订阅全部 `my_channels` + connect-time replay（`?cursors=`） | **`lilium.chat.v2`**；connect 只建 session；`session.live_start` 后为全部 active 频道注册 fanout lease；**无 WS replay/cursor** (v2.11 delta, Phase 8) |
| Live push 订阅模型 | connect 后 server 自动 register-online + replay | **`session.live_start` + `session.heartbeat` + affected-user live resync**；全 active 频道 best-effort live push；`ChannelFanout` 为 TTL lease cache；**v1 无 `channel.subscribe`**；membership projection 成功后可发 `user_event my_channels_changed` hint (v2.12 delta) |
| 事件恢复权威来源 | WS connect replay + `?cursors=` | **HTTP** bootstrap / history / `GET .../events`；WS 仅 best-effort live (v2.11 delta) |

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
- **v2.11 (2026-06-27)**：Phase 8 Live Fanout redesign（无 WS cursor recovery）。具体：Browser WS 子协议 **`lilium.chat.v1` → `lilium.chat.v2`（breaking）**；§10.1 connect 只建 live session，**不** replay、**不**解析 `?cursors=`、**不**隐式订阅；新增 §5.11 `session.live_start`、§5.12 `session.heartbeat`；§10.5/§10.6；**v1 无 `channel.subscribe`**；§5.5 read-state 澄清；§6.1b `GET .../events`；§12.11；§15 addendum（含 membership re-check 与 heartbeat 不得复活 stale lease）。设计：`docs/plans/2026-06-27-userconnection-live-subscription-redesign.md`。
- **v2.12 (2026-06-27)**：Phase 8 live membership resync delta。Membership mutation 在 `UserDirectory /my-channels` projection 可见后按 `affected_user_id` 通知 `UserConnection /internal/live-memberships-changed`，主动为已有 live sessions 建立/关闭 leases；新增 Browser-visible user-scoped hint frame `user_event my_channels_changed`（非 timeline、非权威、漏收安全）。Heartbeat 保留为 fallback convergence，不再是新频道订阅/踢出/解散收敛主路径。
- **v2.14 (2026-06-27)**：v4.4 delta — 移除默认 system channel。`GET /bootstrap` 及 `GET /channels` **不再** lazy-create 或 lazy-join 系统公共频道；新用户返回空 `channels`（§4.1 空列表示例为 norm）。所有 ChatChannel DO name = `channel_id`（§5.2b 删除 `system-general` 路由例外）。用户须通过创建频道、公开目录 join、邀请或被添加成员获得 membership。
- **v2.13 (2026-06-27)**：DM delta（完整规范见 **`docs/api-contract/2026-06-27-dm-api-contract-addendum.md`**，实现前以 addendum 为准）。新增 `POST /api/chat/dms` get-or-create 一对一 DM；`ChannelSummary.dm_peer`；`dm.open` 幂等由 `UserDirectory(current_user_id)` 协调（同 `Idempotency-Key` 异 `recipient_user_id` → `409 IDEMPOTENCY_CONFLICT`）；pair 唯一性由 `DMDirectory(pair_key)` 协调；`POST /dms` 响应必须返回完整 `ChannelSummary`（含 `unread_count` / `last_message_*`）；DM 禁用频道管理/Bot 路径返回 `409 UNSUPPORTED_CHANNEL_KIND`（`GET .../commands` on DM 返回空列表例外）。`POST /channels` 仍只创建 `kind=channel`。
- **v2.15 (2026-06-28)**：`invite_url` 修正为 SPA 前端域名（`API_BASE_URL`，如 `https://lilium.kuma.homes`），不再使用 Worker API host（`chat.kuma.homes`）。§5.8 响应示例与说明同步。
- **v2.16 (2026-06-28)**：Bot platform admin delta（与 `docs/api-contract/2026-06-28-bot-slash-command-contract-addendum.md` 叠加）。§2.1 JWT 补 `admin` claim；§9.3 catalog sync 补 `help_text`、移除 `default_enabled_on_install` / `event_capabilities`（slash 模型）；§9.4 manifest 返回 `{version, items}`，补 `help_text`、platform `/help`、official bot 全局 auto-allow（block-only）；§9.5 platform `/help` invoke 同步发 bot message、无 Bot Gateway delivery；§9.2 platform bot 固定 identity；新增 §9.10 Developer Bots API、§9.11 Admin Bots API；§1.1 路由表移除 `bot-installations`、补 developer/admin bot 路由；§11 补 `ADMIN_ACCESS_REQUIRED`、`OFFICIAL_COMMAND_AUTO_ALLOWED`。
- **v2.18 (2026-06-28)**：Rich UI components v2 + `interaction_policy`（v2.18 delta）。§3.8 扩展 `kind` 为 `button` | `select` | `radio` | `checkbox` | `checkbox_group` | `text_input`；新增 per-component `interaction_policy`（`multi` | `per_user_once` | `exclusive` | `targeted`）与 `target_user_id`；§9.6 补 submit 触发规则、`value` 类型表、平台/Bot 职责分界、delivery 顺序不变量；§11 补 `COMPONENT_ALREADY_USED`、`INTERACTION_ALREADY_SUBMITTED`、`INTERACTION_FORBIDDEN_TARGET`。
- **v2.19 (2026-06-30)**：Bot internal contract addendum（§16，**内部实现专用，不对第三方公开**）。§9.7.3 流式 effect 设计被 §16 替换：主 Bot Gateway WS 仅接受 `start_stream`；`append`/`finalize` 走专用 Stream WS（§16.4）；`delivery_ack.effect_results` 携带 `start_stream` 的 `message_id`/`ws_url`；Browser live stream frames 与 canonical `message.stream_finalized` 分离；Machine Token owner API / Bot read API / Bot attachment upload 明确为 future/open。后端实现不变量见 §17；实现 spec 见 `docs/superpowers/specs/2026-06-30-lilium-chat-bot-streaming-and-internal-api-spec.md`。
- **v2.20 (2026-06-30)**：权威 contract 文件迁至 `docs/api-contract.md`（自 `docs/api-contract/2026-06-22-toolbear-chat-api-contract.md`）。`docs/api-contract/` 目录改为 patch / 讨论 / changelog 存放处，**不是**权威文档；所有 API 变更须直接修改本文件并保留修订记录。

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
| POST | `/api/chat/dms` | get-or-create 一对一 DM (v2.13 delta，详见 DM addendum) | addendum §2 |
| POST | `/api/chat/channels/{channel_id}/dissolve` | 解散群聊 (v2.2 delta) | §5.4 |
| GET | `/api/chat/channels/directory` | 公开频道目录 (v2.9 delta：URL 由 `/channels/{channel_id}/public-catalog` 改为无 channel_id 的 `/channels/directory`) | §5.6 |
| POST | `/api/chat/channels/{channel_id}/join` | 加入公开频道 | §5.7 |
| POST | `/api/chat/channels/{channel_id}/invites` | 创建邀请 | §5.8 |
| GET | `/api/chat/invites/{invite_code}` | 邀请预览（read-only，无 join 副作用）(v2.7 delta) | §5.10 |
| POST | `/api/chat/invites/{invite_code}/accept` | 接受邀请 | §5.9 |
| POST | `/api/chat/channels/{channel_id}/owner-transfer` | 转让群主（原子）(v2.7 delta) | §7.5 |
| GET | `/api/chat/channels/{channel_id}/messages` | 历史消息分页 | §6.1 |
| GET | `/api/chat/channels/{channel_id}/events` | 频道事件 gap 恢复（HTTP 权威）(v2.11 delta) | §6.1b |
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
| WS | `session.live_start` | 启动全频道 live fanout（无 replay）(v2.11 delta) | §5.11 |
| WS | `session.heartbeat` | 刷新 live session fanout lease (v2.11 delta) | §5.12 |
| GET | `/api/chat/bot/ws` | Bot Gateway WebSocket RPC（bot token，outbound WS）(v2.10 delta) | §9.7 |
| GET | `/api/chat/bot/channels/{channel_id}/streams/{message_id}/ws` | Bot Stream WebSocket（一连接一流；append/finalize）(v2.19 internal addendum) | §16.4 |
| PUT | `/api/chat/bot/commands` | Bot 注册全局 slash command catalog（bot token）(v2.10 delta) | §9.3 |
| WS (Bot Gateway) | `delivery_result` / `session.effects` | Bot 非流式 effect + `start_stream`（v2.19：append/finalize 走 Stream WS） | §9.7 / §16.3 |
| WS (Bot Stream) | `append` / `finalize` | 单条 streaming message 的 delta 追加与 finalize (v2.19 internal addendum) | §16.4 |
| PATCH | `/api/chat/channels/{channel_id}/commands/{bot_command_id}` | allow/block 频道 command binding（Browser admin） | §9.3 / addendum |
| GET | `/api/chat/channels/{channel_id}/commands` | 频道 command manifest | §9.4 |
| GET | `/api/chat/commands/directory` | 全局 command 目录搜索 | addendum |
| GET | `/api/chat/channels/{channel_id}/stateful-session` | 当前 stateful session | addendum |
| POST | `/api/chat/channels/{channel_id}/stateful-session/stop` | 停止 stateful session | addendum |
| POST | `/api/chat/bots` | 创建 bot（developer）(v2.16 delta) | §9.10 |
| GET | `/api/chat/bots` | 列出当前用户拥有的 bot (v2.16 delta) | §9.10 |
| GET | `/api/chat/bots/{bot_id}` | bot 详情（owner）(v2.16 delta) | §9.10 |
| PATCH | `/api/chat/bots/{bot_id}` | 更新 bot（owner；`official` 需 admin）(v2.16 delta) | §9.10 |
| GET | `/api/chat/bots/{bot_id}/tokens` | 列出 token 元数据 (v2.16 delta) | §9.10 |
| POST | `/api/chat/bots/{bot_id}/tokens` | 创建 token (v2.16 delta) | §9.10 |
| DELETE | `/api/chat/bots/{bot_id}/tokens/{token_id}` | 撤销 token (v2.16 delta) | §9.10 |
| GET | `/api/chat/admin/bots` | 全局 bot 列表（admin）(v2.16 delta) | §9.11 |
| GET | `/api/chat/admin/bots/{bot_id}` | bot 详情（admin）(v2.16 delta) | §9.11 |
| PATCH | `/api/chat/admin/bots/{bot_id}` | 更新任意 bot（admin）(v2.16 delta) | §9.11 |
| GET | `/api/chat/admin/bots/{bot_id}/tokens` | 列出 token 元数据（admin）(v2.16 delta) | §9.11 |
| DELETE | `/api/chat/admin/bots/{bot_id}/tokens/{token_id}` | 撤销 token（admin）(v2.16 delta) | §9.11 |
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
- ToolBear admin claim：JWT payload `admin === true` 时 Worker 将 caller 视为 chat admin（`is_admin`），用于 `visibility: "official"` 设置及 `GET/PATCH /api/chat/admin/bots*` 鉴权 (v2.16 delta)。非 admin JWT 不得通过 developer API 将 bot `visibility` 设为 `official`（`403 ADMIN_ACCESS_REQUIRED`）。

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
new WebSocket("wss://chat.kuma.homes/api/chat/ws", [
  "lilium.chat.v2",
  "bearer.<toolbear_browser_jwt>"
])
```

Worker 只接受 `lilium.chat.v2` + `bearer.<jwt>` subprotocol (v2.11 delta：`lilium.chat.v1` 已废弃，connect 返回 `426` 或握手失败)。JWT 验证规则与 HTTP Browser API 一致。WS upgrade 时校验 `Origin` ∈ {`https://lilium.kuma.homes`, 本地开发 origin}，不匹配拒绝 (v2 delta)。

> **v2.11 breaking：** connect URL **不再**使用 `?cursors=`。旧客户端若传入，服务端 **MAY ignore**，但 **MUST NOT** 用于 `UserConnection` replay。Per-channel gap recovery 改由 HTTP `GET /api/chat/bootstrap`、`GET /api/chat/channels/{channel_id}/events` 或 `GET /api/chat/channels/{channel_id}/messages` 承担。Live push 在 WS `open` 后由客户端自动发送 `session.live_start` 建立（§5.11）。

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

Bot 消息可以携带 rich interactive UI。组件由 Bot 生成，Worker 校验后随消息持久化。普通用户消息不能携带 components (v2.18 delta)。

**公共字段（所有 kind）：**

| 字段 | 说明 |
|---|---|
| `component_id` | UUIDv7；组件稳定 id |
| `kind` | 见下方枚举 |
| `custom_id` | Bot 私有 payload；前端只原样回传，不解析 |
| `disabled` | `true` 时不可提交 |
| `interaction_policy` | 可选；缺省 `multi`（v2.18 delta） |
| `target_user_id` | `interaction_policy=targeted` 时必填；仅该用户可提交 (v2.18 delta) |

**`interaction_policy`（v2.18 delta，Worker 在 `interaction.submit` 事务内原子执行）：**

| policy | 平台保证 |
|---|---|
| `multi`（默认） | 频道内任意可见成员可提交；同一 `(user, command_id)` 幂等 |
| `per_user_once` | 同一 `(message_id, component_id, actor_user_id)` 只允许一条成功 interaction；重复 → `409 INTERACTION_ALREADY_SUBMITTED` |
| `exclusive` | 全频道该 component 只允许一条成功 interaction；首个成功 submit **同事务** 将该 component 标 `disabled=true`；后续 → `409 COMPONENT_ALREADY_USED` |
| `targeted` | 仅 `target_user_id` 可提交；他人 → `403 INTERACTION_FORBIDDEN_TARGET` |

平台负责 **结构性门禁**（谁能点、能点几次、是否一次性锁死）与 **有序事件流**；**业务冲突**（余额、库存、游戏状态等）由 Bot 在 `delivery_result.effects` 中自行裁决。Bot 的 `disable_components` 用于 UI 反馈与 Bot 主动锁控件，**不能**作为 `exclusive` 的替代（`exclusive` 已在 submit 事务内锁死，无竞态窗口）。

按钮：

```json
{
  "component_id": "00000000-0000-7000-8000-000000000a01",
  "kind": "button",
  "style": "primary",
  "label": "确认",
  "custom_id": "confirm",
  "disabled": false,
  "interaction_policy": "exclusive"
}
```

下拉选择（`select`）：

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

可见单选（`radio`；与 `select` 区别为平铺选项，点一项即提交）：

```json
{
  "component_id": "00000000-0000-7000-8000-000000000a03",
  "kind": "radio",
  "label": "选择难度",
  "custom_id": "difficulty",
  "disabled": false,
  "options": [
    { "value": "easy", "label": "简单" },
    { "value": "hard", "label": "困难" }
  ]
}
```

单项复选（`checkbox`）：

```json
{
  "component_id": "00000000-0000-7000-8000-000000000a04",
  "kind": "checkbox",
  "label": "同意条款",
  "custom_id": "agree_tos",
  "disabled": false,
  "default_checked": false
}
```

多项复选（`checkbox_group`；须用户点组内「提交」才发 `interaction.submit`）：

```json
{
  "component_id": "00000000-0000-7000-8000-000000000a05",
  "kind": "checkbox_group",
  "label": "战利品筛选",
  "custom_id": "loot_filter",
  "disabled": false,
  "submit_label": "确认",
  "options": [
    { "value": "weapon", "label": "武器" },
    { "value": "armor", "label": "防具" }
  ],
  "min_selected": 0,
  "max_selected": 2
}
```

文本输入（`text_input`）：

```json
{
  "component_id": "00000000-0000-7000-8000-000000000a06",
  "kind": "text_input",
  "label": "角色名",
  "custom_id": "char_name",
  "disabled": false,
  "placeholder": "最多 16 字",
  "multiline": false,
  "min_length": 1,
  "max_length": 16,
  "submit_label": "提交"
}
```

枚举：

- `kind`: `button` | `select` | `radio` | `checkbox` | `checkbox_group` | `text_input` (v2.18 delta)
- `style`（仅 `button`）: `primary` | `secondary` | `danger`
- `interaction_policy`: `multi` | `per_user_once` | `exclusive` | `targeted` (v2.18 delta)

**提交触发（Browser 行为，v2.18 delta）：**

| kind | 何时发 `interaction.submit` |
|---|---|
| `button` | 点击 |
| `select` / `radio` | 选中一项 |
| `checkbox` | 每次 toggle |
| `checkbox_group` | 用户点 `submit_label` |
| `text_input` | 单行：Enter 或点 `submit_label`；多行（`multiline=true`）：仅点 `submit_label` |

typing 中间态 **不** 发 interaction；只有上述触发才进入 §9.6 流程。

## 4. 首屏

### 4.1 Bootstrap

```http
GET /api/chat/bootstrap?channel_id=00000000-0000-7000-8000-000000000201
```

`channel_id` 可选。未传时后端选择**当前用户已加入频道列表**中最近活跃的一个；若用户尚未加入任何频道则 `active_channel=null`（v2.13）。

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
- `POST /api/chat/channels` 仍只创建 `kind="channel"`，请求不接受 `kind` 字段。**Phase 3 允许任意已认证 Browser 用户创建 `kind="channel"` 频道**。DM 不通过本端点创建；DM 创建已在 v2.13 暴露为 `POST /api/chat/dms`，详见 `docs/api-contract/2026-06-27-dm-api-contract-addendum.md`。
- endpoint 必须存在——后续 admin UI / 初始化工具 / 测试 fixture 都经此正式入口，不靠 `/internal/*` 旁路。

路由与幂等（v2.5 delta）：创建频道的幂等由 `UserDirectory(creator_user_id)` 协调，不由 Worker 现场 mint 的 `ChatChannel` DO 承担。Worker 路由到 `UserDirectory(user_id)`，后者在其 `idempotency_keys` 事务内 mint `channel_id`（UUIDv7，即 `ChatChannel` DO name），状态机 `creating`→`completed`，持久化 `channel_id`，再调用 `ChatChannel(channel_id).createChannel`（单事务原子写入，`channel_meta` 存在性即幂等 guard）。同一 `(user, operation=channel.create, key)` + 相同 `request_hash` 重试命中同一 `UserDirectory` DO → 同一 `channel_id` → 同一 `ChatChannel` DO → 缓存结果；不同 `request_hash` 返回 `409 IDEMPOTENCY_CONFLICT`。崩溃窗口：`status=creating` 时 retry 重新调用同一 `ChatChannel(channel_id).createChannel`（幂等返回已提交行）后标 `completed`，不重复建群。跨 DO 仍为 best-effort（无 2PC）。



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

**Read-state is not live delivery state (v2.11 delta):** `last_read_event_id` 表示当前用户已将频道标为已读至该 event。它**不是** WebSocket delivery cursor，**不用于** WS replay、重连恢复、fanout lease 刷新或 gap repair。HTTP bootstrap/history/events API 负责恢复。服务端必须保持 `(user_id, channel_id)` 上 `last_read_event_id` 单调前进，并向该用户所有 live session 广播 `read_state_updated`（§5.5 multi-session note）。

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
  "invite_url": "https://lilium.kuma.homes/chat/invites/invite-code-abc123",
  "expires_at": "2026-06-28T05:30:00Z",
  "max_uses": null
}
```

`invite_url` 是 Browser 可打开的 SPA 邀请页 URL，由 Worker 配置 `API_BASE_URL`（ToolBear 前端 origin，如 `https://lilium.kuma.homes`）与 `/chat/invites/{invite_code}` 拼接而成；**不是** Worker API host（`chat.kuma.homes`）。

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

### 5.11 启动 live fanout：`session.live_start` (v2.11 delta, Phase 8)

WebSocket `open` 后，Browser socket manager **必须自动**发送本 command。这不是用户可见的 per-channel 订阅操作；它为当前用户全部 **active** 成员频道启动 live fanout。

```json
{
  "frame_type": "command",
  "command": "session.live_start",
  "command_id": "00000000-0000-7000-8000-000000000001",
  "payload": {}
}
```

Committed ack：

```json
{
  "frame_type": "command_ack",
  "command": "session.live_start",
  "command_id": "00000000-0000-7000-8000-000000000001",
  "status": "committed",
  "payload": {
    "session_id": "00000000-0000-7000-8000-000000000101",
    "subscribed_channel_count": 12,
    "lease_expires_at": "2026-06-27T13:10:00Z"
  }
}
```

语义：

- 为当前用户全部 active 成员频道注册 `ChannelFanout` fanout lease（经 `UserConnection` 本地 `live_channel_leases`）。
- 对当前 WebSocket session **幂等**；同一 `command_id` 重试返回等价 ack。
- 已 live 的 session 用不同 `command_id` 重发 **不得**为同一 `(session_id, channel_id)` 创建重复 lease。
- **不得** replay 历史 channel events。
- **不得**接受或处理 per-channel cursor。
- **不得**发送历史 `message.created` / `message.updated` / `message.deleted` 等 event。
- 部分频道 lease 瞬态失败 → `503 CHAT_WORKER_UNAVAILABLE`（除非实现可证明确定性 partial retry 路径）。
- Connect 握手期间 **不得**执行本逻辑；仅在客户端显式 command 时执行。

**v1 non-goal：** 不暴露 `channel.subscribe` / `channel.unsubscribe`。连接并在 `session.live_start` committed 后，live WS 接收全部 active 成员频道的新事件。客户端按 `event.channel_id` 更新 sidebar/unread 或 active timeline；所有 event 按 `(channel_id, event_id)` dedupe。

### 5.12 Session heartbeat：`session.heartbeat` (v2.11 delta, Phase 8)

Socket 打开期间低频发送，仅刷新 lease TTL。

```json
{
  "frame_type": "command",
  "command": "session.heartbeat",
  "command_id": "00000000-0000-7000-8000-000000000002",
  "payload": {}
}
```

Committed ack：

```json
{
  "frame_type": "command_ack",
  "command": "session.heartbeat",
  "command_id": "00000000-0000-7000-8000-000000000002",
  "status": "committed",
  "payload": {
    "session_id": "00000000-0000-7000-8000-000000000101",
    "lease_expires_at": "2026-06-27T13:14:00Z"
  }
}
```

语义：

- 刷新 `UserConnection.live_sessions.last_seen_at`。
- **必须**从 `UserDirectory /my-channels` 重载当前 active memberships，再处理本地 lease（**不得** blind refresh 全部 `status='active'` 行）。
- 对仍 active 的频道：延长 `expires_at`；若 `membership_version` 升高则写回 `live_channel_leases` 并 upsert `ChannelFanout`。
- 对不再 active 的频道：将本地 `live_channel_leases.status` 标为 `closed`，best-effort `/lease-revoke`，**不得** upsert 到 `ChannelFanout`。
- 本地 `status='closed'` 或因 `/deliver` 返回 `membership_not_active` / `membership_stale` 而被 fanout 删除的 lease，**不得**被 heartbeat 复活。
- **不得** replay events；**不得** gap repair；**不得**携带 cursor。
- Session 尚未 `session.live_start` → `409 SESSION_NOT_LIVE` 或 `422 INVALID_COMMAND`（实现择一，全仓库一致）。
- 推荐 lease TTL：10 分钟；推荐 heartbeat 间隔：4 分钟（active tab）。

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

### 6.1b 频道事件 gap 恢复 (v2.11 delta, Phase 8)

HTTP 是 Browser 权威状态恢复的 source of truth。重连、tab resume、active channel 进入、`session.live_start` ack 后若需补齐 timeline，使用本端点（或 §6.1 messages，若足以恢复全部 Browser-visible message 状态）。

```http
GET /api/chat/channels/{channel_id}/events?after_event_id=00000000-0000-7000-8000-000000000301&limit=100
```

响应：

```json
{
  "events": [],
  "latest_event_id": "00000000-0000-7000-8000-000000000301",
  "next_cursor": null
}
```

`events[]` 每项为 Browser-visible event 投影（与 §10.4 EventEnvelope 同形，含 replay 过滤规则 §10.3）。`after_event_id` 为空时从频道最早可见 event 起（或实现定义的 floor）。需要多频道恢复时仍可用全局 `GET /api/chat/events?cursors=...`（§10.3）；单频道 active timeline 同步优先本端点。

**Recovery triggers（normative）：** initial app load；WebSocket reconnect；`session.live_start` committed；active channel route enter；tab 从 hidden/suspended resume；疑似本地 event gap；local cache reset；timeline 分页。

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
- Bot catalog 同步走 outbound HTTP：`PUT /api/chat/bot/commands`（bot → Chat 的 HTTP，**不要求 bot 暴露 HTTP endpoint**）。
- Bot **消息 mutation**（发消息、改消息、流式、components）**只**走 Bot Gateway WS 的 `delivery_result.effects` / `session.effects`；**无** Bot HTTP 发消息端点（v2.17 delta：移除 `POST /api/chat/bot/channels/{channel_id}/messages`）。
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

`GET /api/chat/bot/ws` 必须有 `chat:runtime:connect` scope（v2.10 delta）。`PUT /api/chat/bot/commands` 需 `chat:commands:manage`。`chat:messages:write` 用于 Bot Gateway WS 上 `delivery_result` / `session.effects` 中的发消息类 effect（v2.17 delta：不再绑定任何 Bot HTTP 发消息路由）。

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

**Platform bot（内置 `/help`）** (v2.16 delta)：平台命令不经过 BotRegistry，使用固定 well-known identity：

| 字段 | 值 |
|---|---|
| `bot_id` | `00000000-0000-7000-8000-000000000600` |
| `display_name` | `system` |
| `avatar_url` | `https://s3.kuma.homes/chat/avatars/019f134b-4324-7300-9023-b092c06ac4b2.png` |
| `/help` 的 `bot_command_id` | `00000000-0000-7000-8000-000000000700` |

`/help` 响应以普通 bot text message 写入频道 timeline；`messages` 行持久化 `sender_bot_display_name` / `sender_bot_avatar_url`，Browser 投影为完整 `sender.bot`（不查 BotRegistry）。

### 9.3 注册 slash command

```http
PUT /api/chat/bot/commands
Authorization: Bearer <bot_token>
Idempotency-Key: client-key-bot-command-sync
```

请求 (v2.16 delta：补 `help_text` / `execution`；移除 `default_enabled_on_install` / `event_capabilities`，见 slash addendum)：

```json
{
  "commands": [
    {
      "name": "ask",
      "aliases": ["ai", "chat"],
      "description": "Ask the assistant",
      "help_text": "用法: /ask <prompt>\n向助手提问。",
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
    }
  ]
}
```

`PUT /bot/commands` only syncs the **global bot command catalog** (BotRegistry)。它 **不 enable 任何频道的 command** —— channel 内是否可用由 per-channel allow/block binding（`PATCH /channels/{channel_id}/commands/{bot_command_id}`）及 official bot 全局 auto-allow 规则决定 (v2.16 delta；`POST .../bot-installations` 已移除，见 slash addendum)。

字段：

- `commands[].aliases`: 同一 `bot_command_id` 的 alternate slash triggers；`command.invoke` 用 `bot_command_id`，payload 带 `invoked_name`（见 §9.5）。
- `commands[].help_text`: 单命令详细帮助文本；`/help <command>` 命中时返回此字段（fallback 为 `description`）(v2.16 delta)。
- `commands[].default_member_permission`: 默认 `member`/`admin`/`owner`；channel binding 可用 `permission_override` 覆盖。
- `commands[].execution`: `mode` 为 `stateless` | `stateful`；`stateful` 时带 mutex/TTL/listen_capability（见 slash addendum）。
- 全局 slash namespace：`bot_command_names` 在 BotRegistry；sync 时名称冲突 → `409 COMMAND_NAME_CONFLICT`。

响应 (v2.16 delta)：

```json
{
  "commands": [
    {
      "bot_command_id": "00000000-0000-7000-8000-000000000701",
      "name": "ask",
      "aliases": ["ai", "chat"],
      "status": "active",
      "execution_mode": "stateless",
      "stateful_config": null,
      "definition_hash": "sha256:...",
      "schema_version": 1,
      "updated_at": "2026-06-21T05:30:00Z"
    }
  ]
}
```

**Official bot commands** (v2.16 delta)：`visibility: "official"` 的 bot 其 catalog 中 `status=active` 的命令在**所有非 DM 频道**自动可用，无需 allow binding。频道管理员只能 `blocked` 显式禁用；对 official command 发 `status: "allowed"` → `409 OFFICIAL_COMMAND_AUTO_ALLOWED`。非 official bot 仍须 allow binding 后才出现在 manifest。

同一频道内 allowed command 名称不能冲突（`channel_command_names`）；bot slash command 定义 id 字段名为 `bot_command_id`（与 Browser WS frame 的 `command_id` = durable operation id 区分）(v2.6 delta)。

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
GET /api/chat/channels/{channel_id}/commands
```

响应 (v2.16 delta：完整 manifest；`?prefix=` 已废弃，传入则忽略)：

```json
{
  "version": 3,
  "items": [
    {
      "bot_command_id": "00000000-0000-7000-8000-000000000701",
      "name": "summarize",
      "aliases": ["sum", "tl_dr"],
      "description": "Summarize recent messages",
      "help_text": "用法: /summarize\n总结最近消息。",
      "bot": {
        "bot_id": "00000000-0000-7000-8000-000000000601",
        "display_name": "Lilium Bot",
        "avatar_url": null
      },
      "options": [],
      "effective_member_permission": "member",
      "execution": { "mode": "stateless" }
    },
    {
      "bot_command_id": "00000000-0000-7000-8000-000000000700",
      "name": "help",
      "aliases": [],
      "description": "查看可用命令",
      "help_text": "",
      "bot": {
        "bot_id": "00000000-0000-7000-8000-000000000600",
        "display_name": "system",
        "avatar_url": "https://s3.kuma.homes/chat/avatars/019f134b-4324-7300-9023-b092c06ac4b2.png"
      },
      "options": [
        { "name": "command", "type": "string", "required": false, "description": "命令名" }
      ],
      "effective_member_permission": "member",
      "execution": { "mode": "stateless" }
    }
  ]
}
```

字段与规则 (v2.16 delta)：

- `version`: 频道 manifest 单调版本；binding 变更通过 `command.binding_updated` 事件携带 `command_manifest_delta`（见 slash addendum）。
- `items[]`: 当前 caller 在该频道可见的全部 allowed commands（含 official auto-allowed + 显式 allowed binding + platform `/help`）。
- `help_text`: 来自 binding snapshot 或 official catalog；platform `/help` 固定为空字符串。
- `effective_member_permission`: `permission_override ?? default_member_permission`；caller role 不足的项被过滤。
- `bot`: 来自 binding snapshot 或 official catalog；platform `/help` 使用 §9.2 platform bot identity。
- **Official auto-allow**：`visibility: "official"` bot 的 active catalog 命令自动并入 manifest，除非该频道存在 `status: "blocked"` binding。
- **Platform `/help`**：服务端始终 append 到 manifest（`bot_command_id` = `00000000-0000-7000-8000-000000000700`），不占 binding 行。
- DM 频道：返回 `{ "version": 0, "items": [] }`（无 `/help`）。
- Bootstrap `command_manifest` 与 `GET .../commands` 同形（slash addendum）。

`GET .../commands` 是 read cache（binding snapshot + official merge）；`command.invoke` 的 correctness source 是当前 BotRegistry catalog + official catalog fallback（见 §9.5）。

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

**Platform `/help` 特例** (v2.16 delta)：`bot_command_id` = `00000000-0000-7000-8000-000000000700` 时：

- 不经过 Bot Gateway delivery；服务端同步写入一条 bot text message（`sender_kind: "bot"`，platform bot identity，见 §9.2）。
- 无 `command.invoked` pending 态；`command_invocations.status` 直接 `completed`。
- `committed_ack.payload` 含 `message_id`、`event_id` 及完整 Browser-visible `message` 投影（同 `message.send` ack 形状）。
- 无 `options.command` 时列出当前 manifest 全部命令（按 bot 分组）；有 `options.command` 时返回该命令的 `help_text`（fallback `description`），未知命令返回 `未知命令: <name>` 文本。

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

Worker 校验当前用户能看见该消息、消息来自 Bot、component 未 disabled、`custom_id` 与持久化组件一致、**`interaction_policy` 门禁通过**（§3.8）、**`value` 形状与 `kind` 匹配**（见下表）。前端不解析 `custom_id`，只原样提交。

**`payload.value` 类型（v2.18 delta）：**

| component `kind` | `value` 类型 | Worker 额外校验 |
|---|---|---|
| `button` | `boolean`（恒 `true`） | — |
| `select` / `radio` | `string` | 必须命中 `options[].value` |
| `checkbox` | `boolean` | — |
| `checkbox_group` | `string[]` | 每项命中 `options[].value`；长度 ∈ `[min_selected, max_selected]` |
| `text_input` | `string` | 长度 ∈ `[min_length, max_length]` |

**平台 / Bot 职责（v2.18 delta）：**

- **平台（Chat）**：per-channel 有序 `event_id`；`interaction.created` / `interaction.completed` / `message.updated`（`exclusive` 锁控件）进同一 timeline；`message_interaction` delivery 顺序与同 channel 已 committed interaction 顺序一致（at-least-once delivery，Bot 用 `delivery_id` + effect 幂等去重）；`interaction_policy` 在 submit 事务内执行。
- **Bot**：收到 delivery 后处理业务语义（谁该得奖励、状态如何变）；`multi` policy 下可能收到并发 delivery，Bot 自行 dedupe；`disable_components` / `update_message` 用于 Bot 主动更新 UI，非 primary 互斥手段（`exclusive` 已由平台锁死）。

**delivery 顺序不变量（v2.18 delta）：** 同一 `channel_id` 内，Bot 经 `message_interaction` delivery 收到的 interaction，其 `interaction_id` 对应 committed 顺序与频道 `interaction.created` event 顺序一致。Bot 应按 delivery 到达顺序处理；重试 delivery 不改变已应用的业务结果（effect / interaction lifecycle 幂等）。

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

> **v2.19 superseded（流式部分）**：本节原 `append_stream` / `finalize_stream` 主 Gateway WS effect 设计**作废**，由 §16 替换。主 Bot Gateway WS（§9.7）仅接受非流式 effect + `start_stream`；流式 append/finalize 走专用 Stream WS（§16.4）。实现以 §16 + §17 + `docs/superpowers/specs/2026-06-30-lilium-chat-bot-streaming-and-internal-api-spec.md` 为准。

Bot `delivery_result` / `session.effects` 在主 Bot Gateway WS 上可返回的 effect：

- `send_message`: 发送 Bot 消息。
- `update_message`: 更新 Bot 自己发送的消息文本、附件和 components。
- `disable_components`: 禁用 Bot 自己发送的消息组件。
- `start_stream`: 创建 streaming registry + 返回 Stream WS URL（**不**写入 canonical `messages`；详见 §16.3）。

主 Bot Gateway WS **拒绝**：

- `append_stream` → `BOT_EFFECT_INVALID`（recovery hint 可含 `stream.ws_url`）
- `finalize_stream` → `BOT_EFFECT_INVALID`

`delivery_ack` 对成功应用的 effect 可携带 `effect_results[]`（§16.3.2）；`start_stream` **必须**返回 `{ message_id, stream: { channel_id, message_id, ws_url, expires_at } }`。

非流式 effect 示例：

```json
{
  "effects": [
    {
      "type": "send_message",
      "client_effect_id": "00000000-0000-7000-8000-000000000910",
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

Chat 按 `(channel_id, bot_id, client_effect_id)` 对 effects 做幂等。同一 `client_effect_id` 配不同 body → `BOT_EFFECT_CONFLICT`。

Chat Worker 校验 effects 后写入后端内的消息、审计记录和事件流。ToolBear Python 后端不执行 bot effects。

### 9.8 Bot 消息 mutation（双 WebSocket）

Bot 对频道消息的创建与修改分两条 WebSocket 路径（v2.19 internal addendum）：

| 路径 | 允许的 mutation |
|---|---|
| 主 Bot Gateway WS（§9.7） | `send_message`、`update_message`、`disable_components`、`start_stream` |
| Stream WS（§16.4） | 单条 streaming message 的 `append`、`finalize` |

提交入口：

- stateless / interaction / passive event 响应：主 Gateway `delivery_result.effects`
- stateful 会话内：主 Gateway `session.effects`
- 流式正文：Stream WS `append` / `finalize`（**不在**主 Gateway 上提交）

**不提供** `POST /api/chat/bot/channels/{channel_id}/messages` 或任何其它 Bot HTTP 消息 mutation 端点（v2.17 delta：自 v2.10 草案中移除）。

Bot 消息须满足与 §9.7.3 / §16 相同的 effect 校验：目标频道为已 allow 的 `kind=channel` 群聊、scope 含 `chat:messages:write`、components 规则同 Browser 可见消息投影。

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

> **Removed (slash addendum + v2.16)**：`PATCH .../bot-installations/.../event-subscriptions/message.created` 及整个 bot-installation 产品层已移除。Passive `message_event` 由 stateful command `listen_capability` 替代（见 slash addendum）。

### 9.10 Developer Bots API (v2.16 delta)

Browser JWT 鉴权。Owner-scoped：caller 必须是 `owner_user_id`。

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/chat/bots` | 创建 bot；`Idempotency-Key` 必填 |
| GET | `/api/chat/bots` | 列出 caller 拥有的 bot；`limit`/`cursor` 分页 |
| GET | `/api/chat/bots/{bot_id}` | bot 详情 |
| PATCH | `/api/chat/bots/{bot_id}` | 更新 bot；`Idempotency-Key` 必填 |
| GET | `/api/chat/bots/{bot_id}/tokens` | token 元数据列表（无 plaintext） |
| POST | `/api/chat/bots/{bot_id}/tokens` | 创建 token；响应含一次性 `plaintext` |
| DELETE | `/api/chat/bots/{bot_id}/tokens/{token_id}` | 撤销 token；`Idempotency-Key` 必填 |

**`BotAppSummary` 形状：**

```json
{
  "bot_id": "00000000-0000-7000-8000-000000000601",
  "owner_user_id": "00000000-0000-7000-8000-000000000101",
  "display_name": "My Bot",
  "avatar_url": null,
  "description": null,
  "visibility": "private",
  "status": "active",
  "command_count": 3,
  "created_at": "2026-06-21T05:30:00Z",
  "updated_at": "2026-06-21T05:30:00Z"
}
```

- `visibility`: `private` | `unlisted` | `public` | `official`。设 `official` 需 JWT `admin: true`（否则 `403 ADMIN_ACCESS_REQUIRED`）。
- `status`: `active` | `disabled` | `deleted`。
- **无** `seed-official-bot` 内部路由；official bot 通过 admin API 创建并设 `visibility: "official"`。

**POST `/api/chat/bots` 请求：**

```json
{
  "display_name": "My Bot",
  "avatar_url": null,
  "description": null,
  "visibility": "private",
  "issue_initial_token": true,
  "initial_token_name": "default"
}
```

**POST 响应 (201)：** `{ "bot": BotAppSummary, "initial_token"?: BotTokenCreated }`

**`BotTokenCreated`：** `{ token_id, name, scopes, plaintext, created_at, expires_at }` — `plaintext` 只返回一次。

**PATCH `/api/chat/bots/{bot_id}`：** 至少一个字段；`display_name` / `avatar_url` / `description` / `visibility` / `status`。非 owner → `403 FORBIDDEN`；`visibility: "official"` 需 admin。

### 9.11 Admin Bots API (v2.16 delta)

Browser JWT + `admin: true` 必填；否则 `403 ADMIN_ACCESS_REQUIRED`。

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/chat/admin/bots` | 全局 bot 列表 |
| GET | `/api/chat/admin/bots/{bot_id}` | 任意 bot 详情 |
| PATCH | `/api/chat/admin/bots/{bot_id}` | 更新任意 bot（含 `official` visibility） |
| GET | `/api/chat/admin/bots/{bot_id}/tokens` | token 元数据 |
| DELETE | `/api/chat/admin/bots/{bot_id}/tokens/{token_id}` | 撤销 token |

**GET `/api/chat/admin/bots` 查询参数：** `limit`、`cursor`、`q`（display_name 搜索）、`owner_user_id`、`status`、`visibility`。

**响应：** `{ "items": BotAppSummary[], "next_cursor": string | null }`

Admin PATCH 请求体与 §9.10 owner PATCH 相同，但不校验 ownership。Admin **不能**通过此 API 为他人创建 bot token（无 `POST .../tokens`）；token 创建仍走 owner-scoped §9.10 或由 bot owner 自行操作。

## 10. 实时与事件回放

### 10.1 WebSocket 连接 (v2.11 delta 重写)

```text
wss://chat.kuma.homes/api/chat/ws
```

前端通过 WebSocket subprotocol 携带 ToolBear browser JWT：

```js
new WebSocket("wss://chat.kuma.homes/api/chat/ws", [
  "lilium.chat.v2",
  "bearer.<toolbear_browser_jwt>"
])
```

Worker 只接受 `lilium.chat.v2` + `bearer.<jwt>`（`lilium.chat.v1` 已废弃）。JWT 与 Origin 规则同 §2.1。

**Connect 语义：** WebSocket 建立用户级 live session。鉴权成功后 server `acceptWebSocket` 并创建 `UserConnection` live session。

Connect **必须不**：

- replay 历史 channel events
- 使用 Browser 提供的 per-channel cursors
- 执行 gap recovery
- 隐式订阅全部频道或写 `ChannelFanout`

历史数据、重连恢复、gap recovery 由 **HTTP read APIs** 处理（§10.6）。Query `cursors` 已从 contract 移除；旧客户端传入则 **MAY ignore**，**MUST NOT** 用于 `UserConnection` replay。

**Live fanout 启动：** WS `open` 后客户端自动发 `session.live_start`（§5.11）。Committed 后接收全部 active 成员频道的新 event（best-effort，§10.5）。

推荐启动顺序：

```text
1. Open WebSocket (v2)
2. Send session.live_start
3. After ack → HTTP bootstrap / refresh channel list
4. If active channel → HTTP channel sync (§6.1b or §6.1)
```

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
- `session.live_start` → `{ session_id, subscribed_channel_count, lease_expires_at }`（§5.11）。
- `session.heartbeat` → `{ session_id, lease_expires_at }`（§5.12）。
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
- `message.stream_finalized`（canonical channel event；streamed bot message **不**额外发 `message.created`，见 §16.5）
- `command.invoked`
- `command.completed`
- `command.failed`
- `interaction.created`
- `interaction.completed`
- `interaction.failed`

> **Live-only stream frames（v2.19 internal addendum）**：`message.stream_started`、`message.stream_delta`、`message.stream_abandoned` **不是** channel timeline event，不写入 `ChatChannel.events`，不进入 HTTP `GET .../events` 恢复。它们经 Browser WS 以 `frame_type="stream_event"` 投递（§16.5）。离线客户端只通过 HTTP history/events 看到已 finalize 的消息。

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
- 收到 gap 错误后重新调用 `GET /api/chat/bootstrap?channel_id=...` 或 `GET /api/chat/channels/{channel_id}/events`（§6.1b）(v2.11 delta)。

### 10.5 WS live event delivery 语义 (v2.11 delta, Phase 8)

Browser WS live events 为 **best-effort**：

- Server **SHOULD** 向 active live session 投递各 active 成员频道的新 event。
- Server **不保证** WebSocket exactly-once delivery。
- Server **不保证** 恢复以下期间错过的事件：disconnect、reconnect、tab suspension、deploy、DO restart/hibernation、网络失败、backpressure、lease expiry。

Browser **必须** 按 `(channel_id, event_id)` dedupe。Browser **必须** 通过 HTTP bootstrap 与 channel history/events API 恢复权威状态（§10.6）。

每个 live event frame **必须** 含 `frame_type`、`type`（event 类型）、`channel_id`、`event_id`、`payload`。Live event **SHOULD** 与 HTTP history / committed mutation ack 使用同一 Browser 投影 builder（§10.4）。`api_version` 为 `lilium.chat.v2`。

成员关系变化后，server 会在 `UserDirectory /my-channels` projection 可见后按 `affected_user_id` 主动 resync 该用户所有 live sessions。Browser 可能收到 user-scoped hint：

```json
{
  "frame_type": "user_event",
  "event": "my_channels_changed",
  "reason": "member_added",
  "changed_channel_id": "01..."
}
```

该 frame 不是 channel timeline event，不包含 `event_id`，不写入历史，不经 `ChannelFanout`。Browser 可据此刷新 channel list/bootstrap；漏收该 hint 不影响正确性，HTTP 仍是权威。

客户端应用规则：

- `event.channel_id === activeChannelId` → 写入 active timeline。
- 否则 → 只更新 channel list / unread，不 append 到 active timeline。
- `user_event my_channels_changed` → 刷新用户频道列表/bootstrap，不写入任何频道 timeline。

### 10.6 HTTP 权威恢复 (v2.11 delta, Phase 8)

WebSocket **不得**作为历史真相或 gap repair 来源。权威恢复触发见 §6.1b。实现 **必须** 提供足以在本地 cursor 之后恢复 canonical message/timeline 状态的 HTTP API（`GET .../events` 或等价的 `GET .../messages`）。

全局多频道恢复仍可用 `GET /api/chat/events?cursors=...`（§10.3）。单频道 active timeline 同步优先 `GET /api/chat/channels/{channel_id}/events`（§6.1b）。

## 11. 错误码

HTTP error envelope 和 WebSocket `command_error.error` 使用同一套 `code`。

| HTTP | code | 含义 |
|---:|---|---|
| 401 | UNAUTHORIZED | 未登录或 token 失效 |
| 401 | MACHINE_TOKEN_NOT_ALLOWED | machine token 不允许访问 Browser API |
| 403 | SESSION_NOT_ALLOWED | delegated / managed session 不允许进入聊天 |
| 403 | FORBIDDEN | 当前用户无权执行该 action |
| 403 | ADMIN_ACCESS_REQUIRED | JWT 无 `admin: true` 却访问 admin API 或设置 `visibility: official` (v2.16 delta) |
| 404 | CHANNEL_NOT_FOUND | 频道不存在或不可见 |
| 404 | MESSAGE_NOT_FOUND | 消息不存在或不可见 |
| 404 | MEMBER_NOT_FOUND | 用户不是该频道成员（从未加入）(v2 delta, Phase 3) |
| 404 | INVITE_NOT_FOUND | 邀请不存在、不可见、已撤销或已过期 (v2.2 delta) |
| 409 | CHANNEL_ARCHIVED | 频道已归档，不允许写入 |
| 409 | CHANNEL_DISSOLVED | 频道已解散，不允许写入或成员变更 (v2.2 delta) |
| 409 | SESSION_NOT_LIVE | `session.heartbeat` 时 session 尚未 `session.live_start` (v2.11 delta) |
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
| 409 | OFFICIAL_COMMAND_AUTO_ALLOWED | 对 official bot command 发 `status: "allowed"` binding；official 命令已全局 auto-allow，只能 `blocked` (v2.16 delta) |
| 404 | COMMAND_NOT_FOUND | command binding 不存在/disabled 或 `invoked_name` 不命中该频道 (v2.10 delta) |
| 422 | INVALID_COMMAND_OPTIONS | command 参数不合法 |
| 404 | COMPONENT_NOT_FOUND | 组件不存在或不可见 |
| 409 | COMPONENT_DISABLED | 组件已禁用 |
| 409 | COMPONENT_ALREADY_USED | `interaction_policy=exclusive` 且该 component 已被他人成功提交 (v2.18 delta) |
| 409 | INTERACTION_ALREADY_SUBMITTED | `interaction_policy=per_user_once` 且该用户已提交过 (v2.18 delta) |
| 403 | INTERACTION_FORBIDDEN_TARGET | `interaction_policy=targeted` 且提交者不是 `target_user_id` (v2.18 delta) |
| 422 | INVALID_INTERACTION_VALUE | interaction value 不合法 |
| 404 | BOT_NOT_FOUND | bot 不存在或非 active（install/bot-get 时）(v2.10 delta) |
| 409 | BOT_COMMAND_DISABLED | command.invoke 时目标 command 在当前 BotRegistry catalog 已 disabled/deleted (v2.10 delta) |
| 503 | BOT_OFFLINE | command.invoke/interaction.submit precheck 时 bot 未连接 Bot Gateway WS，可重试 (v2.10 delta) |
| 422 | BOT_EFFECT_INVALID | bot `delivery_result` 返回的 effect 校验失败（ownership/stream 不变量/components 非法）(v2.10 delta) |
| 409 | BOT_EFFECT_CONFLICT | 同一 `(channel_id, bot_id, client_effect_id)` 配不同 effect body (v2.10 delta) |
| 404 / WS | BOT_STREAM_NOT_FOUND | Stream registry 不存在或不属于该 bot (v2.19 internal addendum) |
| 409 / WS | BOT_STREAM_CONFLICT | 同一 pending stream seq 复用但 delta 不同 (v2.19 internal addendum) |
| 409 / WS | BOT_STREAM_SEQUENCE_GAP | append seq 跳过 `ack_seq + 1`，可重试 (v2.19 internal addendum) |
| 410 / WS | BOT_STREAM_EXPIRED | stream 在 finalize 前过期 (v2.19 internal addendum) |
| 403 / WS | BOT_SCOPE_DENIED | bot token 缺少所需 scope (v2.19 internal addendum) |
| 403 / WS | COMMAND_PERMISSION_DENIED | 用户无权执行 platform `/permission` (v2.19 internal addendum) |
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

目标：bootstrap + 历史分页 + per-channel cursor（无默认频道、无自动入群，v2.13）。

### 12.3 阶段 2：WebSocket command/event 文本消息

目标：WS 端点 + committed_ack + message.created event + per-channel cursor（HTTP 侧）(v2 delta)。**v2.11 superseded：** connect 不再隐式订阅/replay；live push 改 `session.live_start` + HTTP 恢复（§12.11 Phase 8）。

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

### 12.11 阶段 8：Live fanout without WS cursor recovery (v2.11 delta)

目标：消除 connect 期 `registerOnlineOnConnect` + `ctx.waitUntil` 竞态与 stale `ChannelFanout.online_sessions`。`UserConnection` 薄 connect + `session.live_start` / `session.heartbeat`；`fanout_leases` + deliver stale cleanup；子协议 `lilium.chat.v2`；HTTP `GET .../channels/{id}/events` gap 恢复。设计：`docs/plans/2026-06-27-userconnection-live-subscription-redesign.md`；计划：`docs/superpowers/plans/2026-06-27-lilium-chat-phase-8-live-subscription.md`。

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
10. Bot catalog 同步（`PUT /bot/commands`）是 bot → Chat 的 outbound HTTP，不要求 bot 暴露 HTTP endpoint。Bot 消息 mutation **只**走 Bot Gateway WS effects，无 Bot HTTP 发消息路由（v2.17 delta）。

## 15. v2.11 addendum 实现不变量（Phase 8 Live Fanout）

以下不变量对应 Phase 8 live fanout redesign（§5.11 / §5.12 / §10.1 / §10.5 / §10.6），与 `docs/plans/2026-06-27-userconnection-live-subscription-redesign.md` 同步生效：

1. WebSocket live delivery 是 best-effort，永远不是历史真相来源。
2. HTTP read APIs 是 bootstrap、history、reconnect、resume、gap recovery 的权威来源。
3. Browser live session 在 `session.live_start` 后自动接收用户全部 **当前 active** 成员频道的新 events。
4. `UserConnection` 不得做 replay 或 cursor recovery（connect、`session.live_start`、`session.heartbeat` 均不得）。
5. `UserConnection` 不得使用 `ctx.waitUntil` 做有副作用的连接初始化。
6. `ChannelFanout` 存 `fanout_leases`（临时 cache），不是权威在线状态。
7. Close/error 清理是 best-effort；lease TTL + 过期 prune + deliver stale cleanup 提供收敛。
8. WebSocket attachment 不是 subscribed channels 的权威来源；清理读 `live_channel_leases`。
9. 前端按 `(channel_id, event_id)` dedupe；恢复走 HTTP。
10. v1 **不暴露** `channel.subscribe` / `channel.unsubscribe`。
11. `channel.mark_read` 的 `last_read_event_id` 不是 WS delivery cursor（§5.5）。
12. 移除：`registerOnlineOnConnect`、connect replay、`?cursors=` on WS、attachment `subscribed_channels` 作清理依据、`ChannelFanout /register-online` 与 `/unregister-online` 写路径。
13. `UserConnection /deliver`：当 `membership_version_at_event > lease.membership_version` 时 **必须** re-check membership；非 active 必须将本地 `live_channel_leases` 标 `closed` 并返回 `membership_not_active`（ChannelFanout 删 lease）。
14. `session.heartbeat` **必须**对照 `UserDirectory /my-channels` 过滤 lease；**不得** upsert 已 `closed` 或非 active 频道 lease；**不得**复活因 membership 失败被 fanout 删除的 lease。
15. `live_channel_leases.membership_version` 在 `session.live_start`、`/deliver` re-check 通过、或 `session.heartbeat` 发现 version 升高时写回当前值。
16. Membership mutation 的 live resync 以 `affected_user_id` 为 key，而不是 actor。member add/remove、invite accept/public join、leave、channel create、channel dissolve 都必须在 `UserDirectory /my-channels` projection 可见后通知 `UserConnection(affected_user_id)`。
17. Heartbeat 是 fallback convergence，不是新频道订阅或踢出/解散收敛的主路径。通知失败不回滚 membership mutation；`/deliver` membership re-check 仍保留安全兜底。
18. 关闭后的 `(session_id, channel_id)` lease 只有在当前 active membership set 再次包含该频道时才能 reopen，且 reopen 必须生成新的 `lease_id`。
19. `UserDirectory /my-channels` reload 失败必须作为 transient failure 处理；不得解释为空 active membership set，也不得因此关闭已有 leases。

## 16. v2.19 internal contract addendum（Bot streaming + internal API）

**状态：** 内部实现前 contract addendum
**日期：** 2026-06-30
**受众：** lilium-chat 内部实现者。**不对第三方 Bot 开发者公开。**

### 16.0 与主 contract 的关系

- 本文 §1–§15 是 Browser/Bot **公开 wire shape** 的主 contract；§16 是 **内部实现 addendum**，与主 contract **组合**构成当前完整实现前规范。
- §16 **替换** §9.7.3 中的 Bot 流式 effect 旧设计（主 Gateway WS 上的 `append_stream` / `finalize_stream`）。§9.7.1–§9.7.2、§9.8 的非流式部分仍有效；流式部分以 §16 为准。
- 第三方公开 API 文档（`lilium-openapi`、Bot developer guide 等）**本轮不更新**。只有在功能生产可用、测试与部署验证闭合后，才从已上线能力抽取公开说明。
- 后端 DO ownership、schema、状态机、测试不变量见 `docs/superpowers/specs/2026-06-30-lilium-chat-bot-streaming-and-internal-api-spec.md`；实现计划见 `docs/superpowers/plans/2026-06-30-lilium-chat-bot-streaming-internal-api-implementation.md`。
- 历史讨论与 gap 追踪见 `docs/superpowers/specs/2026-06-28-lilium-chat-bot-third-party-api-gaps.md`（**不是**实现 source of truth）。

### 16.1 Scope decision

本轮只确定内部实现文档：

- `docs/api-contract.md` §16：实现前 wire shape、认证边界、错误码、与既有 contract 的替换关系。
- `docs/superpowers/specs/2026-06-30-lilium-chat-bot-streaming-and-internal-api-spec.md`：DO ownership、schema、状态机、实现不变量。
- `lilium-openapi` / 第三方公开 API 说明：本轮不写。

任何“尚未实现”“预留 scope”“内部 Browser route”“Admin route”“ToolBear Web route”都不得进入第三方公开文档。

### 16.2 Decisions

| ID | Decision | Rationale |
|---|---|---|
| D1 | `/api/chat/bots*` 继续是 Browser Developer/Admin API，不改成 Machine Token owner API | 当前 contract v2.16 和实现均以 Browser JWT owner/admin 为锚点；同一路径混收 user/machine identity 会扩大安全审计面 |
| D2 | Machine Token owner-management API 暂不实现 | 需要独立 actor/audit/rate-limit 设计；不阻塞 Bot runtime/effect/stream 实现 |
| D3 | 主 Bot Gateway WS 只接受 `start_stream`，不再接受 `append_stream` / `finalize_stream` | 流式正文热路径不应压在 `BotConnection` 或主 delivery_result effect 管线内 |
| D4 | 流式 append/finalize 走专用 Stream WS：`/api/chat/bot/channels/{channel_id}/streams/{message_id}/ws` | 一连接一流，天然按 `{channel_id,message_id}` 路由和隔离 buffer |
| D5 | Stream WS append 支持 seq/ack 恢复 | 第三方 bot 网络抖动时可从 `ack_seq + 1` 恢复，避免重复拼接 |
| D6 | Stream 中断不 promote partial text | 只有 bot 显式 `finalize` 才产生最终消息；timeout/disconnect 到期 abandon |
| D7 | `message.stream_finalized` 是 streamed bot message 的 canonical final event | 不再额外发送 `message.created`，避免双事件/双 listener 语义 |
| D8 | Bot read scopes 暂保留为 token scope，不新增 read endpoint | `chat:messages:read` 等 scope 必须有显式 read grant 设计，command allow 不隐含历史读取 |
| D9 | Bot attachment upload 如实现，v1 采用 channel-scoped upload + 独立 `chat:attachments:write` | 上传是高滥用面；channel-scoped 能避免先引入全局 AttachmentDirectory |
| D10 | Platform `/permission` 是内部平台命令，不是第三方 Bot API | 它影响第三方 Bot UX，但不属于 Bot owner/runtime public surface |

### 16.3 主 Bot Gateway WS 与 Stream WS 职责边界

| WebSocket | 路由 | DO | 职责 |
|---|---|---|---|
| **主 Bot Gateway WS** | `GET /api/chat/bot/ws` | `BotConnection(bot_id)` | `delivery` 接收；`delivery_result` / `session.effects` 提交非流式 effect + `start_stream`；delivery 队列；online 状态 |
| **Stream WS** | `GET /api/chat/bot/channels/{channel_id}/streams/{message_id}/ws` | `BotStreamConnection(channel_id#message_id)` | 单条 stream 的 `append` + `finalize`；热路径 text buffer；seq/ack；live delta fanout |

规则：

- 两条 WS 使用**同一份** Chat Bot Token（`Authorization: Bearer`）；**无**独立 stream token。
- `{channel_id, message_id}` **成对**出现在 Stream WS path 中，用于路由 DO 与校验 registry；禁止仅按 `message_id` 路由。
- 主 Gateway WS **禁止** `append_stream` / `finalize_stream` effect → `BOT_EFFECT_INVALID`。
- 单个 effect batch **不得**同时含 `start_stream` 与 `append_stream`/`finalize_stream`。

### 16.4 Bot Gateway effects（非流式 + start_stream）

#### 16.4.1 主 Gateway 允许的 effect

- `send_message`
- `update_message`
- `disable_components`
- `start_stream`

#### 16.4.2 `delivery_ack.effect_results`

`delivery_ack` 对成功应用的 effect 携带可选 `effect_results[]`。`start_stream` **必须**返回生成的 `message_id` 与 Stream WS URL：

```json
{
  "type": "delivery_ack",
  "api_version": "lilium.chat.bot.v1",
  "delivery_id": "01J...",
  "status": "applied",
  "effect_results": [
    {
      "client_effect_id": "00000000-0000-7000-8000-000000000910",
      "type": "start_stream",
      "status": "applied",
      "message_id": "00000000-0000-7000-8000-000000000301",
      "stream": {
        "channel_id": "00000000-0000-7000-8000-000000000201",
        "message_id": "00000000-0000-7000-8000-000000000301",
        "ws_url": "/api/chat/bot/channels/00000000-0000-7000-8000-000000000201/streams/00000000-0000-7000-8000-000000000301/ws",
        "expires_at": "2026-06-30T12:00:00Z"
      }
    }
  ]
}
```

规则：

- `effect_results[].client_effect_id` 回显提交的 effect id。
- 重放相同 `client_effect_id` 返回相同 result payload。
- 相同 `(channel_id, bot_id, client_effect_id)` 但不同 effect body → `BOT_EFFECT_CONFLICT`。
- `send_message` / `update_message` / `disable_components` 可在 `effect_results` 含 `{ message_id, event_id }` 供 SDK 便利；Browser timeline 仍以 channel events 为准。

#### 16.4.3 `start_stream` effect

```json
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
}
```

语义：

- 在 `ChatChannel` 创建 `message_stream_registry` 行。
- **不**插入 canonical `messages` 行。
- 向在线 Browser 会话 emit live-only `message.stream_started` stream frame。
- 在 `delivery_ack.effect_results[].stream` 返回 `ws_url`。
- Bot 须在 `expires_at` 前连接 Stream WS。

### 16.5 Stream WebSocket

#### 16.5.1 Route and auth

```http
GET /api/chat/bot/channels/{channel_id}/streams/{message_id}/ws
Authorization: Bearer <bot_token>
Sec-WebSocket-Protocol: lilium.chat.bot.stream.v1
```

Worker 校验：

1. `verifyBotToken` 成功。
2. Token 含 `chat:runtime:connect` 与 `chat:messages:write`。
3. `ChatChannel /internal/stream-registry-check` 确认 `{ channel_id, message_id, bot_id, status="streaming" }`。
4. 路由到 `BotStreamConnection`，DO name = `` `${channel_id}#${message_id}` ``。

#### 16.5.2 Frames

`api_version` = `lilium.chat.bot.stream.v1`。

| Direction | Type | Payload |
|---|---|---|
| Bot → Server | `hello` | `{}` |
| Server → Bot | `ready` | `{ channel_id, message_id, expires_at, ack_seq }` |
| Bot → Server | `append` | `{ seq, delta }` |
| Server → Bot | `append_ack` | `{ ack_seq }` |
| Bot → Server | `finalize` | `{ final_seq, components?, attachment_ids? }` |
| Server → Bot | `finalized_ack` | `{ ok: true, message_id, event_id }` |
| Server → Bot | `stream_error` | `{ code, message, retryable }` |
| Both | `ping` / `pong` | `{}` |

#### 16.5.3 Sequence rules

- `seq` 从 `1` 起，严格递增 1。
- Server `ready.ack_seq` 是 stream server 已 durable accept 的最高 seq。
- Bot 重连后从 `ack_seq + 1` 重发。
- `seq <= ack_seq`：幂等 no-op。
- `seq == ack_seq + 1`：接受。
- `seq > ack_seq + 1`：`BOT_STREAM_SEQUENCE_GAP`（retryable）。
- 未 ack 的 duplicate `seq` 同 delta hash：no-op；不同 hash：`BOT_STREAM_CONFLICT`。
- `append_ack` 可在 batch 后发送；server 仅在 delta durable 后才 advance `ack_seq`。

#### 16.5.4 Finalize rules

- `final_seq >= ack_seq`，不得跳过 pending accepted deltas。
- Server drain pending live delta fanout 后 finalize。
- 最终文本由 server buffer resolve；bot 不在 `finalize` 发送全文。
- `finalize` 一次 canonical ChatChannel 事务：insert final `messages`（`stream_state="final"`）+ insert `message.stream_finalized` event + delete/mark registry + enqueue ChannelFanout。
- **不**额外 emit `message.created`。

#### 16.5.5 Interruption policy

- Stream WS 断连 **不** finalize。
- 主 Bot Gateway 断连 **不** finalize。
- Server 保留 registry 直至 `expires_at`；bot 可在 expiry 前重连同一 stream URL。
- Expiry 后未 finalize → abandon；emit live-only `message.stream_abandoned`；**不** promote partial text。

### 16.6 Browser stream frames

Streaming 中间态是 live-only，**不得**推进 HTTP recovery cursor。

Live-only frames 使用 `frame_type="stream_event"`：

```json
{
  "frame_type": "stream_event",
  "api_version": "lilium.chat.stream.v1",
  "type": "message.stream_delta",
  "channel_id": "00000000-0000-7000-8000-000000000201",
  "message_id": "00000000-0000-7000-8000-000000000301",
  "stream_seq": 42,
  "delta": "hello"
}
```

| Frame type | 存储 | 说明 |
|---|---|---|
| `message.stream_started` | live-only |  provisional UI |
| `message.stream_delta` | live-only |  batched delta |
| `message.stream_abandoned` | live-only |  移除 provisional UI |
| `message.stream_finalized` | canonical channel event |  HTTP history/events 权威 |

Browser 规则：

- 按 `(channel_id, message_id, stream_seq)` 去重/排序 stream frames。
- **不**把 stream frames 存为 channel event cursor。
- 重连/resume 时 HTTP history/events 为权威；streaming 进行中 history 无该 message。
- 离线期间 abandoned 的 stream 不出现在 history。

### 16.7 Bot owner management surface

当前 normative surface 仍是主 contract §9.10/§9.11 Browser Developer/Admin API：

- Browser JWT 鉴权 owner user。
- `/api/chat/bots*` owner routes 按 `bot.owner_user_id` 限定。
- `/api/chat/admin/bots*` 需 Browser JWT `admin: true`。
- Browser JWT 拒绝 Machine Token → `401 MACHINE_TOKEN_NOT_ALLOWED`。

本节 **不** 引入 Machine Token owner-management routes。`Authorization: Bearer <lilium_machine_token>` 在本阶段 **不得**被 `/api/chat/bots*` 接受。

### 16.8 Bot read scopes（future / open）

以下 scope 已定义但 **无** Bot Token read endpoint：

- `chat:messages:read`
- `chat:channels:read`
- `chat:members:read`

未来 read API 需要显式 read grant 模型；command allow 不隐含历史读取权限。在本阶段 **不**实现、**不**发布 Bot Token history/member/channel read endpoints。

### 16.9 Bot attachments（future / open）

Bot 消息可引用 `attachment_ids`，但 Bot upload **不是** streaming unblock 的必须项。

若实现，v1 internal contract 为 channel-scoped：

```http
POST /api/chat/bot/channels/{channel_id}/uploads/images/presign
POST /api/chat/bot/channels/{channel_id}/uploads/images/{attachment_id}/finalize
```

规则：`chat:attachments:write` 必须；`chat:messages:write`  alone 不足；attachment 归属 `{ bot_id, channel_id }`；v1 不可跨 channel 复用。跨 channel Bot asset library 需独立 `BotAssetDirectory` 设计，out of scope。

### 16.10 Platform `/permission` command

`/permission` 是内部 platform command，影响 Bot UX，**不是**第三方 Bot API。

- 出现在非 DM 频道 command manifest（owner/admin 可见）。
- 使用 platform bot identity（§9.2）。
- 在 `ChatChannel` 内联执行 Browser WS `command.invoke`；**不**经 Bot Gateway delivery。

| Invocation | Behavior |
|---|---|
| `/permission` | 列出当前频道 allowed/blocked commands |
| `/permission <name> on` | allow command |
| `/permission <name> off` | block command |

规则：caller 须 channel `owner`/`admin`；DM 返回 `UNSUPPORTED_CHANNEL_KIND` 或不出现在 manifest；official commands auto-allowed（`on` → `OFFICIAL_COMMAND_AUTO_ALLOWED`）；成功写入与 Browser command settings 相同的 binding rows；emit `command.binding_updated` + 可选 `system.notice`。

## 17. v2.19 internal addendum 实现不变量（Bot streaming + effects）

以下不变量与 §16 及 backend spec 同步生效：

1. 主 Bot Gateway WS 与 Stream WS 物理分离；Bot **不得**在主 Gateway 提交 `append_stream` / `finalize_stream`。
2. 流式进行中 **不**写入 canonical `messages` / `events`；只有 `finalize` 写 canonical message + `message.stream_finalized` event。
3. Streamed bot message **不**额外 emit `message.created`。
4. `message.stream_started` / `message.stream_delta` / `message.stream_abandoned` 是 live-only `stream_event` frames，**不**进入 HTTP `GET .../events`。
5. `BotStreamConnection` DO name = `` `${channel_id}#${message_id}` ``；registry 在 `ChatChannel`；append hot path **不**写 ChatChannel SQLite per-delta。
6. `append_ack.ack_seq` 不得 advance 超过 durable `flushed_text` 所覆盖的 seq。
7. Stream expiry/abandon **不** promote partial text；offline 客户端 history 无 abandoned stream。
8. Effect 幂等键 `(channel_id, bot_id, client_effect_id)` 不变；`start_stream` 重放返回相同 `{ message_id, ws_url, expires_at }`。
9. Append 幂等键 `(channel_id, message_id, seq, delta_hash)`；seq gap → `BOT_STREAM_SEQUENCE_GAP`；conflict → `BOT_STREAM_CONFLICT`。
10. Finalize 幂等：已 committed finalize 重放返回相同 `{ message_id, event_id }`；abandoned/expired 后 finalize → `BOT_STREAM_EXPIRED` / `BOT_STREAM_NOT_FOUND`。
11. Machine Token owner API、Bot read API、Bot attachment upload 在本阶段 **不**实现，除非 implementation plan 显式纳入且 product 确认。
12. 第三方公开 API 文档在本轮 **不**更新；实现引用 §16 + backend spec，**不**引用 gap tracker 作为 normative source。
