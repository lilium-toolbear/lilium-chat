import type { ChatId, IsoDateTimeString, UserSummary } from "./primitives";

export type MessageSender =
  | {
      kind: "user";
      user: UserSummary;
    }
  | {
      kind: "bot";
      bot: {
        bot_id: ChatId;
        display_name: string;
        avatar_url: string | null;
      };
    };

/** Bot sender before BotRegistry resolution (Phase 7). */
export type UnresolvedBotSender = {
  kind: "bot";
  bot_id: string | null;
};

export type WireMessageSender = MessageSender | UnresolvedBotSender | { kind: string };

export type MessageType = "text" | "image" | "sticker" | "system";
export type MessageFormat = "plain" | "markdown" | "unsafe-markdown";
export type MessageLifecycleStatus = "normal" | "edited" | "deleted" | "recalled" | "failed";
export type MessageStreamState = "none" | "streaming" | "final" | "abandoned";

export interface ReplySnapshotMediaPreview {
  kind: "image" | "sticker";
  url: string;
  blurhash: string | null;
  width: number;
  height: number;
}

export interface ReplySnapshot {
  message_id: ChatId;
  sender_display_name: string;
  text_preview: string;
  status: MessageLifecycleStatus;
  media_preview?: ReplySnapshotMediaPreview | null;
}

export interface Attachment {
  attachment_id: ChatId;
  kind: "image";
  filename: string;
  mime_type: string;
  size_bytes: number;
  width: number;
  height: number;
  blurhash: string | null;
  url: string;
}

/** Message attachment projection omits kind/filename (contract §3.6). */
export interface MessageImageAttachment {
  attachment_id: ChatId;
  url: string;
  mime_type: string;
  size_bytes: number;
  width: number;
  height: number;
  blurhash: string | null;
}

/** Finalize/upload response includes kind (image, avatar, …). */
export interface FinalizedAttachmentProjection {
  attachment_id: ChatId;
  kind: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  width: number;
  height: number;
  blurhash: string | null;
  url: string;
}

export interface Mention {
  user_id: ChatId;
  start: number;
  end: number;
}

export interface StickerMessageProjection {
  sticker_id: ChatId;
  attachment_id: ChatId;
  url: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  blurhash: string | null;
}

export interface MessageComponentBase {
  component_id: ChatId;
  custom_id: string;
  disabled: boolean;
  interaction_policy?: "multi" | "per_user_once" | "exclusive" | "targeted";
  target_user_id?: ChatId;
}

export interface ButtonMessageComponent extends MessageComponentBase {
  kind: "button";
  style: "primary" | "secondary" | "danger";
  label: string;
}

export interface SelectMessageComponent extends MessageComponentBase {
  kind: "select";
  label: string;
  options: Array<{
    value: string;
    label: string;
  }>;
}

export interface RadioMessageComponent extends MessageComponentBase {
  kind: "radio";
  label: string;
  options: Array<{
    value: string;
    label: string;
  }>;
}

export interface CheckboxMessageComponent extends MessageComponentBase {
  kind: "checkbox";
  label: string;
  default_checked: boolean;
}

export interface CheckboxGroupMessageComponent extends MessageComponentBase {
  kind: "checkbox_group";
  label: string;
  submit_label: string;
  options: Array<{
    value: string;
    label: string;
  }>;
  min_selected: number;
  max_selected: number;
}

export interface TextInputMessageComponent extends MessageComponentBase {
  kind: "text_input";
  label: string;
  placeholder?: string;
  multiline: boolean;
  min_length: number;
  max_length: number;
  submit_label: string;
}

export type MessageComponent =
  | ButtonMessageComponent
  | SelectMessageComponent
  | RadioMessageComponent
  | CheckboxMessageComponent
  | CheckboxGroupMessageComponent
  | TextInputMessageComponent;

export interface CommandInvocationProjection {
  bot_command_id: ChatId;
  invoked_name: string;
  options: Record<string, { type: string; value: unknown }>;
}

/** Optional message the user was replying to when invoking a slash command. */
export interface CommandInvocationReplyContext {
  message_id: ChatId;
  sender: WireMessageSender;
  type: MessageType;
  status: MessageLifecycleStatus;
  text: string | null;
}

export interface ChatMessage {
  message_id: ChatId;
  command_id: ChatId;
  channel_id: ChatId;
  sender: MessageSender;
  type: MessageType;
  format: MessageFormat;
  status: MessageLifecycleStatus;
  stream_state: MessageStreamState;
  text: string | null;
  reply_to: ChatId | null;
  reply_snapshot: ReplySnapshot | null;
  attachments: Attachment[];
  sticker: StickerMessageProjection | null;
  components: MessageComponent[];
  mentions: Mention[];
  command_invocation?: CommandInvocationProjection | null;
  created_at: IsoDateTimeString;
  updated_at: IsoDateTimeString;
  edited_at: IsoDateTimeString | null;
  deleted_at: IsoDateTimeString | null;
  recalled_at: IsoDateTimeString | null;
}

/** Browser-visible message; bot senders may be unresolved until Phase 7. */
export type WireChatMessage = Omit<ChatMessage, "sender" | "attachments"> & {
  sender: WireMessageSender;
  attachments: MessageImageAttachment[];
};
