import type { ChannelMetaProjection } from "../contract/channel-api";

type SyncSql = {
  exec: (query: string, ...params: unknown[]) => { toArray: () => unknown[] };
};

export function buildChannelMetaProjectionForMember(
  sql: SyncSql,
  viewerUserId: string,
): ChannelMetaProjection | null {
  const meta = sql
    .exec(
      "SELECT channel_id, kind, visibility, title, topic, avatar_url, status, created_at, updated_at, member_count FROM channel_meta LIMIT 1",
    )
    .toArray()[0] as
    | {
        channel_id: string;
        kind: string;
        visibility: string;
        title: string;
        topic: string | null;
        avatar_url: string | null;
        status: string;
        created_at: string;
        updated_at: string;
        member_count: number;
      }
    | undefined;

  if (meta === undefined) {
    return null;
  }

  const member = viewerUserId
    ? (sql
        .exec(
          "SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL",
          meta.channel_id,
          viewerUserId,
        )
        .toArray()[0] as { role: string } | undefined)
    : undefined;

  const lastEvent = sql
    .exec("SELECT event_id FROM events WHERE channel_id=? ORDER BY event_id DESC LIMIT 1", meta.channel_id)
    .toArray()[0] as { event_id: string } | undefined;
  const lastMsg = sql
    .exec(
      "SELECT text, created_at FROM messages WHERE channel_id=? AND status NOT IN ('deleted','recalled') ORDER BY message_id DESC LIMIT 1",
      meta.channel_id,
    )
    .toArray()[0] as { text: string | null; created_at: string } | undefined;

  let dmPeerUserId: string | null = null;
  if (meta.kind === "dm" && viewerUserId) {
    const peer = sql
      .exec(
        "SELECT user_id FROM members WHERE channel_id=? AND user_id != ? AND left_at IS NULL LIMIT 1",
        meta.channel_id,
        viewerUserId,
      )
      .toArray()[0] as { user_id: string } | undefined;
    dmPeerUserId = peer?.user_id ?? null;
  }

  return {
    channel_id: meta.channel_id,
    kind: meta.kind,
    visibility: meta.visibility,
    title: meta.title,
    topic: meta.topic,
    avatar_url: meta.avatar_url,
    member_count: meta.member_count,
    status: meta.status,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    last_message_at: lastMsg?.created_at ?? null,
    last_message_preview: lastMsg?.text ?? null,
    last_event_id: lastEvent?.event_id ?? null,
    my_role: member?.role ?? null,
    dm_peer_user_id: dmPeerUserId,
  };
}
