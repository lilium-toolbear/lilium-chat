#!/usr/bin/env node
/**
 * Backfill normalized archive tables from legacy raw rows
 * (chat.events with { id, payload } storing full ArchiveRecord JSON).
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run archive:backfill
 *
 * Optional env:
 *   BACKFILL_BATCH_SIZE=100
 *   BACKFILL_DRY_RUN=1
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { parseArchiveBody } from "../../src/archive/apply-events.js";
import { ARCHIVE_FORMAT } from "../../src/archive/payload.js";
import { applyArchiveRecord } from "../../src/archive-consumer/replay.js";
import { ensureRawEventsRenamed, tableExists } from "./schema-bootstrap.mjs";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const { Client } = pg;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "migrations");

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

const DATABASE_URL = requireEnv("DATABASE_URL");
const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE ?? 100);
const DRY_RUN = process.env.BACKFILL_DRY_RUN === "1";

type EventsSchema = "raw" | "structured" | "missing" | "unknown";

interface RawRow {
  id: string;
  payload: unknown;
}

async function detectEventsSchema(client: pg.Client): Promise<EventsSchema> {
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

async function rawSourceTable(client: pg.Client): Promise<string | null> {
  if (await tableExists(client, "events_raw")) return "chat.events_raw";
  if ((await detectEventsSchema(client)) === "raw") return "chat.events";
  return null;
}

async function applyMigrationFiles(client: pg.Client, files: string[]): Promise<void> {
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await client.query(sql);
    console.log(`applied ${file}`);
  }
}

async function ensureBackfillStateTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS chat.archive_backfill_applied (
      raw_id      BIGINT PRIMARY KEY,
      archive_id  TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function ensureNormalizedSchema(client: pg.Client): Promise<string | null> {
  if (!DRY_RUN) {
    await ensureRawEventsRenamed(client);
    await applyMigrationFiles(client, ["001_chat_events.sql", "002_message_tables.sql"]);
  }
  await ensureBackfillStateTable(client);

  return rawSourceTable(client);
}

async function fetchPendingRawRows(client: pg.Client, sourceTable: string, limit: number): Promise<RawRow[]> {
  const res = await client.query(
    `SELECT r.id::text AS id, r.payload
     FROM ${sourceTable} r
     LEFT JOIN chat.archive_backfill_applied a ON a.raw_id = r.id
     WHERE a.raw_id IS NULL
       AND r.payload->>'format' = $1
     ORDER BY r.payload->>'source_kind',
              r.payload->>'source_key',
              (r.payload->>'source_seq')::bigint,
              r.id
     LIMIT $2`,
    [ARCHIVE_FORMAT, limit],
  );
  return res.rows.map((row) => ({
    id: String(row.id),
    payload: row.payload,
  }));
}

async function markApplied(client: pg.Client, rawId: string, archiveId: string): Promise<void> {
  await client.query(
    `INSERT INTO chat.archive_backfill_applied (raw_id, archive_id)
     VALUES ($1::bigint, $2)
     ON CONFLICT (raw_id) DO NOTHING`,
    [rawId, archiveId],
  );
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const sourceTable = await ensureNormalizedSchema(client);
    if (!sourceTable) {
      console.log("no raw archive table — nothing to backfill");
      return;
    }

    if (DRY_RUN) {
      console.log(`dry run: reading from ${sourceTable}`);
    } else {
      console.log(`backfill source: ${sourceTable}`);
    }

    let totalApplied = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    while (true) {
      const batch = await fetchPendingRawRows(client, sourceTable, BATCH_SIZE);
      if (batch.length === 0) break;

      for (const row of batch) {
        try {
          const record = parseArchiveBody(row.payload);
          if (DRY_RUN) {
            console.log(`[dry-run] would replay ${record.archive_id} (raw_id=${row.id})`);
            totalApplied += 1;
            continue;
          }

          await client.query("BEGIN");
          try {
            const applied = await applyArchiveRecord(client, record);
            await markApplied(client, row.id, record.archive_id);
            await client.query("COMMIT");
            if (applied === 0) {
              totalSkipped += 1;
            } else {
              totalApplied += 1;
            }
            console.log(`replayed ${record.archive_id} (raw_id=${row.id}, changes=${applied})`);
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          }
        } catch (err) {
          totalFailed += 1;
          console.error(`failed raw_id=${row.id}:`, err);
        }
      }
    }

    console.log(
      `backfill complete: applied=${totalApplied} skipped=${totalSkipped} failed=${totalFailed} dry_run=${DRY_RUN}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
