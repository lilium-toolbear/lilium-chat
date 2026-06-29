#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { loadEnv } from "./load-env.mjs";
import { ensureRawEventsRenamed } from "./schema-bootstrap.mjs";

loadEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const migrations = ["001_chat_events.sql", "002_message_tables.sql"];

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query("CREATE SCHEMA IF NOT EXISTS chat");
  await ensureRawEventsRenamed(client);

  for (const file of migrations) {
    const sql = readFileSync(join(here, "migrations", file), "utf8");
    await client.query(sql);
    console.log(`applied scripts/archive-local/migrations/${file}`);
  }
} finally {
  await client.end();
}
