import { buildChannelMetaProjectionForMember } from "../../../chat/channel-meta-projection";
import type { ChannelMetaProjection } from "../../../contract/channel-api";
import type { ResolveVisibleAttachmentRpcInput, VisibleAttachmentResponse } from "../../../contract/chat-channel-rpc";
import { ApiError } from "../../../errors";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";

export function ChannelReadMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    getSummary(userId: string): ChannelMetaProjection {
      const summary = buildChannelMetaProjectionForMember(this.ctx.storage.sql, userId);
      if (summary === null) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel not created");
      }
      if (summary.visibility === "private" && summary.my_role == null) {
        throw new ApiError("FORBIDDEN", "not a member");
      }
      return summary;
    }

    getUnreadCount(userId: string, after: string): { unread_count: number } {
      const realMeta = this.repo.soleChannelMetaChannelId();
      if (!realMeta) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
      const total = this.repo.channelMessageCreatedCountSince(realMeta.channel_id, after);
      const ownCount = this.repo.channelOwnMessageCreatedCountSince(realMeta.channel_id, after, userId);
      return { unread_count: Math.max(0, total - ownCount) };
    }

    async resolveVisibleAttachment(input: ResolveVisibleAttachmentRpcInput): Promise<VisibleAttachmentResponse> {
      const userId = input.user_id;
      const attachmentId = input.attachment_id;

      const meta = this.repo.soleChannelMetaVisibilityGate();
      if (!meta) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel not created");
      }

      if (!this.repo.isActiveMember(meta.channel_id, userId)) {
        throw new ApiError("FORBIDDEN", "not a member");
      }

      const visibleRow = this.repo.visibleAttachmentInChannel(attachmentId, meta.channel_id);
      if (!visibleRow) {
        throw new ApiError("INVALID_STICKER_SOURCE", "attachment is not a visible image or sticker");
      }

      return {
        attachment: {
          attachment_id: visibleRow.attachment_id,
          url: visibleRow.url,
          mime_type: visibleRow.mime_type,
          width: visibleRow.width,
          height: visibleRow.height,
          size_bytes: visibleRow.size_bytes,
          blurhash: visibleRow.blurhash,
        },
      };
    }
  };
}
