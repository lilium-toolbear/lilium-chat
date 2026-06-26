import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import {
  applyBaselineSchema,
  indexExists,
  migrateSqlite,
  tableExists,
} from "../../src/do/sql-migrations";
import {
  BOT_REGISTRY_BASELINE_SCHEMA,
  BOT_REGISTRY_CURRENT_SCHEMA_VERSION,
  botRegistryBaseline,
  botRegistryMigrations,
  migrateBotRegistrySchema,
} from "../../src/do/migrations/bot-registry";

function registryStub() {
  return getNamedDo(env.BOT_REGISTRY as unknown as DurableObjectNamespace, "registry");
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

function expectPhase7Catalog(ctx: DurableObjectState): void {
  expect(tableExists(ctx, "bot_commands")).toBe(true);
  expect(tableExists(ctx, "bot_command_aliases")).toBe(true);
  expect(tableExists(ctx, "bot_event_capabilities")).toBe(true);
  expect(tableExists(ctx, "bot_idempotency_keys")).toBe(true);
  expect(indexExists(ctx, "idx_bot_commands_bot")).toBe(true);
  // token_hash must be unique so singleton SELECT ... WHERE token_hash=? is
  // unambiguous (plaintext -> hash cannot reverse-resolve bot_id).
  expect(indexExists(ctx, "idx_bot_tokens_hash")).toBe(true);
}

describe("BotRegistry v2 migrations (Phase 7)", () => {
  it("fresh install reaches Phase 7 catalog schema", async () => {
    const stub = registryStub();
    await stub.fetch(new Request("https://x/ping"));
    await withDoState(stub, (ctx) => {
      expectPhase7Catalog(ctx);
    });
    expect(await schemaVersion(stub)).toBe(BOT_REGISTRY_CURRENT_SCHEMA_VERSION);
  });

  it("upgrades legacy v1 baseline (bot_apps/bot_tokens only) to Phase 7 catalog", async () => {
    const stub = registryStub();

    await withDoState(stub, (ctx) => {
      for (const table of [
        "schema_migrations",
        "bot_commands",
        "bot_command_aliases",
        "bot_event_capabilities",
        "bot_idempotency_keys",
      ]) {
        ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      // legacy baseline = original 2-table registry (bot_apps/bot_tokens + idx_bot_tokens_bot)
      applyBaselineSchema(ctx, BOT_REGISTRY_BASELINE_SCHEMA);
      expect(tableExists(ctx, "bot_commands")).toBe(false);

      migrateBotRegistrySchema(ctx);
      expectPhase7Catalog(ctx);
    });
    expect(await schemaVersion(stub)).toBe(BOT_REGISTRY_CURRENT_SCHEMA_VERSION);
  });

  it("migration is idempotent (re-run is noop)", async () => {
    const stub = registryStub();
    await stub.fetch(new Request("https://x/ping"));

    let extraRuns = 0;
    const extra = {
      version: 99,
      name: "count runs",
      up() {
        extraRuns += 1;
      },
    };

    await withDoState(stub, (ctx) => {
      migrateSqlite(ctx, "BotRegistry", botRegistryBaseline, [
        ...botRegistryMigrations,
        extra,
      ]);
      migrateSqlite(ctx, "BotRegistry", botRegistryBaseline, [
        ...botRegistryMigrations,
        extra,
      ]);
    });
    expect(extraRuns).toBe(1);
  });

  it("idx_bot_tokens_hash is unique", async () => {
    const stub = registryStub();
    await stub.fetch(new Request("https://x/ping"));
    await withDoState(stub, (ctx) => {
      const rows = ctx.storage.sql
        .exec("PRAGMA index_list(bot_tokens)")
        .toArray() as Array<{ name: string; unique: number }>;
      const idx = rows.find((r) => r.name === "idx_bot_tokens_hash");
      expect(idx).toBeDefined();
      expect(idx?.unique).toBe(1);
    });
  });
});