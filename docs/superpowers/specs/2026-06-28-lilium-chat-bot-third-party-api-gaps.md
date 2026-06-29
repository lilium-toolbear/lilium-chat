# Lilium Chat Bot API Gaps — Discussion Tracker

**Status:** Discussion / Tracking（**非** implementation source of truth）
**Audience:** `lilium-chat` + `toolbear_ui` 实现与评审  
**Public doc:** 暂不更新；第三方公开说明等实现完成并部署验证后再统一整理

> **2026-06-30 收口：** 本文是历史讨论稿和 gap tracker，**不再**作为实现计划或 contract 的规范来源。下一步实现应引用：
>
> - **Internal contract（normative wire shape）：** `docs/api-contract.md` **§9.13–§9.16**（Bot streaming）与 **§12.4**（实现不变量）
> - **Backend spec（normative 实现不变量）：** `docs/superpowers/specs/2026-06-30-lilium-chat-bot-streaming-and-internal-api-spec.md`
> - **Implementation plan：** `docs/superpowers/plans/2026-06-30-lilium-chat-bot-streaming-internal-api-implementation.md`
>
> 旧 standalone addendum 文件 `docs/api-contract/2026-06-30-bot-internal-api-contract-addendum.md` 已合并入主 contract §9.13–§9.16 / §12.4，仅保留 redirect stub。
>
> 第三方公开 API 文档只描述已上线、可调用、经过验证的能力；不得从本文直接摘取“预留 scope / 尚未实现 / 内部路由 / Browser/Admin API / ToolBear Web route”等内容。
>
> **Spec 变更流程：** API contract 有变更时，**只**更新 `docs/api-contract.md`（含修订记录）；**不要**回头修改本文或其它历史文档。

本文保留用于追踪历史讨论项、实现缺口、以及公开文档刻意不写的设计方向。

---

## 1. Bot 所有者管理 API（Lilium Machine Token）

**目标：** 第三方用 `client_credentials` Machine Token 自助注册 Bot、管理元数据、签发/撤销 Chat Bot Token。

| Method | Path | Machine scope |
| --- | --- | --- |
| `POST` | `/api/chat/bots` | `chat:bots:manage` |
| `GET` | `/api/chat/bots` | `chat:bots:read` |
| `GET` | `/api/chat/bots/{bot_id}` | `chat:bots:read` |
| `PATCH` | `/api/chat/bots/{bot_id}` | `chat:bots:manage` |
| `GET` | `/api/chat/bots/{bot_id}/tokens` | `chat:bots:read` |
| `POST` | `/api/chat/bots/{bot_id}/tokens` | `chat:bots:manage` |
| `DELETE` | `/api/chat/bots/{bot_id}/tokens/{token_id}` | `chat:bots:manage` |
| `GET` | `/api/chat/commands/directory` | `chat:bots:read` |

**规则：**

- 认证：`Authorization: Bearer <lilium_machine_token>`
- 所有权：`bot.owner_user_id` = Machine Token `effective_account_user_id`（非 `sub`）
- 写操作需 `Idempotency-Key`
- 平台 scope 定义见 `lilium-openapi` 的 `lilium-platform-authentication.md`

**当前状态：**

- `src/routes/bots.ts` 等路由走 `verifyBrowserJwt`
- Machine Token 请求返回 `401 MACHINE_TOKEN_NOT_ALLOWED`（`src/auth/jwt.ts`）

**上线后：** 将请求/响应形状写入公开 `lilium-chat-bot-api-design.md` §所有者管理。

---

## 2. Bot 回复消息（effect 应用管线 + 流式 + 前端）

### 2.1 后端 effect 应用

**目标：** Bot 经 Bot Gateway WS 提交 `delivery_result.effects` / `session.effects` 后，Chat 写入频道消息（`send_message`、`update_message`、stream、components 等）。

**当前状态：**

- `src/do/bot-connection.ts` 对 `delivery_result` 返回 `BOT_EFFECT_INVALID`（`delivery_result not implemented yet`）
- `session.effects` 同属未完成的 effect 应用路径
- 频道 WS 事件 `message.stream_started` / `message.stream_delta` / `message.stream_finalized` 仅在 `src/contract/events.ts` 有类型定义，**无** emit 实现

**上线后：** 在公开文档 §Effects 保留协议形状；不在公开文档写「缺口」表述。

### 2.2 流式输出：双 WebSocket + 专用 DO（historical decision, superseded by `docs/api-contract.md` §9.13–§9.16）

> 以下内容为历史讨论摘要；**规范以主 contract §9.13–§9.16 与 backend spec 为准**。
>
> **Current decision:** non-empty durable partial text is persisted as an abandoned/failed canonical message. This is not a successful finalize and must be visually distinct from normal bot replies. Empty durable buffer → live-only `message.stream_abandon_cleanup` only.

**架构结论（已与产品对齐）：**

- **主 Bot Gateway WS**（`GET /api/chat/bot/ws` → `BotConnection(bot_id)`）：`delivery` / `session.*` / 非流式 effect；**仅** `start_stream` 可在此提交。
- **流专用 WS**（`GET /api/chat/bot/channels/{channel_id}/streams/{message_id}/ws` → `BotStreamConnection`）：**一连接一流**；只处理该 `{channel_id, message_id}` 的 append + finalize。
- **无 stream token**：流 WS 与主 WS 使用**同一份** Chat Bot Token（`Authorization: Bearer`）；`{channel_id, message_id}` **成对**出现在 path 中，用于路由 DO 与校验 registry。
- **主 WS 禁止** `append_stream` / `finalize_stream` → `BOT_EFFECT_INVALID`（错误信息含 `stream.ws_url`）。

**「不落盘」的定义：** 流式进行中 **不** 写入 canonical 层（`messages` / `events`）。`append` 热路径 **不** 写 ChatChannel SQLite；**允许** 在 `BotStreamConnection` 按 **chunk** 刷写 SQLite（非 per-delta）。

**落盘时机：**

| 结束方式 | 行为 |
| --- | --- |
| `finalize`（流 WS） | 一次 INSERT `messages` + `events`（`resolved_text` 来自 BotStreamConnection buffer）；fanout `message.stream_finalized`；DELETE registry + 关流 WS |
| 中断（timeout、流 WS 断连、主 bot 断连、session.close 等） | **historical, rejected：** 旧讨论/旧 contract 曾写「不 promote partial text」。**当前 contract：** 非空 `flushed_text` → canonical abandoned message + `message.stream_abandoned`；空 buffer → live-only `message.stream_abandon_cleanup` |

**与旧 Phase 7 plan 的差异：** 主 WS 上 `append_stream` UPDATE `messages.text` **作废**；以本节为准。

#### 2.2.1 协议与路由（historical sketch, non-normative）

**`start_stream`（主 WS）**

1. Bot 在主 WS 的 `delivery_result.effects` 或 `session.effects` 中提交 **仅** `start_stream`（同批 **不得** 含 `append_stream` / `finalize_stream`）。
2. ChatChannel：`INSERT message_stream_registry`（`channel_id`、`message_id`、`bot_id`、metadata、`expires_at`）；同步 fanout `message.stream_started`。
3. `delivery_ack`（或 `session.effects` 等价 ack）在 `status=applied` 时附带：

```json
{
  "stream": {
    "channel_id": "00000000-0000-7000-8000-000000000201",
    "message_id": "00000000-0000-7000-8000-000000000301",
    "ws_url": "/api/chat/bot/channels/00000000-0000-7000-8000-000000000201/streams/00000000-0000-7000-8000-000000000301/ws"
  }
}
```

4. Bot **必须**在收到 ack 后，用**同一 Chat Bot Token** upgrade `ws_url`（仍需 `chat:runtime:connect`）。

**流 WS upgrade 校验（Worker）**

1. `verifyBotToken` → `bot_id` + scopes。
2. 调源 `ChatChannel /internal/stream-registry-check`：`{channel_id, message_id, bot_id}` 且 `status=streaming`。
3. 通过后路由 `env.BOT_STREAM_CONNECTION.getByName(streamDoName(channel_id, message_id))`。

**`BotStreamConnection` DO 命名（normative）**

```text
streamDoName(channel_id, message_id) = `${channel_id}#${message_id}`
```

`channel_id` 与 `message_id` **必须成对**；禁止仅用 `message_id` 路由 DO。

**流 WS 帧协议（`api_version`: `lilium.chat.bot.stream.v1`）**

| 方向 | 帧 | 说明 |
| --- | --- | --- |
| Bot → Server | `hello` | 空 body；鉴权已由 HTTP upgrade 完成 |
| Server → Bot | `ready` | `{ channel_id, message_id, expires_at }` |
| Bot → Server | `append` | `{ delta: string }` |
| Server → Bot | `append_ack` | `{ ok: true }`（可选；实现可合并为 silent） |
| Bot → Server | `finalize` | `{ components?, attachment_ids? }`；**不要求** `text` |
| Server → Bot | `finalized_ack` | `{ ok: true }`；随后 Server 关 WS |
| 双向 | `ping` / `pong` | 与主 Gateway 相同 |

**主 WS 禁止项**

| 在主 WS 提交 | 结果 |
| --- | --- |
| `append_stream` / `finalize_stream` | `BOT_EFFECT_INVALID` + `stream.ws_url` |
| 同批 `start_stream` + `append_stream` | `BOT_EFFECT_INVALID` |

#### 2.2.2 BotStreamConnection 内 buffer（normative）

**职责**

| DO | 持有 |
| --- | --- |
| **BotStreamConnection**（`channel_id#message_id`） | 该流 authoritative 正文 + fanout 合并；单 WS `serializeAttachment` |
| **ChatChannel**（`channel_id`） | `message_stream_registry`、canonical 写入、`bot_effects_applied`（`start_stream` / finalize 事务） |
| **BotConnection**（`bot_id`） | **不**持有 stream buffer |
| **ChannelFanout** | live `stream_delta` 投递 |

**平台约束：** `serializeAttachment` 上限 **16 KiB**。单连接单流；attachment 只存小 `pending_text` + fanout 合并状态；大正文 chunk flush 到 **本 DO** SQLite `stream_buffer`（每 DO 一行：`flushed_text`）。

**成本约束**

- `append` **不得** per-delta 写 ChatChannel / canonical SQLite。
- `append` **不得** per-delta 写 `BotStreamConnection` SQLite；仅 `pending_text.length >= STREAM_PENDING_FLUSH_THRESHOLD_BYTES`（或 finalize / 强制瘦身）时 `UPDATE flushed_text`。
- `serializeAttachment` 前：若预估大小 `>= WS_ATTACHMENT_MAX_BYTES`，**强制** flush `pending_text` 到 SQLite。
- `append` **不得** per-delta fanout；按 fanout 限速合并。

**实现常量**（`src/chat/stream-constants.ts`）：

| 常量 | 值 |
| --- | --- |
| `WS_ATTACHMENT_MAX_BYTES` | `16384` |
| `STREAM_PENDING_FLUSH_THRESHOLD_BYTES` | `8192` |
| `STREAM_FANOUT_INTERVAL_MS` | `100` |
| `STREAM_FANOUT_MAX_PENDING_BYTES` | `4096` |

**`BotStreamConnectionAttachment`**

```ts
interface BotStreamConnectionAttachment {
  channel_id: string;
  message_id: string;
  bot_id: string;
  pending_text: string;
  fanout_pending_text: string;
  fanout_due_at_ms: number;
  expires_at: string;
}
```

**`resolved_text`（finalize only）**

```text
resolved_partial = stream_buffer.flushed_text  // abandon 前 flush pending
resolved_text = stream_buffer.flushed_text + attachment.pending_text  // finalize 前 drain pending
```

**historical, rejected：** 旧稿/旧 contract 曾写中断时不写入 canonical `messages`。**当前 contract（§9.15.5 / §12.4）：** 非空 durable partial 写入 abandoned/failed canonical message；空 buffer 仅 live cleanup。

finalize 前 **drain** `fanout_pending_text`。Bot `finalize` **不得**依赖重传全文；平台以 `resolved_text` 写 canonical。

**Fanout 限速：** `Date.now() >= fanout_due_at_ms` **或** `fanout_pending_text.length >= STREAM_FANOUT_MAX_PENDING_BYTES` 时合并一次 `message.stream_delta`；finalize / 中断前 drain 尾 delta。

**帧路径**

```text
start_stream @ 主 WS
  → ChatChannel: registry INSERT + stream_started fanout
  → delivery_ack.stream { channel_id, message_id, ws_url }

Bot upgrade 流 WS（Bearer 同主连接）
  → Worker: registry 校验 (channel_id, message_id, bot_id)
  → BotStreamConnection(channel_id#message_id): acceptWebSocket + serializeAttachment
  → ready

append @ 流 WS
  → pending_text += delta; fanout_pending_text += delta
  → 达 flush 阈值 → stream_buffer.flushed_text += pending_text; serializeAttachment
  → 达 fanout 限速 → ChannelFanout message.stream_delta（batched）

finalize @ 流 WS
  → drain fanout; resolved_text
  → ChatChannel: INSERT messages + events; DELETE registry
  → DELETE stream_buffer; 关 WS; finalized_ack
```

#### 2.2.3 并发与异步（historical sketch, non-normative）

- 主 Bot Gateway 仍为 **异步** at-least-once delivery；与流 WS **解耦**。
- **N 条并发 stream = N 条流 WS + N 个 `BotStreamConnection` DO**；`BotConnection` **无** stream buffer。
- 不同 `{channel_id, message_id}` 可并行；**同一** pair 仅允许 **一条** active 流 WS（新 upgrade 替换旧连接）。
- 单条流内 `append` 按流 WS **收到顺序**拼接。

#### 2.2.4 Fanout vs replay

| 事件 | SQLite | 投递 |
| --- | --- | --- |
| `message.stream_started` | ChatChannel registry INSERT | 同步 ChannelFanout live-only |
| `message.stream_delta` | 无 canonical；BotStreamConnection 合并 | 限速 live-only ChannelFanout |
| `message.stream_abandon_cleanup` | 无 canonical | live-only ChannelFanout |
| `message.stream_abandoned` | messages + events INSERT（非空 partial） | canonical ChannelFanout / HTTP events |
| `message.stream_finalized` | messages + events INSERT | outbox 或同步 fanout |

History / replay **不**含 streaming 中途 delta；离线 reconnect 在 finalize 或 abandon-with-partial 后收敛。

**实现缺口（相对 §2.1）：** 新增 `BotStreamConnection` DO + binding + migration；`src/routes/bot-stream-ws.ts`；`streamDoName(channel_id, message_id)`；contract / 公开文档补充流 WS 路径与 `delivery_ack.stream`；主 WS effect 校验拒绝 append/finalize。

### 2.3 ToolBear 前端消费侧（`toolbear_ui/frontend`）

前端**不**实现 Bot Gateway；只消费 Browser WS 频道事件。与 §2.1 后端 effect 管线配合后方能端到端。

**已有（无需重做）：**

| 能力 | 位置 |
| --- | --- |
| Bot sender 渲染（`kind=bot`） | `MessageTimeline.vue` |
| 流式 UI（`stream_state=streaming` +「生成中」） | `MessageTimeline.vue` |
| `message.stream_started` / `stream_delta` / `stream_finalized` | `chatMessageStore.ts`、`useChatStore.ts` |
| Delta 100ms 批量追加 | `chatMessageStore.applyStreamDelta` |
| Bot components + `interaction.submit` | `BotComponents.vue`、`useChatSocket.ts` |
| Slash invoke + command pending | `MessageComposer.vue`、`ChatSurface.vue` |
| Stateful session banner | `StatefulSessionBanner.vue` |

**缺口 / 待对齐：**

| 项 | 说明 | 依赖 |
| --- | --- | --- |
| 端到端不可用 | 后端 §2.1 未 emit stream / effect 事件 | §2.1 |
| `start` 事件名 | 前端 handler 用 `message.stream_started`；旧 plan 写 `start_stream` → `message.created`。实现 backend 时**统一**为一种（建议 `message.stream_started`，payload 含完整 `message` 投影） | §2.1 实现 |
| `message.updated` 校验过严 | `chatFrameGuards.ts` 仅接受 `status=edited`；`disable_components` 若发 `status=normal` 会被静默丢弃 | 后端 effect 定稿后改 guard 或 contract 规定 component-only update 的 status |
| `command.invoked` / `interaction.created` | `chatEvents.ts` 有类型，`useChatStore.applyHistoryEvent` 无 case | 可选；本地 pending 已部分覆盖 |
| 流式 markdown | streaming 期间 plain text 追加；`format=markdown` 是否在 delta 阶段重渲染未优化 | 低优先级 |
| Replay 无中途 delta | 与 §2.2 一致；前端 reconnect 只应看到 final 消息 — 需确认 history API 不返回 `streaming` 半成品 | §2.2 后端 |

**上线后：** 前端缺口关闭项从本文删除；不在公开 Bot API 文档写「缺口」。

---

## 3. Chat Bot Token read scope（无公开端点）

下列 scope 已在 token 模型与 contract 中定义，**尚无**对应 Bot Token HTTP/WS 只读 API：

| Scope | 预期用途（待设计公开端点） |
| --- | --- |
| `chat:messages:read` | Bot 主动拉取频道消息历史 |
| `chat:channels:read` | Bot 查询频道元数据 |
| `chat:members:read` | Bot 查询频道成员列表 |

**当前状态：** Token 可签发这些 scope，但签发后无 API 可调用。Bot 仅能通过 `delivery` / `message_event` 被动接收上下文。

**上线后：** 为每个 scope 定义公开路径与认证后写入公开文档 §Scopes。

---

## 4. Bot 图片附件

**目标：** Bot 在 `send_message` / `start_stream` / `update_message` effects 中引用 `attachment_ids`（`type: "image"`）。

**阻塞：**

1. Effect 应用管线（§2.1）未完成。
2. 无 Bot Token 附件上传公开 API（presign + finalize）。
3. 附件归属模型仅 `owner_user_id`（`UserDirectory.pending_attachments`），无 `owner_bot_id`。
4. Bot 不能复用用户 `attachment_id`（归属校验拒绝）。

**设计方向（未承诺路径）：**

- `POST /api/chat/bot/uploads/images/presign`
- `POST /api/chat/bot/uploads/images/{attachment_id}/finalize`
- Scope：`chat:messages:write` 或独立 `chat:attachments:write`
- 消息 mutation 仍只经 WS effects；上传 HTTP 仅产生可引用的 `attachment_id`

`type: "sticker"` + `sticker_id` 为用户个人表情库能力，不纳入 Bot 第三方公开面。

**上线后：** 上传 API + effect 中 `attachment_ids` 字段写入公开文档。

---

## 5. 平台内置 `/permission` 命令

**目标：** 除已实现的 platform `/help` 外，再提供 platform `/permission`，让频道 **owner/admin** 在聊天内通过 slash 管理本频道 command allow/block，**不必**打开 ToolBear 频道设置。行为对齐旧 DZMM bot `bots/commands/permission.py`（房间命令开关）。

**产品语义（normative）：**

| 用法 | 行为 |
| --- | --- |
| `/permission` | 列出本频道当前 **已开启** / **已关闭** 的命令（基于 manifest 可见集 + binding） |
| `/permission <name> on` | allow 该 command（写入 channel binding，`status=allowed`） |
| `/permission <name> off` | block 该 command（`status=blocked`） |

- **权限：** 仅频道 `owner` 或 `admin`；普通 member invoke → `403 COMMAND_PERMISSION_DENIED`（或专用文案 bot message，与 `/help` 一样走 platform 同步回复）。
- **可管理范围：** 只能开关本频道 manifest 中已出现的 command（含 official auto-allowed + 显式 allowed）；不能凭空启用 catalog 里未注册或不适用于该频道的 command。
- **名称解析：** `<name>` 可省略 `/`；匹配 canonical `name` 或 catalog `aliases`（同 invoke）。
- **Official command：** 默认 allowed；`/permission <name> off` 写 explicit `blocked`；对已 official auto-allowed 的 command 再 `/permission <name> on` → `409 OFFICIAL_COMMAND_AUTO_ALLOWED`（与 Web allow 一致）。
- **DM：** 与 `/help` 相同，DM 不提供 platform `/permission`（`409 UNSUPPORTED_CHANNEL_KIND` 或 manifest 不含该项）。
- **执行路径：** 与 `/help` 相同 — **不经 Bot Gateway**；`command.invoke` 在 ChatChannel 内联处理，同步写入 bot text message + 更新 binding + fanout `command.binding_updated` + 递增 `command_manifest_version`。
- **Identity：** 复用 platform bot `bot_id` `00000000-0000-7000-8000-000000000600`（`display_name=system`）；新增 well-known `bot_command_id`（与 `00000000-0000-7000-8000-000000000700` 的 `/help` 并列，具体 UUID 实现时分配并写入 `src/chat/platform-commands.ts` + contract §9.2）。
- **Options 形状（建议）：** `command`（string，invoke 时必填 except 列表模式）、`action`（enum `on` \| `off`，与旧 bot 的 trailing `on/off` 等价；列表模式两者均 omit）。

**与 Web 频道设置的关系：** 同一套 `ChatChannel` binding 行；slash 与 ToolBear Web `PATCH .../commands/{bot_command_id}` 互为等价入口。Web 仍为产品 UI；`/permission` 为聊天内快捷入口，**不是**第三方 Bot API。

**当前状态：**

- `/help` 已实现（`src/chat/platform-commands.ts`、`platformHelpManifestItem()`、manifest append、invoke 内联）。
- `/permission` **未实现** — manifest 无该项；无 invoke handler。

**上线后：** 在 contract addendum + 公开文档 §Slash Command 与频道绑定 补充 platform `/permission` 用户可见语义；仍不暴露 Web PATCH 路径给第三方。

**参考：** `dzmm_archive/bots/commands/permission.py`、`bots/room_permissions.py`（旧 bot 存 SharedStorage；新系统映射到 `ChatChannel` command binding）。

---

## 7. Rich UI components v2 + `interaction_policy`

**目标：** Bot 消息内嵌交互控件覆盖常见表单场景；平台提供有序事件流与结构性门禁；业务冲突由 Bot 裁决。

**Contract：** `docs/api-contract.md` §3.8（v2.18）、§9.6、§11。

### 7.1 组件 kind（normative）

| kind | 用途 | submit 触发 |
| --- | --- | --- |
| `button` | 单次动作 | 点击 |
| `select` | 下拉单选 | 选中 |
| `radio` | 可见单选 | 选中 |
| `checkbox` | 单项布尔 | toggle |
| `checkbox_group` | 多项复选 | 点 `submit_label` |
| `text_input` | 文本输入 | Enter（单行）或 `submit_label` |

`value` 类型见 contract §9.6 表。

### 7.2 `interaction_policy`（normative）

| policy | 平台行为 |
| --- | --- |
| `multi`（默认） | 可见成员均可提交；Bot 处理并发业务冲突 |
| `per_user_once` | 每用户每 component 仅一条成功 interaction |
| `exclusive` | 全频道首个成功 submit 同事务 `disabled=true` |
| `targeted` | 仅 `target_user_id` 可提交 |

**职责分界：**

- **平台：** policy 门禁 + per-channel 有序 timeline + `message_interaction` delivery 顺序与 committed interaction 一致
- **Bot：** 余额/库存/游戏状态等业务冲突；`multi` 下可能收到多条 delivery

### 7.3 实现缺口

| 层 | 状态 |
| --- | --- |
| Contract §3.8 / §9.6 / §11 | **v2.18 已定稿**（本文同步） |
| `src/contract/message.ts` | 类型已扩展；`validateComponents` **未实现** |
| ChatChannel `interaction.submit` | **未实现**；`user-connection.ts` 仍 `unsupported command` |
| `interactions` 表 | 需 `UNIQUE(message_id, component_id, actor_user_id)` 支撑 `per_user_once`（migration） |
| `exclusive` 原子 disable | 在 submit 事务内 UPDATE `components_json`，不等 bot effect |
| Bot effect 管线 | **未实现**（§2.1） |
| `toolbear_ui` `BotComponents.vue` | 仅 `button`/`select`；需补 radio/checkbox/checkbox_group/text_input + policy UX |

**Phase 7 plan 对齐：** `docs/superpowers/plans/2026-06-26-lilium-chat-phase-7.md` Task 7c-components / 7d 实现时以 contract v2.18 为准（非旧 `{button, select}` 范围）。

**刻意不在 v1：** `modal` / `form` 容器 / 多字段一次性 submit object — 需另开 contract 修订。

---

## 8. 公开文档维护规则

1. `lilium-openapi/docs/lilium-chat-bot-api-design.md` **不得**出现「尚未实现」「缺口」「能力矩阵」「预留 scope」等表述。
2. 某能力在本表对应条目关闭且生产可用后，从本文删除或标为 **Done**，并同步扩充公开文档。
3. ToolBear Web / Browser JWT / 频道 allow-block HTTP / Admin API **永不**写入第三方公开文档（非第三方集成面）。
