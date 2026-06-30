import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, readDoSchemaVersion } from "../helpers";
import {
  applyBaselineSchema,
  columnExists,
  indexExists,
  migrateSqlite,
  quoteIdent,
  tableExists,
} from "../../src/do/shared/sql-migrations";
import {
  CHAT_CHANNEL_CURRENT_SCHEMA_VERSION,
  CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA,
  chatChannelBaseline,
  chatChannelMigrations,
  migrateChatChannelSchema,
} from "../../src/do/chat-channel/data/migrations";

function chatStub(channelId: string) {
  return getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace, channelId);
}

async function withDoState(
  stub: DurableObjectStub,
  fn: (ctx: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    await fn(ctx);
  });
}

async function schemaVersion(stub: DurableObjectStub): Promise<number> {
  return (await readDoSchemaVersion(stub)).current_version;
}

function expectPhase7Tables(ctx: DurableObjectState): void {
  expect(tableExists(ctx, "channel_command_bindings")).toBe(true);
  expect(columnExists(ctx, "channel_command_bindings", "command_snapshot_json")).toBe(true);
  expect(columnExists(ctx, "channel_command_bindings", "status")).toBe(true);
  expect(columnExists(ctx, "channel_command_bindings", "stateful_max_ttl_seconds")).toBe(true);
  expect(indexExists(ctx, "idx_bindings_channel_enabled")).toBe(true);

  expect(tableExists(ctx, "stateful_command_sessions")).toBe(true);
  expect(tableExists(ctx, "stateful_session_inputs")).toBe(true);
  expect(indexExists(ctx, "uniq_active_stateful_session_per_channel")).toBe(true);

  expect(tableExists(ctx, "command_invocations")).toBe(true);
  expect(tableExists(ctx, "bot_delivery_outbox")).toBe(true);
  expect(tableExists(ctx, "bot_effects_applied")).toBe(true);
  expect(columnExists(ctx, "channel_meta", "command_manifest_version")).toBe(true);

  // Removed from greenfield baseline.
  expect(tableExists(ctx, "bot_installations")).toBe(false);
  expect(tableExists(ctx, "channel_command_names")).toBe(false);
  expect(tableExists(ctx, "channel_bot_event_subscriptions")).toBe(false);
  expect(tableExists(ctx, "commands")).toBe(false);
  expect(tableExists(ctx, "invocations")).toBe(false);
}

function stampSchemaVersion(ctx: DurableObjectState, version: number, name = "legacy"): void {
  ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  ctx.storage.sql.exec(
    "INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    version,
    name,
    new Date().toISOString(),
  );
}

describe("ChatChannel v2 migrations (Task 7 baseline reset)", () => {
  it("fresh install uses reset baseline schema", async () => {
    const stub = chatStub(`fresh-v2-${crypto.randomUUID()}`);
    await schemaVersion(stub);

    await withDoState(stub, (ctx) => {
      expectPhase7Tables(ctx);
    });
    expect(await schemaVersion(stub)).toBe(CHAT_CHANNEL_CURRENT_SCHEMA_VERSION);
  });

  it("defensively upgrades existing legacy test schema to required columns/tables", async () => {
    const channelId = `legacy-v2-${crypto.randomUUID()}`;
    const stub = chatStub(channelId);

    await withDoState(stub, (ctx) => {
      for (const table of [
        "schema_migrations",
        "channel_meta",
        "channel_command_bindings",
        "stateful_command_sessions",
        "stateful_session_inputs",
      ]) {
        ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
      }
      applyBaselineSchema(ctx, CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA);
      // simulate old Phase 7-style binding schema used in older tests
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_command_bindings (
        binding_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_command_id TEXT NOT NULL
      )`);
      stampSchemaVersion(ctx, 2026062803, "legacy-phase7");

      expect(tableExists(ctx, "commands")).toBe(true);
      expect(tableExists(ctx, "invocations")).toBe(true);
      expect(columnExists(ctx, "channel_meta", "command_manifest_version")).toBe(false);
      expect(columnExists(ctx, "channel_command_bindings", "command_snapshot_json")).toBe(false);
      expect(tableExists(ctx, "stateful_command_sessions")).toBe(false);

      migrateChatChannelSchema(ctx);

      expect(tableExists(ctx, "commands")).toBe(false);
      expect(tableExists(ctx, "invocations")).toBe(false);
      expect(columnExists(ctx, "channel_meta", "command_manifest_version")).toBe(true);
      expect(columnExists(ctx, "channel_command_bindings", "command_snapshot_json")).toBe(true);
      expect(columnExists(ctx, "channel_command_bindings", "status")).toBe(true);
      expect(columnExists(ctx, "channel_command_bindings", "stateful_max_ttl_seconds")).toBe(true);
      expect(tableExists(ctx, "stateful_command_sessions")).toBe(true);
      expect(tableExists(ctx, "stateful_session_inputs")).toBe(true);
    });
    expect(await schemaVersion(stub)).toBe(CHAT_CHANNEL_CURRENT_SCHEMA_VERSION);
  });

  it("migration is idempotent (re-run is noop)", async () => {
    const stub = chatStub(`idempotent-v2-${crypto.randomUUID()}`);
    await schemaVersion(stub);

    let extraRuns = 0;
    const extra = {
      version: CHAT_CHANNEL_CURRENT_SCHEMA_VERSION + 1,
      name: "count runs",
      up() {
        extraRuns += 1;
      },
    };

    await withDoState(stub, (ctx) => {
      migrateSqlite(ctx, "ChatChannel", chatChannelBaseline, [...chatChannelMigrations, extra]);
      migrateSqlite(ctx, "ChatChannel", chatChannelBaseline, [...chatChannelMigrations, extra]);
    });
    expect(extraRuns).toBe(1);
  });

  it("baseline and defensive migration both satisfy Task 7 assertions", async () => {
    const freshStub = chatStub(`assertions-fresh-${crypto.randomUUID()}`);
    const legacyStub = chatStub(`assertions-legacy-${crypto.randomUUID()}`);
    await schemaVersion(freshStub);

    await withDoState(legacyStub, (ctx) => {
      applyBaselineSchema(ctx, CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA);
      stampSchemaVersion(ctx, 2026062803, "legacy-phase7");
      migrateChatChannelSchema(ctx);
    });

    await withDoState(freshStub, (ctx) => expectPhase7Tables(ctx));
    await withDoState(legacyStub, (ctx) => {
      expect(tableExists(ctx, "channel_command_bindings")).toBe(true);
      expect(columnExists(ctx, "channel_meta", "command_manifest_version")).toBe(true);
      expect(tableExists(ctx, "stateful_command_sessions")).toBe(true);
      expect(tableExists(ctx, "stateful_session_inputs")).toBe(true);
    });
  });
});
