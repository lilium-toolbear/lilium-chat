import type { Env } from "../env";
import {
  TIMELINE_HISTORY_EVENT_TYPES,
} from "../contract/events";
import type { EventFrame } from "../contract/wire-frames";
import {
  collectReplayUserIds,
  parseReplayRows,
  projectParsedEventRows,
  type ReplaySqlEventRow,
  type SyncSql,
} from "./replay-projection";
import { resolveUserSummaries } from "../profile/resolve";
import { buildLiveUserMaps } from "./replay-user-maps";

export type { SyncSql };

export interface TimelineHistoryPage {
  items: EventFrame[];
  next_cursor: string | null;
}

function timelineTypePlaceholders(): { clause: string; types: string[] } {
  const types = Array.from(TIMELINE_HISTORY_EVENT_TYPES);
  return {
    clause: types.map(() => "?").join(", "),
    types,
  };
}

async function projectTimelineRows(opts: {
  sql: SyncSql;
  env: Env;
  channelId: string;
  rows: ReplaySqlEventRow[];
}): Promise<EventFrame[]> {
  const parsedRows = parseReplayRows(opts.rows);
  const userIdsToResolve = collectReplayUserIds(opts.sql, parsedRows);
  const rawMap = await resolveUserSummaries(Array.from(new Set(userIdsToResolve)), opts.env);
  const { liveMap, liveSenderMap } = buildLiveUserMaps(rawMap);
  return projectParsedEventRows({
    sql: opts.sql,
    channelId: opts.channelId,
    parsedRows,
    liveMap,
    liveSenderMap,
    allowedEventTypes: TIMELINE_HISTORY_EVENT_TYPES,
  });
}

export async function buildTimelineHistoryPage(opts: {
  sql: SyncSql;
  env: Env;
  userId: string;
  before?: string | null;
  after?: string | null;
  limit: number;
}): Promise<TimelineHistoryPage | { forbidden: true } | { notFound: true }> {
  const { sql, env, userId, limit } = opts;
  const before = opts.before && opts.before !== "" ? opts.before : null;
  const after = opts.after && opts.after !== "" ? opts.after : null;

  const meta = sql.exec("SELECT channel_id, visibility FROM channel_meta LIMIT 1").toArray()[0] as
    | { channel_id: string; visibility: string }
    | undefined;
  if (meta === undefined) return { notFound: true };

  const member = userId
    ? (sql.exec(
        "SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL",
        meta.channel_id,
        userId,
      ).toArray()[0] as { x: number } | undefined)
    : undefined;
  if (!member && meta.visibility === "private") {
    return { forbidden: true };
  }

  const { clause, types } = timelineTypePlaceholders();
  const pageLimit = Math.max(1, Math.min(100, limit));
  const queryLimit = pageLimit + 1;

  let rows: ReplaySqlEventRow[];
  if (after !== null) {
    rows = sql.exec(
      `SELECT event_id, event_type, payload_json, occurred_at FROM events WHERE channel_id=? AND event_type IN (${clause}) AND event_id > ? ORDER BY event_id ASC LIMIT ?`,
      meta.channel_id,
      ...types,
      after,
      queryLimit,
    ).toArray() as unknown as ReplaySqlEventRow[];
    const hasMore = rows.length > pageLimit;
    const slice = hasMore ? rows.slice(0, pageLimit) : rows;
    const items = await projectTimelineRows({ sql, env, channelId: meta.channel_id, rows: slice });
    const next_cursor = hasMore && slice.length > 0 ? slice[slice.length - 1]!.event_id as string : null;
    return { items, next_cursor };
  }

  rows = before === null
    ? sql.exec(
        `SELECT event_id, event_type, payload_json, occurred_at FROM events WHERE channel_id=? AND event_type IN (${clause}) ORDER BY event_id DESC LIMIT ?`,
        meta.channel_id,
        ...types,
        queryLimit,
      ).toArray() as unknown as ReplaySqlEventRow[]
    : sql.exec(
        `SELECT event_id, event_type, payload_json, occurred_at FROM events WHERE channel_id=? AND event_type IN (${clause}) AND event_id < ? ORDER BY event_id DESC LIMIT ?`,
        meta.channel_id,
        ...types,
        before,
        queryLimit,
      ).toArray() as unknown as ReplaySqlEventRow[];

  const hasMore = rows.length > pageLimit;
  const slice = (hasMore ? rows.slice(0, pageLimit) : rows).reverse();
  const items = await projectTimelineRows({ sql, env, channelId: meta.channel_id, rows: slice });
  const next_cursor = hasMore && slice.length > 0 ? String(slice[0]!.event_id ?? "") : null;
  return { items, next_cursor: next_cursor || null };
}

export async function buildTimelineHistoryResponse(opts: {
  sql: SyncSql;
  env: Env;
  userId: string;
  before?: string | null;
  after?: string | null;
  limit: number;
}): Promise<Response> {
  const result = await buildTimelineHistoryPage(opts);
  if ("forbidden" in result) return new Response("forbidden", { status: 403 });
  if ("notFound" in result) return new Response("channel not created", { status: 409 });
  return Response.json({ items: result.items, next_cursor: result.next_cursor });
}
