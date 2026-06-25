import { describe, it, expect, vi } from "vitest";
import { resolveUserSummaries, type UserSummary } from "./resolve";
import type { Env } from "../env";

interface FakeClient {
  connect(): Promise<void>;
  query(sql: string, params: unknown[]): Promise<{ rows: Array<{ user_id: string; full_name: string | null; avatar_url: string | null }> }>;
  end(): Promise<void>;
}

function makeEnv(connStr: string): Pick<Env, "LILIUM_DB"> {
  return { LILIUM_DB: { connectionString: connStr } as Env["LILIUM_DB"] };
}

function fakeClientFactory(rowsByBatch: Record<number, UserSummary[]>): (connStr: string) => FakeClient {
  let batch = 0;
  return () => {
    const myBatch = batch++;
    return {
      connect: async () => {},
      query: async () => ({ rows: (rowsByBatch[myBatch] ?? []).map((r) => ({ user_id: r.user_id, full_name: r.display_name, avatar_url: r.avatar_url })) }),
      end: async () => {},
    };
  };
}

describe("resolveUserSummaries", () => {
  it("returns a map keyed by user_id with full_name → display_name", async () => {
    const env = makeEnv("postgres://fake") as Env;
    const ids = ["u1", "u2"];
    const map = await resolveUserSummaries(ids, env, {
      clientFactory: fakeClientFactory({ 0: [
        { user_id: "u1", display_name: "alice", avatar_url: "https://x/a.png" },
        { user_id: "u2", display_name: null, avatar_url: null },
      ] }),
    });
    expect(map.get("u1")).toEqual({ user_id: "u1", display_name: "alice", avatar_url: "https://x/a.png" });
    expect(map.get("u2")).toEqual({ user_id: "u2", display_name: null, avatar_url: null });
  });

  it("dedupes input ids", async () => {
    const env = makeEnv("postgres://fake") as Env;
    const connect = vi.fn(async () => {});
    const factory = () => ({ connect, query: async () => ({ rows: [{ user_id: "u1", full_name: "a", avatar_url: null }] }), end: async () => {} });
    await resolveUserSummaries(["u1", "u1", "u1"], env, { clientFactory: factory });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("batches in chunks of 50 without truncation", async () => {
    const env = makeEnv("postgres://fake") as Env;
    const ids = Array.from({ length: 120 }, (_, i) => `u${i}`);
    let batches = 0;
    const factory = () => ({
      connect: async () => {},
      query: async () => { batches++; return { rows: [] }; },
      end: async () => {},
    });
    await resolveUserSummaries(ids, env, { clientFactory: factory });
    expect(batches).toBe(3); // 50 + 50 + 20
  });

  it("returns empty map for empty input without connecting", async () => {
    const env = makeEnv("postgres://fake") as Env;
    const connect = vi.fn(async () => {});
    const factory = () => ({ connect, query: async () => ({ rows: [] }), end: async () => {} });
    const map = await resolveUserSummaries([], env, { clientFactory: factory });
    expect(map.size).toBe(0);
    expect(connect).not.toHaveBeenCalled();
  });
});
