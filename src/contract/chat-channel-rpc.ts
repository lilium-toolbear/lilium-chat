/** ChatChannel Durable Object public RPC — inputs and response type re-exports. */

export type {
  AcceptInviteApiResponse,
  AddMemberApiResponse,
  ChannelMetaProjection,
  CreateChannelRpcResult,
  CreateDmApiResponse,
  CreateInviteApiResponse,
  DissolveChannelApiResponse,
  InvitePreviewApiResponse,
  JoinChannelApiResponse,
  ListMembersApiResponse,
  MemberProjection,
  RemoveMemberApiResponse,
  TransferOwnerApiResponse,
  UpdateChannelApiResponse,
  UpdateMemberRoleApiResponse,
} from "./channel-api";

export type {
  BotDeliveryResultInput,
  BotDeliveryResultResponse,
  CommandBindingUpdateResponse,
  CommandInvokeResponse,
  CommandManifestResponse,
  InteractionSubmitResponse,
  StreamRegistryCheckResponse,
  StreamRegistryPeekResponse,
  VisibleAttachmentResponse,
} from "./bot-api";

export type {
  BotSessionAckResponse,
  GetStatefulSessionResponse,
  StatefulSessionInputsResponse,
  StopStatefulSessionResponse,
} from "./stateful-session-api";

export type { MessageMutationAckPayload } from "./idempotency";

export type {
  StartStreamEffectResponse,
  StreamAbandonResponse,
  StreamFinalizeResponse,
} from "../chat/stream-registry";

// --- Member ---

export interface MemberMutationRpcInput {
  /** Authenticated caller (owner/admin performing the action). */
  user_id: string;
  idempotency_key: string;
  channel_id: string;
  /** Member being added, updated, or removed. */
  target_user_id: string;
}

export interface AddMemberRpcInput extends MemberMutationRpcInput {
  role: string;
}

export type UpdateMemberRoleRpcInput = AddMemberRpcInput;

export type RemoveMemberRpcInput = MemberMutationRpcInput;

export interface DebugLeaveMemberRpcInput {
  user_id: string;
}

// --- Channel ---

export interface CreateChannelRpcInput {
  user_id: string;
  channel_id: string;
  creator_user_id: string;
  title: string;
  topic: string | null;
  avatar_attachment_id: string | null;
  visibility: string;
  initial_members: Array<{ user_id: string; role: string }>;
}

export interface CreateDmRpcInput {
  user_id: string;
  channel_id: string;
  user_a: string;
  user_b: string;
  created_by: string;
}

export interface GetInviteRpcInput {
  user_id: string;
  invite_code: string;
  channel_id: string;
}

export interface UpdateChannelRpcInput {
  user_id: string;
  idempotency_key: string;
  channel_id: string;
  title?: string;
  topic?: string | null;
  avatar_attachment_id?: string | null;
  visibility?: string;
}

export interface DissolveChannelRpcInput {
  user_id: string;
  idempotency_key: string;
  channel_id: string;
}

export interface TransferOwnerRpcInput {
  user_id: string;
  operation_id: string;
  channel_id: string;
  target_user_id: string;
  previous_owner_role: string;
}

export interface CreateInviteRpcInput {
  user_id: string;
  operation_id: string;
  channel_id: string;
  expires_in_seconds?: number;
  max_uses?: number | null;
}

export interface AcceptInviteRpcInput {
  user_id: string;
  operation_id: string;
  channel_id: string;
  invite_code: string;
}

export interface JoinChannelRpcInput {
  user_id: string;
  operation_id?: string | null;
  caller_user_id?: string | null;
}

export interface ResolveVisibleAttachmentRpcInput {
  user_id: string;
  attachment_id: string;
}

// --- Message ---

export interface MessageSendRpcInput {
  user_id: string;
  command_id: string;
  dedupe_principal_key: string;
  type: string;
  text: string;
  reply_to: string | null;
  attachment_ids: string[];
  sticker_id?: string;
  mentions: Array<{ user_id: string; start: number; end: number }>;
  channel_id: string;
}

export interface MessageMutateRpcInput {
  user_id: string;
  operation: "message.edit" | "message.recall" | "message.delete";
  operation_id: string;
  message_id: string;
  channel_id: string;
  text?: string;
  reason?: string | null;
}

export interface GetMessagesRpcInput {
  before: string | null;
  after: string | null;
  limit: number;
}

// --- Command ---

export interface CommandBindingUpdateRpcInput {
  user_id: string;
  operation_id: string;
  channel_id: string;
  bot_command_id: string;
  status: "allowed" | "blocked";
  permission_override: string | null;
  stateful_max_ttl_seconds: number | null;
  command_snapshot: unknown;
}

export interface InvokeCommandRpcInput {
  user_id: string;
  operation_id: string;
  channel_id: string;
  bot_command_id: string;
  invoked_name: string;
  command_manifest_version: number;
  options: Record<string, { type: string; value: unknown }>;
  reply_to_message_id: string | null;
}

// --- Interaction ---

export interface InteractionSubmitRpcInput {
  user_id: string;
  operation_id: string;
  channel_id: string;
  message_id: string;
  component_id: string;
  custom_id: string;
  value: unknown;
}

// --- Stateful ---

export interface StopStatefulSessionRpcInput {
  user_id: string;
  channel_id: string;
  session_id: string;
  reason: string;
  operation_id: string;
}

export interface StatefulSessionInputsRpcInput {
  session_id: string;
}

export interface GetStatefulSessionRpcInput {
  channel_id: string;
}

export interface BotSessionStartedRpcInput {
  session_id: string;
}

export interface BotSessionInputAckRpcInput {
  session_id: string;
  last_received_seq: number;
}

export interface BotSessionCloseRpcInput {
  session_id: string;
  reason?: string;
}

// --- Stream ---

export interface StreamRegistryCheckRpcInput {
  channel_id: string;
  message_id: string;
  bot_id: string;
}

export type StreamRegistryPeekRpcInput = StreamRegistryCheckRpcInput;

export interface StreamRegistryRegisterRpcInput {
  channel_id: string;
  bot_id: string;
  client_effect_id: string;
  request_hash: string;
  sender_bot_display_name: string;
  sender_bot_avatar_url?: string | null;
  message?: unknown;
}

export interface StreamFinalizeRpcInput {
  channel_id: string;
  message_id: string;
  bot_id: string;
  resolved_text: string;
  finalize_request_hash: string;
  final_seq: number;
  components?: unknown[];
  attachment_ids?: string[];
}

export interface StreamAbandonRpcInput {
  channel_id: string;
  message_id: string;
  bot_id: string;
  resolved_partial: string;
  abandoned_text_hash: string;
}
