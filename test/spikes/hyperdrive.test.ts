import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

const LIVE = !!(globalThis as { process?: { env?: { SPIKE_LIVE?: string } } }).process?.env?.SPIKE_LIVE;

if (LIVE) {
  describe("spike: Hyperdrive + pg reads users table", () => {
    it("connects and runs SELECT", async () => {
      const { Client } = await import("pg") as {
        Client: {
          new (opts: { connectionString: string }): {
            connect(): Promise<void>;
            query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }>;
            end(): Promise<void>;
          };
        };
      };
      const client = new Client({ connectionString: env.LILIUM_DB.connectionString });
      await client.connect();

      try {
        const res = await client.query("SELECT 1 AS ok");
        expect((res.rows[0] as { ok: number }).ok).toBe(1);
      } finally {
        await client.end();
      }
    });
  });
} else {
  describe.skip("spike: Hyperdrive (skipped, set SPIKE_LIVE=1 to run)", () => {
    it.skip("skipped in CI", () => {});
  });
}
