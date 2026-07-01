import type { Env } from "../env";
import { TIMELINE_HISTORY_EVENT_TYPES } from "../contract/events";
import { ApiError } from "../errors";
import type { EventFrame } from "../contract/wire-frames";
import { projectTimelineRows, type SyncSql } from "./timeline-history";

export interface MessageContextPage {
  anchor_message_id: string;
  items: EventFrame[];
}

function timelineTypePlaceholders(): { clause: string; types: string[] } {
  const types = Array.from(TIMELINE_HISTORY_EVENT_TYPES);
  return {
    clause: types.map(() => "?").join(", "),
    types,
  };
}

function clampContextCount(value: number): number {
  return Math.max(0, Math.min(50, Math.floor(value)));
}

function resolveAnchorEventId(sql: SyncSql, channelId: string, messageId: string): string {
  const messageRow = sql
    .exec("SELECT status FROM messages WHERE message_id=? AND channel_id=?", messageId, channelId)
    .toArray()[0] as { status: string } | undefined;
  if (messageRow === undefined) {
    throw new ApiError("MESSAGE_NOT_FOUND", "message not found");
  }
  if (messageRow.status === "deleted" || messageRow.status === "recalled") {
    throw new ApiError("MESSAGE_NOT_FOUND", "message not found");
  }

  const eventRow = sql
    .exec(
      "SELECT event_id FROM events WHERE channel_id=? AND event_type='message.created' AND json_extract(payload_json, '$.message.message_id')=? LIMIT 1",
      channelId,
      messageId,
    )
    .toArray()[0] as { event_id: string } | undefined;
  if (eventRow === undefined) {
    throw new ApiError("MESSAGE_NOT_FOUND", "message not found");
  }
  return eventRow.event_id;
}

export async function buildMessageContextPage(opts: {
  sql: SyncSql;
  env: Env;
  userId: string;
  messageId: string;
  beforeCount: number;
  afterCount: number;
}): Promise<MessageContextPage> {
  const { sql, env, userId, messageId } = opts;
  const beforeCount = clampContextCount(opts.beforeCount);
  const afterCount = clampContextCount(opts.afterCount);

  const meta = sql.exec("SELECT channel_id, visibility FROM channel_meta LIMIT 1").toArray()[0] as
    | { channel_id: string; visibility: string }
    | undefined;
  if (meta === undefined) {
    throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
  }

  const member = userId
    ? (sql.exec(
        "SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL",
        meta.channel_id,
        userId,
      ).toArray()[0] as { x: number } | undefined)
    : undefined;
  if (!member && meta.visibility === "private") {
    throw new ApiError("FORBIDDEN", "not a member");
  }

  const anchorEventId = resolveAnchorEventId(sql, meta.channel_id, messageId);
  const { clause, types } = timelineTypePlaceholders();

  const beforeRows = beforeCount > 0
    ? (sql.exec(
        `SELECT event_id, event_type, payload_json, occurred_at FROM events WHERE channel_id=? AND event_type IN (${clause}) AND event_id < ? ORDER BY event_id DESC LIMIT ?`,
        meta.channel_id,
        ...types,
        anchorEventId,
        beforeCount,
      ).toArray() as Array<{ event_id: unknown; event_type: unknown; payload_json: unknown; occurred_at: unknown }>).reverse()
    : [];

  const anchorRows = sql.exec(
    "SELECT event_id, event_type, payload_json, occurred_at FROM events WHERE event_id=?",
    anchorEventId,
  ).toArray() as Array<{ event_id: unknown; event_type: unknown; payload_json: unknown; occurred_at: unknown }>;

  const afterRows = afterCount > 0
    ? (sql.exec(
        `SELECT event_id, event_type, payload_json, occurred_at FROM events WHERE channel_id=? AND event_type IN (${clause}) AND event_id > ? ORDER BY event_id ASC LIMIT ?`,
        meta.channel_id,
        ...types,
        anchorEventId,
        afterCount,
      ).toArray() as Array<{ event_id: unknown; event_type: unknown; payload_json: unknown; occurred_at: unknown }>)
    : [];

  const rows = [...beforeRows, ...anchorRows, ...afterRows];
  const items = await projectTimelineRows({ sql, env, channelId: meta.channel_id, rows });

  return {
    anchor_message_id: messageId,
    items,
  };
}
