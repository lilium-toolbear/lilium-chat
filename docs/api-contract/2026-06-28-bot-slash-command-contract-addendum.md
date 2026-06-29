# Bot Slash Command Contract Addendum

状态：实现前 API contract addendum（相对 v2.15 + DM addendum）
日期：2026-06-28
权威来源：`docs/superpowers/specs/2026-06-28-lilium-chat-bot-spec-revised.md`

本 addendum 描述 Slash Command 产品模型对 Browser/Bot API 的变更。与 base contract 冲突处以本文件 + spec 为准。

## Removed Browser routes (non-goals)

- `POST /api/chat/channels/{channel_id}/bot-installations`
- `PATCH /api/chat/channels/{channel_id}/bot-installations/{bot_id}`
- `PATCH /api/chat/channels/{channel_id}/bot-installations/{bot_id}/event-subscriptions/message.created`

Bot installation UI 与 per-channel slash 冲突模型移除。频道管理员通过 allow/block 管理 Slash Command。

## Added Browser routes

| Method | Path | Notes |
|---|---|---|
| POST | `/api/chat/bots` | Create bot app (developer) |
| GET | `/api/chat/bots` | List caller's bots |
| GET | `/api/chat/bots/{bot_id}` | Bot summary |
| GET | `/api/chat/bots/{bot_id}/tokens` | List token metadata (no plaintext) |
| POST | `/api/chat/bots/{bot_id}/tokens` | Create token; response includes one-time `plaintext` |
| DELETE | `/api/chat/bots/{bot_id}/tokens/{token_id}` | Revoke token |
| GET | `/api/chat/commands/directory` | Global command search (admin cold path); `query`, `cursor`, `limit` |
| GET | `/api/chat/channels/{channel_id}/stateful-session` | Active session summary or null |
| POST | `/api/chat/channels/{channel_id}/stateful-session/stop` | Admin stop active session |

**Deferred v1.1:** `PATCH /api/chat/bots/{bot_id}` (profile update)

## Changed Browser routes

### `PATCH /api/chat/channels/{channel_id}/commands/{bot_command_id}`

Request body (replaces `enabled: boolean`):

```json
{
  "status": "allowed",
  "permission_override": "member",
  "stateful_max_ttl_seconds": 3600
}
```

- `status`: `"allowed" | "blocked"`
- `permission_override`: optional channel role floor override
- `stateful_max_ttl_seconds`: optional cap when command execution is stateful

Allow path fetches command definition from BotRegistry once and stores `command_snapshot_json` on the binding.

### `GET /api/chat/channels/{channel_id}/commands`

Returns full manifest (no required `?prefix=`):

```json
{
  "version": 3,
  "items": [ /* CommandManifestItem[] */ ]
}
```

Hot path: bootstrap attaches the same shape as `command_manifest`. Deprecated `?prefix=` query param is ignored (full manifest returned).

DM channels: empty manifest `{ "version": 0, "items": [] }`; PATCH returns `409 UNSUPPORTED_CHANNEL_KIND`.

### `GET /api/chat/bootstrap?channel_id=`

Extended response includes:

```json
{
  "command_manifest": { "version": 1, "items": [] },
  "active_stateful_session": null
}
```

## Changed Bot routes

### `PUT /api/chat/bot/commands` (catalog sync)

- Add `execution.mode`: `"stateless" | "stateful"`
- Add `execution.stateful` config when mode is stateful (mutex, TTL, listen_capability)
- Remove `event_capabilities`, `default_enabled_on_install`
- Global slash namespace: `bot_command_names` in BotRegistry; sync conflict → `409 COMMAND_NAME_CONFLICT` with `conflict` object

## Events

### Extended: `command.binding_updated`

Wire payload **must** include required `command_manifest_delta`:

```json
{
  "op": "upsert",
  "manifest_version": 2,
  "item": { /* CommandManifestItem */ }
}
```

Remove delta:

```json
{
  "op": "remove",
  "manifest_version": 3,
  "item": { "bot_command_id": "..." }
}
```

Persisted event storage includes `command_manifest_delta` for timeline replay.

### Added channel events

- `stateful_session.started` — payload `{ session: StatefulSessionSummary }` (emit only after bot `session.started`, status `active`)
- `stateful_session.updated` — payload `{ session: StatefulSessionSummary }`
- `stateful_session.closed` — payload `{ session_id, bot_command_id, command_name, status, reason, closed_at }`

## Bot Gateway session frames (§10.3–10.6)

Bot ↔ `BotConnection` WebSocket frames:

| Direction | Frame |
|---|---|
| Server → Bot | `session.start`, `session.input`, `session.closed` |
| Bot → Server | `session.started`, `session.input_ack`, `session.effects`, `session.effects_ack`, `session.close` |

Reconnect resume: `BotConnection` reads bot-scoped `active_stateful_session_refs`, then fetches unacked inputs per channel from `ChatChannel`.

## Error codes (additions)

| Code | HTTP | Retryable |
|---|---|---|
| `COMMAND_NOT_ALLOWED` | 403 | no |
| `COMMAND_PERMISSION_DENIED` | 403 | no |
| `COMMAND_OPTIONS_INVALID` | 422 | no |
| `COMMAND_MANIFEST_VERSION_STALE` | 409 | no |
| `STATEFUL_SESSION_BUSY` | 409 | no |
| `STATEFUL_SESSION_NOT_FOUND` | 404 | no |
| `STATEFUL_SESSION_NOT_ACTIVE` | 409 | no |
| `STATEFUL_SESSION_PERMISSION_DENIED` | 403 | no |
| `STATEFUL_SESSION_EXPIRED` | 410 | no |
| `STATEFUL_INPUT_BACKLOG_OVERFLOW` | 429 | no |
| `BOT_TOKEN_INVALID` | 401 | no |
| `BOT_TOKEN_REVOKED` | 401 | no |
| `BOT_SCOPE_DENIED` | 403 | no |
| `BOT_DISABLED` | 403 | no |

`BOT_OFFLINE` remains `503` retryable (existing).
