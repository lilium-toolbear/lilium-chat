#!/usr/bin/env node
/**
 * Drain unapplied chat_archive_records into normalized PG tables (spec §8.8).
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run archive:replay
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import pg from "pg";
import { drainAllPendingSources } from "../../src/archive-consumer/drain.js";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const maxPerSource = Number(process.env.MAX_DRAIN_RECORDS_PER_SOURCE ?? 1000);
const here = dirname(fileURLToPath(import.meta.url));
const infraSql = readFileSync(join(here, "migrations", "005_archive_infra.sql"), "utf8");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(infraSql);
  const drained = await drainAllPendingSources(client, maxPerSource);
  console.log(`archive:replay drained ${drained} record(s)`);
} finally {
  await client.end();
}
