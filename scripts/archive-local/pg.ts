import pg from "pg";
import type { ChatEventRow } from "./apply-events.js";

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

export class PgWriter {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async upsertEvents(rows: ChatEventRow[]): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
