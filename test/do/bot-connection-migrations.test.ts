import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, readDoSchemaVersion } from "../helpers";
import { indexExists, tableExists } from "../../src/do/shared/sql-migrations";
import { BOT_CONNECTION_CURRENT_SCHEMA_VERSION } from "../../src/do/bot-connection/migrations";

function connectionStub(botId: string) {
  return getNamedDo(env.BOT_CONNECTION as unknown as DurableObjectNamespace, botId);
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

describe("BotConnection baseline migrations (Phase 7)", () => {
  it("fresh install creates connection state + delivery queue", async () => {
    const stub = connectionStub(`bot-${crypto.randomUUID()}`);
    await schemaVersion(stub);

    await withDoState(stub, (ctx) => {
      expect(tableExists(ctx, "bot_connection_state")).toBe(true);
      expect(tableExists(ctx, "bot_deliveries")).toBe(true);
      const stateCols = ctx.storage.sql
        .exec("PRAGMA table_info(bot_connection_state)")
        .toArray() as Array<{ name: string }>;
      expect(stateCols.map((r) => r.name)).toContain("expires_at");
      expect(indexExists(ctx, "idx_bot_deliveries_due")).toBe(true);
      expect(indexExists(ctx, "idx_bot_deliveries_source_outbox")).toBe(true);
    });
    expect(await schemaVersion(stub)).toBe(BOT_CONNECTION_CURRENT_SCHEMA_VERSION);
  });

  it("delivery queue due index covers (bot_id, status, next_attempt_at)", async () => {
    const stub = connectionStub(`bot-idx-${crypto.randomUUID()}`);
    await schemaVersion(stub);
    await withDoState(stub, (ctx) => {
      const rows = ctx.storage.sql
        .exec("PRAGMA index_info(idx_bot_deliveries_due)")
        .toArray() as Array<{ name: string }>;
      const cols = rows.map((r) => r.name);
      expect(cols).toContain("bot_id");
      expect(cols).toContain("status");
      expect(cols).toContain("next_attempt_at");
    });
  });

  it("delivery queue source outbox index covers (bot_id, source_outbox_id)", async () => {
    const stub = connectionStub(`bot-source-idx-${crypto.randomUUID()}`);
    await schemaVersion(stub);
    await withDoState(stub, (ctx) => {
      const rows = ctx.storage.sql
        .exec("PRAGMA index_info(idx_bot_deliveries_source_outbox)")
        .toArray() as Array<{ name: string }>;
      const cols = rows.map((r) => r.name);
      expect(cols).toContain("bot_id");
      expect(cols).toContain("source_outbox_id");
    });
  });
});
