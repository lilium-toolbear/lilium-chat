import type { ChatEventRow } from "../archive/apply-events.js";

const UPSERT_EVENT_SQL = `
INSERT INTO chat.events (
  event_id, event_type, channel_id, actor_kind, actor_id, actor_session_id,
  payload, membership_version_at_event, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::timestamptz)
ON CONFLICT (event_id) DO UPDATE SET
  event_type = EXCLUDED.event_type,
  channel_id = EXCLUDED.channel_id,
  actor_kind = EXCLUDED.actor_kind,
  actor_id = EXCLUDED.actor_id,
  actor_session_id = EXCLUDED.actor_session_id,
  payload = EXCLUDED.payload,
  membership_version_at_event = EXCLUDED.membership_version_at_event,
  occurred_at = EXCLUDED.occurred_at
`;

export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function upsertChatEvents(client: PgQueryable, rows: ChatEventRow[]): Promise<void> {
  for (const row of rows) {
    await client.query(UPSERT_EVENT_SQL, [
      row.event_id,
      row.event_type,
      row.channel_id,
      row.actor_kind,
      row.actor_id,
      row.actor_session_id,
      JSON.stringify(row.payload),
      row.membership_version_at_event,
      row.occurred_at,
    ]);
  }
}

export async function pingPg(client: PgQueryable): Promise<void> {
  await client.query("SELECT 1");
}
