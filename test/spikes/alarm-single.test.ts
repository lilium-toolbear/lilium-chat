import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { TestEnv } from "../../src/test-env";

const tEnv = env as unknown as TestEnv;

describe("spike: single alarm earliest-wins over multiple pendings", () => {
  it("setAlarm is last-write-wins; scheduler keeps earliest due", async () => {
    const id = tEnv.SCHEDULER_PROBE.idFromName("alarm-1");
    const stub = tEnv.SCHEDULER_PROBE.get(id);

    await stub.setup([100, 50, 300]);

    const body = await stub.run(75);
    expect(body.processed).toEqual([50]);
    expect(body.nextAlarm).toBe(100);
  });
});
