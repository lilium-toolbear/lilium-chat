# ToolBear Frontend — Bot Streaming + Rich UI Changes

**Status:** Implementation checklist (non-normative)  
**Audience:** `toolbear_ui/frontend`  
**Authority:** `docs/api-contract.md` §3.8、§9.6、§9.13–§9.16、§12.4  
**Backend plan:** `docs/superpowers/plans/2026-06-30-lilium-chat-bot-streaming-internal-api-implementation.md`

前端**不**实现 Bot Gateway / Stream WS；只消费 Browser WS + HTTP history/events。本清单覆盖 bot effect 管线落地后 ToolBear 所需的**全部**前端变更，不仅 abandon 语义，还包括传输层、流式生命周期、Rich UI v2.18、以及 bot `message.updated`（`disable_components`）对齐。

---

## 1. 变更面总览

| 领域 | 现状 | 目标 |
|---|---|---|
| WS 传输 | 只解析 `frame_type=event` 等；**无** `stream_event` | 增加 live-only stream frame 路由 |
| 流式生命周期 | 有 started/delta/finalized handler；**无** abandon_cleanup / canonical abandoned | 完整五态 + 双投递路径 |
| 类型枚举 | `stream_state`: none/streaming/final；`status` 无 `failed` | + `abandoned` / `failed` |
| Rich UI | 仅 `button` + `select`；无 `interaction_policy` | contract §3.8 六种 kind + policy UX |
| Bot 消息更新 | `chatFrameGuards` 拒收 `message.updated` + `status=normal` | 接受 component-only update（disable_components） |
| 组件挂载时机 | `canRenderComponents` 仅看 status normal/edited | finalize 后渲染；streaming / abandoned partial 不渲染 |
| 错误文案 | 无 Rich UI 专用 error code 映射 | + COMPONENT_* / INTERACTION_* 用户文案 |

---

## 2. 后端依赖（必须先落地）

| Backend Task | 前端解锁能力 |
|---|---|
| Task 5 | live `message.stream_started`（`stream_event`） |
| Task 7 | live `message.stream_delta`、batched delta |
| Task 8 | canonical `message.stream_finalized`（含 components）、无 `message.created` |
| Task 9 | `message.stream_abandon_cleanup`（空 stream）、canonical `message.stream_abandoned`（非空 partial） |
| Task 4 | bot `send_message` / `update_message` / `disable_components` → `message.created` / `message.updated` |

Rich UI **不依赖** streaming Task；可与 Task 4 并行，但 `disable_components` 的 `message.updated` 投影依赖 Task 4。

---

## 3. 传输层：`stream_event` 帧

### 3.1 问题

`useChatSocket.ts` 的 `parseFrame` / `handleFrame` **不识别** `frame_type: "stream_event"`（contract §9.16，`api_version: lilium.chat.stream.v1`）。后端 live fanout 的 started/delta/abandon_cleanup 无法到达前端。

### 3.2 修改文件

| 文件 | 变更 |
|---|---|
| `src/types/chat.ts` | 新增 `WebSocketStreamEventFrame`：`{ frame_type: 'stream_event', api_version, channel_id, type, payload, stream_seq?, occurred_at? }` |
| `src/composables/useChatSocket.ts` | `parseFrame` 识别 `stream_event`；`handleFrame` 分支 dispatch |
| `src/composables/useChatStore.ts` | 新增 `applyStreamEventFrame(frame)` 或在 socket 层直接调 store helpers |

### 3.3 路由规则

```
stream_event.type ∈ { message.stream_started, message.stream_delta, message.stream_abandon_cleanup }
  → chatMessageStore.applyStream*（与 today 的 event 路径相同逻辑）

frame_type=event, type ∈ { message.stream_finalized, message.stream_abandoned }
  → 现有 applyEvent / applyHistoryEvent（canonical channel event）
```

**Dedupe：** 按 `(channel_id, message_id, stream_seq)` 去重 live stream frames（contract §9.16）；canonical events 仍按 `(channel_id, event_id)`。

---

## 4. 流式生命周期（Store）

### 4.1 类型（`src/types/chat.ts` + `src/types/chatEvents.ts`）

```ts
// MessageLifecycleStatus 增加
'failed'  // bot stream 中断 partial only

// MessageStreamState 增加
'abandoned'

// ChatEventType 增加
'message.stream_abandoned'  // canonical

// 新增 live-only payload（不经 chatEvents union，走 stream_event）
MessageStreamAbandonCleanupPayload { channel_id, message_id }
MessageStreamAbandonedPayload { channel_id, event_id, message }  // 同 MessageProjectionEventPayload
```

同步 `lilium-chat/src/contract/events.ts`（backend 类型源）与 `chatEvents.ts`（frontend 注释已要求手动 sync）。

### 4.2 `src/composables/chat/chatMessageStore.ts`

| 函数 | 变更 |
|---|---|
| `applyStreamStarted` | 保持；确保 provisional message 来自 payload.message 投影 |
| `applyStreamDelta` | 保持；guard 仍要求 `status=normal && stream_state=streaming` |
| `applyStreamFinalized` | 保持；finalize 后 `stream_state=final`，可带 `components` |
| **`applyStreamAbandonCleanup`**（新） | 收到 cleanup：若存在 provisional message（streaming），**移除** timeline 条目或 reset 为不可见；clearStreamState |
| **`applyStreamAbandored`**（新） | 收到 canonical abandoned：flush delta buffer → `applyMessageProjection` with `stream_state=abandoned`, `status=failed`；**不清空** text |

### 4.3 `src/composables/useChatStore.ts` — `applyHistoryEvent`

新增 cases：

- `message.stream_abandoned` → `applyStreamAbandoned` + `syncChannelSummaryFromMessage`
- `message.stream_finalized` — 已有；确认 history bootstrap 走此路径而非 `message.created`

**不要**在 history 路径处理 live-only 的 started/delta/cleanup（HTTP 不返回）。

### 4.4 与 `message.created` 的关系

Stream bot 消息**不会** emit `message.created`。前端不得假设 bot 流式回复会先出现 `message.created`；首见应为 `stream_started`（live）或 history 中的 `stream_finalized` / `stream_abandoned`。

非流式 bot `send_message` 仍走 `message.created` — 现有路径保留。

---

## 5. Rich UI v2.18（contract §3.8 / §9.6）

> **这是独立大块工作**，与 streaming abandon 正交，但同属 bot 回复体验；backend Task 4/8 落地后必须一起验收。

### 5.1 类型扩展 — `src/types/chat.ts`

当前 `MessageComponent = ButtonMessageComponent | SelectMessageComponent`，缺：

| kind | 必要字段 | submit `value` 类型 |
|---|---|---|
| `radio` | `label`, `options[]` | `string`（选中一项即提交） |
| `checkbox` | `label`, `default_checked?` | `boolean`（每次 toggle 提交） |
| `checkbox_group` | `label`, `options[]`, `submit_label`, `min_selected`, `max_selected` | `string[]`（点 submit_label） |
| `text_input` | `label`, `placeholder?`, `multiline`, `min_length`, `max_length`, `submit_label` | `string`（Enter 或 submit_label） |

**所有 kind 公共字段（当前缺失）：**

```ts
interaction_policy?: 'multi' | 'per_user_once' | 'exclusive' | 'targeted'
target_user_id?: string  // policy=targeted 时
```

用 discriminated union 建模；更新 `src/types/__tests__/chatTypes.test.ts`。

### 5.2 组件渲染 — `src/components/chat/BotComponents.vue`

现状：template 仅 `button` / `else→select`；未知 kind 会误渲染为 select。

**必须新增 UI：**

| kind | 交互（contract §3.8 提交触发） |
|---|---|
| `radio` | 平铺选项；点一项 → 立即 `submitInteraction`（value=option.value） |
| `checkbox` | toggle → 每次变更提交 boolean value |
| `checkbox_group` | 多选 + 独立「提交」按钮；校验 min/max selected 后再提交 string[] |
| `text_input` | 输入框 + submit_label；单行 Enter 提交；multiline 仅按钮提交；客户端校验 length |

**`interaction_policy` 前端 UX（平台仍做 authoritative 校验）：**

| policy | 前端行为 |
|---|---|
| `multi` | 默认；现有 pending 防抖即可 |
| `per_user_once` | 本地成功后保持 disabled 直到 `message.updated` 或 ack 失败 |
| `exclusive` | 任意用户 pending 时全员 disable；收到 `message.updated` 见 component.disabled=true |
| `targeted` | 当前用户 ≠ `target_user_id` 时不渲染或可 aria-hidden；不 emit submit |

**样式：** 遵循 `design-guideline/UI_GUIDELINES.md`；bot 消息内组件与现有 button/select 视觉一致。

### 5.3 组件挂载时机 — `MessageTimeline.vue`

```ts
function canRenderComponents(message: ChatMessage) {
  return isMessageContentVisible(message.status)
    && message.stream_state === 'final'   // 新增：streaming/abandoned 不渲染
    && message.components.length > 0
}
```

- **finalize** 后 `stream_finalized` 投影可带 components → 渲染 + interaction
- **abandoned partial** contract 明确不附带 finalize-only components → 保持 `components=[]`
- **streaming 期间** contract：typing 中间态 **不** 发 interaction

### 5.4 `disable_components` / `message.updated`

Backend `disable_components` effect 可能发 `message.updated`，投影 `status=normal` 且仅 `components[].disabled` 变化。

**`src/utils/chatFrameGuards.ts`：**

```ts
// 扩展 MESSAGE_PROJECTION_STATUS_BY_EVENT['message.updated']
new Set(['edited', 'normal'])  // normal = component-only update
```

或更严：仅当 payload 中 components 数组存在且其余字段符合 component-only patch 时放行。

**Store：** `applyHistoryEvent` case `message.updated` 已 `projectMessage` — guard 修好后自动生效。

### 5.5 错误码与用户文案 — `src/utils/chatErrorMessages.ts`

新增 SOCKET/API 映射（contract §11 v2.18）：

| code | 建议中文 |
|---|---|
| `COMPONENT_ALREADY_USED` | 该选项已被其他人选用 |
| `INTERACTION_ALREADY_SUBMITTED` | 你已经提交过了 |
| `INTERACTION_FORBIDDEN_TARGET` | 这个互动仅限指定成员 |
| `COMPONENT_DISABLED` | 该控件已不可用 |
| `INVALID_INTERACTION_VALUE` | 提交内容无效，请重试 |

`ChatSurface.vue` 的 `componentErrors` computed 已按 `pendingInteractions` 展示 — 确保 `applyCommandError` 把上述 code 写入 pending interaction。

### 5.6 测试 — Rich UI

| 文件 | 新增用例 |
|---|---|
| `BotComponents.spec.ts` | radio/checkbox/checkbox_group/text_input 各 emit 正确 value；targeted 对非目标用户不可点；checkbox_group min/max |
| `chatFrameGuards.spec.ts` | `message.updated` + status=normal + components patch → valid |
| `useChatStore.spec.ts` | disable_components 投影后 component.disabled=true |
| `MessageTimeline.spec.ts` | streaming 消息不渲染 BotComponents；final 渲染 |

---

## 6. 流式 UI / 消息状态

### 6.1 `src/utils/chatMessageStatus.ts`

```ts
// isMessageContentVisible: 增加 status==='failed'（展示 abandoned partial 文本）
// isTimelineVisibleMessage: 增加 'failed'（abandoned 消息留在 timeline）
```

`failed` **不是** deleted/recalled — 仍显示 partial text。

### 6.2 `src/components/chat/MessageTimeline.vue`

| 状态 | UI |
|---|---|
| `stream_state=streaming` | 保留「生成中」badge（已有） |
| `stream_state=final` | 正常 bot 回复样式 |
| `stream_state=abandoned` + `status=failed` | **新**：中断样式（如边框/文案「回复中断」），与 final 区分；**不**显示「生成中」 |
| `format=markdown` + streaming | 低优先级：delta 期间 plain 追加 vs 重渲染 markdown（gap tracker §2.3） |

`isBotMarkdown` / `messageSegments` 需允许 `status=failed` 显示内容。

### 6.3 Channel summary

`syncChannelSummaryFromMessage` — abandoned/finalized stream 结束时应更新 `last_message_preview`（与 today finalized 行为一致）。

---

## 7. 其他 Bot 事件（可选 / 低优先级）

| 项 | 文件 | 说明 |
|---|---|---|
| `command.invoked` timeline | `useChatStore.applyHistoryEvent` | 类型已有，无 case；本地 pending 已部分覆盖 |
| `interaction.created` | 同上 | 可选 timeline 行 |
| HTTP gap replay | `useChatStore` replay 路径 | 确认 `GET .../events` 含 stream_finalized / stream_abandoned |

---

## 8. 文件清单（按优先级）

### P0 — 阻塞 E2E streaming

1. `src/types/chat.ts` + `src/types/chatEvents.ts`
2. `src/composables/useChatSocket.ts`
3. `src/composables/chat/chatMessageStore.ts`
4. `src/composables/useChatStore.ts`
5. `src/utils/chatMessageStatus.ts`
6. `src/components/chat/MessageTimeline.vue`

### P0 — 阻塞 bot 互动（Rich UI + disable）

7. `src/types/chat.ts`（MessageComponent union + policy）
8. `src/components/chat/BotComponents.vue`
9. `src/utils/chatFrameGuards.ts`
10. `src/utils/chatErrorMessages.ts`

### P1 — 测试与 polish

11. `src/composables/__tests__/useChatStore.spec.ts`
12. `src/composables/__tests__/useChatSocket.spec.ts`
13. `src/components/chat/__tests__/BotComponents.spec.ts`
14. `src/components/chat/__tests__/MessageTimeline.spec.ts`
15. `src/utils/__tests__/chatFrameGuards.spec.ts`
16. `src/test/chatFixtures.ts`（fixtures 补 stream_state/status 变体）

---

## 9. 前端验收清单

### Streaming

- [ ] live `stream_event`：started → delta → finalized 在线可见
- [ ] canonical `message.stream_finalized` 经 `event` frame 与 HTTP history 一致
- [ ] 空 stream expiry：收到 `stream_abandon_cleanup`，provisional 消失，history 无行
- [ ] 非空 partial expiry：provisional 收敛为 `failed`/`abandoned` 消息，刷新仍在
- [ ] 无 `message.created` 的 bot stream 仍正常显示
- [ ] finalize 后 delta 被忽略（已有测试，保持）

### Rich UI

- [ ] 六种 component kind 可渲染且 value 形状正确
- [ ] `exclusive` / `per_user_once` / `targeted` 有合理 UX
- [ ] `disable_components` → `message.updated` 更新 disabled，不被 guard 丢弃
- [ ] streaming / abandoned 消息上不出现 BotComponents
- [ ] finalize 后 components 可交互，`interaction.submit` ack/error 正常

### 构建

```bash
cd toolbear_ui/frontend && npm run build
```

---

## 10. 明确不在本轮

- Bot Token 附件上传 UI（contract §9.17 future）
- Bot read API 客户端
- Machine Token Developer Bots（已有 DeveloperBotsView，与 streaming 无关）
- 修改 `lilium-chat` 后端（另 repo / 另 plan）

---

## 11. 与 backend 类型同步

`lilium-chat/src/contract/events.ts` 与 `toolbear_ui/frontend/src/types/chatEvents.ts` 需保持手动 sync（backend 已有注释）。Task 1 落地后 frontend 应 cherry-pick 新增 event types / Message 枚举，避免 drift。
