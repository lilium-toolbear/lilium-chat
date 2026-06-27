import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../env";
import type { UserSummary } from "../profile/resolve";
import { projectMessagesForBrowser } from "./sender";
import { resolveUserSummaries } from "../profile/resolve";
import type { MessageRow } from "../contract/persisted";
import type { AttachmentRow } from "./attachment-projection";


vi.mock("../profile/resolve", () => ({
  resolveUserSummaries: vi.fn(),
}));

function makeEnv(): Pick<Env, "LILIUM_DB"> {
  return { LILIUM_DB: { connectionString: "postgres://fake" } as Env["LILIUM_DB"] };
}

const mockedResolve = vi.mocked(resolveUserSummaries);

function row(over: Partial<MessageRow> = {}): MessageRow {
  return {
    message_id: "m1", command_id: "c1", channel_id: "ch1",
    sender_kind: "user", sender_user_id: "u1", sender_bot_id: null,
    type: "text", format: "plain", status: "normal", text: "hi",
    reply_to: null, reply_snapshot_json: null, stream_state: "none",
    created_at: "t", updated_at: "t", edited_at: null, deleted_at: null,
    deleted_by: null, recalled_at: null,
    ...over,
  };
}

beforeEach(() => {
  mockedResolve.mockReset();
});

describe("projectMessagesForBrowser (history path)", () => {
  it("projects a user message with resolved sender + injected mentions", async () => {
    mockedResolve.mockResolvedValueOnce(new Map<string, UserSummary>([
      ["u1", { user_id: "u1", display_name: "alice", avatar_url: "https://x/a.png" }],
    ]));

    const env = makeEnv() as Env;
    const out = await projectMessagesForBrowser(
      [row()],
      { m1: [{ user_id: "u2", start: 0, end: 4 }] },
      env,
    );

    expect(out[0]).toBeDefined();
    expect((out[0] as { sender: { kind: string; user: { user_id: string; display_name: string; avatar_url: string | null } } }).sender).toEqual({
      kind: "user",
      user: { user_id: "u1", display_name: "alice", avatar_url: "https://x/a.png" },
    });
    expect((out[0] as { mentions: unknown[] }).mentions).toEqual([{ user_id: "u2", start: 0, end: 4 }]);
  });

  it("missing user → fallback display_name user-<8>", async () => {
    mockedResolve.mockResolvedValueOnce(new Map<string, UserSummary>());

    const env = makeEnv() as Env;
    const out = await projectMessagesForBrowser(
      [row({ sender_user_id: "00000000-0000-7000-8000-000000000099" })],
      {},
      env,
    );

    expect((out[0] as { sender: { user: { display_name: string } } }).sender.user.display_name).toBe("user-00000000");
  });

  it("projects finalized attachments and drops non-finalized ones", async () => {
    mockedResolve.mockResolvedValueOnce(new Map<string, UserSummary>());

    const attachment: AttachmentRow = {
      attachment_id: "a1",
      owner_user_id: "u1",
      kind: "image",
      filename: "img.png",
      mime_type: "image/png",
      size_bytes: 12345,
      width: 512,
      height: 512,
      blurhash: "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
      storage_key: "k1",
      url: "https://s3.kuma.homes/chat/a1",
      status: "finalized",
      created_at: "t",
    };

    const env = makeEnv() as Env;
    const out = await projectMessagesForBrowser(
      [row({ message_id: "m1" })],
      {},
      env,
      { m1: [attachment, { ...attachment, attachment_id: "a2", status: "pending" }] },
    );

    const atts = (out[0] as { attachments: Array<{ attachment_id: string }> }).attachments;
    expect(atts).toHaveLength(1);
    expect(atts[0]!.attachment_id).toBe("a1");
  });
});
