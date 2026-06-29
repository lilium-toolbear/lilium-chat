/**
 * Shared PG bootstrap for archive migrations/backfill when legacy raw
 * chat.events (id, payload) coexists with structured schema.
 */

export async function tableExists(client, tableName) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'chat' AND table_name = $1 LIMIT 1`,
    [tableName],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function detectEventsSchema(client) {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'chat' AND table_name = 'events'`,
  );
  if ((res.rowCount ?? 0) === 0) return "missing";
  const cols = new Set(res.rows.map((r) => String(r.column_name)));
  if (cols.has("payload") && cols.has("id") && !cols.has("event_id")) return "raw";
  if (cols.has("event_id")) return "structured";
  return "unknown";
}

/**
 * Rename legacy raw chat.events → chat.events_raw so structured migrations can run.
 * No-op when structured events already exists or events_raw already present.
 */
export async function ensureRawEventsRenamed(client) {
  const hasEventsRaw = await tableExists(client, "events_raw");
  if (hasEventsRaw) {
    console.log("chat.events_raw already exists — skip rename");
    return;
  }

  const schema = await detectEventsSchema(client);
  if (schema === "raw") {
    console.log("renaming legacy chat.events → chat.events_raw");
    await client.query("ALTER TABLE chat.events RENAME TO events_raw");
    return;
  }
  if (schema === "missing") {
    return;
  }
  if (schema === "structured") {
    return;
  }
  throw new Error("chat.events has unknown schema; resolve manually before migrate");
}
