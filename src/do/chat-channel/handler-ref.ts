import type { Env } from "../../env";
import type { UserSummary as LiveUserSummary } from "../../chat/event-broadcast";
import type {
  ManagementPersistedEventType,
  ManagementPersistedPayload,
  ManagementPersistedPayloadByType,
} from "../../contract/persisted";
import type { ChannelDirectorySnapshotFields, UserDirectoryOutboxPayload } from "../../contract/outbox";
import type { ChatChannelRepository } from "./data/repository";

/**
 * pub(crate) view for handler-module helpers that live outside the mixin class body.
 * Composed DO instances are cast to this at helper boundaries.
 */
export interface ChatChannelHandlerRef {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly repo: ChatChannelRepository;

  nowIso(): string;
  nextEventId(nowMs?: number): string;
  resolveActorMap(userIds: string[]): Promise<Map<string, LiveUserSummary>>;
  persistEventAndFanout<T extends ManagementPersistedEventType>(
    eventId: string,
    type: T,
    channelId: string,
    occurredAt: string,
    persistedPayload: ManagementPersistedPayloadByType[T],
    membershipVersion: number,
    nowIso: string,
    actorMap: Map<string, LiveUserSummary>,
  ): void;
  insertOutboxRowForFanout(
    channelId: string,
    eventId: string,
    eventFrameJson: string,
    membershipVersionAtEvent: number,
    nowIso: string,
  ): void;
  readChannelDirectorySnapshot(channelId: string, nowIso: string): ChannelDirectorySnapshotFields | null;
  insertOutboxRowForChannelDirectory(
    channelId: string,
    action: "upsert" | "delete",
    snapshot: ChannelDirectorySnapshotFields | null,
    nowIso: string,
  ): void;
  insertUserDirectoryOutbox(
    targetUserId: string,
    payload: UserDirectoryOutboxPayload,
    nowIso: string,
    outboxId: string,
  ): void;
  markMemberLeftAndEnqueueFanoutUnregisterSync(channelId: string, userId: string, nowIso: string): void;
  markMemberLeftAndEnqueueFanoutUnregister(channelId: string, userId: string, nowIso: string): Promise<void>;
  scheduleOutboxAlarm(nowIso?: string): Promise<void>;
  scheduleArchiveAlarm(nowIso?: string): Promise<void>;
  flushSingleInviteDirectoryOutbox(outboxId: string, nowIso: string): Promise<boolean>;
  assertNotDissolved(status: string): { code: string; message: string } | null;
  activeRole(channelId: string, userId: string): string | null;
  assertChannelKindChannel(): NonNullable<ReturnType<ChatChannelRepository["soleChannelMetaJoinHeader"]>>;
}

export function asHandlerRef(channel: object): ChatChannelHandlerRef {
  return channel as ChatChannelHandlerRef;
}
