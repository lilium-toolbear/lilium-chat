import type { ArchiveChange, ArchiveRecord } from "../../src/archive/payload.js";
import { validateArchiveRecord } from "../../src/archive/payload.js";

export interface ChatEventRow {
  event_id: string;
  event_type: string;
  channel_id: string;
  actor_kind: string | null;
  actor_id: string | null;
  actor_session_id: string | null;
  payload: unknown;
  membership_version_at_event: number;
  occurred_at: string;
}

export function parseArchiveBody(body: unknown): ArchiveRecord {
  const raw = typeof body === "string" ? JSON.parse(body) : body;
  const validation = validateArchiveRecord(raw);
  if (!validation.ok) {
    throw new Error(`invalid archive record: ${validation.error}`);
  }
  return raw as ArchiveRecord;
}

export function chatEventRowsFromRecord(record: ArchiveRecord): ChatEventRow[] {
  const rows: ChatEventRow[] = [];
  for (const change of record.changes) {
  const row = chatEventRowFromChange(change);
    if (row) rows.push(row);
  }
  return rows;
}

function chatEventRowFromChange(change: ArchiveChange): ChatEventRow | null {
  if (change.op !== "upsert" || change.table !== "chat_events") return null;
  const after = change.after;
  const eventId = after.event_id;
  const eventType = after.event_type;
  const channelId = after.channel_id;
  const occurredAt = after.occurred_at;
  if (typeof eventId !== "string" || typeof eventType !== "string" || typeof channelId !== "string") {
    throw new Error("chat_events upsert missing event_id, event_type, or channel_id");
  }
  if (typeof occurredAt !== "string") {
    throw new Error("chat_events upsert missing occurred_at");
  }

  let payload: unknown = after.payload_json ?? after.payload;
  if (typeof payload === "string") {
    payload = JSON.parse(payload);
  }
  if (payload === undefined || payload === null) {
    throw new Error(`chat_events upsert missing payload for event_id=${eventId}`);
  }

  return {
    event_id: eventId,
    event_type: eventType,
    channel_id: channelId,
    actor_kind: typeof after.actor_kind === "string" ? after.actor_kind : null,
    actor_id: typeof after.actor_id === "string" ? after.actor_id : null,
    actor_session_id: typeof after.actor_session_id === "string" ? after.actor_session_id : null,
    payload,
    membership_version_at_event:
      typeof after.membership_version_at_event === "number"
        ? after.membership_version_at_event
        : Number(after.membership_version_at_event ?? 0),
    occurred_at: occurredAt,
  };
}
