import { buildEventFrame, type UserSummary as LiveUserSummary } from "./event-broadcast";
import { parseStoredComponents } from "./bot-effects";
import {
  type CommandInvokedPersistedPayload,
  type InteractionCreatedPersistedPayload,
  projectCommandInvokedWirePayload,
  projectInteractionCreatedWirePayload,
  resolveComponentLabelFromJson,
} from "./bot-lifecycle-events";
import { projectMessageForBrowser, type MessageStickerSnapshot } from "./message-projection";
import { buildReplyTargetStatusLookup } from "./reply-snapshot";
import { projectAttachmentForBrowser, type AttachmentRow as ChatAttachmentRow } from "./attachment-projection";
import { resolveActorWithMap } from "./channel-events";
import type { Env } from "../env";
import {
  isChatEventType,
  REPLAY_BOT_LIFECYCLE_EVENT_TYPES,
  REPLAY_MANAGEMENT_EVENT_TYPES,
  REPLAY_MESSAGE_EVENT_TYPES,
  type ChatEventPayloadByType,
  type ChatEventType,
} from "../contract/events";
import type {
  ManagementPersistedPayload,
  MessagePersistedPayload,
  MessageRow,
} from "../contract/persisted";
import { resolveUserSummaries } from "../profile/resolve";
import { buildLiveUserMaps } from "./replay-user-maps";
import type { EventFrame } from "../contract/wire-frames";

export type SyncSql = {
  exec: (query: string, ...params: unknown[]) => { toArray: () => unknown[] };
};

export interface ReplayEventRow {
  event_id: string;
  event_type: string;
  payload_json: string;
  occurred_at: string;
}

export interface ReplaySqlEventRow {
  event_id: unknown;
  event_type: unknown;
  payload_json: unknown;
  occurred_at: unknown;
}

export interface ReplayEnvelope {
  event_id: string;
  event_json: string;
}

export function parseReplayRows(rows: ReplaySqlEventRow[]): ReplayEventRow[] {
  return rows.map((row) => ({
    event_id: typeof row.event_id === "string" ? row.event_id : String(row.event_id ?? ""),
    event_type: typeof row.event_type === "string" ? row.event_type : String(row.event_type ?? ""),
    payload_json: typeof row.payload_json === "string" ? row.payload_json : "",
    occurred_at: typeof row.occurred_at === "string" ? row.occurred_at : "",
  }));
}

function extractMessageSenderUserId(sql: SyncSql, messageId: string): string[] {
  const messageRow = sql
    .exec("SELECT sender_kind, sender_user_id FROM messages WHERE message_id=?", messageId)
    .toArray()[0] as { sender_kind: string; sender_user_id: string | null } | undefined;
  if (messageRow?.sender_kind === "user" && messageRow.sender_user_id) {
    return [messageRow.sender_user_id];
  }
  return [];
}

function projectReplayMessagePayload(
  sql: SyncSql,
  eventType: string,
  persistedPayload: MessagePersistedPayload | ManagementPersistedPayload | unknown,
  liveSenderMap: Map<string, LiveUserSummary>,
): ChatEventPayloadByType[ChatEventType] | unknown | null {
  const messagePersisted = persistedPayload as MessagePersistedPayload;
  const p = messagePersisted.message;
  const messageId = typeof p?.message_id === "string" ? p.message_id : "";
  if (!messageId) {
    return persistedPayload;
  }
  const messageRow = sql
    .exec(
      `SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id,
              sender_bot_display_name, sender_bot_avatar_url, type, format, status, text,
              reply_to, reply_snapshot_json, components_json, stream_state, created_at, updated_at,
              edited_at, deleted_at, deleted_by, recalled_at, invocation_json
       FROM messages WHERE message_id=?`,
      messageId,
    )
    .toArray()[0] as (MessageRow & { components_json?: string | null }) | undefined;
  if (!messageRow) {
    return persistedPayload;
  }
  if (eventType === "message.created" && (messageRow.status === "deleted" || messageRow.status === "recalled")) {
    return null;
  }
  const senderSummary = messageRow.sender_kind === "user" && messageRow.sender_user_id
    ? liveSenderMap.get(messageRow.sender_user_id) ?? undefined
    : undefined;
  const replayMentionRows = sql
    .exec("SELECT user_id, start, end_ AS end FROM mentions WHERE message_id=?", messageRow.message_id)
    .toArray() as Array<{ user_id: string; start: number; end: number }>;
  const replayMentions = replayMentionRows.map((m) => ({ user_id: m.user_id, start: m.start, end: m.end }));
  const replayAttachmentRows = sql
    .exec(
      `SELECT a.attachment_id, a.owner_user_id, a.kind, a.filename, a.mime_type, a.size_bytes, a.width, a.height, a.blurhash, a.storage_key, a.url, a.status, a.created_at
       FROM message_attachments ma
       JOIN attachments a ON a.attachment_id = ma.attachment_id
       WHERE ma.message_id=?`,
      messageRow.message_id,
    )
    .toArray() as unknown as ChatAttachmentRow[];
  const replayAttachments = replayAttachmentRows
    .map(projectAttachmentForBrowser)
    .filter((a): a is NonNullable<ReturnType<typeof projectAttachmentForBrowser>> => a !== null);
  const replayStickerRow = sql
    .exec(
      "SELECT sticker_id, attachment_id, url, mime_type, width, height, size_bytes, blurhash FROM message_stickers WHERE message_id=?",
      messageRow.message_id,
    )
    .toArray()[0] as unknown as MessageStickerSnapshot | undefined;
  const replyTargetStatus = messageRow.reply_to
    ? buildReplyTargetStatusLookup(sql, [messageRow.reply_to]).get(messageRow.reply_to)
    : undefined;
  return {
    message: projectMessageForBrowser(messageRow, {
      senderSummary,
      mentions: replayMentions,
      attachments: replayAttachments,
      sticker: replayStickerRow ?? null,
      components: parseStoredComponents(messageRow.components_json ?? "[]"),
      replyTargetStatus,
    }),
  };
}

function projectReplayBotLifecyclePayload(
  sql: SyncSql,
  eventType: string,
  persistedPayload: unknown,
  liveMap: Map<string, LiveUserSummary>,
): ChatEventPayloadByType[ChatEventType] | unknown {
  if (eventType === "command.invoked") {
    const persisted = persistedPayload as CommandInvokedPersistedPayload;
    const actorUserId = persisted.actor_user_id;
    const actor = actorUserId
      ? liveMap.get(actorUserId) ?? {
          user_id: actorUserId,
          display_name: actorUserId,
          avatar_url: null,
        }
      : undefined;
    if (!actor) return persistedPayload;
    return projectCommandInvokedWirePayload(persisted, actor);
  }

  if (eventType === "interaction.created") {
    const persisted = persistedPayload as InteractionCreatedPersistedPayload;
    const actorUserId = persisted.actor_user_id;
    const actor = actorUserId
      ? liveMap.get(actorUserId) ?? {
          user_id: actorUserId,
          display_name: actorUserId,
          avatar_url: null,
        }
      : undefined;
    if (!actor) return persistedPayload;
    const messageRow = sql
      .exec("SELECT components_json FROM messages WHERE message_id=?", persisted.message_id)
      .toArray()[0] as { components_json: string | null } | undefined;
    const componentLabel = messageRow
      ? resolveComponentLabelFromJson(messageRow.components_json ?? "[]", persisted.component_id)
      : null;
    return projectInteractionCreatedWirePayload(persisted, actor, componentLabel);
  }

  return persistedPayload;
}

export function collectReplayUserIds(sql: SyncSql, parsedRows: ReplayEventRow[]): string[] {
  const messageReplayTypes = REPLAY_MESSAGE_EVENT_TYPES;
  const managementTypes = REPLAY_MANAGEMENT_EVENT_TYPES;
  const botLifecycleTypes = REPLAY_BOT_LIFECYCLE_EVENT_TYPES;
  const userIdsToResolve: string[] = [];

  for (const r of parsedRows) {
    if (messageReplayTypes.has(r.event_type)) {
      try {
        const p = JSON.parse(r.payload_json) as { message?: { message_id?: string } };
        const messageId = p.message?.message_id;
        if (messageId) {
          userIdsToResolve.push(...extractMessageSenderUserId(sql, messageId));
        }
      } catch {
        // ignore malformed payload
      }
      continue;
    }
    if (botLifecycleTypes.has(r.event_type)) {
      try {
        const p = JSON.parse(r.payload_json) as { actor_user_id?: string };
        if (typeof p.actor_user_id === "string" && p.actor_user_id) {
          userIdsToResolve.push(p.actor_user_id);
        }
      } catch {
        // ignore malformed payload
      }
      continue;
    }
    if (managementTypes.has(r.event_type)) {
      try {
        const p = JSON.parse(r.payload_json) as {
          actor_kind?: string;
          actor_id?: string;
          target_user_id?: string | null;
          user_id?: string;
          inviter_user_id?: string;
        };
        if (p.actor_kind === "user" && typeof p.actor_id === "string" && p.actor_id) userIdsToResolve.push(p.actor_id);
        if (typeof p.target_user_id === "string" && p.target_user_id) userIdsToResolve.push(p.target_user_id);
        if (typeof p.user_id === "string" && p.user_id) userIdsToResolve.push(p.user_id);
        if (typeof p.inviter_user_id === "string" && p.inviter_user_id) userIdsToResolve.push(p.inviter_user_id);
      } catch {
        // ignore malformed payload
      }
    }
  }

  return userIdsToResolve;
}

export function projectParsedEventRows(opts: {
  sql: SyncSql;
  channelId: string;
  parsedRows: ReplayEventRow[];
  liveMap: Map<string, LiveUserSummary>;
  liveSenderMap: Map<string, LiveUserSummary>;
  allowedEventTypes?: ReadonlySet<string>;
}): EventFrame[] {
  const { sql, channelId, parsedRows, liveMap, liveSenderMap, allowedEventTypes } = opts;
  const messageReplayTypes = REPLAY_MESSAGE_EVENT_TYPES;
  const managementTypes = REPLAY_MANAGEMENT_EVENT_TYPES;
  const botLifecycleTypes = REPLAY_BOT_LIFECYCLE_EVENT_TYPES;
  const out: EventFrame[] = [];

  for (const r of parsedRows) {
    if (allowedEventTypes && !allowedEventTypes.has(r.event_type)) {
      continue;
    }

    let persistedPayload: MessagePersistedPayload | ManagementPersistedPayload | unknown = {};
    try {
      persistedPayload = JSON.parse(r.payload_json) as MessagePersistedPayload | ManagementPersistedPayload;
    } catch {
      persistedPayload = {};
    }

    let wirePayload: ChatEventPayloadByType[ChatEventType] | unknown = persistedPayload;

    if (messageReplayTypes.has(r.event_type)) {
      try {
        const projected = projectReplayMessagePayload(sql, r.event_type, persistedPayload, liveSenderMap);
        if (projected === null) {
          continue;
        }
        if (
          (r.event_type === "interaction.completed" || r.event_type === "command.completed") &&
          typeof persistedPayload === "object" &&
          persistedPayload !== null &&
          "command_id" in persistedPayload
        ) {
          wirePayload = {
            ...(projected as Record<string, unknown>),
            command_id: (persistedPayload as { command_id?: string }).command_id,
          };
        } else {
          wirePayload = projected;
        }
      } catch {
        continue;
      }
    } else if (botLifecycleTypes.has(r.event_type)) {
      wirePayload = projectReplayBotLifecyclePayload(sql, r.event_type, persistedPayload, liveMap);
    } else if (managementTypes.has(r.event_type) && r.event_type !== "read_state.updated") {
      wirePayload = resolveActorWithMap(persistedPayload as ManagementPersistedPayload, liveMap);
    }

    if (!isChatEventType(r.event_type)) {
      continue;
    }

    out.push(
      buildEventFrame({
        event_id: r.event_id,
        type: r.event_type,
        channel_id: channelId,
        occurred_at: r.occurred_at,
        payload: wirePayload as ChatEventPayloadByType[typeof r.event_type],
      }),
    );
  }

  return out;
}

export async function buildReplayEventsResponse(opts: {
  sql: SyncSql;
  env: Env;
  userId: string;
  after: string;
}): Promise<Response> {
  const { sql, env, userId, after } = opts;
  const meta = sql.exec("SELECT channel_id, visibility FROM channel_meta LIMIT 1").toArray()[0] as
    | { channel_id: string; visibility: string }
    | undefined;
  if (meta === undefined) return Response.json({ events: [] });

  const member = userId
    ? (sql.exec(
        "SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL",
        meta.channel_id,
        userId,
      ).toArray()[0] as { x: number } | undefined)
    : undefined;
  if (!member && meta.visibility === "private") {
    return new Response("forbidden", { status: 403 });
  }

  const rows = sql
    .exec(
      "SELECT event_id, event_type, payload_json, occurred_at FROM events WHERE channel_id=? AND event_id > ? ORDER BY event_id",
      meta.channel_id,
      after,
    )
    .toArray() as unknown as ReplaySqlEventRow[];
  const parsedRows = parseReplayRows(rows);
  const rawMap = await resolveUserSummaries(Array.from(new Set(collectReplayUserIds(sql, parsedRows))), env);
  const { liveMap, liveSenderMap } = buildLiveUserMaps(rawMap);
  const frames = projectParsedEventRows({
    sql,
    channelId: meta.channel_id,
    parsedRows,
    liveMap,
    liveSenderMap,
  });

  const out: ReplayEnvelope[] = frames.map((frame) => ({
    event_id: frame.event_id,
    event_json: JSON.stringify(frame),
  }));

  return Response.json({ events: out });
}
