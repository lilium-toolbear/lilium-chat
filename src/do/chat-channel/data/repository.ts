import { decodeMemberListCursor, MEMBER_ROLE_ORDER_CASE } from "../../../chat/member-list-order";
import { sqlRow, sqlRows } from "../../shared/sql";
import {
  MESSAGE_LIFECYCLE_COLS,
  MESSAGE_REPLY_TARGET_COLS,
  sqlColumns,
  type MessageLifecycleRow,
  type MessageReplyTargetRow,
  type SyncSql,
} from "./queries";
import type {
  ChannelMetaAdminRow,
  ChannelMetaCommandRow,
  ChannelMetaDirectoryFieldsRow,
  ChannelMetaExistsRow,
  ChannelMetaIdStatusRow,
  ChannelMetaInviteAcceptRow,
  ChannelMetaInvitePreviewRow,
  ChannelMetaJoinHeaderRow,
  ChannelMetaKindRow,
  ChannelMetaKindStreamGateRow,
  ChannelMetaManifestGateRow,
  ChannelMetaManifestVersionRow,
  ChannelMetaMemberCountRow,
  ChannelMetaMembershipRow,
  ChannelMetaPublicProjectionRow,
  ChannelMetaStatusVisibilityRow,
  ChannelMetaStreamGateRow,
  ChannelMetaUpdateRow,
  ChannelMetaVisibilityGateRow,
  ActiveMemberListRow,
  ActiveMemberWithJoinedAtRow,
  InviteCreatedByRow,
  InviteRow,
  MemberJoinedAtRow,
  MemberLeftAtRow,
  MemberRoleRow,
  MemberRoleStatusRow,
  MentionRow,
  MessageLastActivityRow,
  SqlExistsRow,
} from "./schema";

/** Typed read accessors for ChatChannel SQLite tables. */
export class ChatChannelRepository {
  constructor(private readonly sql: SyncSql) {}

  // --- channel_meta ---

  soleChannelMetaSendGate(): Pick<ChannelMetaJoinHeaderRow, "channel_id" | "membership_version"> | undefined {
    return sqlRow<Pick<ChannelMetaJoinHeaderRow, "channel_id" | "membership_version">>(
      this.sql.exec(`SELECT ${sqlColumns("channel_id", "membership_version")} FROM channel_meta LIMIT 1`).toArray(),
    );
  }

  soleChannelMetaJoinHeader(): ChannelMetaJoinHeaderRow | undefined {
    return sqlRow<ChannelMetaJoinHeaderRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("channel_id", "kind", "visibility", "status", "membership_version", "member_count")} FROM channel_meta LIMIT 1`,
      ).toArray(),
    );
  }

  soleChannelMetaIdStatus(): ChannelMetaIdStatusRow | undefined {
    return sqlRow<ChannelMetaIdStatusRow>(
      this.sql.exec(`SELECT ${sqlColumns("channel_id", "status")} FROM channel_meta LIMIT 1`).toArray(),
    );
  }

  soleChannelMetaChannelId(): ChannelMetaExistsRow | undefined {
    return sqlRow<ChannelMetaExistsRow>(
      this.sql.exec(`SELECT ${sqlColumns("channel_id")} FROM channel_meta LIMIT 1`).toArray(),
    );
  }

  soleChannelMetaKind(): ChannelMetaKindRow | undefined {
    return sqlRow<ChannelMetaKindRow>(
      this.sql.exec(`SELECT ${sqlColumns("channel_id", "kind")} FROM channel_meta LIMIT 1`).toArray(),
    );
  }

  soleChannelMetaStreamGate(): ChannelMetaStreamGateRow | undefined {
    return sqlRow<ChannelMetaStreamGateRow>(
      this.sql.exec(`SELECT ${sqlColumns("channel_id", "status", "membership_version")} FROM channel_meta LIMIT 1`).toArray(),
    );
  }

  soleChannelMetaKindStreamGate(): ChannelMetaKindStreamGateRow | undefined {
    return sqlRow<ChannelMetaKindStreamGateRow>(
      this.sql.exec(`SELECT ${sqlColumns("channel_id", "kind", "status", "membership_version")} FROM channel_meta LIMIT 1`).toArray(),
    );
  }

  soleChannelMetaVisibilityGate(): ChannelMetaVisibilityGateRow | undefined {
    return sqlRow<ChannelMetaVisibilityGateRow>(
      this.sql.exec(`SELECT ${sqlColumns("channel_id", "visibility")} FROM channel_meta LIMIT 1`).toArray(),
    );
  }

  channelMetaMembership(channelId: string): ChannelMetaMembershipRow | undefined {
    return sqlRow<ChannelMetaMembershipRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("status", "visibility", "membership_version", "member_count")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaStatusVisibility(channelId: string): ChannelMetaStatusVisibilityRow | undefined {
    return sqlRow<ChannelMetaStatusVisibilityRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("status", "visibility")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaStatus(channelId: string): { status: string } | undefined {
    return sqlRow<{ status: string }>(
      this.sql.exec(`SELECT ${sqlColumns("status")} FROM channel_meta WHERE channel_id=?`, channelId).toArray(),
    );
  }

  channelMetaAdmin(channelId: string): ChannelMetaAdminRow | undefined {
    return sqlRow<ChannelMetaAdminRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("status", "visibility", "membership_version", "member_count", "kind", "created_by")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaOwnerTransfer(
    channelId: string,
  ): Pick<ChannelMetaAdminRow, "status" | "created_by" | "membership_version"> | undefined {
    return sqlRow<Pick<ChannelMetaAdminRow, "status" | "created_by" | "membership_version">>(
      this.sql.exec(
        `SELECT ${sqlColumns("status", "created_by", "membership_version")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaDissolveGate(
    channelId: string,
  ): Pick<ChannelMetaAdminRow, "status" | "visibility" | "created_by"> | undefined {
    return sqlRow<Pick<ChannelMetaAdminRow, "status" | "visibility" | "created_by">>(
      this.sql.exec(
        `SELECT ${sqlColumns("status", "visibility", "created_by")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaMembershipVersionKind(
    channelId: string,
  ): Pick<ChannelMetaAdminRow, "membership_version" | "kind"> | undefined {
    return sqlRow<Pick<ChannelMetaAdminRow, "membership_version" | "kind">>(
      this.sql.exec(
        `SELECT ${sqlColumns("membership_version", "kind")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaMembershipVersion(channelId: string): { membership_version: number } | undefined {
    return sqlRow<{ membership_version: number }>(
      this.sql.exec(`SELECT ${sqlColumns("membership_version")} FROM channel_meta WHERE channel_id=?`, channelId).toArray(),
    );
  }

  channelMetaInviteAccept(channelId: string): ChannelMetaInviteAcceptRow | undefined {
    return sqlRow<ChannelMetaInviteAcceptRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("channel_id", "kind", "visibility", "title", "avatar_url", "member_count", "membership_version", "status")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaUpdate(channelId: string): ChannelMetaUpdateRow | undefined {
    return sqlRow<ChannelMetaUpdateRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("kind", "visibility", "title", "topic", "avatar_url", "status", "created_at", "updated_at", "member_count", "membership_version")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaCommand(channelId: string): ChannelMetaCommandRow | undefined {
    return sqlRow<ChannelMetaCommandRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("kind", "status", "membership_version", "command_manifest_version")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaKind(channelId: string): { kind: string } | undefined {
    return sqlRow<{ kind: string }>(
      this.sql.exec(`SELECT ${sqlColumns("kind")} FROM channel_meta WHERE channel_id=?`, channelId).toArray(),
    );
  }

  channelMetaExists(channelId: string): ChannelMetaExistsRow | undefined {
    return sqlRow<ChannelMetaExistsRow>(
      this.sql.exec(`SELECT ${sqlColumns("channel_id")} FROM channel_meta WHERE channel_id=?`, channelId).toArray(),
    );
  }

  channelMetaPublicProjection(channelId: string): ChannelMetaPublicProjectionRow | undefined {
    return sqlRow<ChannelMetaPublicProjectionRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("channel_id", "kind", "visibility", "title", "topic", "avatar_url", "member_count", "status", "created_at", "updated_at")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaInvitePreview(channelId: string): ChannelMetaInvitePreviewRow | undefined {
    return sqlRow<ChannelMetaInvitePreviewRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("channel_id", "kind", "visibility", "title", "avatar_url", "member_count", "status")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaManifestGate(channelId: string): ChannelMetaManifestGateRow | undefined {
    return sqlRow<ChannelMetaManifestGateRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("kind", "status", "command_manifest_version")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaManifestVersion(channelId: string): ChannelMetaManifestVersionRow | undefined {
    return sqlRow<ChannelMetaManifestVersionRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("status", "command_manifest_version")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaDirectoryFields(channelId: string): ChannelMetaDirectoryFieldsRow | undefined {
    return sqlRow<ChannelMetaDirectoryFieldsRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("title", "avatar_url", "member_count", "status")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaMemberCount(channelId: string): ChannelMetaMemberCountRow | undefined {
    return sqlRow<ChannelMetaMemberCountRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("membership_version", "member_count")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelLastVisibleMessageAt(channelId: string): MessageLastActivityRow | undefined {
    return sqlRow<MessageLastActivityRow>(
      this.sql
        .exec(
          `SELECT ${sqlColumns("created_at")} FROM messages WHERE channel_id=? AND status NOT IN ('deleted','recalled') ORDER BY message_id DESC LIMIT 1`,
          channelId,
        )
        .toArray(),
    );
  }

  channelMetaRoleUpdateContext(
    channelId: string,
  ): Pick<ChannelMetaAdminRow, "status" | "membership_version" | "created_by" | "kind"> | undefined {
    return sqlRow<Pick<ChannelMetaAdminRow, "status" | "membership_version" | "created_by" | "kind">>(
      this.sql.exec(
        `SELECT ${sqlColumns("status", "membership_version", "created_by", "kind")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  channelMetaRemoveMember(
    channelId: string,
  ): Pick<ChannelMetaAdminRow, "status" | "visibility" | "membership_version" | "kind" | "created_by"> | undefined {
    return sqlRow<Pick<ChannelMetaAdminRow, "status" | "visibility" | "membership_version" | "kind" | "created_by">>(
      this.sql.exec(
        `SELECT ${sqlColumns("status", "visibility", "membership_version", "kind", "created_by")} FROM channel_meta WHERE channel_id=?`,
        channelId,
      ).toArray(),
    );
  }

  // --- members ---

  isActiveMember(channelId: string, userId: string): boolean {
    return (
      sqlRow<SqlExistsRow>(
        this.sql
          .exec(
            `SELECT 1 AS x FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL`,
            channelId,
            userId,
          )
          .toArray(),
      ) !== undefined
    );
  }

  memberRoleStatus(channelId: string, userId: string): MemberRoleStatusRow | undefined {
    return sqlRow<MemberRoleStatusRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("joined_at", "left_at", "role")} FROM members WHERE channel_id=? AND user_id=?`,
        channelId,
        userId,
      ).toArray(),
    );
  }

  activeMemberRole(channelId: string, userId: string): MemberRoleRow | undefined {
    return sqlRow<MemberRoleRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("role")} FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL`,
        channelId,
        userId,
      ).toArray(),
    );
  }

  memberRoleLeftAt(channelId: string, userId: string): Pick<MemberRoleStatusRow, "role" | "left_at"> | undefined {
    return sqlRow<Pick<MemberRoleStatusRow, "role" | "left_at">>(
      this.sql.exec(
        `SELECT ${sqlColumns("role", "left_at")} FROM members WHERE channel_id=? AND user_id=?`,
        channelId,
        userId,
      ).toArray(),
    );
  }

  memberLeftAt(channelId: string, userId: string): MemberLeftAtRow | undefined {
    return sqlRow<MemberLeftAtRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("left_at")} FROM members WHERE channel_id=? AND user_id=?`,
        channelId,
        userId,
      ).toArray(),
    );
  }

  listActiveMemberUserIds(channelId: string): string[] {
    return sqlRows<{ user_id: string }>(
      this.sql.exec(`SELECT ${sqlColumns("user_id")} FROM members WHERE channel_id=? AND left_at IS NULL`, channelId).toArray(),
    ).map((row) => row.user_id);
  }

  listActiveMemberUserIdsSample(channelId: string, limit: number): string[] {
    return sqlRows<{ user_id: string }>(
      this.sql
        .exec(
          `SELECT ${sqlColumns("user_id")} FROM members WHERE channel_id=? AND left_at IS NULL ORDER BY user_id ASC LIMIT ?`,
          channelId,
          limit,
        )
        .toArray(),
    ).map((row) => row.user_id);
  }

  listActiveMembersWithJoinedAt(channelId: string): ActiveMemberWithJoinedAtRow[] {
    return sqlRows<ActiveMemberWithJoinedAtRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("user_id", "joined_at")} FROM members WHERE channel_id=? AND left_at IS NULL`,
        channelId,
      ).toArray(),
    );
  }

  activeMemberJoinedAt(channelId: string, userId: string): MemberJoinedAtRow | undefined {
    return sqlRow<MemberJoinedAtRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("joined_at")} FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL`,
        channelId,
        userId,
      ).toArray(),
    );
  }

  listActiveMembersPage(channelId: string, cursor: string): ActiveMemberListRow[] {
    const decodedCursor = decodeMemberListCursor(cursor ?? "");
    if (decodedCursor) {
      return sqlRows<ActiveMemberListRow>(
        this.sql
          .exec(
            `SELECT ${sqlColumns("user_id", "role", "joined_at")} FROM members WHERE channel_id=? AND left_at IS NULL AND (
              (${MEMBER_ROLE_ORDER_CASE}) > ?
              OR ((${MEMBER_ROLE_ORDER_CASE}) = ? AND joined_at > ?)
              OR ((${MEMBER_ROLE_ORDER_CASE}) = ? AND joined_at = ? AND user_id > ?)
            ) ORDER BY ${MEMBER_ROLE_ORDER_CASE} ASC, joined_at ASC, user_id ASC LIMIT 101`,
            channelId,
            decodedCursor.roleRank,
            decodedCursor.roleRank,
            decodedCursor.joined_at,
            decodedCursor.roleRank,
            decodedCursor.joined_at,
            decodedCursor.user_id,
          )
          .toArray(),
      );
    }
    return sqlRows<ActiveMemberListRow>(
      this.sql
        .exec(
          `SELECT ${sqlColumns("user_id", "role", "joined_at")} FROM members WHERE channel_id=? AND left_at IS NULL ORDER BY ${MEMBER_ROLE_ORDER_CASE} ASC, joined_at ASC, user_id ASC LIMIT 101`,
          channelId,
        )
        .toArray(),
    );
  }

  // --- invites ---

  inviteHead(inviteCode: string): Pick<InviteRow, "invite_code" | "created_by" | "revoked_at"> | undefined {
    return sqlRow<Pick<InviteRow, "invite_code" | "created_by" | "revoked_at">>(
      this.sql.exec(
        `SELECT ${sqlColumns("invite_code", "created_by", "revoked_at")} FROM invites WHERE invite_code=?`,
        inviteCode,
      ).toArray(),
    );
  }

  inviteCreatedBy(inviteCode: string): InviteCreatedByRow | undefined {
    return sqlRow<InviteCreatedByRow>(
      this.sql.exec(`SELECT ${sqlColumns("created_by")} FROM invites WHERE invite_code=?`, inviteCode).toArray(),
    );
  }

  inviteForPreview(inviteCode: string): Pick<InviteRow, "invite_code" | "created_by" | "expires_at" | "max_uses" | "revoked_at"> | undefined {
    return sqlRow<Pick<InviteRow, "invite_code" | "created_by" | "expires_at" | "max_uses" | "revoked_at">>(
      this.sql.exec(
        `SELECT ${sqlColumns("invite_code", "created_by", "expires_at", "max_uses", "revoked_at")} FROM invites WHERE invite_code=?`,
        inviteCode,
      ).toArray(),
    );
  }

  inviteForAccept(inviteCode: string): InviteRow | undefined {
    return sqlRow<InviteRow>(
      this.sql.exec(
        `SELECT ${sqlColumns("invite_code", "created_by", "expires_at", "max_uses", "used_count", "revoked_at")} FROM invites WHERE invite_code=?`,
        inviteCode,
      ).toArray(),
    );
  }

  // --- messages ---

  messageReplyTarget(messageId: string, channelId: string): MessageReplyTargetRow | undefined {
    return sqlRow<MessageReplyTargetRow>(
      this.sql
        .exec(`SELECT ${MESSAGE_REPLY_TARGET_COLS} FROM messages WHERE message_id=? AND channel_id=?`, messageId, channelId)
        .toArray(),
    );
  }

  messageLifecycle(messageId: string, channelId: string): MessageLifecycleRow | undefined {
    return sqlRow<MessageLifecycleRow>(
      this.sql
        .exec(`SELECT ${MESSAGE_LIFECYCLE_COLS} FROM messages WHERE message_id=? AND channel_id=?`, messageId, channelId)
        .toArray(),
    );
  }

  messageSenderUserId(messageId: string, channelId: string): { sender_user_id: string | null } | undefined {
    return sqlRow<{ sender_user_id: string | null }>(
      this.sql
        .exec(`SELECT ${sqlColumns("sender_user_id")} FROM messages WHERE message_id=? AND channel_id=?`, messageId, channelId)
        .toArray(),
    );
  }

  listMentions(messageId: string): MentionRow[] {
    return sqlRows<MentionRow>(
      this.sql.exec(`SELECT user_id, start, end_ AS end FROM mentions WHERE message_id=?`, messageId).toArray(),
    );
  }

  channelMessageCreatedCountSince(channelId: string, afterEventId: string): number {
    const row = sqlRow<{ c: number | bigint }>(
      this.sql.exec(
        "SELECT COUNT(*) AS c FROM events WHERE channel_id=? AND event_id > ? AND event_type='message.created'",
        channelId,
        afterEventId,
      ).toArray(),
    );
    return Number(row?.c ?? 0);
  }

  channelOwnMessageCreatedCountSince(channelId: string, afterEventId: string, actorId: string): number {
    const row = sqlRow<{ c: number | bigint }>(
      this.sql.exec(
        "SELECT COUNT(*) AS c FROM events WHERE channel_id=? AND event_id > ? AND event_type='message.created' AND actor_id=?",
        channelId,
        afterEventId,
        actorId,
      ).toArray(),
    );
    return Number(row?.c ?? 0);
  }

  visibleAttachmentInChannel(
    attachmentId: string,
    channelId: string,
  ): {
    attachment_id: string;
    url: string;
    mime_type: string;
    width: number | null;
    height: number | null;
    size_bytes: number;
    blurhash: string | null;
  } | undefined {
    type SourceRow = {
      attachment_id: string;
      url: string;
      mime_type: string;
      width: number | null;
      height: number | null;
      size_bytes: number;
      blurhash: string | null;
      status: string;
      type: string;
    };
    const imageRows = sqlRows<SourceRow>(
      this.sql.exec(
        `SELECT a.attachment_id, a.url, a.mime_type, a.width, a.height, a.size_bytes, a.blurhash, m.status, m.type
         FROM attachments a
         JOIN message_attachments ma ON a.attachment_id = ma.attachment_id
         JOIN messages m ON m.message_id = ma.message_id
         WHERE a.attachment_id=? AND m.channel_id=?`,
        attachmentId,
        channelId,
      ).toArray(),
    );
    const stickerRows = sqlRows<SourceRow>(
      this.sql.exec(
        `SELECT ms.attachment_id, ms.url, ms.mime_type, ms.width, ms.height, ms.size_bytes, ms.blurhash, m.status, m.type
         FROM message_stickers ms
         JOIN messages m ON m.message_id = ms.message_id
         WHERE ms.attachment_id=? AND m.channel_id=?`,
        attachmentId,
        channelId,
      ).toArray(),
    );
    const visibleRow = [...imageRows, ...stickerRows].find(
      (r) => (r.status === "normal" || r.status === "edited") && (r.type === "image" || r.type === "sticker"),
    );
    if (!visibleRow) return undefined;
    return {
      attachment_id: visibleRow.attachment_id,
      url: visibleRow.url,
      mime_type: visibleRow.mime_type,
      width: visibleRow.width,
      height: visibleRow.height,
      size_bytes: visibleRow.size_bytes,
      blurhash: visibleRow.blurhash,
    };
  }
}
