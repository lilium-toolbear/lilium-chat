import { describe, expect, it, vi } from "vitest";
import { inflateChannelSummaryForViewer } from "../../src/chat/channel-summary";

vi.mock("../../src/profile/resolve", () => ({
  resolveUserSummaries: vi.fn(async (userIds: string[]) => {
    const map = new Map<string, { user_id: string; display_name: string; avatar_url: string | null }>();
    for (const id of userIds) {
      map.set(id, { user_id: id, display_name: "Alice", avatar_url: "https://cdn.example/a.png" });
    }
    return map;
  }),
}));

const PEER = "00000000-0000-7000-8000-000000000501";
const VIEWER = "00000000-0000-7000-8000-000000000502";

describe("inflateChannelSummaryForViewer", () => {
  it("sets dm_peer and viewer-specific title for dm channels", async () => {
    const inflated = await inflateChannelSummaryForViewer({
      summary: {
        channel_id: "ch-dm-1",
        kind: "dm",
        visibility: "private",
        title: "",
        avatar_url: null,
        member_count: 2,
        status: "active",
        created_at: "2026-06-27T00:00:00Z",
        updated_at: "2026-06-27T00:00:00Z",
        my_role: "member",
        dm_peer_user_id: PEER,
      },
      viewerUserId: VIEWER,
      myChannelRow: { last_read_event_id: null },
      env: { LILIUM_DB: { connectionString: "postgres://x" } } as never,
    });

    expect(inflated.kind).toBe("dm");
    expect(inflated.title).toBe("Alice");
    expect(inflated.avatar_url).toBe("https://cdn.example/a.png");
    expect((inflated.dm_peer as { user_id: string }).user_id).toBe(PEER);
    expect(inflated.unread_count).toBe(0);
    expect(inflated.last_read_event_id).toBeNull();
  });

  it("passes through group channel title unchanged", async () => {
    const inflated = await inflateChannelSummaryForViewer({
      summary: {
        channel_id: "ch-1",
        kind: "channel",
        visibility: "private",
        title: "General",
        avatar_url: null,
        member_count: 3,
        status: "active",
        created_at: "2026-06-27T00:00:00Z",
        updated_at: "2026-06-27T00:00:00Z",
        my_role: "owner",
      },
      viewerUserId: VIEWER,
      env: { LILIUM_DB: { connectionString: "postgres://x" } } as never,
    });
    expect(inflated.title).toBe("General");
    expect(inflated.dm_peer).toBeUndefined();
  });
});
