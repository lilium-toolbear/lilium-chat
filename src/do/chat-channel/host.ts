import type { Env } from "../../env";
import type { UserSummary as LiveUserSummary } from "../../chat/event-broadcast";
import type {
  ManagementPersistedEventType,
  ManagementPersistedPayload,
  MessageRow,
} from "../../contract/persisted";
import type { ChannelDirectorySnapshotFields, UserDirectoryOutboxPayload } from "../../contract/outbox";

export interface ChatChannelHost {
  readonly ctx: DurableObjectState;
  readonly env: Env;

  nowIso(): string;
  nextEventId(nowMs?: number): string;
  resolveActorMap(userIds: string[]): Promise<Map<string, LiveUserSummary>>;
  persistEventAndFanout<T extends ManagementPersistedEventType>(
    eventId: string,
    eventType: T,
    channelId: string,
    occurredAt: string,
    payload: ManagementPersistedPayload,
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
  insertUserDirectoryOutbox(
    userId: string,
    payload: UserDirectoryOutboxPayload,
    nowIso: string,
    outboxId: string,
  ): void;
  insertOutboxRowForChannelDirectory(
    channelId: string,
    action: "upsert" | "delete",
    snapshot: ChannelDirectorySnapshotFields | null,
    nowIso: string,
  ): void;
  readChannelDirectorySnapshot(channelId: string, nowIso: string): ChannelDirectorySnapshotFields | null;
  scheduleOutboxAlarm(nowIso?: string): Promise<void>;
  scheduleArchiveAlarm(nowIso?: string): Promise<void>;
  markMemberLeftAndEnqueueFanoutUnregister(channelId: string, userId: string, nowIso: string): Promise<void>;
  markMemberLeftAndEnqueueFanoutUnregisterSync(channelId: string, userId: string, nowIso: string): void;
  applyMessageMutation(input: {
    userId: string;
    operationId: string;
    channelId: string;
    messageId: string;
    operation: "message.edit" | "message.recall" | "message.delete";
    requestHash: string;
    reason: string | null;
    mutate: (row: MessageRow) => {
      eventType: "message.updated" | "message.recalled" | "message.deleted";
      fields: Partial<MessageRow>;
    };
  }): Promise<Response>;
  requireChannelKindChannel():
    | { ok: true; meta: { channel_id: string; kind: string; visibility: string; status: string; membership_version: number; member_count: number } }
    | { ok: false; response: Response };
  cachedResponse(j: string): Response;
  activeRole(channelId: string, userId: string): string | null;
  assertNotDissolved(status: string): { code: string; message: string } | null;
  flushSingleInviteDirectoryOutbox(outboxId: string, nowIso: string): Promise<boolean>;
  handleBotInstall(request: Request): Promise<Response>;
  handleBotInstallUpdate(request: Request): Promise<Response>;
  handleCommandBindingUpdate(request: Request): Promise<Response>;
  handleChannelCommands(request: Request): Promise<Response>;
}
