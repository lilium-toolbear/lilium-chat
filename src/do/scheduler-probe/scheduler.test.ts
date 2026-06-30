import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { TestEnv } from "../../test-env";

const tEnv = env as unknown as TestEnv;

describe("per-DO scheduler", () => {
  it("processes the earliest due row and re-arms the alarm", async () => {
    const id = tEnv.SCHEDULER_PROBE.idFromName("t1");
    const stub = tEnv.SCHEDULER_PROBE.get(id);

    await stub.setup([100, 200]);

    const runBody = await stub.run(150);
    expect(runBody.processed).toEqual([100]);
    expect(runBody.nextAlarm).toBe(200);
  });

  it("deletes the alarm when no pending rows remain", async () => {
    const id = tEnv.SCHEDULER_PROBE.idFromName("t2");
    const stub = tEnv.SCHEDULER_PROBE.get(id);

    await stub.setup([]);
    const runBody = await stub.run(150);
    expect(runBody.processed).toEqual([]);
    expect(runBody.nextAlarm).toBe(null);
  });
});
