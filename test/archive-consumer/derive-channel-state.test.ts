import { describe, expect, it } from "vitest";
import { deriveChannelMemberState } from "../../src/archive-consumer/derive-channel-state";

describe("deriveChannelMemberState", () => {
  it("builds channel and members from lifecycle events", () => {
    const channelId = "ch-1";
    const { channels, members } = deriveChannelMemberState(
      [
        {
          event_type: "channel.created",
          channel_id: channelId,
          occurred_at: "2026-06-28T00:00:00.000Z",
          membership_version_at_event: 1,
          payload: {
            actor_kind: "user",
            actor_id: "u1",
            channel: {
              channel_id: channelId,
              kind: "channel",
              visibility: "public_listed",
              title: "general",
            },
          },
        },
        {
          event_type: "member.joined",
          channel_id: channelId,
          occurred_at: "2026-06-28T00:00:01.000Z",
          membership_version_at_event: 2,
          payload: {
            channel_id: channelId,
            user_id: "u2",
            role: "member",
            membership_version: 2,
            actor_kind: "user",
            actor_id: "u1",
            join_source: "admin_add",
            inviter_user_id: "u1",
          },
        },
      ],
      [],
    );

    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      channel_id: channelId,
      title: "general",
      member_count: 1,
      membership_version: 2,
    });
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      channel_id: channelId,
      user_id: "u2",
      role: "member",
      left_at: null,
    });
  });

  it("fills message-only gaps when events omit channel snapshots", () => {
    const { channels, members } = deriveChannelMemberState(
      [],
      [{ channel_id: "ch-2", sender_user_id: "u9", first_at: "2026-06-28T01:00:00.000Z" }],
    );

    expect(channels).toHaveLength(1);
    expect(channels[0]!.channel_id).toBe("ch-2");
    expect(members).toHaveLength(1);
    expect(members[0]!.user_id).toBe("u9");
  });
});
