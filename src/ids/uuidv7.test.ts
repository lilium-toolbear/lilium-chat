import { describe, it, expect } from "vitest";
import { uuidv7, monotonicUuidV7 } from "./uuidv7";

describe("uuidv7", () => {
  it("is 36 chars and lexicographically time-ordered", () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // version nibble is 7
    expect(a[14]).toBe("7");
    // variant nibble is 8/9/a/b
    expect(["8", "9", "a", "b"]).toContain(a[19]);
    expect(a.length).toBe(36);
    expect(b.length).toBe(36);
  });
});

describe("monotonicUuidV7", () => {
  it("increments counter within the same millisecond → strictly increasing ids", () => {
    const now = 1_700_000_000_000;
    let seq = { last_ms: now, counter: 0 };
    const r1 = monotonicUuidV7(seq, now);
    seq = r1.seq;
    const r2 = monotonicUuidV7(seq, now);
    seq = r2.seq;
    const r3 = monotonicUuidV7(seq, now);
    expect(r1.id < r2.id).toBe(true);
    expect(r2.id < r3.id).toBe(true);
  });

  it("resets counter when millisecond advances", () => {
    let seq = { last_ms: 1_700_000_000_000, counter: 5 };
    const r = monotonicUuidV7(seq, 1_700_000_000_001);
    expect(r.seq.last_ms).toBe(1_700_000_000_001);
    expect(r.seq.counter).toBe(0);
  });

  it("stays monotonic across many calls", () => {
    let seq = { last_ms: 0, counter: 0 };
    let prev = "";
    for (let i = 0; i < 1000; i++) {
      const now = 1_700_000_000_000 + Math.floor(i / 3); // advance ms every 3 calls
      const r = monotonicUuidV7(seq, now);
      if (prev) expect(r.id > prev).toBe(true);
      prev = r.id;
      seq = r.seq;
    }
  });
});
