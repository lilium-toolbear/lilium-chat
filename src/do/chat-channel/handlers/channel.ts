import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";
import type {
  AcceptInviteRpcInput,
  CreateChannelRpcInput,
  CreateDmRpcInput,
  CreateInviteRpcInput,
  GetInviteRpcInput,
  UpdateChannelRpcInput,
} from "../../../contract/chat-channel-rpc";
import {
  buildChannelCreatedPayload,
  buildChannelUpdatedPayload,
  buildMemberJoinedPayload,
} from "../../../chat/channel-events";
import type {
  ManagementPersistedEventType,
  ManagementPersistedPayload,
} from "../../../contract/persisted";
import type {
  AcceptInviteApiResponse,
  ChannelMetaProjection,
  ChannelUpdatePresentFields,
  CreateChannelRpcResult,
  CreateDmApiResponse,
  CreateInviteApiResponse,
  InvitePreviewApiResponse,
  UpdateChannelApiResponse,
} from "../../../contract/channel-api";
import type { AttachmentRow as ChatAttachmentRow } from "../../../chat/attachment-projection";
import { ApiError, apiErrorFromRemote } from "../../../errors";
import { personalInviteCode } from "../../../chat/invite-code";
import { parseRpcCachedJson } from "../../shared/do-rpc";
import {
  checkUserIdempotencyInTxn,
  readUserCompletedIdempotency,
  writeUserCompletedIdempotency,
} from "../data/idempotency";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  rvEvent,
  rvSeq,
  upsertAuditLogChange,
  upsertChannelChange,
  upsertEventChange,
  upsertInviteChange,
  upsertMemberChange,
} from "../../../archive/chat-channel-record";
import { resolveUserSummaries } from "../../../profile/resolve";
import { fallbackUserDisplayName } from "../../../contract/primitives";

export function ChannelMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async createInvite(input: CreateInviteRpcInput): Promise<CreateInviteApiResponse> {
  const userId = input.user_id;
  const b = input;

    if (!b.operation_id) {
      throw new ApiError("INVALID_MESSAGE", "operation_id is required");
    }
    if (!b.channel_id) {
      throw new ApiError("INVALID_MESSAGE", "channel_id is required");
    }

    const channelId = b.channel_id;
    const now = this.nowIso();
    const nowMs = Date.parse(now);
    const requestHash = JSON.stringify({
      channel_id: channelId,
      expires_in_seconds: b.expires_in_seconds ?? 7 * 24 * 60 * 60,
      max_uses: b.max_uses ?? null,
    });

    const rawExpires = b.expires_in_seconds ?? 7 * 24 * 60 * 60;
    if (!Number.isInteger(rawExpires) || rawExpires <= 0) {
      throw new ApiError("INVALID_MESSAGE", "expires_in_seconds must be a positive integer");
    }

    const rawMaxUses = b.max_uses ?? null;
    if (rawMaxUses !== null && (!Number.isInteger(rawMaxUses) || rawMaxUses < 0)) {
      throw new ApiError("INVALID_MESSAGE", "max_uses must be a non-negative integer or null");
    }

    const expiresAt = new Date(nowMs + rawExpires * 1000).toISOString();
    const maxUses: number | null = rawMaxUses;

    const cachedJson = readUserCompletedIdempotency(
      this.ctx.storage.sql,
      userId,
      "channel.invite_create",
      b.operation_id,
      requestHash,
    );
    if (cachedJson) return parseRpcCachedJson<CreateInviteApiResponse>(cachedJson);

    const inviteCode = await personalInviteCode(channelId, userId);
    const outboxId = `invite_directory:${inviteCode}:${now}`;
    const outboxEventId = this.nextEventId(nowMs);
    const response = {
      invite_code: inviteCode,
      expires_at: expiresAt,
      max_uses: maxUses,
    };
    const responseJson = JSON.stringify(response);

    type TxResult =
      | { kind: "conflict" }
      | { kind: "cached"; responseJson: string }
      | { kind: "ok"; responseJson: string; outboxId: string };

    const txResult = await this.ctx.storage.transaction(async (): Promise<TxResult> => {
      const idem = checkUserIdempotencyInTxn(
        this.ctx.storage.sql,
        userId,
        "channel.invite_create",
        b.operation_id,
        requestHash,
      );
      if (idem.kind === "conflict") return { kind: "conflict" };
      if (idem.kind === "cached") return { kind: "cached", responseJson: idem.responseJson };

      const meta = this.repo.channelMetaStatus(channelId);
      if (!meta) return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
      if (meta.status === "dissolved") {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
      }

      const role = this.activeRole(channelId, userId);
      if (!role) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "FORBIDDEN", message: "only channel members may create invite", retryable: false } }) };
      }

      const existing = this.repo.inviteHead(inviteCode);

      if (existing === undefined) {
        this.ctx.storage.sql.exec(
          "INSERT INTO invites (invite_code, created_by, expires_at, max_uses, used_count, revoked_at, created_at) VALUES (?, ?, ?, ?, 0, NULL, ?)",
          inviteCode,
          userId,
          expiresAt,
          maxUses,
          now,
        );
      } else {
        if (existing.created_by !== userId) {
          return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHAT_WORKER_UNAVAILABLE", message: "invite code collision", retryable: true } }) };
        }
        this.ctx.storage.sql.exec(
          "UPDATE invites SET expires_at=?, max_uses=?, revoked_at=NULL WHERE invite_code=?",
          expiresAt,
          maxUses,
          inviteCode,
        );
      }
      writeUserCompletedIdempotency(this.ctx.storage.sql, {
        userId,
        operation: "channel.invite_create",
        operationId: b.operation_id,
        requestHash,
        responseJson,
        nowIso: now,
      });
      this.ctx.storage.sql.exec(
        "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'invite_directory', ?, ?, ?, 'pending', ?, ?, ?, 0, 5)",
        outboxId,
        inviteCode,
        outboxEventId,
        JSON.stringify({ invite_code: inviteCode, channel_id: channelId, status: "active", expires_at: expiresAt, revoked_at: null }),
        now,
        now,
        now,
      );

      appendChatChannelArchive(this.ctx, channelId, now, [], (sourceSeq) => {
        const rv = rvSeq(sourceSeq);
        return collectDefinedChanges([upsertInviteChange(this.ctx.storage.sql, inviteCode, rv)]);
      });

      return { kind: "ok", responseJson, outboxId };
    });

    if (txResult.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
    }
    if (txResult.kind === "cached") {
      return parseRpcCachedJson<CreateInviteApiResponse>(txResult.responseJson);
    }

    await this.flushSingleInviteDirectoryOutbox(txResult.outboxId, now);
    await this.scheduleArchiveAlarm(now);
    return JSON.parse(txResult.responseJson) as CreateInviteApiResponse;
}

    async acceptInvite(input: AcceptInviteRpcInput): Promise<AcceptInviteApiResponse> {
  const userId = input.user_id;
  const b = input;
    const operationId = b.operation_id;
    if (!operationId) {
      throw new ApiError("INVALID_MESSAGE", "operation_id is required");
    }
    const channelId = b.channel_id;
    if (!channelId) {
      throw new ApiError("INVALID_MESSAGE", "channel_id is required");
    }
    const inviteCode = b.invite_code;
    if (!inviteCode) {
      throw new ApiError("INVALID_MESSAGE", "invite_code is required");
    }

    const now = this.nowIso();
    const nowMs = Date.parse(now);
    const requestHash = JSON.stringify({ channel_id: channelId, invite_code: inviteCode });

    type TxResult =
      | { kind: "conflict" }
      | { kind: "cached"; responseJson: string }
      | { kind: "ok"; responseJson: string };

    const inviteHead = this.repo.inviteCreatedBy(inviteCode);
    const inviterUserIdForResolve = inviteHead?.created_by ?? userId;
    const actorMap = await this.resolveActorMap([userId, inviterUserIdForResolve]);

    const txResult = await this.ctx.storage.transaction(async (): Promise<TxResult> => {
      const idem = checkUserIdempotencyInTxn(
        this.ctx.storage.sql,
        userId,
        "channel.invite_accept",
        operationId,
        requestHash,
      );
      if (idem.kind === "conflict") return { kind: "conflict" };
      if (idem.kind === "cached") return { kind: "cached", responseJson: idem.responseJson };

      const meta = this.repo.channelMetaInviteAccept(channelId);
      if (!meta) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
      }
      const dissolved = this.assertNotDissolved(meta.status);
      if (dissolved) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: dissolved.code, message: dissolved.message, retryable: false } }) };
      }

      const invite = this.repo.inviteForAccept(inviteCode);
      if (!invite || invite.invite_code !== inviteCode) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "INVITE_NOT_FOUND", message: "invite not found", retryable: false } }) };
      }

      const expiresAtMs = Date.parse(invite.expires_at);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || invite.revoked_at !== null) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "INVITE_NOT_FOUND", message: "invite not found", retryable: false } }) };
      }

      const currentMember = this.repo.memberRoleStatus(channelId, userId);

      if (currentMember && currentMember.left_at === null) {
        const responseJson = JSON.stringify({
          channel: {
            channel_id: meta.channel_id,
            kind: meta.kind,
            visibility: meta.visibility,
            title: meta.title,
            avatar_url: meta.avatar_url,
            member_count: meta.member_count,
            status: meta.status,
          },
          membership: {
            role: currentMember.role,
            joined_at: currentMember.joined_at,
            status: "active",
          },
        });
        writeUserCompletedIdempotency(this.ctx.storage.sql, {
          userId,
          operation: "channel.invite_accept",
          operationId,
          requestHash,
          responseJson,
          nowIso: now,
        });
        return { kind: "ok", responseJson };
      }

      if (invite.max_uses !== null && invite.used_count >= invite.max_uses) {
        return {
          kind: "cached",
          responseJson: JSON.stringify({ error: { code: "INVITE_NOT_AVAILABLE", message: "invite max uses exceeded", retryable: false } }),
        };
      }

      const mv = meta.membership_version + 1;
      if (currentMember === undefined) {
        this.ctx.storage.sql.exec(
          "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, ?, ?, NULL)",
          channelId,
          userId,
          "member",
          now,
        );
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE members SET role=?, joined_at=?, left_at=NULL WHERE channel_id=? AND user_id=?",
          "member",
          now,
          channelId,
          userId,
        );
      }
      this.ctx.storage.sql.exec("UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?", mv, meta.member_count + 1, now, channelId);
      this.ctx.storage.sql.exec("UPDATE invites SET used_count = used_count + 1 WHERE invite_code=?", invite.invite_code);

      const joinedId = this.nextEventId(nowMs);
      this.persistEventAndFanout(
        joinedId,
        "member.joined",
        channelId,
        now,
        buildMemberJoinedPayload({
          channel_id: channelId,
          user_id: userId,
          role: "member",
          membership_version: mv,
          actor_kind: "user",
          actor_id: userId,
          join_source: "invite",
          inviter_user_id: invite.created_by,
        }),
        mv,
        now,
        actorMap,
      );
      this.insertUserDirectoryOutbox(
        userId,
        { action: "join", channel_id: channelId, kind: meta.kind, membership_version: mv },
        now,
        `user_directory:join:${channelId}:${userId}:${now}`,
      );
      if (meta.visibility === "public_listed") {
        this.insertOutboxRowForChannelDirectory(channelId, "upsert", this.readChannelDirectorySnapshot(channelId, now), now);
      }

      const channel = {
        channel_id: meta.channel_id,
        kind: meta.kind,
        visibility: meta.visibility,
        title: meta.title,
        avatar_url: meta.avatar_url,
        member_count: meta.member_count + 1,
        status: meta.status,
      };
      const responseJson = JSON.stringify({ channel, membership: { role: "member", joined_at: now, status: "active" } });
      writeUserCompletedIdempotency(this.ctx.storage.sql, {
        userId,
        operation: "channel.invite_accept",
        operationId,
        requestHash,
        responseJson,
        nowIso: now,
      });

      appendChatChannelArchive(this.ctx, channelId, now, [joinedId], (sourceSeq) => {
        const rv = rvEvent(joinedId);
        return collectDefinedChanges([
          upsertChannelChange(this.ctx.storage.sql, channelId, rv),
          upsertMemberChange(this.ctx.storage.sql, channelId, userId, rv),
          upsertInviteChange(this.ctx.storage.sql, invite.invite_code, rv),
          upsertEventChange(this.ctx.storage.sql, joinedId),
        ]);
      });

      return { kind: "ok", responseJson };
    });

    if (txResult.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
    }
    if (txResult.kind === "ok") {
      await this.scheduleArchiveAlarm(now);
      return parseRpcCachedJson<AcceptInviteApiResponse>(txResult.responseJson);
    }
    return parseRpcCachedJson<AcceptInviteApiResponse>(txResult.responseJson);
}

    async updateChannel(input: UpdateChannelRpcInput): Promise<UpdateChannelApiResponse> {
  const userId = input.user_id;
  this.assertChannelKindChannel();
  const b = input;
    const channelId = b.channel_id;
    const now = this.nowIso();
    const nowMs = Date.parse(now);

    let pendingAvatarUrl: string | null | undefined;
    if (b.avatar_attachment_id !== undefined) {
      if (b.avatar_attachment_id === null) {
        pendingAvatarUrl = null;
      } else {
        const userDir = this.env.USER_DIRECTORY.getByName(userId);
        let attachmentRow: ChatAttachmentRow;
        try {
          attachmentRow = (await userDir.getAttachment(userId, b.avatar_attachment_id)).attachment as ChatAttachmentRow;
        } catch (err) {
          const apiErr = apiErrorFromRemote(err);
          if (apiErr) throw apiErr;
          throw err;
        }
        if (!attachmentRow || attachmentRow.status !== "finalized" || attachmentRow.owner_user_id !== userId) {
          throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "attachment not available", { httpStatus: 415 });
        }
        if (attachmentRow.kind !== "avatar") {
          throw new ApiError("UNSUPPORTED_ATTACHMENT_TYPE", "channel avatar must use the avatar upload namespace", { httpStatus: 415 });
        }
        pendingAvatarUrl = attachmentRow.url;
      }
    }

    // Presence-aware canonical request body: omitted field vs explicit null are DISTINCT.
    // `title:"x"` (only title set) must hash differently from `title:"x", topic:null`,
    // otherwise a second request that explicitly nulls `topic` would collide with an omit-topic
    // request and wrongly register as cached/conflict. Capture exactly the keys the client sent.
    const present: ChannelUpdatePresentFields = {};
    if (b.title !== undefined) present.title = b.title;
    if (b.topic !== undefined) present.topic = b.topic;
    if (b.avatar_attachment_id !== undefined) present.avatar_attachment_id = b.avatar_attachment_id;
    if (b.visibility !== undefined) present.visibility = b.visibility;
    const requestHash = JSON.stringify(present);

    const actorMap = await this.resolveActorMap([userId]);

    const txResult = await this.ctx.storage.transaction(async (): Promise<
      | { kind: "conflict" }
      | { kind: "cached"; responseJson: string }
      | { kind: "ok"; channel: ChannelMetaProjection }
    > => {
      const idem = checkUserIdempotencyInTxn(
        this.ctx.storage.sql,
        userId,
        "channel.update",
        b.idempotency_key,
        requestHash,
      );
      if (idem.kind === "conflict") return { kind: "conflict" };
      if (idem.kind === "cached") return { kind: "cached", responseJson: idem.responseJson };

      const meta = this.repo.channelMetaUpdate(channelId);
      if (meta === undefined) {
        // channel gone → 404 CHANNEL_NOT_FOUND (NOT a conflict).
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
      }
      const d = this.assertNotDissolved(meta.status);
      if (d) return { kind: "cached", responseJson: JSON.stringify({ error: { code: d.code, message: d.message, retryable: false } }) };

      const role = this.activeRole(channelId, userId);
      if (role !== "owner" && role !== "admin") {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "FORBIDDEN", message: "not authorized to update channel", retryable: false } }) };
      }

      const changes: Record<string, { before: unknown; after: unknown }> = {};
      const newTitle = b.title !== undefined ? b.title : meta.title;
      const newTopic = b.topic !== undefined ? b.topic : meta.topic;
      const newVisibility = b.visibility !== undefined ? b.visibility : meta.visibility;
      const newAvatarUrl = pendingAvatarUrl !== undefined ? pendingAvatarUrl : meta.avatar_url;
      if (b.title !== undefined && b.title !== meta.title) changes.title = { before: meta.title, after: b.title };
      if (b.topic !== undefined && b.topic !== meta.topic) changes.topic = { before: meta.topic, after: b.topic };
      if (pendingAvatarUrl !== undefined && pendingAvatarUrl !== meta.avatar_url) {
        changes.avatar_url = { before: meta.avatar_url, after: pendingAvatarUrl };
      }
      if (b.visibility !== undefined && b.visibility !== meta.visibility) {
        if (!["private", "public_unlisted", "public_listed"].includes(b.visibility)) return { kind: "cached", responseJson: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "invalid visibility", retryable: false } }) };
        changes.visibility = { before: meta.visibility, after: b.visibility };
      }

      const channel = {
        channel_id: channelId,
        kind: meta.kind,
        visibility: newVisibility,
        title: newTitle,
        topic: newTopic,
        avatar_url: newAvatarUrl,
        member_count: meta.member_count,
        status: meta.status,
        created_at: meta.created_at,
        updated_at: Object.keys(changes).length > 0 ? now : meta.updated_at,
      };

      if (Object.keys(changes).length > 0) {
        this.ctx.storage.sql.exec(
          "UPDATE channel_meta SET title=?, topic=?, visibility=?, avatar_url=?, updated_at=? WHERE channel_id=?",
          newTitle, newTopic, newVisibility, newAvatarUrl, now, channelId,
        );

        const mv = meta.membership_version;
        const updatedId = this.nextEventId(nowMs);
        this.persistEventAndFanout(updatedId, "channel.updated", channelId, now,
          buildChannelUpdatedPayload({ channel_id: channelId, channel_changes: changes, actor_kind: "user", actor_id: userId }), mv, now, actorMap);

        appendChatChannelArchive(this.ctx, channelId, now, [updatedId], (sourceSeq) => {
          const rv = rvEvent(updatedId);
          return collectDefinedChanges([
            upsertChannelChange(this.ctx.storage.sql, channelId, rv),
            upsertEventChange(this.ctx.storage.sql, updatedId),
          ]);
        });
      }

      const responseJson = JSON.stringify({ channel });
      writeUserCompletedIdempotency(this.ctx.storage.sql, {
        userId,
        operation: "channel.update",
        operationId: b.idempotency_key,
        requestHash,
        responseJson,
        nowIso: now,
      });
      // channel_directory projection: visibility transitions + public title/topic/avatar updates.
      if (Object.keys(changes).length > 0) {
        if (meta.visibility === "public_listed" && newVisibility !== "public_listed") {
          // public → private/public_unlisted: remove from directory
          this.insertOutboxRowForChannelDirectory(channelId, "delete", null, now);
        } else if (meta.visibility !== "public_listed" && newVisibility === "public_listed") {
          // non-public → public_listed: add to directory with current full snapshot
          this.insertOutboxRowForChannelDirectory(channelId, "upsert", this.readChannelDirectorySnapshot(channelId, now), now);
        } else if (meta.visibility === "public_listed" && newVisibility === "public_listed") {
          // public → public: re-project (title/topic/avatar changed)
          this.insertOutboxRowForChannelDirectory(channelId, "upsert", this.readChannelDirectorySnapshot(channelId, now), now);
        }
      }
      // both non-public → no outbox write
      return { kind: "ok", channel };
    });

    if (txResult.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "idempotency_key reused with different body");
    }
    if (txResult.kind === "ok") {
      await this.scheduleArchiveAlarm(now);
      return { channel: txResult.channel };
    }
    return parseRpcCachedJson<UpdateChannelApiResponse>(txResult.responseJson);
}

    async getInvite(input: GetInviteRpcInput): Promise<InvitePreviewApiResponse> {
  const invite = this.repo.inviteForPreview(input.invite_code);
  if (!input.invite_code || !input.channel_id || invite === undefined) {
    throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  }

  const expiresAtMs = Date.parse(invite.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() || invite.revoked_at !== null) {
    throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  }

  const meta = this.repo.channelMetaInvitePreview(input.channel_id);
  if (meta === undefined) {
    throw new ApiError("INVITE_NOT_FOUND", "invite not found");
  }

  const sampleRows = this.repo.listActiveMemberUserIdsSample(input.channel_id, 3);
  const userIds = Array.from(new Set([invite.created_by, ...sampleRows]));
  const memberRow = this.repo.memberLeftAt(meta.channel_id, input.user_id);
  const membershipStatus = memberRow === undefined ? "not_joined" : memberRow.left_at === null ? "active" : "left";
  const resolvedMembers = await resolveUserSummaries(userIds, this.env);
  const inviterSummary = resolvedMembers.get(invite.created_by) ?? {
    user_id: invite.created_by,
    display_name: `user-${invite.created_by.slice(0, 8)}`,
    avatar_url: null,
  };
  const sampleMembers = sampleRows.map((sampleUserId) => {
    const summary = resolvedMembers.get(sampleUserId) ?? {
      user_id: sampleUserId,
      display_name: `user-${sampleUserId.slice(0, 8)}`,
      avatar_url: null,
    };
    return {
      user_id: summary.user_id,
      display_name: summary.display_name ?? fallbackUserDisplayName(summary.user_id),
      avatar_url: summary.avatar_url,
    };
  });

  return {
    invite: {
      invite_code: invite.invite_code,
      expires_at: invite.expires_at,
      max_uses: invite.max_uses,
    },
    channel: {
      channel_id: meta.channel_id,
      kind: meta.kind,
      visibility: meta.visibility,
      title: meta.title,
      avatar_url: meta.avatar_url,
      member_count: meta.member_count,
      status: meta.status === "dissolved" ? "dissolved" : meta.status,
    },
    inviter: {
      user_id: inviterSummary.user_id,
      display_name: inviterSummary.display_name ?? fallbackUserDisplayName(inviterSummary.user_id),
      avatar_url: inviterSummary.avatar_url,
    },
    sample_members: sampleMembers,
    my_membership: {
      status: membershipStatus,
      channel_id: membershipStatus === "active" ? meta.channel_id : null,
    },
  };
}

    async createChannel(input: CreateChannelRpcInput): Promise<CreateChannelRpcResult> {
  const creatorUserId = input.user_id;
  const channelId = input.channel_id;
  if (!channelId) throw new ApiError("INVALID_MESSAGE", "channel_id required");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title === "") throw new ApiError("INVALID_MESSAGE", "title is required");
  if (input.avatar_attachment_id !== null && input.avatar_attachment_id !== undefined) {
    throw new ApiError("INVALID_MESSAGE", "avatar_attachment_id not supported in Phase 3");
  }
  const visibility = input.visibility ?? "private";
  if (!["private", "public_unlisted", "public_listed"].includes(visibility)) {
    throw new ApiError("INVALID_MESSAGE", "invalid visibility");
  }
  const initialMembers = Array.isArray(input.initial_members) ? input.initial_members : [];
  for (const im of initialMembers) {
    if (im.role !== "member" && im.role !== "admin") {
      throw new ApiError("INVALID_MESSAGE", "initial_members role must be member or admin");
    }
    if (im.user_id === creatorUserId) {
      throw new ApiError("INVALID_MESSAGE", "creator must not be in initial_members");
    }
  }

  const now = this.nowIso();
  const nowMs = Date.parse(now);
  const actorMap = await this.resolveActorMap([creatorUserId]);
  const ownerMv = 1;
  const events: Array<{
    id: string;
    type: ManagementPersistedEventType;
    payload: ManagementPersistedPayload;
    mv: number;
  }> = [];
  const channelCreatedId = this.nextEventId(nowMs);
  events.push({ id: channelCreatedId, type: "channel.created", payload: buildChannelCreatedPayload({ channel_id: channelId, kind: "channel", visibility, title, actor_kind: "user", actor_id: creatorUserId }), mv: ownerMv });
  const memberJoinedCreatorId = this.nextEventId(nowMs);
  events.push({ id: memberJoinedCreatorId, type: "member.joined", payload: buildMemberJoinedPayload({ channel_id: channelId, user_id: creatorUserId, role: "owner", membership_version: ownerMv, actor_kind: "system", actor_id: "system" }), mv: ownerMv });

  let mv = ownerMv;
  for (const im of initialMembers) {
    mv += 1;
    const eid = this.nextEventId(nowMs);
    events.push({ id: eid, type: "member.joined", payload: buildMemberJoinedPayload({ channel_id: channelId, user_id: im.user_id, role: im.role, membership_version: mv, actor_kind: "system", actor_id: "system" }), mv });
  }

  const finalMv = mv;
  const memberCount = 1 + initialMembers.length;
  const result = await this.ctx.storage.transaction(async (): Promise<
    | { kind: "cached"; channel: ChannelMetaProjection; joinedAt: string }
    | { kind: "created"; channel: ChannelMetaProjection; joinedAt: string }
  > => {
    const existing = this.repo.channelMetaExists(channelId);
    if (existing !== undefined) {
      const meta = this.repo.channelMetaPublicProjection(channelId)!;
      const owner = this.repo.activeMemberJoinedAt(channelId, creatorUserId);
      const cachedChannel = { channel_id: meta.channel_id, kind: meta.kind, visibility: meta.visibility, title: meta.title, topic: meta.topic, avatar_url: meta.avatar_url, member_count: meta.member_count, status: meta.status, created_at: meta.created_at, updated_at: meta.updated_at };
      return { kind: "cached" as const, channel: cachedChannel, joinedAt: owner?.joined_at ?? meta.created_at };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO channel_meta (channel_id, kind, visibility, title, topic, avatar_url, status, created_by, created_at, updated_at, member_count, membership_version) VALUES (?, 'channel', ?, ?, ?, NULL, 'active', ?, ?, ?, ?, ?)`,
      channelId, visibility, title, input.topic ?? null, creatorUserId, now, now, memberCount, finalMv,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'owner', ?, NULL)",
      channelId, creatorUserId, now,
    );
    for (const im of initialMembers) {
      this.ctx.storage.sql.exec(
        "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, ?, ?, NULL)",
        channelId, im.user_id, im.role, now,
      );
    }
    for (const ev of events) {
      this.persistEventAndFanout(ev.id, ev.type, channelId, now, ev.payload, ev.mv, now, actorMap);
    }
    this.insertUserDirectoryOutbox(
      creatorUserId,
      { action: "join", channel_id: channelId, kind: "channel", membership_version: ownerMv },
      now,
      `user_directory:join:${channelId}:${creatorUserId}:${now}`,
    );
    for (const im of initialMembers) {
      this.insertUserDirectoryOutbox(
        im.user_id,
        { action: "join", channel_id: channelId, kind: "channel", membership_version: finalMv },
        now,
        `user_directory:join:${channelId}:${im.user_id}:${now}`,
      );
    }
    if (visibility === "public_listed") {
      this.insertOutboxRowForChannelDirectory(channelId, "upsert", {
        title, avatar_url: null, member_count: memberCount, last_message_at: null, status: "active",
      }, now);
    }

    const memberUserIds = [creatorUserId, ...initialMembers.map((im) => im.user_id)];
    const businessEventIds = events.map((e) => e.id);
    appendChatChannelArchive(this.ctx, channelId, now, businessEventIds, (sourceSeq) => {
      const tableRv = rvSeq(sourceSeq);
      const changes = [
        upsertChannelChange(this.ctx.storage.sql, channelId, tableRv),
        ...memberUserIds.map((uid) => upsertMemberChange(this.ctx.storage.sql, channelId, uid, tableRv)),
        ...events.map((ev) => upsertEventChange(this.ctx.storage.sql, ev.id)),
      ];
      return collectDefinedChanges(changes);
    });

    return { kind: "created" as const, channel: { channel_id: channelId, kind: "channel", visibility, title, topic: input.topic ?? null, avatar_url: null, member_count: memberCount, status: "active", created_at: now, updated_at: now }, joinedAt: now };
  });

  if (result.kind === "created") await this.scheduleArchiveAlarm(now);

  return {
    channel: result.channel,
    joined_at: result.joinedAt,
    membership: { role: "owner", joined_at: result.joinedAt },
    event_ids: result.kind === "created" ? events.map((e) => e.id) : [],
  };
}

    async createDm(input: CreateDmRpcInput): Promise<CreateDmApiResponse> {
  const channelId = input.channel_id;
  if (!channelId) {
    throw new ApiError("INVALID_MESSAGE", "channel_id required");
  }
  const userA = input.user_a;
  const userB = input.user_b;
  if (!userA || !userB || userA === userB) {
    throw new ApiError("INVALID_DM_TARGET", "invalid dm participants");
  }

  const now = this.nowIso();
  const nowMs = Date.parse(now);
  const membershipVersion = 1;
  const result = await this.ctx.storage.transaction(async (): Promise<
    | { kind: "cached"; channel: ChannelMetaProjection; joinedAtByUser: Record<string, string> }
    | { kind: "created"; channel: ChannelMetaProjection; joinedAtByUser: Record<string, string> }
  > => {
    const existing = this.repo.channelMetaExists(channelId);

    const members = this.repo.listActiveMembersWithJoinedAt(channelId);
    const joinedAtByUser: Record<string, string> = {};
    for (const m of members) joinedAtByUser[m.user_id] = m.joined_at;

    if (existing !== undefined) {
      const meta = this.repo.channelMetaPublicProjection(channelId)!;
      return {
        kind: "cached" as const,
        channel: {
          channel_id: meta.channel_id,
          kind: meta.kind,
          visibility: meta.visibility,
          title: meta.title,
          topic: meta.topic,
          avatar_url: meta.avatar_url,
          member_count: meta.member_count,
          status: meta.status,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
        },
        joinedAtByUser,
      };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO channel_meta (channel_id, kind, visibility, title, topic, avatar_url, status, created_by, created_at, updated_at, member_count, membership_version)
       VALUES (?, 'dm', 'private', '', NULL, NULL, 'active', ?, ?, ?, 2, ?)`,
      channelId, input.created_by, now, now, membershipVersion,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'member', ?, NULL)",
      channelId, userA, now,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'member', ?, NULL)",
      channelId, userB, now,
    );
    joinedAtByUser[userA] = now;
    joinedAtByUser[userB] = now;

    const auditId = `${channelId}:create-dm:${now}`;
    this.ctx.storage.sql.exec(
      "INSERT INTO audit_logs (audit_id, actor_kind, actor_id, action, target_type, target_id, before_json, after_json, reason, request_id, created_at) VALUES (?, 'user', ?, 'this.create_dm', 'channel', ?, NULL, ?, NULL, ?, ?)",
      auditId, input.created_by, channelId, JSON.stringify({ channel_id: channelId, kind: "dm", user_a: userA, user_b: userB }), channelId, now,
    );

    const channelCreatedId = this.nextEventId(nowMs);
    this.ctx.storage.sql.exec(
      "INSERT INTO events (event_id, event_type, channel_id, payload_json, occurred_at) VALUES (?, 'this.created', ?, ?, ?)",
      channelCreatedId, channelId, JSON.stringify(buildChannelCreatedPayload({
        channel_id: channelId, kind: "dm", visibility: "private", title: "", actor_kind: "user", actor_id: input.created_by,
      })), now,
    );

    for (const userId of [userA, userB]) {
      this.insertUserDirectoryOutbox(
        userId,
        { action: "join", channel_id: channelId, kind: "dm", membership_version: membershipVersion },
        now,
        `user_directory:join:${channelId}:${userId}:${now}`,
      );
    }

    appendChatChannelArchive(this.ctx, channelId, now, [channelCreatedId], () => {
      const rv = rvEvent(channelCreatedId);
      return collectDefinedChanges([
        upsertChannelChange(this.ctx.storage.sql, channelId, rv),
        upsertMemberChange(this.ctx.storage.sql, channelId, userA, rv),
        upsertMemberChange(this.ctx.storage.sql, channelId, userB, rv),
        upsertAuditLogChange(this.ctx.storage.sql, auditId, rv),
        upsertEventChange(this.ctx.storage.sql, channelCreatedId),
      ]);
    });

    return {
      kind: "created" as const,
      channel: {
        channel_id: channelId,
        kind: "dm",
        visibility: "private",
        title: "",
        topic: null,
        avatar_url: null,
        member_count: 2,
        status: "active",
        created_at: now,
        updated_at: now,
      },
      joinedAtByUser,
    };
  });

  if (result.kind === "created") await this.scheduleArchiveAlarm(now);

  return {
    ...result.channel,
    joined_at_by_user: result.joinedAtByUser,
  };
    }
  };
}
