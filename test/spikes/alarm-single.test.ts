import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { TestEnv } from "../../src/test-env";

const tEnv = env as unknown as TestEnv;

describe("spike: single alarm earliest-wins over multiple pendings", () => {
  it("setAlarm is last-write-wins; scheduler keeps earliest due", async () => {
    const id = tEnv.SCHEDULER_PROBE.idFromName("alarm-1");
    const stub = tEnv.SCHEDULER_PROBE.get(id);

    await stub.fetch(
      new Request("https://x/setup", {
        method: "POST",
        body: JSON.stringify({ rows: [100, 50, 300] }),
      }),
    );

    const runRes = await stub.fetch(
      new Request("https://x/run", {
        method: "POST",
        body: JSON.stringify({ now: 75 }),
      }),
    );

    const body = (await runRes.json()) as { processed: number[]; nextAlarm: number | null };
    expect(body.processed).toEqual([50]);
    expect(body.nextAlarm).toBe(100);
  });
});
