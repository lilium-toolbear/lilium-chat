import type { UserSummary, ResolveUserSummaries } from "./event-broadcast";

export type { UserSummary, ResolveUserSummaries };

export function buildChannelCreatedPayload(raw: {
  channel_id: string; kind: string; visibility: string; title: string;
  actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return {
    channel: { channel_id: raw.channel_id, kind: raw.kind, visibility: raw.visibility, title: raw.title },
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
  };
}

export function buildChannelUpdatedPayload(raw: {
  channel_id: string; channel_changes: Record<string, { before: unknown; after: unknown }>;
  actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, channel_changes: raw.channel_changes, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
}

export function buildChannelDissolvedPayload(raw: {
  channel_id: string; dissolved_at: string; actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, status: "dissolved", dissolved_at: raw.dissolved_at, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
}

export function buildMemberJoinedPayload(raw: {
  channel_id: string; user_id: string; role: string; membership_version: number;
  actor_kind: string; actor_id: string;
  join_source?: "invite" | "public" | "admin_add" | "initial" | null;
  inviter_user_id?: string | null;
}): Record<string, unknown> {
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
  channel_id: string; user_id: string; before_role: string; after_role: string; membership_version: number;
  actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, user_id: raw.user_id, before_role: raw.before_role, after_role: raw.after_role, membership_version: raw.membership_version, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
}

export function buildMemberLeftPayload(raw: {
  channel_id: string; user_id: string; role: string; membership_version: number;
  actor_kind: string; actor_id: string;
  leave_source?: "self" | "removed" | null;
}): Record<string, unknown> {
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
  channel_id: string; user_id: string; last_read_event_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, user_id: raw.user_id, last_read_event_id: raw.last_read_event_id };
}

export function buildBotInstalledPayload(raw: {
  channel_id: string; bot_id: string; actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, bot_id: raw.bot_id, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
}

export function buildBotUpdatedPayload(raw: {
  channel_id: string; bot_id: string; status: string;
  changes: Record<string, { before: unknown; after: unknown }> | null;
  actor_kind: string; actor_id: string;
}): Record<string, unknown> {
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
  channel_id: string; bot_id: string; bot_command_id: string;
  binding_changes: Record<string, { before: unknown; after: unknown }>;
  actor_kind: string; actor_id: string;
}): Record<string, unknown> {
  return {
    channel_id: raw.channel_id,
    bot_id: raw.bot_id,
    bot_command_id: raw.bot_command_id,
    binding_changes: raw.binding_changes,
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
  };
}

// Wire projection: resolve actor (and target_user) refs to UserSummary at output time.
// System actor → actor: null (no resolution). Falls back to user-<shortid> when pg has no row.
export function resolveActorWithMap(
  payload: Record<string, unknown>,
  map: Map<string, UserSummary>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  const actorKind = typeof out.actor_kind === "string" ? out.actor_kind : "";
  const actorId = typeof out.actor_id === "string" ? out.actor_id : "";

  if (actorKind === "user" && actorId) {
    const u = map.get(actorId) ?? { user_id: actorId, display_name: `user-${actorId.slice(0, 8)}`, avatar_url: null };
    out.actor = u;
  } else if (actorKind === "system") {
    out.actor = null;
  }
  delete out.actor_id;
  delete out.actor_kind;

  const targetUserId = typeof out.target_user_id === "string" ? out.target_user_id : null;
  if (targetUserId) {
    const u = map.get(targetUserId) ?? { user_id: targetUserId, display_name: `user-${targetUserId.slice(0, 8)}`, avatar_url: null };
    out.target_user = u;
  } else {
    out.target_user = null;
  }
  delete out.target_user_id;

  const subjectUserId = typeof out.user_id === "string" ? out.user_id : null;
  if (subjectUserId) {
    out.user = map.get(subjectUserId) ?? { user_id: subjectUserId, display_name: `user-${subjectUserId.slice(0, 8)}`, avatar_url: null };
    delete out.user_id;
  }

  const inviterUserId = typeof out.inviter_user_id === "string" ? out.inviter_user_id : null;
  if (inviterUserId) {
    out.inviter = map.get(inviterUserId) ?? { user_id: inviterUserId, display_name: `user-${inviterUserId.slice(0, 8)}`, avatar_url: null };
    delete out.inviter_user_id;
  }

  return out;
}

// Async injected-resolver variant — used by unit tests. Prod code uses resolveActorWithMap
// (sync) after pre-resolving via Hyperdrive BEFORE the DO transaction.
export async function resolveActorForLiveBroadcast(
  payload: Record<string, unknown>,
  resolveUserSummaries: ResolveUserSummaries,
): Promise<Record<string, unknown>> {
  const ids: string[] = [];
  const actorKind = typeof payload.actor_kind === "string" ? payload.actor_kind : "";
  const actorId = typeof payload.actor_id === "string" ? payload.actor_id : "";
  if (actorKind === "user" && actorId) ids.push(actorId);
  const targetUserId = typeof payload.target_user_id === "string" ? payload.target_user_id : null;
  if (targetUserId) ids.push(targetUserId);
  const subjectUserId = typeof payload.user_id === "string" ? payload.user_id : null;
  if (subjectUserId) ids.push(subjectUserId);
  const inviterUserId = typeof payload.inviter_user_id === "string" ? payload.inviter_user_id : null;
  if (inviterUserId) ids.push(inviterUserId);
  const map = ids.length > 0 ? await resolveUserSummaries(ids) : new Map<string, UserSummary>();
  return resolveActorWithMap(payload, map);
}
