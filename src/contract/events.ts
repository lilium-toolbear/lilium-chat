/** Copied from toolbear_ui/frontend/src/types/chatEvents.ts — keep in sync manually until shared package. */

import type { ChannelDetail, ChannelMember, DissolvedChannelProjection } from "./channel";
import type { CommandManifestDelta } from "./bot-api";
import type { ChannelRole, ChannelVisibility } from "./primitives";
import type { ChatMessage, WireChatMessage } from "./message";
import type { ChatId, IsoDateTimeString, UserSummary } from "./primitives";

export type ChatEventType =
  | "message.created"
  | "message.updated"
  | "message.deleted"
  | "message.recalled"
  | "message.stream_started"
  | "message.stream_delta"
  | "message.stream_finalized"
  | "member.joined"
  | "member.left"
  | "member.removed"
  | "member.role_updated"
  | "channel.created"
  | "channel.updated"
  | "channel.archived"
  | "channel.dissolved"
  | "bot.installed"
  | "bot.updated"
  | "command.binding_updated"
  | "command.invoked"
  | "command.completed"
  | "command.failed"
  | "stateful_session.started"
  | "stateful_session.updated"
  | "stateful_session.closed"
  | "interaction.created"
  | "interaction.completed"
  | "interaction.failed";

export const CHAT_EVENT_TYPES = [
  "message.created",
  "message.updated",
  "message.deleted",
  "message.recalled",
  "message.stream_started",
  "message.stream_delta",
  "message.stream_finalized",
  "member.joined",
  "member.left",
  "member.removed",
  "member.role_updated",
  "channel.created",
  "channel.updated",
  "channel.archived",
  "channel.dissolved",
  "bot.installed",
  "bot.updated",
  "command.binding_updated",
  "command.invoked",
  "command.completed",
  "command.failed",
  "stateful_session.started",
  "stateful_session.updated",
  "stateful_session.closed",
  "interaction.created",
  "interaction.completed",
  "interaction.failed",
] as const satisfies readonly ChatEventType[];

export const DOMAIN_TIMELINE_EVENT_TYPES = [
  "channel.created",
  "channel.updated",
  "channel.archived",
  "channel.dissolved",
  "member.joined",
  "member.left",
  "member.role_updated",
  "bot.installed",
  "bot.updated",
  "command.binding_updated",
  "stateful_session.started",
  "stateful_session.updated",
  "stateful_session.closed",
] as const satisfies readonly ChatEventType[];

export type DomainTimelineEventType = (typeof DOMAIN_TIMELINE_EVENT_TYPES)[number];

/** Event types returned by channel timeline history HTTP (`GET .../messages`, bootstrap). */
export const TIMELINE_HISTORY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message.created",
  ...DOMAIN_TIMELINE_EVENT_TYPES,
]);

const DOMAIN_TIMELINE_EVENT_TYPE_SET = new Set<string>(DOMAIN_TIMELINE_EVENT_TYPES);
const CHAT_EVENT_TYPE_SET = new Set<string>(CHAT_EVENT_TYPES);

/** Event types replay re-projects against current message.status. */
export const REPLAY_MESSAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message.created",
  "message.updated",
  "message.recalled",
  "message.deleted",
]);

/** Management events replay resolves actor refs to live UserSummary. */
export const REPLAY_MANAGEMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "channel.created",
  "channel.updated",
  "channel.dissolved",
  "member.joined",
  "member.left",
  "member.removed",
  "member.role_updated",
  "bot.installed",
  "bot.updated",
  "command.binding_updated",
  "stateful_session.started",
  "stateful_session.updated",
  "stateful_session.closed",
]);

export function isDomainTimelineEventType(type: string): type is DomainTimelineEventType {
  return DOMAIN_TIMELINE_EVENT_TYPE_SET.has(type);
}

export function isChatEventType(value: string): value is ChatEventType {
  return CHAT_EVENT_TYPE_SET.has(value);
}

export interface FieldChange<T> {
  before: T;
  after: T;
}

export interface ChannelFieldChanges {
  title?: FieldChange<string>;
  topic?: FieldChange<string | null>;
  avatar_url?: FieldChange<string | null>;
  visibility?: FieldChange<ChannelVisibility>;
}

export type ResolvedEventActor = UserSummary | null;

export interface MemberEventSubjectFields {
  user?: UserSummary;
  member?: ChannelMember;
  target_user?: UserSummary | null;
  user_id?: ChatId;
}

export type MemberJoinSource = "invite" | "public" | "admin_add" | "initial";
export type MemberLeaveSource = "self" | "removed";

export interface MessageProjectionEventPayload {
  channel_id?: ChatId;
  event_id?: ChatId;
  message: WireChatMessage;
}

export interface MessageStreamStartedPayload {
  channel_id?: ChatId;
  event_id?: ChatId;
  message: WireChatMessage;
}

export interface MessageStreamDeltaPayload {
  channel_id?: ChatId;
  message_id: ChatId;
  delta: string;
}

export interface MessageStreamFinalizedPayload {
  channel_id?: ChatId;
  message_id?: ChatId;
  message?: WireChatMessage;
}

export interface ChannelCreatedEventPayload {
  channel: Pick<ChannelDetail, "channel_id" | "kind" | "visibility" | "title">;
  actor?: ResolvedEventActor;
}

export interface ChannelUpdatedEventPayload {
  channel_id?: ChatId;
  channel_changes?: ChannelFieldChanges | null;
  channel?: ChannelDetail;
  actor?: ResolvedEventActor;
}

export interface ChannelArchivedEventPayload {
  channel_id: ChatId;
  actor?: ResolvedEventActor;
}

export interface ChannelDissolvedEventPayload {
  channel_id?: ChatId;
  status?: "dissolved";
  dissolved_at?: IsoDateTimeString;
  channel?: DissolvedChannelProjection;
  actor?: ResolvedEventActor;
}

export interface MemberJoinedEventPayload extends MemberEventSubjectFields {
  channel_id?: ChatId;
  role?: ChannelRole;
  membership_version?: number;
  join_source?: MemberJoinSource | null;
  inviter?: UserSummary | null;
  actor?: ResolvedEventActor;
}

export interface MemberLeftEventPayload extends MemberEventSubjectFields {
  channel_id?: ChatId;
  role?: ChannelRole;
  membership_version?: number;
  leave_source?: MemberLeaveSource | null;
  actor?: ResolvedEventActor;
}

export interface MemberRemovedEventPayload extends MemberEventSubjectFields {
  channel_id?: ChatId;
  user_id: ChatId;
}

export interface MemberRoleUpdatedEventPayload extends MemberEventSubjectFields {
  channel_id?: ChatId;
  before_role?: ChannelRole;
  after_role?: ChannelRole;
  membership_version?: number;
  actor?: ResolvedEventActor;
}

export interface BotInstalledEventPayload {
  channel_id: ChatId;
  bot_id: ChatId;
  actor?: ResolvedEventActor;
}

export interface BotUpdatedEventPayload {
  channel_id: ChatId;
  bot_id: ChatId;
  status: string;
  changes: Record<string, FieldChange<unknown>> | null;
  actor?: ResolvedEventActor;
}

export interface CommandBindingUpdatedEventPayload {
  channel_id: ChatId;
  bot_id: ChatId;
  bot_command_id: ChatId;
  binding_changes: Record<string, FieldChange<unknown>>;
  actor?: ResolvedEventActor;
  command_manifest_delta: CommandManifestDelta;
}

export interface StatefulSessionSummary {
  session_id: string;
  bot_command_id: string;
  command_name: string;
  status: string;
  started_by: UserSummary;
  started_at: IsoDateTimeString;
  expires_at: IsoDateTimeString;
}

export interface StatefulSessionStartedPayload {
  session: StatefulSessionSummary;
}

export interface StatefulSessionUpdatedPayload {
  session: StatefulSessionSummary;
}

export interface StatefulSessionClosedPayload {
  session_id: string;
  bot_command_id: string;
  command_name: string;
  status: string;
  reason: string;
  closed_at: IsoDateTimeString;
}

export interface CommandInvokedEventPayload {
  invocation: {
    invocation_id: ChatId;
    status: string;
    created_at: IsoDateTimeString;
  };
  command_id?: ChatId;
}

export interface CommandCompletedEventPayload {
  command_id: ChatId;
  channel_id?: ChatId;
  event_id?: ChatId;
  message?: ChatMessage;
}

export interface CommandFailedEventPayload {
  command_id: ChatId;
  error_code?: string;
  error_message?: string;
  retryable?: boolean;
}

export interface InteractionCreatedEventPayload {
  interaction: {
    interaction_id: ChatId;
    status: string;
    created_at: IsoDateTimeString;
  };
  command_id?: ChatId;
}

export interface InteractionCompletedEventPayload {
  command_id: ChatId;
  channel_id?: ChatId;
  event_id?: ChatId;
  message?: ChatMessage;
}

export interface InteractionFailedEventPayload {
  command_id: ChatId;
  error_code?: string;
  error_message?: string;
  retryable?: boolean;
}

export interface DomainTimelineEventPayloadByType {
  "channel.created": ChannelCreatedEventPayload;
  "channel.updated": ChannelUpdatedEventPayload;
  "channel.archived": ChannelArchivedEventPayload;
  "channel.dissolved": ChannelDissolvedEventPayload;
  "member.joined": MemberJoinedEventPayload;
  "member.left": MemberLeftEventPayload;
  "member.role_updated": MemberRoleUpdatedEventPayload;
  "bot.installed": BotInstalledEventPayload;
  "bot.updated": BotUpdatedEventPayload;
  "command.binding_updated": CommandBindingUpdatedEventPayload;
  "stateful_session.started": StatefulSessionStartedPayload;
  "stateful_session.updated": StatefulSessionUpdatedPayload;
  "stateful_session.closed": StatefulSessionClosedPayload;
}

export type DomainTimelineEventPayload<T extends DomainTimelineEventType = DomainTimelineEventType> =
  DomainTimelineEventPayloadByType[T];

export interface ChatEventPayloadByType {
  "message.created": MessageProjectionEventPayload;
  "message.updated": MessageProjectionEventPayload;
  "message.deleted": MessageProjectionEventPayload;
  "message.recalled": MessageProjectionEventPayload;
  "message.stream_started": MessageStreamStartedPayload;
  "message.stream_delta": MessageStreamDeltaPayload;
  "message.stream_finalized": MessageStreamFinalizedPayload;
  "member.joined": MemberJoinedEventPayload;
  "member.left": MemberLeftEventPayload;
  "member.removed": MemberRemovedEventPayload;
  "member.role_updated": MemberRoleUpdatedEventPayload;
  "channel.created": ChannelCreatedEventPayload;
  "channel.updated": ChannelUpdatedEventPayload;
  "channel.archived": ChannelArchivedEventPayload;
  "channel.dissolved": ChannelDissolvedEventPayload;
  "bot.installed": BotInstalledEventPayload;
  "bot.updated": BotUpdatedEventPayload;
  "command.binding_updated": CommandBindingUpdatedEventPayload;
  "command.invoked": CommandInvokedEventPayload;
  "command.completed": CommandCompletedEventPayload;
  "command.failed": CommandFailedEventPayload;
  "stateful_session.started": StatefulSessionStartedPayload;
  "stateful_session.updated": StatefulSessionUpdatedPayload;
  "stateful_session.closed": StatefulSessionClosedPayload;
  "interaction.created": InteractionCreatedEventPayload;
  "interaction.completed": InteractionCompletedEventPayload;
  "interaction.failed": InteractionFailedEventPayload;
}

export type TypedChatEventFrame<T extends ChatEventType> = {
  frame_type: "event";
  event_id: ChatId;
  type: T;
  channel_id: ChatId;
  occurred_at: IsoDateTimeString;
  payload: ChatEventPayloadByType[T];
};

export type ChatEventFrame = {
  [K in ChatEventType]: TypedChatEventFrame<K>;
}[ChatEventType];

export interface UnknownChatEventFrame {
  frame_type: "event";
  event_id: ChatId;
  type: string;
  channel_id: ChatId;
  occurred_at: IsoDateTimeString;
  payload: Record<string, unknown>;
}

export type IncomingChatEventFrame = ChatEventFrame | UnknownChatEventFrame;

export type DomainTimelineChatEventFrame<T extends DomainTimelineEventType = DomainTimelineEventType> =
  TypedChatEventFrame<T>;
