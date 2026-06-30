import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { tableExists } from "../../src/do/sql-migrations";
import { BOT_STREAM_CONNECTION_CURRENT_SCHEMA_VERSION } from "../../src/do/migrations/bot-stream-connection";
import { botStreamDoName } from "../../src/do/bot-stream-connection";

function streamStub(channelId: string, messageId: string) {
  return getNamedDo(
    env.BOT_STREAM_CONNECTION as unknown as DurableObjectNamespace,
    botStreamDoName(channelId, messageId),
  );
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
  expect(res.status).toBe(200);
  const body = (await res.json()) as { current_version: number };
  return body.current_version;
}

describe("BotStreamConnection baseline migrations", () => {
  it("fresh install creates stream_state table", async () => {
    const channelId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const stub = streamStub(channelId, messageId);
    await stub.fetch(new Request("https://x/ping"));

    await withDoState(stub, (ctx) => {
      expect(tableExists(ctx, "stream_state")).toBe(true);
      expect(tableExists(ctx, "stream_due_jobs")).toBe(true);
      const cols = ctx.storage.sql
        .exec("PRAGMA table_info(stream_state)")
        .toArray() as Array<{ name: string }>;
      const names = cols.map((row) => row.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "channel_id",
          "message_id",
          "bot_id",
          "status",
          "ack_seq",
          "flushed_text",
          "pending_bytes",
          "expires_at",
          "created_at",
          "updated_at",
        ]),
      );
    });
    expect(await schemaVersion(stub)).toBe(BOT_STREAM_CONNECTION_CURRENT_SCHEMA_VERSION);
  });

  it("rejects schema-version without X-Test-Only", async () => {
    const stub = streamStub(crypto.randomUUID(), crypto.randomUUID());
    const res = await stub.fetch(new Request("https://x/internal/schema-version"));
    expect(res.status).toBe(403);
  });
});
