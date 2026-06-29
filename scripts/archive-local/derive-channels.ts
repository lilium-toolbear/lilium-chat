#!/usr/bin/env node
/**
 * Derive chat.channels / chat.channel_members from chat.events + chat.messages.
 * Safe to rerun; does not overwrite rows from real archive replay.
 */

import pg from "pg";
import { deriveChannelsAndMembers } from "../../src/archive-consumer/derive-channels.js";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const result = await deriveChannelsAndMembers(client);
  console.log(`derived channels=${result.channels} members=${result.members}`);
} finally {
  await client.end();
}
