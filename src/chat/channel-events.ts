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
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, user_id: raw.user_id, role: raw.role, membership_version: raw.membership_version, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
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
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, user_id: raw.user_id, role: raw.role, membership_version: raw.membership_version, actor_kind: raw.actor_kind, actor_id: raw.actor_id };
}

export function buildReadStateUpdatedPayload(raw: {
  channel_id: string; user_id: string; last_read_event_id: string;
}): Record<string, unknown> {
  return { channel_id: raw.channel_id, user_id: raw.user_id, last_read_event_id: raw.last_read_event_id };
}

// Persisted ref shape per design §3.5a: only refs + structural fields, NO UserSummary.
export function buildSystemNoticePayload(raw: {
  notice_kind: string; actor_kind: string; actor_id: string;
  target_user_id: string | null; message_id: string | null;
  channel_changes: Record<string, { before: unknown; after: unknown }> | null;
  /** Phase 7 bot setting notices (bot.installed / bot.updated / command.binding_updated / bot.subscription_updated). */
  bot_id?: string | null;
  bot_command_id?: string | null;
  binding_changes?: Record<string, { before: unknown; after: unknown }> | null;
}): Record<string, unknown> {
  return {
    notice_kind: raw.notice_kind,
    actor_kind: raw.actor_kind,
    actor_id: raw.actor_id,
    target_user_id: raw.target_user_id,
    message_id: raw.message_id,
    channel_changes: raw.channel_changes,
    bot_id: raw.bot_id ?? null,
    bot_command_id: raw.bot_command_id ?? null,
    binding_changes: raw.binding_changes ?? null,
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
  const map = ids.length > 0 ? await resolveUserSummaries(ids) : new Map<string, UserSummary>();
  return resolveActorWithMap(payload, map);
}
