import type { Env } from "../env";
import type { UserSummary } from "../profile/resolve";
import { resolveUserSummaries } from "../profile/resolve";

export interface ChannelSummaryFromDo {
  channel_id: string;
  kind: string;
  visibility: string;
  title: string;
  topic?: string | null;
  avatar_url: string | null;
  member_count: number;
  status: string;
  created_at: string;
  updated_at: string;
  last_message_preview?: string | null;
  last_message_at?: string | null;
  last_event_id?: string | null;
  my_role?: string | null;
  dm_peer_user_id?: string | null;
}

export interface MyChannelListFields {
  last_read_event_id: string | null;
  unread_count?: number;
}

function fallbackDisplayName(userId: string): string {
  return `user-${userId.slice(0, 8)}`;
}

export async function inflateChannelSummaryForViewer(input: {
  summary: ChannelSummaryFromDo;
  viewerUserId: string;
  myChannelRow?: MyChannelListFields | null;
  env: Env;
}): Promise<Record<string, unknown>> {
  const { summary, viewerUserId, myChannelRow, env } = input;
  const base: Record<string, unknown> = {
    channel_id: summary.channel_id,
    kind: summary.kind,
    visibility: summary.visibility,
    title: summary.title,
    topic: summary.topic ?? null,
    avatar_url: summary.avatar_url,
    member_count: summary.member_count,
    status: summary.status,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
    unread_count: myChannelRow?.unread_count ?? 0,
    last_read_event_id: myChannelRow?.last_read_event_id ?? null,
    last_message_preview: summary.last_message_preview ?? null,
    last_message_at: summary.last_message_at ?? null,
    last_event_id: summary.last_event_id ?? null,
    role: summary.my_role ?? null,
  };

  if (summary.kind !== "dm") {
    return base;
  }

  const peerUserId = summary.dm_peer_user_id;
  if (!peerUserId) {
    return { ...base, dm_peer: null };
  }

  const profileMap = await resolveUserSummaries([peerUserId], env);
  const peer = profileMap.get(peerUserId);
  const dmPeer: UserSummary = peer ?? {
    user_id: peerUserId,
    display_name: fallbackDisplayName(peerUserId),
    avatar_url: null,
  };

  return {
    ...base,
    role: "member",
    dm_peer: dmPeer,
    title: dmPeer.display_name ?? fallbackDisplayName(peerUserId),
    avatar_url: dmPeer.avatar_url,
  };
}
