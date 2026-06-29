import type {
  BotInstalledPersistedPayload,
  BotUpdatedPersistedPayload,
  ChannelCreatedPersistedPayload,
  ChannelDissolvedPersistedPayload,
  ChannelUpdatedPersistedPayload,
  CommandBindingUpdatedPersistedPayload,
  ManagementPersistedPayload,
  MemberJoinedPersistedPayload,
  MemberLeftPersistedPayload,
  MemberRoleUpdatedPersistedPayload,
  ReadStateUpdatedPersistedPayload,
  StatefulSessionRefSummary,
} from "../contract/persisted";
import type { CommandManifestDelta } from "../contract/bot-api";
import type { ManagementWirePayload } from "../contract/wire-frames";
import { fallbackUserDisplayName, type UserSummary } from "../contract/primitives";

export type { UserSummary };

export function buildChannelCreatedPayload(raw: {
  channel_id: string;
  kind: string;
  visibility: string;
  title: string;
  actor_kind: string;
  actor_id: string;
}): ChannelCreatedPersistedPayload {
  return {
    channel: { channel_id: raw.channel_id, kind: raw.kind, visibility: raw.visibility, title: raw.title },
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
  };
}

export function buildChannelUpdatedPayload(raw: {
  channel_id: string;
  channel_changes: Record<string, { before: unknown; after: unknown }>;
  actor_kind: string;
  actor_id: string;
}): ChannelUpdatedPersistedPayload {
  return {
    channel_id: raw.channel_id,
    channel_changes: raw.channel_changes,
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
  };
}

export function buildChannelDissolvedPayload(raw: {
  channel_id: string;
  dissolved_at: string;
  actor_kind: string;
  actor_id: string;
}): ChannelDissolvedPersistedPayload {
  return {
    channel_id: raw.channel_id,
    status: "dissolved",
    dissolved_at: raw.dissolved_at,
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
  };
}

export function buildMemberJoinedPayload(raw: {
  channel_id: string;
  user_id: string;
  role: string;
  membership_version: number;
  actor_kind: string;
  actor_id: string;
  join_source?: "invite" | "public" | "admin_add" | "initial" | null;
  inviter_user_id?: string | null;
}): MemberJoinedPersistedPayload {
  return {
    channel_id: raw.channel_id,
    user_id: raw.user_id,
    role: raw.role,
    membership_version: raw.membership_version,
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
    join_source: raw.join_source ?? null,
    inviter_user_id: raw.inviter_user_id ?? null,
  };
}

export function buildMemberRoleUpdatedPayload(raw: {
  channel_id: string;
  user_id: string;
  before_role: string;
  after_role: string;
  membership_version: number;
  actor_kind: string;
  actor_id: string;
}): MemberRoleUpdatedPersistedPayload {
  return {
    channel_id: raw.channel_id,
    user_id: raw.user_id,
    before_role: raw.before_role,
    after_role: raw.after_role,
    membership_version: raw.membership_version,
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
  };
}

export function buildMemberLeftPayload(raw: {
  channel_id: string;
  user_id: string;
  role: string;
  membership_version: number;
  actor_kind: string;
  actor_id: string;
  leave_source?: "self" | "removed" | null;
}): MemberLeftPersistedPayload {
  return {
    channel_id: raw.channel_id,
    user_id: raw.user_id,
    role: raw.role,
    membership_version: raw.membership_version,
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
    leave_source: raw.leave_source ?? null,
  };
}

export function buildReadStateUpdatedPayload(raw: {
  channel_id: string;
  user_id: string;
  last_read_event_id: string;
}): ReadStateUpdatedPersistedPayload {
  return { channel_id: raw.channel_id, user_id: raw.user_id, last_read_event_id: raw.last_read_event_id };
}

export function buildBotInstalledPayload(raw: {
  channel_id: string;
  bot_id: string;
  actor_kind: string;
  actor_id: string;
}): BotInstalledPersistedPayload {
  return { channel_id: raw.channel_id, bot_id: raw.bot_id, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
}

export function buildBotUpdatedPayload(raw: {
  channel_id: string;
  bot_id: string;
  status: string;
  changes: Record<string, { before: unknown; after: unknown }> | null;
  actor_kind: string;
  actor_id: string;
}): BotUpdatedPersistedPayload {
  return {
    channel_id: raw.channel_id,
    bot_id: raw.bot_id,
    status: raw.status,
    changes: raw.changes,
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
  };
}

export function buildCommandBindingUpdatedPayload(raw: {
  channel_id: string;
  bot_id: string;
  bot_command_id: string;
  binding_changes: Record<string, { before: unknown; after: unknown }>;
  actor_kind: string;
  actor_id: string;
  command_manifest_delta: CommandManifestDelta;
}): CommandBindingUpdatedPersistedPayload {
  return {
    channel_id: raw.channel_id,
    bot_id: raw.bot_id,
    bot_command_id: raw.bot_command_id,
    binding_changes: raw.binding_changes,
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
    command_manifest_delta: raw.command_manifest_delta,
  };
}

function fallbackUserSummary(userId: string): UserSummary {
  return { user_id: userId, display_name: fallbackUserDisplayName(userId), avatar_url: null };
}

// Wire projection: resolve actor (and target_user) refs to UserSummary at output time.
// System actor → actor: null (no resolution). Falls back to user-<shortid> when pg has no row.
export function resolveActorWithMap(
  payload: ManagementPersistedPayload,
  map: Map<string, UserSummary>,
): ManagementWirePayload {
  const { actor_kind, actor_id, ...rest } = payload as ManagementPersistedPayload & {
    user_id?: string;
    inviter_user_id?: string | null;
    target_user_id?: string;
  };

  let actor: UserSummary | null | undefined;
  if (actor_kind === "user" && actor_id) {
    actor = map.get(actor_id) ?? fallbackUserSummary(actor_id);
  } else if (actor_kind === "system") {
    actor = null;
  }

  const withUser = rest as typeof rest & { user_id?: string; inviter_user_id?: string | null; target_user_id?: string };
  const { user_id: subjectUserId, inviter_user_id: inviterUserId, target_user_id: targetUserId, ...tail } = withUser;

  const wire: ManagementWirePayload = {
    ...(tail as ManagementWirePayload),
    ...(actor !== undefined ? { actor } : {}),
  } as ManagementWirePayload;

  if (targetUserId) {
    (wire as { target_user?: UserSummary | null }).target_user =
      map.get(targetUserId) ?? fallbackUserSummary(targetUserId);
  } else if ("target_user_id" in withUser) {
    (wire as { target_user?: UserSummary | null }).target_user = null;
  }

  if (subjectUserId) {
    (wire as { user?: UserSummary }).user = map.get(subjectUserId) ?? fallbackUserSummary(subjectUserId);
  }

  if (inviterUserId) {
    (wire as { inviter?: UserSummary | null }).inviter =
      map.get(inviterUserId) ?? fallbackUserSummary(inviterUserId);
  }

  const sessionRef = (tail as { session?: StatefulSessionRefSummary }).session;
  if (sessionRef?.started_by_user_id) {
    const { started_by_user_id, ...sessionRest } = sessionRef;
    (wire as { session?: Record<string, unknown> }).session = {
      ...sessionRest,
      started_by: map.get(started_by_user_id) ?? fallbackUserSummary(started_by_user_id),
    };
  }

  return wire;
}

export type ResolveUserSummaries = (userIds: string[]) => Promise<Map<string, UserSummary>>;

// Async injected-resolver variant — used by unit tests. Prod code uses resolveActorWithMap
// (sync) after pre-resolving via Hyperdrive BEFORE the DO transaction.
export async function resolveActorForLiveBroadcast(
  payload: ManagementPersistedPayload,
  resolveUserSummaries: ResolveUserSummaries,
): Promise<ManagementWirePayload> {
  const ids: string[] = [];
  if (payload.actor_kind === "user" && payload.actor_id) ids.push(payload.actor_id);
  const withTarget = payload as ManagementPersistedPayload & { target_user_id?: string };
  if (typeof withTarget.target_user_id === "string") ids.push(withTarget.target_user_id);
  const withUser = payload as ManagementPersistedPayload & { user_id?: string };
  if (typeof withUser.user_id === "string") ids.push(withUser.user_id);
  const withInviter = payload as MemberJoinedPersistedPayload;
  if (typeof withInviter.inviter_user_id === "string") ids.push(withInviter.inviter_user_id);
  const map = ids.length > 0 ? await resolveUserSummaries(ids) : new Map<string, UserSummary>();
  return resolveActorWithMap(payload, map);
}
