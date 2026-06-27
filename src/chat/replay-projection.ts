import { buildEventFrame, type UserSummary as LiveUserSummary } from "./event-broadcast";
import { projectMessageForBrowser, type MessageStickerSnapshot } from "./message-projection";
import { projectAttachmentForBrowser, type AttachmentRow as ChatAttachmentRow } from "./attachment-projection";
import { resolveActorWithMap } from "./channel-events";
import type { Env } from "../env";
import {
  isChatEventType,
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
import { fallbackUserDisplayName } from "../contract/primitives";
import { resolveUserSummaries } from "../profile/resolve";

type SyncSql = {
  exec: (query: string, ...params: unknown[]) => { toArray: () => unknown[] };
};

interface ReplayEventRow {
  event_id: string;
  event_type: string;
  payload_json: string;
  occurred_at: string;
}

interface ReplaySqlEventRow {
  event_id: unknown;
  event_type: unknown;
  payload_json: unknown;
  occurred_at: unknown;
}

export interface ReplayEnvelope {
  event_id: string;
  event_json: string;
}

function parseReplayRows(rows: ReplaySqlEventRow[]): ReplayEventRow[] {
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

function buildLiveUserMaps(rawMap: Map<string, { user_id: string; display_name: string | null; avatar_url: string | null }>): {
  liveMap: Map<string, LiveUserSummary>;
  liveSenderMap: Map<string, LiveUserSummary>;
} {
  const liveSenderMap = new Map<string, LiveUserSummary>();
  const liveMap = new Map<string, LiveUserSummary>();
  for (const [id, summary] of rawMap) {
    const resolved = {
      user_id: summary.user_id,
      display_name: summary.display_name ?? fallbackUserDisplayName(id),
      avatar_url: summary.avatar_url,
    };
    liveMap.set(id, resolved);
    liveSenderMap.set(id, resolved);
  }
  return { liveMap, liveSenderMap };
}

function projectReplayMessagePayload(
  sql: SyncSql,
  eventType: string,
  persistedPayload: MessagePersistedPayload | ManagementPersistedPayload | unknown,
  liveSenderMap: Map<string, LiveUserSummary>,
): ChatEventPayloadByType[ChatEventType] | unknown {
  const messagePersisted = persistedPayload as MessagePersistedPayload;
  const p = messagePersisted.message;
  const messageId = typeof p?.message_id === "string" ? p.message_id : "";
  if (!messageId) {
    return persistedPayload;
  }
  const messageRow = sql
    .exec(
      "SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at FROM messages WHERE message_id=?",
      messageId,
    )
    .toArray()[0] as MessageRow | undefined;
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
  return {
    message: projectMessageForBrowser(messageRow, {
      senderSummary,
      mentions: replayMentions,
      attachments: replayAttachments,
      sticker: replayStickerRow ?? null,
    }),
  };
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
  const messageReplayTypes = REPLAY_MESSAGE_EVENT_TYPES;
  const managementTypes = REPLAY_MANAGEMENT_EVENT_TYPES;

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

  const rawMap = await resolveUserSummaries(Array.from(new Set(userIdsToResolve)), env);
  const { liveMap, liveSenderMap } = buildLiveUserMaps(rawMap);
  const out: ReplayEnvelope[] = [];

  for (const r of parsedRows) {
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
        wirePayload = projected;
      } catch {
        // malformed payload or missing payload message_id
      }
    } else if (managementTypes.has(r.event_type) && r.event_type !== "read_state.updated") {
      wirePayload = resolveActorWithMap(persistedPayload as ManagementPersistedPayload, liveMap);
    }

    const eventJson = isChatEventType(r.event_type)
      ? JSON.stringify(
          buildEventFrame({
            event_id: r.event_id,
            type: r.event_type,
            channel_id: meta.channel_id,
            occurred_at: r.occurred_at,
            payload: wirePayload as ChatEventPayloadByType[typeof r.event_type],
          }),
        )
      : JSON.stringify({
          frame_type: "event",
          api_version: "lilium.chat.v1",
          event_id: r.event_id,
          type: r.event_type,
          channel_id: meta.channel_id,
          occurred_at: r.occurred_at,
          payload: wirePayload,
        });

    out.push({
      event_id: r.event_id,
      event_json: eventJson,
    });
  }

  return Response.json({ events: out });
}
