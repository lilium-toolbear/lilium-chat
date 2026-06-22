import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { TestEnv } from "../../src/test-env";

const tEnv = env as unknown as TestEnv;

describe("per-DO scheduler", () => {
  it("processes the earliest due row and re-arms the alarm", async () => {
    const id = tEnv.SCHEDULER_PROBE.idFromName("t1");
    const stub = tEnv.SCHEDULER_PROBE.get(id);

    const setupRes = await stub.fetch(
      new Request("https://x/setup", { method: "POST", body: JSON.stringify({ rows: [100, 200] }) }),
    );
    expect(setupRes.status).toBe(200);

    const runRes = await stub.fetch(new Request("https://x/run", { method: "POST", body: JSON.stringify({ now: 150 }) }));
    const runBody = (await runRes.json()) as { processed: number[]; nextAlarm: number | null };
    expect(runBody.processed).toEqual([100]);
    expect(runBody.nextAlarm).toBe(200);
  });

  it("deletes the alarm when no pending rows remain", async () => {
    const id = tEnv.SCHEDULER_PROBE.idFromName("t2");
    const stub = tEnv.SCHEDULER_PROBE.get(id);

    await stub.fetch(new Request("https://x/setup", { method: "POST", body: JSON.stringify({ rows: [] }) }));
    const runRes = await stub.fetch(new Request("https://x/run", { method: "POST", body: JSON.stringify({ now: 150 }) }));
    const runBody = (await runRes.json()) as { processed: number[]; nextAlarm: number | null };
    expect(runBody.processed).toEqual([]);
    expect(runBody.nextAlarm).toBe(null);
  });
});
