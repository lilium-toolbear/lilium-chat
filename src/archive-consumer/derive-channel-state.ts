/**
 * Derive chat.channels / chat.channel_members for legacy archive rows that only
 * replayed messages and events (message-send never archived channel snapshots).
 */

export interface DerivedChannelRow {
  channel_id: string;
  kind: string;
  visibility: string;
  title: string;
  topic: string | null;
  avatar_url: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  member_count: number;
  membership_version: number;
}

export interface DerivedMemberRow {
  channel_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  left_at: string | null;
}

export interface DeriveEventInput {
  event_type: string;
  channel_id: string;
  occurred_at: string;
  membership_version_at_event: number;
  payload: unknown;
}

function parsePayload(payload: unknown): Record<string, unknown> {
  if (payload === null || payload === undefined) return {};
  if (typeof payload === "string") {
    return JSON.parse(payload) as Record<string, unknown>;
  }
  return payload as Record<string, unknown>;
}

function memberKey(channelId: string, userId: string): string {
  return `${channelId}\0${userId}`;
}

function activeMemberCount(members: Map<string, DerivedMemberRow>, channelId: string): number {
  let count = 0;
  for (const row of members.values()) {
    if (row.channel_id === channelId && row.left_at === null) count += 1;
  }
  return count;
}

function ensureChannel(
  channels: Map<string, DerivedChannelRow>,
  channelId: string,
  occurredAt: string,
  createdBy: string,
): DerivedChannelRow {
  const existing = channels.get(channelId);
  if (existing) return existing;
  const row: DerivedChannelRow = {
    channel_id: channelId,
    kind: "channel",
    visibility: "private",
    title: channelId,
    topic: null,
    avatar_url: null,
    status: "active",
    created_by: createdBy,
    created_at: occurredAt,
    updated_at: occurredAt,
    member_count: 0,
    membership_version: 0,
  };
  channels.set(channelId, row);
  return row;
}

function ensureMember(
  members: Map<string, DerivedMemberRow>,
  channelId: string,
  userId: string,
  occurredAt: string,
  role: string,
): DerivedMemberRow {
  const key = memberKey(channelId, userId);
  const existing = members.get(key);
  if (existing) {
    if (existing.left_at !== null && existing.joined_at <= occurredAt) {
      existing.left_at = null;
      existing.role = role;
    }
    return existing;
  }
  const row: DerivedMemberRow = {
    channel_id: channelId,
    user_id: userId,
    role,
    joined_at: occurredAt,
    left_at: null,
  };
  members.set(key, row);
  return row;
}

function applyChannelFieldChanges(
  channel: DerivedChannelRow,
  changes: Record<string, { before: unknown; after: unknown }>,
  occurredAt: string,
): void {
  for (const [field, change] of Object.entries(changes)) {
    if (field === "title" && typeof change.after === "string") channel.title = change.after;
    if (field === "topic") channel.topic = change.after === null ? null : String(change.after);
    if (field === "avatar_url") {
      channel.avatar_url = change.after === null ? null : String(change.after);
    }
    if (field === "visibility" && typeof change.after === "string") channel.visibility = change.after;
    if (field === "status" && typeof change.after === "string") channel.status = change.after;
  }
  channel.updated_at = occurredAt;
}

export function deriveChannelMemberState(
  events: readonly DeriveEventInput[],
  messageSenders: ReadonlyArray<{ channel_id: string; sender_user_id: string; first_at: string }>,
): { channels: DerivedChannelRow[]; members: DerivedMemberRow[] } {
  const channels = new Map<string, DerivedChannelRow>();
  const members = new Map<string, DerivedMemberRow>();

  for (const event of events) {
    const payload = parsePayload(event.payload);
    const channelId = event.channel_id;
    const at = event.occurred_at;
    const mv = event.membership_version_at_event;

    switch (event.event_type) {
      case "channel.created": {
        const ch = payload.channel as Record<string, unknown> | undefined;
        const actorId = typeof payload.actor_id === "string" ? payload.actor_id : "unknown";
        const row = ensureChannel(channels, channelId, at, actorId);
        if (ch) {
          if (typeof ch.kind === "string") row.kind = ch.kind;
          if (typeof ch.visibility === "string") row.visibility = ch.visibility;
          if (typeof ch.title === "string") row.title = ch.title;
        }
        row.updated_at = at;
        row.membership_version = Math.max(row.membership_version, mv);
        break;
      }
      case "channel.updated": {
        const actorId = typeof payload.actor_id === "string" ? payload.actor_id : "unknown";
        const row = ensureChannel(channels, channelId, at, actorId);
        const changes = payload.channel_changes as
          | Record<string, { before: unknown; after: unknown }>
          | undefined;
        if (changes) applyChannelFieldChanges(row, changes, at);
        row.membership_version = Math.max(row.membership_version, mv);
        break;
      }
      case "channel.dissolved": {
        const actorId = typeof payload.actor_id === "string" ? payload.actor_id : "unknown";
        const row = ensureChannel(channels, channelId, at, actorId);
        row.status = "dissolved";
        row.updated_at = at;
        row.membership_version = Math.max(row.membership_version, mv);
        break;
      }
      case "member.joined": {
        const userId = String(payload.user_id ?? "");
        const role = String(payload.role ?? "member");
        if (!userId) break;
        const actorId = typeof payload.actor_id === "string" ? payload.actor_id : userId;
        ensureChannel(channels, channelId, at, actorId);
        ensureMember(members, channelId, userId, at, role);
        const ch = channels.get(channelId)!;
        ch.membership_version = Math.max(
          ch.membership_version,
          Number(payload.membership_version ?? mv),
        );
        ch.updated_at = at;
        break;
      }
      case "member.role_updated": {
        const userId = String(payload.user_id ?? "");
        const afterRole = String(payload.after_role ?? "member");
        if (!userId) break;
        const member = ensureMember(members, channelId, userId, at, afterRole);
        member.role = afterRole;
        const ch = channels.get(channelId) ?? ensureChannel(channels, channelId, at, userId);
        ch.membership_version = Math.max(
          ch.membership_version,
          Number(payload.membership_version ?? mv),
        );
        ch.updated_at = at;
        break;
      }
      case "member.left": {
        const userId = String(payload.user_id ?? "");
        if (!userId) break;
        const key = memberKey(channelId, userId);
        const member = members.get(key);
        if (member) {
          member.left_at = at;
        } else {
          members.set(key, {
            channel_id: channelId,
            user_id: userId,
            role: String(payload.role ?? "member"),
            joined_at: at,
            left_at: at,
          });
        }
        const ch = channels.get(channelId);
        if (ch) {
          ch.membership_version = Math.max(
            ch.membership_version,
            Number(payload.membership_version ?? mv),
          );
          ch.updated_at = at;
        }
        break;
      }
      default:
        break;
    }
  }

  for (const row of messageSenders) {
    ensureChannel(channels, row.channel_id, row.first_at, row.sender_user_id);
    ensureMember(members, row.channel_id, row.sender_user_id, row.first_at, "member");
  }

  for (const channel of channels.values()) {
    channel.member_count = activeMemberCount(members, channel.channel_id);
    if (channel.membership_version === 0) {
      channel.membership_version = channel.member_count;
    }
  }

  return {
    channels: [...channels.values()],
    members: [...members.values()],
  };
}
