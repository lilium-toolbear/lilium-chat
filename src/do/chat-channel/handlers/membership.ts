import type {
  AddMemberRpcInput,
  DebugLeaveMemberRpcInput,
  DissolveChannelRpcInput,
  JoinChannelRpcInput,
  RemoveMemberRpcInput,
  TransferOwnerRpcInput,
  UpdateMemberRoleRpcInput,
} from "../../../contract/chat-channel-rpc";
import {
  buildChannelDissolvedPayload,
  buildMemberJoinedPayload,
  buildMemberLeftPayload,
  buildMemberRoleUpdatedPayload,
} from "../../../chat/channel-events";
import type {
  AddMemberApiResponse,
  DissolveChannelApiResponse,
  JoinChannelApiResponse,
  ListMembersApiResponse,
  MemberProjection,
  RemoveMemberApiResponse,
  TransferOwnerApiResponse,
  UpdateMemberRoleApiResponse,
} from "../../../contract/channel-api";
import type { DissolvedChannelProjection } from "../../../contract/channel";
import { ApiError } from "../../../errors";
import { parseRpcCachedJson } from "../../shared/do-rpc";
import { assertTestRoutesEnabled } from "../../shared/test-gates";
import {
  checkUserIdempotencyInTxn,
  readUserCompletedIdempotency,
  readUserIdempotencyRow,
  writeUserCompletedIdempotency,
} from "../data/idempotency";
import {
  appendChatChannelArchive,
  collectDefinedChanges,
  rvEvent,
  rvSeq,
  upsertChannelChange,
  upsertEventChange,
  upsertMemberChange,
} from "../../../archive/chat-channel-record";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";

export function MembershipMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async joinChannel(input: JoinChannelRpcInput): Promise<JoinChannelApiResponse> {
      const userId = input.user_id;
      const callerUserId = input.caller_user_id ?? userId;
      const now = this.nowIso();
      const nowMs = Date.parse(now);
      const operationId = typeof input.operation_id === "string" && input.operation_id !== "" ? input.operation_id : null;
      // request_hash for join is just {user_id, channel_id} — the only body fields that matter.
      // The differentiator between branches is the membership state at execution time, not the body.
      const requestHash = JSON.stringify({ user_id: userId });

      const meta = this.repo.soleChannelMetaJoinHeader();
      if (meta === undefined) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
      }
      const channelId = meta.channel_id;
      if (meta.status === "dissolved") {
        throw new ApiError("CHANNEL_DISSOLVED", "channel is dissolved");
      }
      // DM channels are not joinable.
      if (meta.kind === "dm") {
        throw new ApiError("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels");
      }

      const actorMap = await this.resolveActorMap([userId]);

      // Cheap pre-check: if operation_id present and the same operation already completed with the
      // same request_hash, return the cached response WITHOUT opening a transaction.
      if (operationId) {
        const cachedJson = readUserCompletedIdempotency(
          this.ctx.storage.sql,
          callerUserId,
          "channel.join",
          operationId,
          requestHash,
        );
        if (cachedJson) {
          const cached = JSON.parse(cachedJson) as { channel_id?: string; membership_version?: number; joined_at?: string; role?: string };
          return {
            channel_id: cached.channel_id ?? channelId,
            membership_version: cached.membership_version ?? 0,
            joined_at: cached.joined_at ?? now,
            role: cached.role ?? "member",
          };
        }
      }

      type JoinTxResult =
        | { kind: "conflict" }
        | { kind: "ok"; membershipVersion: number; joinedAt: string; role: string; writeProjection: boolean };

      const txResult = await this.ctx.storage.transaction(async (): Promise<JoinTxResult> => {
        // Re-read meta inside the txn (handles concurrent joins).
        const m2 = this.repo.channelMetaMembership(channelId);
        if (m2 === undefined) return { kind: "conflict" };
        if (m2.status === "dissolved") return { kind: "conflict" };

        // Idempotency cache check inside the txn (handles the race where two concurrent joins interleave).
        if (operationId) {
          const idem = checkUserIdempotencyInTxn(
            this.ctx.storage.sql,
            callerUserId,
            "channel.join",
            operationId,
            requestHash,
          );
          if (idem.kind === "conflict") return { kind: "conflict" };
          if (idem.kind === "cached") {
            const cached = JSON.parse(idem.responseJson) as { membership_version?: number; joined_at?: string; role?: string };
            return { kind: "ok", membershipVersion: cached.membership_version ?? m2.membership_version, joinedAt: cached.joined_at ?? now, role: cached.role ?? "member", writeProjection: false };
          }
        }

        const m = this.repo.memberRoleStatus(channelId, userId);

        const isActiveMember = m !== undefined && m.left_at === null;
        // Visibility gate (applies always): non-members may only join public_listed channels.
        // Already-active members bypass the gate (they are returning their existing membership).
        if (!isActiveMember && m2.visibility !== "public_listed") {
          return { kind: "conflict" }; // signal FORBIDDEN via conflict branch — see below
        }

        if (isActiveMember) {
          // Already-active-member no-op (P0-3): write the idempotency row so a retry after the user
          // later leaves does NOT become a real rejoin. Returns the EXISTING role (P0-4).
          const role = m!.role;
          const responseJson = JSON.stringify({ channel_id: channelId, membership_version: m2.membership_version, joined_at: m!.joined_at, role });
          if (operationId) {
            writeUserCompletedIdempotency(this.ctx.storage.sql, {
              userId: callerUserId,
              operation: "channel.join",
              operationId,
              requestHash,
              responseJson,
              nowIso: now,
            });
          }
          return { kind: "ok", membershipVersion: m2.membership_version, joinedAt: m!.joined_at, role, writeProjection: false };
        }

        // Fresh join OR rejoin (left/removed): real mutation. Rejoin resets role to 'member'.
        const membershipVersion = m2.membership_version + 1;
        const joinedAt = now;
        if (m === undefined) {
          this.ctx.storage.sql.exec(
            "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'member', ?, NULL)",
            channelId, userId, joinedAt,
          );
        } else {
          this.ctx.storage.sql.exec(
            "UPDATE members SET joined_at=?, left_at=NULL, role='member' WHERE channel_id=? AND user_id=?",
            joinedAt, channelId, userId,
          );
        }
        const nextCount = (m2.member_count ?? 0) + 1;
        this.ctx.storage.sql.exec(
          "UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?",
          membershipVersion, nextCount, now, channelId,
        );

        const eventId = this.nextEventId(nowMs);
        this.persistEventAndFanout(
          eventId,
          "member.joined",
          channelId,
          now,
          buildMemberJoinedPayload({
            channel_id: channelId,
            user_id: userId,
            role: "member",
            membership_version: membershipVersion,
            actor_kind: "user",
            actor_id: userId,
            join_source: "public",
          }),
          membershipVersion,
          now,
          actorMap,
        );

        this.insertUserDirectoryOutbox(
          userId,
          { action: "join", channel_id: channelId, kind: meta.kind, membership_version: membershipVersion },
          now,
          `user_directory:join:${channelId}:${userId}:${now}`,
        );
        // channel_directory projection: bump the directory's member_count for public channels.
        if (m2.visibility === "public_listed") {
          this.insertOutboxRowForChannelDirectory(channelId, "upsert", this.readChannelDirectorySnapshot(channelId, now), now);
        }

        const role = "member";
        const responseJson = JSON.stringify({ channel_id: channelId, membership_version: membershipVersion, joined_at: joinedAt, role });
        if (operationId) {
          writeUserCompletedIdempotency(this.ctx.storage.sql, {
            userId: callerUserId,
            operation: "channel.join",
            operationId,
            requestHash,
            responseJson,
            nowIso: now,
          });
        }

        appendChatChannelArchive(this.ctx, channelId, now, [eventId], (sourceSeq) => {
          const rv = rvEvent(eventId);
          return collectDefinedChanges([
            upsertChannelChange(this.ctx.storage.sql, channelId, rv),
            upsertMemberChange(this.ctx.storage.sql, channelId, userId, rv),
            upsertEventChange(this.ctx.storage.sql, eventId),
          ]);
        });

        return { kind: "ok", membershipVersion: membershipVersion, joinedAt: joinedAt, role, writeProjection: true };
      });

      // The "conflict" kind is overloaded here to signal the visibility-gate failure (403) because
      // the gate is evaluated inside the txn. We disambiguate by re-checking visibility post-txn.
      if (txResult.kind === "conflict") {
        // If the cache had a request_hash mismatch, that's a 409 IDEMPOTENCY_CONFLICT.
        if (operationId) {
          const row = readUserIdempotencyRow(this.ctx.storage.sql, callerUserId, "channel.join", operationId);
          if (row && row.request_hash !== requestHash) {
            throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
          }
        }
        // Otherwise the txn rejected because the channel is not publicly joinable (visibility gate)
        // or the channel dissolved concurrently. The post-txn meta read distinguishes.
        const postMeta = this.repo.channelMetaStatusVisibility(channelId);
        if (postMeta?.status === "dissolved") {
          throw new ApiError("CHANNEL_DISSOLVED", "channel is dissolved");
        }
        throw new ApiError("FORBIDDEN", "channel is not publicly joinable");
      }

      if (txResult.writeProjection) await this.scheduleArchiveAlarm(now);
      return { channel_id: channelId, membership_version: txResult.membershipVersion, joined_at: txResult.joinedAt, role: txResult.role };
    }

    async transferOwner(input: TransferOwnerRpcInput): Promise<TransferOwnerApiResponse> {
      const userId = input.user_id;
      this.assertChannelKindChannel();
      const b = input;
      const requestHash = JSON.stringify({ target_user_id: b.target_user_id, previous_owner_role: b.previous_owner_role });
      const now = this.nowIso();
      const nowMs = Date.parse(now);
      const actorMap = await this.resolveActorMap([userId, b.target_user_id]);

      const cachedJson = readUserCompletedIdempotency(
        this.ctx.storage.sql,
        userId,
        "channel.owner_transfer",
        b.operation_id,
        requestHash,
      );
      if (cachedJson) return parseRpcCachedJson<TransferOwnerApiResponse>(cachedJson);

      type TxResult =
        | { kind: "conflict" }
        | { kind: "cached"; responseJson: string }
        | { kind: "ok"; responseJson: string };
      const txResult = await this.ctx.storage.transaction(async (): Promise<TxResult> => {
        const idem = checkUserIdempotencyInTxn(
          this.ctx.storage.sql,
          userId,
          "channel.owner_transfer",
          b.operation_id,
          requestHash,
        );
        if (idem.kind === "conflict") return { kind: "conflict" };
        if (idem.kind === "cached") return { kind: "cached", responseJson: idem.responseJson };

        const meta = this.repo.channelMetaOwnerTransfer(b.channel_id);
        if (!meta) return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
        if (meta.status === "dissolved") {
          return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
        }

        const callerRole = this.activeRole(b.channel_id, userId);
        if (callerRole !== "owner" || meta.created_by !== userId) {
          return { kind: "cached", responseJson: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may transfer ownership", retryable: false } }) };
        }

        if (b.previous_owner_role !== "admin" && b.previous_owner_role !== "member") {
          return { kind: "cached", responseJson: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "previous_owner_role must be admin or member", retryable: false } }) };
        }

        const target = this.repo.activeMemberRole(b.channel_id, b.target_user_id);
        if (!target) {
          return { kind: "cached", responseJson: JSON.stringify({ error: { code: "MEMBER_NOT_FOUND", message: "target not an active member", retryable: false } }) };
        }
        if (target.role !== "member" && target.role !== "admin") {
          return { kind: "cached", responseJson: JSON.stringify({ error: { code: "INVALID_MEMBER_ROLE", message: "target must be member or admin", retryable: false } }) };
        }
        if (b.target_user_id === meta.created_by) {
          return { kind: "cached", responseJson: JSON.stringify({ error: { code: "INVALID_MEMBER_ROLE", message: "cannot transfer ownership to current owner", retryable: false } }) };
        }

        const firstMembershipVersion = meta.membership_version + 1;
        const secondMembershipVersion = meta.membership_version + 2;

        this.ctx.storage.sql.exec("UPDATE members SET role=? WHERE channel_id=? AND user_id=?", b.previous_owner_role, b.channel_id, userId);
        this.ctx.storage.sql.exec("UPDATE members SET role=? WHERE channel_id=? AND user_id=?", "owner", b.channel_id, b.target_user_id);
        this.ctx.storage.sql.exec("UPDATE channel_meta SET created_by=?, membership_version=?, updated_at=? WHERE channel_id=?", b.target_user_id, secondMembershipVersion, now, b.channel_id);

        const oldOwnerEventId = this.nextEventId(nowMs);
        this.persistEventAndFanout(
          oldOwnerEventId,
          "member.role_updated",
          b.channel_id,
          now,
          buildMemberRoleUpdatedPayload({
            channel_id: b.channel_id,
            user_id: userId,
            before_role: "owner",
            after_role: b.previous_owner_role,
            membership_version: firstMembershipVersion,
            actor_kind: "user",
            actor_id: userId,
          }),
          firstMembershipVersion,
          now,
          actorMap,
        );

        const newOwnerEventId = this.nextEventId(nowMs);
        this.persistEventAndFanout(
          newOwnerEventId,
          "member.role_updated",
          b.channel_id,
          now,
          buildMemberRoleUpdatedPayload({
            channel_id: b.channel_id,
            user_id: b.target_user_id,
            before_role: target.role,
            after_role: "owner",
            membership_version: secondMembershipVersion,
            actor_kind: "user",
            actor_id: userId,
          }),
          secondMembershipVersion,
          now,
          actorMap,
        );

        const response = {
          channel_id: b.channel_id,
          previous_owner: { user_id: userId, role: b.previous_owner_role },
          new_owner: { user_id: b.target_user_id, role: "owner" },
        };
        const responseJson = JSON.stringify(response);
        writeUserCompletedIdempotency(this.ctx.storage.sql, {
          userId,
          operation: "channel.owner_transfer",
          operationId: b.operation_id,
          requestHash,
          responseJson,
          nowIso: now,
        });

        appendChatChannelArchive(this.ctx, b.channel_id, now, [oldOwnerEventId, newOwnerEventId], (sourceSeq) => {
          const tableRv = rvSeq(sourceSeq);
          return collectDefinedChanges([
            upsertMemberChange(this.ctx.storage.sql, b.channel_id, userId, tableRv),
            upsertMemberChange(this.ctx.storage.sql, b.channel_id, b.target_user_id, tableRv),
            upsertChannelChange(this.ctx.storage.sql, b.channel_id, tableRv),
            upsertEventChange(this.ctx.storage.sql, oldOwnerEventId),
            upsertEventChange(this.ctx.storage.sql, newOwnerEventId),
          ]);
        });

        return { kind: "ok", responseJson };
      });
      if (txResult.kind === "conflict") {
        throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
      }
      if (txResult.kind === "ok") {
        await this.scheduleArchiveAlarm(now);
        return JSON.parse(txResult.responseJson) as TransferOwnerApiResponse;
      }
      return parseRpcCachedJson<TransferOwnerApiResponse>(txResult.responseJson);
    }

    async dissolveChannel(input: DissolveChannelRpcInput): Promise<DissolveChannelApiResponse> {
      const userId = input.user_id;
      this.assertChannelKindChannel();
      const b = input;
      const channelId = b.channel_id;
      const now = this.nowIso();
      const nowMs = Date.parse(now);
      const requestHash = "{}";
      const actorMap = await this.resolveActorMap([userId]);

      const txResult = await this.ctx.storage.transaction(async (): Promise<
        | { kind: "conflict" }
        | { kind: "cached"; responseJson: string }
        | { kind: "dissolved"; channel: DissolvedChannelProjection }
      > => {
        const idem = checkUserIdempotencyInTxn(
          this.ctx.storage.sql,
          userId,
          "channel.dissolve",
          b.idempotency_key,
          requestHash,
        );
        if (idem.kind === "conflict") return { kind: "conflict" };
        if (idem.kind === "cached") return { kind: "cached", responseJson: idem.responseJson };

        const meta = this.repo.channelMetaDissolveGate(channelId);
        if (meta === undefined) return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };

        if (meta.status === "dissolved") {
          // already dissolved — idempotent cached result (no key recorded yet → record now)
          const responseJson = JSON.stringify({ channel: { channel_id: channelId, status: "dissolved", updated_at: now } });
          writeUserCompletedIdempotency(this.ctx.storage.sql, {
            userId,
            operation: "channel.dissolve",
            operationId: b.idempotency_key,
            requestHash,
            responseJson,
            nowIso: now,
          });
          return { kind: "cached", responseJson };
        }

        if (meta.created_by !== userId) {
          return { kind: "cached", responseJson: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may dissolve", retryable: false } }) };
        }

        const mvRow = this.repo.channelMetaMembershipVersionKind(channelId);
        const mv = (mvRow?.membership_version ?? 0) + 1;
        const activeMembers = this.repo.listActiveMemberUserIds(channelId).map((user_id: string) => ({ user_id }));
        this.ctx.storage.sql.exec("UPDATE channel_meta SET status='dissolved', membership_version=?, updated_at=? WHERE channel_id=?", mv, now, channelId);
        const dissolvedId = this.nextEventId(nowMs);
        this.persistEventAndFanout(dissolvedId, "channel.dissolved", channelId, now,
          buildChannelDissolvedPayload({ channel_id: channelId, dissolved_at: now, actor_kind: "user", actor_id: userId }), mv, now, actorMap);

        const responseJson = JSON.stringify({ channel: { channel_id: channelId, status: "dissolved", updated_at: now } });
        writeUserCompletedIdempotency(this.ctx.storage.sql, {
          userId,
          operation: "channel.dissolve",
          operationId: b.idempotency_key,
          requestHash,
          responseJson,
          nowIso: now,
        });
        // channel_directory projection: a dissolved channel must leave the public directory.
        if (meta.visibility === "public_listed") {
          this.insertOutboxRowForChannelDirectory(channelId, "delete", null, now);
        }
        for (const member of activeMembers) {
          this.insertUserDirectoryOutbox(
            member.user_id,
            { action: "dissolve", channel_id: channelId, kind: mvRow?.kind ?? "channel", membership_version: mv },
            now,
            `user_directory:dissolve:${channelId}:${member.user_id}:${now}`,
          );
        }

        appendChatChannelArchive(this.ctx, channelId, now, [dissolvedId], (sourceSeq) => {
          const rv = rvEvent(dissolvedId);
          return collectDefinedChanges([
            upsertChannelChange(this.ctx.storage.sql, channelId, rv),
            upsertEventChange(this.ctx.storage.sql, dissolvedId),
          ]);
        });

        return { kind: "dissolved", channel: { channel_id: channelId, status: "dissolved", updated_at: now } };
      });

      if (txResult.kind === "conflict") {
        throw new ApiError("IDEMPOTENCY_CONFLICT", "idempotency_key reused with different body");
      }
      if (txResult.kind === "dissolved") {
        await this.scheduleArchiveAlarm(now);
        return { channel: txResult.channel };
      }
      return parseRpcCachedJson<DissolveChannelApiResponse>(txResult.responseJson);
    }

    async addMember(input: AddMemberRpcInput): Promise<AddMemberApiResponse> {
      const { user_id: actorUserId, target_user_id: targetUserId, channel_id: channelId, idempotency_key, role } = input;
      this.assertChannelKindChannel();
      const now = this.nowIso();
      const nowMs = Date.parse(now);
      const requestHash = JSON.stringify({ user_id: targetUserId, role });
      const actorMap = await this.resolveActorMap([actorUserId, targetUserId]);

      const tx = await this.ctx.storage.transaction(async (): Promise<{ kind: "cached"; j: string } | { kind: "conflict" } | { kind: "ok"; member: MemberProjection & { channel_id: string } }> => {
        const idem = checkUserIdempotencyInTxn(this.ctx.storage.sql, actorUserId, "members.add", idempotency_key, requestHash);
        if (idem.kind === "conflict") return { kind: "conflict" };
        if (idem.kind === "cached") return { kind: "cached", j: idem.responseJson };

        const meta = this.repo.channelMetaAdmin(channelId);
        if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
        if (meta.status === "dissolved") return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
        const callerRole = this.activeRole(channelId, actorUserId);
        if (callerRole !== "owner" && callerRole !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "not authorized to add members", retryable: false } }) };
        if (role !== "member" && role !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "role must be member or admin", retryable: false } }) };
        if (targetUserId === actorUserId) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "cannot add self", retryable: false } }) };
        if (targetUserId === meta.created_by) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner is fixed; cannot add the owner", retryable: false } }) };

        // Member state machine (P0-5): distinguish never-joined / left / active.
        const existing = this.repo.memberRoleLeftAt(channelId, targetUserId);

        if (existing !== undefined && existing.left_at === null) {
          // Already an ACTIVE member — adding must NOT mutate role (that's PATCH /members/{user_id}).
          if (existing.role !== role) {
            return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "member already active; use PATCH /members/{user_id} to change role", retryable: false } }) };
          }
          // Idempotent re-add, no state change.
          const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: targetUserId, role: existing.role } });
          writeUserCompletedIdempotency(this.ctx.storage.sql, {
            userId: actorUserId,
            operation: "members.add",
            operationId: idempotency_key,
            requestHash,
            responseJson,
            nowIso: now,
          });
          return { kind: "cached", j: responseJson };
        }

        const mv = meta.membership_version + 1;
        // never joined → INSERT; left → reactivate (clear left_at, set role). Count +1 either way.
        if (existing === undefined) {
          this.ctx.storage.sql.exec("INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, ?, ?, NULL)", channelId, targetUserId, role, now);
        } else {
          this.ctx.storage.sql.exec("UPDATE members SET role=?, joined_at=?, left_at=NULL WHERE channel_id=? AND user_id=?", role, now, channelId, targetUserId);
        }
        this.ctx.storage.sql.exec("UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?", mv, meta.member_count + 1, now, channelId);

        const joinedId = this.nextEventId(nowMs);
        this.persistEventAndFanout(joinedId, "member.joined", channelId, now, buildMemberJoinedPayload({ channel_id: channelId, user_id: targetUserId, role, membership_version: mv, actor_kind: "user", actor_id: actorUserId, join_source: "admin_add" }), mv, now, actorMap);
        this.insertUserDirectoryOutbox(
          targetUserId,
          { action: "join", channel_id: channelId, kind: meta.kind, membership_version: mv },
          now,
          `user_directory:join:${channelId}:${targetUserId}:${now}`,
        );
        // channel_directory projection: bump the directory's member_count for public channels.
        if (meta.visibility === "public_listed") {
          this.insertOutboxRowForChannelDirectory(channelId, "upsert", this.readChannelDirectorySnapshot(channelId, now), now);
        }

        const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: targetUserId, role, joined_at: now } });
        writeUserCompletedIdempotency(this.ctx.storage.sql, {
          userId: actorUserId,
          operation: "members.add",
          operationId: idempotency_key,
          requestHash,
          responseJson,
          nowIso: now,
        });

        appendChatChannelArchive(this.ctx, channelId, now, [joinedId], (sourceSeq) => {
          const rv = rvEvent(joinedId);
          return collectDefinedChanges([
            upsertChannelChange(this.ctx.storage.sql, channelId, rv),
            upsertMemberChange(this.ctx.storage.sql, channelId, targetUserId, rv),
            upsertEventChange(this.ctx.storage.sql, joinedId),
          ]);
        });

        return { kind: "ok", member: { channel_id: channelId, user_id: targetUserId, role, joined_at: now } };
      });
      if (tx.kind === "conflict") throw new ApiError("IDEMPOTENCY_CONFLICT", "idempotency_key reused with different body");
      if (tx.kind === "ok") await this.scheduleArchiveAlarm(now);
      return tx.kind === "ok" ? { member: tx.member } : parseRpcCachedJson<AddMemberApiResponse>(tx.j);
    }

    async updateMemberRole(input: UpdateMemberRoleRpcInput): Promise<UpdateMemberRoleApiResponse> {
      const { user_id: actorUserId, target_user_id: targetUserId, channel_id: channelId, idempotency_key, role } = input;
      this.assertChannelKindChannel();
      const now = this.nowIso();
      const nowMs = Date.parse(now);
      const requestHash = JSON.stringify({ user_id: targetUserId, role });
      const actorMap = await this.resolveActorMap([actorUserId, targetUserId]);

      const tx = await this.ctx.storage.transaction(async (): Promise<{ kind: "conflict" } | { kind: "cached"; j: string } | { kind: "ok"; member: MemberProjection & { channel_id: string } }> => {
        const idem = checkUserIdempotencyInTxn(this.ctx.storage.sql, actorUserId, "members.role", idempotency_key, requestHash);
        if (idem.kind === "conflict") return { kind: "conflict" };
        if (idem.kind === "cached") return { kind: "cached", j: idem.responseJson };

        const meta = this.repo.channelMetaRoleUpdateContext(channelId);
        if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
        if (meta.status === "dissolved") return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
        const callerRole = this.activeRole(channelId, actorUserId);
        if (callerRole !== "owner") return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may change roles", retryable: false } }) };
        if (role !== "member" && role !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "role must be member or admin", retryable: false } }) };
        const target = this.repo.activeMemberRole(channelId, targetUserId);
        if (!target) return { kind: "cached", j: JSON.stringify({ error: { code: "MEMBER_NOT_FOUND", message: "target not an active member", retryable: false } }) };
        if (targetUserId === meta.created_by) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "cannot change the owner's role (owner is fixed)", retryable: false } }) };
        if (targetUserId === actorUserId) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner cannot change own role", retryable: false } }) };

        const mv = meta.membership_version + 1;
        const beforeRole = target.role;
        this.ctx.storage.sql.exec("UPDATE members SET role=? WHERE channel_id=? AND user_id=?", role, channelId, targetUserId);
        this.ctx.storage.sql.exec("UPDATE channel_meta SET membership_version=?, updated_at=? WHERE channel_id=?", mv, now, channelId);

        const updatedId = this.nextEventId(nowMs);
        this.persistEventAndFanout(updatedId, "member.role_updated", channelId, now, buildMemberRoleUpdatedPayload({ channel_id: channelId, user_id: targetUserId, before_role: beforeRole, after_role: role, membership_version: mv, actor_kind: "user", actor_id: actorUserId }), mv, now, actorMap);
        this.insertUserDirectoryOutbox(
          targetUserId,
          { action: "join", channel_id: channelId, kind: meta.kind, membership_version: mv },
          now,
          `user_directory:membership:${channelId}:${targetUserId}:${now}`,
        );

        const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: targetUserId, role } });
        writeUserCompletedIdempotency(this.ctx.storage.sql, {
          userId: actorUserId,
          operation: "members.role",
          operationId: idempotency_key,
          requestHash,
          responseJson,
          nowIso: now,
        });

        appendChatChannelArchive(this.ctx, channelId, now, [updatedId], (sourceSeq) => {
          const rv = rvEvent(updatedId);
          return collectDefinedChanges([
            upsertMemberChange(this.ctx.storage.sql, channelId, targetUserId, rv),
            upsertChannelChange(this.ctx.storage.sql, channelId, rv),
            upsertEventChange(this.ctx.storage.sql, updatedId),
          ]);
        });

        return { kind: "ok", member: { channel_id: channelId, user_id: targetUserId, role } as MemberProjection & { channel_id: string } };
      });
      if (tx.kind === "conflict") throw new ApiError("IDEMPOTENCY_CONFLICT", "idempotency_key reused with different body");
      if (tx.kind === "ok") await this.scheduleArchiveAlarm(now);
      return tx.kind === "ok" ? { member: tx.member } : parseRpcCachedJson<UpdateMemberRoleApiResponse>(tx.j);
    }

    async removeMember(input: RemoveMemberRpcInput): Promise<RemoveMemberApiResponse> {
      const { user_id: actorUserId, target_user_id: targetUserId, channel_id: channelId, idempotency_key } = input;
      this.assertChannelKindChannel();
      const now = this.nowIso();
      const nowMs = Date.parse(now);
      const requestHash = JSON.stringify({ user_id: targetUserId });
      const actorMap = await this.resolveActorMap([actorUserId, targetUserId]);

      const tx = await this.ctx.storage.transaction(async (): Promise<{ kind: "conflict" } | { kind: "cached"; j: string } | { kind: "ok" }> => {
        const idem = checkUserIdempotencyInTxn(this.ctx.storage.sql, actorUserId, "members.remove", idempotency_key, requestHash);
        if (idem.kind === "conflict") return { kind: "conflict" };
        if (idem.kind === "cached") return { kind: "cached", j: idem.responseJson };

        const meta = this.repo.channelMetaRemoveMember(channelId);
        if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
        const callerRole = this.activeRole(channelId, actorUserId);
        const isSelf = targetUserId === actorUserId;
        if (meta.status === "dissolved") {
          if (!isSelf) {
            return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
          }
        } else if (!isSelf && callerRole !== "owner") {
          return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may remove others", retryable: false } }) };
        } else if (isSelf && targetUserId === meta.created_by) {
          // Owner invariant (P1-6): active channels require dissolve/transfer before owner self-leave.
          return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner cannot leave; dissolve the channel or transfer ownership in a future phase", retryable: false } }) };
        }
        const target = this.repo.activeMemberRole(channelId, targetUserId);
        if (!target) return { kind: "cached", j: JSON.stringify({ error: { code: "MEMBER_NOT_FOUND", message: "target not an active member", retryable: false } }) };

        const mv = meta.membership_version + 1;
        // Reuse the SINGLE sync leave implementation (P0-6): co-atomic left_at + count + fanout unregister outbox.
        this.markMemberLeftAndEnqueueFanoutUnregisterSync(channelId, targetUserId, now);
        // Re-read the bumped mv/counts the sync core wrote, so the events below carry the authoritative mv.
        const mvAfter = this.repo.channelMetaMembershipVersion(channelId)?.membership_version ?? 0;

        const leftId = this.nextEventId(nowMs);
        this.persistEventAndFanout(leftId, "member.left", channelId, now, buildMemberLeftPayload({
          channel_id: channelId,
          user_id: targetUserId,
          role: target.role,
          membership_version: mvAfter,
          actor_kind: "user",
          actor_id: actorUserId,
          leave_source: isSelf ? "self" : "removed",
        }), mvAfter, now, actorMap);
        // user_directory leave projection
        this.insertUserDirectoryOutbox(
          targetUserId,
          { action: "leave", channel_id: channelId, kind: meta.kind, membership_version: mvAfter },
          now,
          `user_directory:leave:${channelId}:${targetUserId}:${now}`,
        );
        // channel_directory projection: decrement the directory's member_count for public channels.
        if (meta.visibility === "public_listed") {
          this.insertOutboxRowForChannelDirectory(channelId, "upsert", this.readChannelDirectorySnapshot(channelId, now), now);
        }

        const responseJson = JSON.stringify({ channel_id: channelId, user_id: targetUserId, removed: true });
        writeUserCompletedIdempotency(this.ctx.storage.sql, {
          userId: actorUserId,
          operation: "members.remove",
          operationId: idempotency_key,
          requestHash,
          responseJson,
          nowIso: now,
        });

        appendChatChannelArchive(this.ctx, channelId, now, [leftId], (sourceSeq) => {
          const rv = rvEvent(leftId);
          return collectDefinedChanges([
            upsertChannelChange(this.ctx.storage.sql, channelId, rv),
            upsertMemberChange(this.ctx.storage.sql, channelId, targetUserId, rv),
            upsertEventChange(this.ctx.storage.sql, leftId),
          ]);
        });

        return { kind: "ok" };
      });
      if (tx.kind === "conflict") throw new ApiError("IDEMPOTENCY_CONFLICT", "idempotency_key reused with different body");
      if (tx.kind === "ok") await this.scheduleArchiveAlarm(now);
      if (tx.kind === "ok") return { channel_id: channelId, user_id: targetUserId, removed: true };
      return parseRpcCachedJson<RemoveMemberApiResponse>((tx as { j: string }).j);
    }

    listMembers(userId: string, cursor: string): ListMembersApiResponse {
      const realMeta = this.repo.soleChannelMetaIdStatus();
      if (!realMeta) throw new ApiError("CHANNEL_NOT_FOUND", "channel not created");
      if (userId && !this.repo.isActiveMember(realMeta.channel_id, userId)) {
        throw new ApiError("FORBIDDEN", "not a member");
      }

      const rows = this.repo.listActiveMembersPage(realMeta.channel_id, cursor ?? "");
      return { items: rows };
    }

    getMember(userId: string, targetUserId: string): MemberProjection {
      const realMeta = this.repo.soleChannelMetaIdStatus();
      if (!realMeta) throw new ApiError("CHANNEL_NOT_FOUND", "channel not created");
      if (userId && !this.repo.isActiveMember(realMeta.channel_id, userId)) {
        throw new ApiError("FORBIDDEN", "not a member");
      }

      const row = this.repo.memberRoleStatus(realMeta.channel_id, targetUserId);
      if (!row) throw new ApiError("MEMBER_NOT_FOUND", "user is not a member of this channel");
      return {
        user_id: targetUserId,
        role: row.role,
        joined_at: row.joined_at,
        status: row.left_at === null ? "active" : "left",
      };
    }

    async debugLeaveMember(input: DebugLeaveMemberRpcInput): Promise<void> {
      assertTestRoutesEnabled(this.env);
      const meta = this.repo.soleChannelMetaKind();
      if (meta === undefined) throw new Error("channel not found");
      const now = this.nowIso();
      await this.markMemberLeftAndEnqueueFanoutUnregister(meta.channel_id, input.user_id, now);
      const mvAfter = this.repo.channelMetaMembershipVersion(meta.channel_id)?.membership_version ?? 0;
      this.insertUserDirectoryOutbox(
        input.user_id,
        { action: "leave", channel_id: meta.channel_id, kind: meta.kind, membership_version: mvAfter },
        now,
        `user_directory:leave:${meta.channel_id}:${input.user_id}:${now}`,
      );
      await this.scheduleOutboxAlarm(now);
    }
  };
}
