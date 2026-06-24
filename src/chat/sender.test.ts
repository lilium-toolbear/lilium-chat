import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../env";
import type { UserSummary } from "../profile/resolve";
import { attachSummaries } from "./sender";
import { resolveUserSummaries } from "../profile/resolve";

vi.mock("../profile/resolve", () => ({
  resolveUserSummaries: vi.fn(),
}));

function makeEnv(): Pick<Env, "TOOLBEAR_DB"> {
  return { TOOLBEAR_DB: { connectionString: "postgres://fake" } as Env["TOOLBEAR_DB"] };
}

const mockedResolve = vi.mocked(resolveUserSummaries);

beforeEach(() => {
  mockedResolve.mockReset();
});

describe("attachSummaries", () => {
  it("reshapes raw sender to contract {kind:'user', user:{...}} with resolved display_name", async () => {
    mockedResolve.mockResolvedValueOnce(new Map<string, UserSummary>([
      ["u1", { user_id: "u1", display_name: "alice", avatar_url: "https://x/a.png" }],
    ]));

    const env = makeEnv() as Env;
    const raw = [{
      message_id: "m1",
      command_id: "c1",
      channel_id: "ch1",
      sender: { kind: "user", user_id: "u1", bot_id: null },
      type: "text",
      format: "plain",
      status: "normal",
      text: "hi",
      reply_to: null,
      reply_snapshot: null,
      stream_state: "none",
      created_at: "t",
      updated_at: "t",
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
      recalled_at: null,
      attachments: [],
      components: [],
      mentions: [],
    }];

    const out = await attachSummaries(raw, env);

    expect(out[0]).toBeDefined();
    expect((out[0] as unknown as { sender: { kind: "user"; user: { user_id: string; display_name: string; avatar_url: string | null } } }).sender).toEqual({
      kind: "user",
      user: { user_id: "u1", display_name: "alice", avatar_url: "https://x/a.png" },
    });
  });

  it("missing user → fallback display_name user-<8>, not raw id", async () => {
    mockedResolve.mockResolvedValueOnce(new Map<string, UserSummary>());

    const env = makeEnv() as Env;
    const raw = [{
      message_id: "m2",
      command_id: "c2",
      channel_id: "ch1",
      sender: { kind: "user", user_id: "00000000-0000-7000-8000-000000000099", bot_id: null },
      type: "text",
      format: "plain",
      status: "normal",
      text: "hi",
      reply_to: null,
      reply_snapshot: null,
      stream_state: "none",
      created_at: "t",
      updated_at: "t",
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
      recalled_at: null,
      attachments: [],
      components: [],
      mentions: [],
    }];

    const out = await attachSummaries(raw, env);

    expect(out[0]).toBeDefined();
    expect((out[0] as { sender: { user: { display_name: string } } }).sender.user.display_name).toBe("user-00000000");
  });
});
