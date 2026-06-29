#!/usr/bin/env node
/**
 * Backfill ALL legacy ArchiveRecord rows into normalized PG tables.
 *
 * Phase 1 — ingest: read every row from chat.events_raw / legacy chat.events,
 *           validate, INSERT into chat_archive_records (idempotent).
 * Phase 2 — replay: drain every pending raw log row via watermark-ordered replay
 *           (same path as queue consumer; all whitelisted tables in changes[]).
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run archive:backfill
 *
 * Optional env:
 *   BACKFILL_BATCH_SIZE=100
 *   BACKFILL_DRY_RUN=1
 *   MAX_DRAIN_RECORDS_PER_SOURCE=1000
 *   BACKFILL_RESET=ingest|replay|full
 *     ingest — re-read legacy events_raw (clears archive_backfill_applied)
 *     replay — re-drain chat_archive_records (clears applied_at + watermarks)
 *     full   — both
 *   BACKFILL_SKIP_INGEST=1 — only run phase 2 (replay pending raw log)
 *   BACKFILL_SKIP_DRAIN=1  — only run phase 1 (persist raw log)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { parseArchiveBody } from "../../src/archive/apply-events.js";
import type { ArchiveRecord } from "../../src/archive/payload.js";
import { ARCHIVE_FORMAT } from "../../src/archive/payload.js";
import { drainAllPendingSources } from "../../src/archive-consumer/drain.js";
import { insertArchiveRecordIfAbsent } from "../../src/archive-consumer/raw-log.js";
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
const MAX_DRAIN_PER_SOURCE = Number(process.env.MAX_DRAIN_RECORDS_PER_SOURCE ?? 1000);
const BACKFILL_RESET = process.env.BACKFILL_RESET?.trim() as "ingest" | "replay" | "full" | undefined;
const SKIP_INGEST = process.env.BACKFILL_SKIP_INGEST === "1";
const SKIP_DRAIN = process.env.BACKFILL_SKIP_DRAIN === "1";

type EventsSchema = "raw" | "structured" | "missing" | "unknown";

interface RawRow {
  id: string;
  payload: unknown;
}

interface IngestStats {
  persisted: number;
  skippedInvalid: number;
  failed: number;
  tables: Map<string, number>;
  sourceKinds: Map<string, number>;
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

async function ensureNormalizedSchema(client: pg.Client): Promise<void> {
  if (DRY_RUN) return;
  await ensureRawEventsRenamed(client);
  await applyMigrationFiles(client, [
    "001_chat_events.sql",
    "002_message_tables.sql",
    "003_channel_tables.sql",
    "004_remaining_tables.sql",
    "005_archive_infra.sql",
    "006_slash_catalog_archive.sql",
  ]);
}

async function resetBackfillState(client: pg.Client, mode: "ingest" | "replay" | "full"): Promise<void> {
  if (mode === "ingest" || mode === "full") {
    const res = await client.query("DELETE FROM chat.archive_backfill_applied");
    console.log(`reset: cleared ${res.rowCount ?? 0} archive_backfill_applied row(s)`);
  }
  if (mode === "replay" || mode === "full") {
    const records = await client.query(
      `UPDATE chat_archive_records
       SET applied_at = NULL, apply_error = NULL
       WHERE applied_at IS NOT NULL OR apply_error IS NOT NULL`,
    );
    const watermarks = await client.query(
      `UPDATE chat_archive_source_watermarks
       SET last_applied_seq = 0, updated_at = now()`,
    );
    console.log(
      `reset: cleared replay on ${records.rowCount ?? 0} archive record(s), ` +
        `${watermarks.rowCount ?? 0} watermark(s)`,
    );
  }
}

function trackRecordStats(record: ArchiveRecord, stats: IngestStats): void {
  stats.sourceKinds.set(record.source_kind, (stats.sourceKinds.get(record.source_kind) ?? 0) + 1);
  for (const change of record.changes) {
    stats.tables.set(change.table, (stats.tables.get(change.table) ?? 0) + 1);
  }
}

function printIngestStats(stats: IngestStats): void {
  if (stats.sourceKinds.size > 0) {
    const kinds = [...stats.sourceKinds.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    console.log(`ingest by source_kind: ${kinds}`);
  }
  if (stats.tables.size > 0) {
    const tables = [...stats.tables.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([t, n]) => `${t}=${n}`)
      .join(", ");
    console.log(`ingest change tables: ${tables}`);
  }
}

async function countLegacyRows(client: pg.Client, sourceTable: string): Promise<number> {
  const res = await client.query(
    `SELECT COUNT(*)::bigint AS n FROM ${sourceTable} WHERE payload->>'format' = $1`,
    [ARCHIVE_FORMAT],
  );
  return Number(res.rows[0]?.n ?? 0);
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

async function markLegacyRowApplied(client: pg.Client, rawId: string, archiveId: string): Promise<void> {
  await client.query(
    `INSERT INTO chat.archive_backfill_applied (raw_id, archive_id)
     VALUES ($1::bigint, $2)
     ON CONFLICT (raw_id) DO NOTHING`,
    [rawId, archiveId],
  );
}

async function persistLegacyRow(client: pg.Client, rawId: string, record: ArchiveRecord): Promise<void> {
  await client.query("BEGIN");
  try {
    await insertArchiveRecordIfAbsent(client, record);
    await markLegacyRowApplied(client, rawId, record.archive_id);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function ingestAllLegacyRows(client: pg.Client, sourceTable: string): Promise<IngestStats> {
  const stats: IngestStats = {
    persisted: 0,
    skippedInvalid: 0,
    failed: 0,
    tables: new Map(),
    sourceKinds: new Map(),
  };

  const total = await countLegacyRows(client, sourceTable);
  console.log(`phase 1 ingest: ${total} legacy ArchiveRecord row(s) in ${sourceTable}`);

  while (true) {
    const batch = await fetchPendingRawRows(client, sourceTable, BATCH_SIZE);
    if (batch.length === 0) break;

    for (const row of batch) {
      try {
        const record = parseArchiveBody(row.payload);
        trackRecordStats(record, stats);
        if (DRY_RUN) {
          console.log(
            `[dry-run] would persist ${record.archive_id} ` +
              `(raw_id=${row.id}, changes=${record.changes.length})`,
          );
          stats.persisted += 1;
          continue;
        }
        await persistLegacyRow(client, row.id, record);
        stats.persisted += 1;
      } catch (err) {
        if (String(err).includes("invalid archive record")) {
          stats.skippedInvalid += 1;
          console.warn(`skip invalid raw_id=${row.id}:`, err);
          if (!DRY_RUN) {
            await markLegacyRowApplied(client, row.id, `invalid:${row.id}`);
          }
          continue;
        }
        stats.failed += 1;
        console.error(`failed raw_id=${row.id}:`, err);
      }
    }
  }

  return stats;
}

async function drainUntilCaughtUp(client: pg.Client): Promise<number> {
  let total = 0;
  while (true) {
    const pending = await client.query(
      `SELECT COUNT(*)::bigint AS n FROM chat_archive_records WHERE applied_at IS NULL`,
    );
    const pendingCount = Number(pending.rows[0]?.n ?? 0);
    if (pendingCount === 0) break;

    const drained = await drainAllPendingSources(client, MAX_DRAIN_PER_SOURCE);
    if (drained === 0) {
      await reportReplayGaps(client);
      break;
    }
    total += drained;
    console.log(`phase 2 replay: drained ${drained} record(s), total=${total}, pending≈${pendingCount - drained}`);
  }
  return total;
}

async function reportReplayGaps(client: pg.Client): Promise<void> {
  const gaps = await client.query(
    `SELECT source_kind, source_key, MIN(source_seq) AS next_seq, COUNT(*)::bigint AS pending
     FROM chat_archive_records
     WHERE applied_at IS NULL
     GROUP BY source_kind, source_key
     ORDER BY source_kind, source_key`,
  );
  if ((gaps.rowCount ?? 0) === 0) return;

  console.warn("replay stalled — pending records (likely missing earlier source_seq):");
  for (const row of gaps.rows) {
    const wm = await client.query(
      `SELECT last_applied_seq FROM chat_archive_source_watermarks
       WHERE source_kind = $1 AND source_key = $2`,
      [row.source_kind, row.source_key],
    );
    const last = wm.rows[0]?.last_applied_seq ?? 0;
    console.warn(
      `  ${row.source_kind}:${row.source_key} watermark=${last} next_pending_seq=${row.next_seq} count=${row.pending}`,
    );
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await ensureBackfillStateTable(client);
    await ensureNormalizedSchema(client);

    if (BACKFILL_RESET === "ingest" || BACKFILL_RESET === "replay" || BACKFILL_RESET === "full") {
      if (DRY_RUN) {
        console.log(`[dry-run] would reset backfill state: ${BACKFILL_RESET}`);
      } else {
        await resetBackfillState(client, BACKFILL_RESET);
      }
    }

    let ingestStats: IngestStats | null = null;
    if (!SKIP_INGEST) {
      const sourceTable = await rawSourceTable(client);
      if (!sourceTable) {
        console.log("phase 1 ingest: no legacy raw table — skip");
      } else {
        if (!DRY_RUN) console.log(`phase 1 ingest source: ${sourceTable}`);
        ingestStats = await ingestAllLegacyRows(client, sourceTable);
        printIngestStats(ingestStats);
        console.log(
          `phase 1 ingest done: persisted=${ingestStats.persisted} ` +
            `invalid=${ingestStats.skippedInvalid} failed=${ingestStats.failed}`,
        );
      }
    }

    let drained = 0;
    if (!SKIP_DRAIN && !DRY_RUN) {
      console.log("phase 2 replay: draining all pending chat_archive_records");
      drained = await drainUntilCaughtUp(client);
      console.log(`phase 2 replay done: drained=${drained}`);
      await reportReplayGaps(client);
    }

    const rawLog = await client.query(`SELECT COUNT(*)::bigint AS n FROM chat_archive_records`);
    const pending = await client.query(
      `SELECT COUNT(*)::bigint AS n FROM chat_archive_records WHERE applied_at IS NULL`,
    );
    console.log(
      `backfill complete: raw_log=${rawLog.rows[0]?.n ?? 0} ` +
        `pending_replay=${pending.rows[0]?.n ?? 0} ` +
        `ingested=${ingestStats?.persisted ?? 0} drained=${drained} dry_run=${DRY_RUN}`,
    );
    if (Number(pending.rows[0]?.n ?? 0) > 0) {
      console.log("hint: fix source_seq gaps or replay errors, then: npm run archive:replay");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
