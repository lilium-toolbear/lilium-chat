import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import {
  applyBaselineSchema,
  columnExists,
  indexExists,
  migrateSqlite,
  tableExists,
} from "../../src/do/sql-migrations";
import {
  CHAT_CHANNEL_CURRENT_SCHEMA_VERSION,
  CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA,
  chatChannelBaseline,
  chatChannelMigrations,
  migrateChatChannelSchema,
} from "../../src/do/migrations/chat-channel";

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
  const res = await stub.fetch(
    new Request("https://x/internal/schema-version", { headers: { "X-Test-Only": "1" } }),
  );
  const body = (await res.json()) as { current_version: number };
  return body.current_version;
}

function expectPhase7Tables(ctx: DurableObjectState): void {
  expect(tableExists(ctx, "channel_command_bindings")).toBe(true);
  expect(tableExists(ctx, "channel_command_names")).toBe(true);
  expect(tableExists(ctx, "command_invocations")).toBe(true);
  expect(tableExists(ctx, "bot_delivery_outbox")).toBe(true);
  expect(tableExists(ctx, "bot_effects_applied")).toBe(true);
  expect(tableExists(ctx, "channel_bot_event_subscriptions")).toBe(true);

  // old shells dropped + repurposed
  expect(tableExists(ctx, "commands")).toBe(false);
  expect(tableExists(ctx, "invocations")).toBe(false);

  // bot message components + actor snapshot
  expect(columnExists(ctx, "messages", "components_json")).toBe(true);
  expect(columnExists(ctx, "messages", "sender_bot_display_name")).toBe(true);
  expect(columnExists(ctx, "messages", "sender_bot_avatar_url")).toBe(true);

  // bot_installations extended
  expect(columnExists(ctx, "bot_installations", "status")).toBe(true);
  expect(columnExists(ctx, "bot_installations", "updated_by")).toBe(true);
  expect(columnExists(ctx, "bot_installations", "updated_at")).toBe(true);
  expect(columnExists(ctx, "bot_installations", "bot_display_name")).toBe(true);
  expect(columnExists(ctx, "bot_installations", "bot_avatar_url")).toBe(true);

  // interactions lifecycle
  expect(columnExists(ctx, "interactions", "updated_at")).toBe(true);
  expect(columnExists(ctx, "interactions", "completed_at")).toBe(true);
  expect(columnExists(ctx, "interactions", "error_code")).toBe(true);

  // indexes
  expect(indexExists(ctx, "idx_bindings_channel_enabled")).toBe(true);
  expect(indexExists(ctx, "idx_invocations_status")).toBe(true);
  expect(indexExists(ctx, "idx_bot_delivery_due")).toBe(true);
  expect(indexExists(ctx, "idx_channel_bot_event_subscriptions_enabled")).toBe(true);
}

describe("ChatChannel v2 migrations (Phase 7)", () => {
  it("fresh install reaches Phase 7 terminal schema", async () => {
    const stub = chatStub(`fresh-v2-${crypto.randomUUID()}`);
    await stub.fetch(new Request("https://x/ping"));

    await withDoState(stub, (ctx) => {
      expectPhase7Tables(ctx);
    });
    expect(await schemaVersion(stub)).toBe(CHAT_CHANNEL_CURRENT_SCHEMA_VERSION);
  });

  it("upgrades legacy v1 baseline (with commands/invocations shells) to Phase 7", async () => {
    const channelId = `legacy-v2-${crypto.randomUUID()}`;
    const stub = chatStub(channelId);

    await withDoState(stub, (ctx) => {
      for (const table of [
        "schema_migrations",
        "commands",
        "invocations",
        "interactions",
        "bot_installations",
        "channel_meta",
      ]) {
        ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      applyBaselineSchema(ctx, CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA);
      // legacy baseline creates commands/invocations shells; confirm pre-migration
      expect(tableExists(ctx, "commands")).toBe(true);
      expect(tableExists(ctx, "invocations")).toBe(true);

      migrateChatChannelSchema(ctx);

      expectPhase7Tables(ctx);
    });
    expect(await schemaVersion(stub)).toBe(CHAT_CHANNEL_CURRENT_SCHEMA_VERSION);
  });

  it("DROP is safe: no runtime path writes the old commands/invocations tables", async () => {
    // grep-proof documented in Task 7a-migration Step 3; this test asserts the
    // post-migration state has no commands/invocations tables on a fresh DO.
    const stub = chatStub(`drop-safe-${crypto.randomUUID()}`);
    await stub.fetch(new Request("https://x/ping"));
    await withDoState(stub, (ctx) => {
      expect(tableExists(ctx, "commands")).toBe(false);
      expect(tableExists(ctx, "invocations")).toBe(false);
    });
  });

  it("migration is idempotent (re-run is noop)", async () => {
    const stub = chatStub(`idempotent-v2-${crypto.randomUUID()}`);
    await stub.fetch(new Request("https://x/ping"));

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

  it("fresh and migrated terminal schemas match (table_info parity)", async () => {
    const freshId = `parity-fresh-${crypto.randomUUID()}`;
    const legacyId = `parity-legacy-${crypto.randomUUID()}`;
    const freshStub = chatStub(freshId);
    const legacyStub = chatStub(legacyId);
    await freshStub.fetch(new Request("https://x/ping"));

    await withDoState(legacyStub, (ctx) => {
      for (const table of ["schema_migrations", "commands", "invocations"]) {
        ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      applyBaselineSchema(ctx, CHAT_CHANNEL_LEGACY_BASELINE_SCHEMA);
      migrateChatChannelSchema(ctx);
    });

    const phase7Tables = [
      "channel_command_bindings",
      "channel_command_names",
      "command_invocations",
      "bot_delivery_outbox",
      "bot_effects_applied",
      "channel_bot_event_subscriptions",
      "messages",
      "bot_installations",
      "interactions",
    ];

    const colsFor = (ctx: DurableObjectState, table: string): string[] =>
      (ctx.storage.sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>)
        .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ""}`)
        .sort();

    const freshCols: Record<string, string[]> = {};
    const legacyCols: Record<string, string[]> = {};
    await withDoState(freshStub, (ctx) => {
      for (const table of phase7Tables) freshCols[table] = colsFor(ctx, table);
    });
    await withDoState(legacyStub, (ctx) => {
      for (const table of phase7Tables) legacyCols[table] = colsFor(ctx, table);
    });

    for (const table of phase7Tables) {
      expect(legacyCols[table]).toEqual(freshCols[table]);
    }
  });
});