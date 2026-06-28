#!/usr/bin/env node
/**
 * Minimal archive daemon: HTTP-pull Cloudflare Queue → INSERT raw message body
 * into chat.events (schema chat, table events).
 *
 * Required env:
 *   CF_ACCOUNT_ID, CF_QUEUE_ID, CF_QUEUES_TOKEN, DATABASE_URL
 *
 * Optional:
 *   QUEUE_PULL_BATCH_SIZE (default 100)
 *   QUEUE_VISIBILITY_TIMEOUT_MS (default 600000) → pull body visibility_timeout
 *   POLL_INTERVAL_MS (default 1000)
 */

import pg from "pg";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const { Pool } = pg;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const CF_ACCOUNT_ID = requireEnv("CF_ACCOUNT_ID");
const CF_QUEUE_ID = requireEnv("CF_QUEUE_ID");
const CF_QUEUES_TOKEN = requireEnv("CF_QUEUES_TOKEN");
const DATABASE_URL = requireEnv("DATABASE_URL");

const BATCH_SIZE = Number(process.env.QUEUE_PULL_BATCH_SIZE ?? 100);
const VISIBILITY_TIMEOUT_MS = Number(process.env.QUEUE_VISIBILITY_TIMEOUT_MS ?? 600_000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 1000);

const QUEUE_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/queues/${CF_QUEUE_ID}`;

const pool = new Pool({ connectionString: DATABASE_URL });

async function pgHealthy() {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    return true;
  } finally {
    client.release();
  }
}

function parseMessageBody(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }
  return { _raw: String(raw) };
}

async function cfQueue(path, body) {
  const res = await fetch(`${QUEUE_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CF_QUEUES_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.errors?.[0]?.message ?? res.statusText;
    throw new Error(`queue ${path} failed: ${res.status} ${msg}`);
  }
  return json;
}

async function pullMessages() {
  const json = await cfQueue("/messages/pull", {
    visibility_timeout: VISIBILITY_TIMEOUT_MS,
    batch_size: BATCH_SIZE,
  });
  return json?.result?.messages ?? [];
}

async function ackMessages(acks, retries = []) {
  if (acks.length === 0 && retries.length === 0) return;
  await cfQueue("/messages/ack", { acks, retries });
}

async function insertRawPayload(client, payload) {
  await client.query("INSERT INTO chat.events (payload) VALUES ($1::jsonb)", [JSON.stringify(payload)]);
}

async function processBatch(messages) {
  if (messages.length === 0) return;

  const client = await pool.connect();
  const acks = [];
  const retries = [];

  try {
    await client.query("BEGIN");
    for (const msg of messages) {
      const leaseId = msg.lease_id;
      if (!leaseId) continue;
      try {
        const payload = parseMessageBody(msg.body);
        if (payload === null) {
          acks.push({ lease_id: leaseId });
          continue;
        }
        await insertRawPayload(client, payload);
        acks.push({ lease_id: leaseId });
      } catch (err) {
        console.error("insert failed", { lease_id: leaseId, err: String(err) });
        retries.push({ lease_id: leaseId, delay_seconds: 60 });
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await ackMessages(acks, retries);
  if (acks.length > 0) {
    console.log(`stored ${acks.length} raw message(s) into chat.events`);
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("archive daemon: queue raw → chat.events");
  while (true) {
    try {
      if (!(await pgHealthy())) {
        console.warn("pg unhealthy, skipping pull");
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const messages = await pullMessages();
      await processBatch(messages);
    } catch (err) {
      console.error("daemon loop error:", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
