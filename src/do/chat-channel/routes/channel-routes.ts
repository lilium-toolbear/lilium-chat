import type { ChatChannelHost } from "../host";
import {
  buildChannelCreatedPayload,
  buildChannelUpdatedPayload,
  buildMemberJoinedPayload,
} from "../../../chat/channel-events";
import type {
  ManagementPersistedEventType,
  ManagementPersistedPayload,
} from "../../../contract/persisted";
import { idempotencyExpiresAt } from "../../../contract/idempotency";
import type { ChannelMetaProjection, ChannelUpdatePresentFields } from "../../../contract/channel-api";
import type { AttachmentRow as ChatAttachmentRow } from "../../../chat/attachment-projection";
import { personalInviteCode } from "../../../chat/invite-code";

export async function dispatchChannelRoutes(host: ChatChannelHost, request: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/internal/invites-create") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });

    const b = (await request.json()) as {
      operation_id: string;
      channel_id: string;
      expires_in_seconds?: number;
      max_uses?: number | null;
    };

    if (!b.operation_id) {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "operation_id is required", retryable: false } }, { status: 422 });
    }
    if (!b.channel_id) {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "channel_id is required", retryable: false } }, { status: 422 });
    }

    const channelId = b.channel_id;
    const now = host.nowIso();
    const nowMs = Date.parse(now);
    const requestHash = JSON.stringify({
      channel_id: channelId,
      expires_in_seconds: b.expires_in_seconds ?? 7 * 24 * 60 * 60,
      max_uses: b.max_uses ?? null,
    });

    const rawExpires = b.expires_in_seconds ?? 7 * 24 * 60 * 60;
    if (!Number.isInteger(rawExpires) || rawExpires <= 0) {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "expires_in_seconds must be a positive integer", retryable: false } }, { status: 422 });
    }

    const rawMaxUses = b.max_uses ?? null;
    if (rawMaxUses !== null && (!Number.isInteger(rawMaxUses) || rawMaxUses < 0)) {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "max_uses must be a non-negative integer or null", retryable: false } }, { status: 422 });
    }

    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    const expiresAt = new Date(nowMs + rawExpires * 1000).toISOString();
    const maxUses: number | null = rawMaxUses;

    const preCheck = host.ctx.storage.sql
      .exec(
        "SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.invite_create' AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
        userId, b.operation_id, requestHash,
      )
      .toArray()[0] as { response_json: string } | undefined;
    if (preCheck) return host.cachedResponse(preCheck.response_json);

    const inviteCode = await personalInviteCode(channelId, userId);
    const outboxId = `invite_directory:${inviteCode}:${now}`;
    const outboxEventId = host.nextEventId(nowMs);
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

    const txResult = await host.ctx.storage.transaction(async (): Promise<TxResult> => {
      const idem = host.ctx.storage.sql
        .exec(
          "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.invite_create' AND operation_id=?",
          userId,
          b.operation_id,
        )
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" };
        return { kind: "cached", responseJson: idem.response_json ?? "{}" };
      }

      const meta = host.ctx.storage.sql
        .exec("SELECT status FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { status: string } | undefined;
      if (!meta) return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
      if (meta.status === "dissolved") {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
      }

      const role = host.activeRole(channelId, userId);
      if (!role) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "FORBIDDEN", message: "only channel members may create invite", retryable: false } }) };
      }

      const existing = host.ctx.storage.sql
        .exec("SELECT invite_code, created_by, revoked_at FROM invites WHERE invite_code=?", inviteCode)
        .toArray()[0] as { invite_code: string; created_by: string; revoked_at: string | null } | undefined;

      if (existing === undefined) {
        host.ctx.storage.sql.exec(
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
        host.ctx.storage.sql.exec(
          "UPDATE invites SET expires_at=?, max_uses=?, revoked_at=NULL WHERE invite_code=?",
          expiresAt,
          maxUses,
          inviteCode,
        );
      }
      host.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.invite_create', ?, ?, ?, 'completed', ?, ?)",
        userId,
        b.operation_id,
        requestHash,
        responseJson,
        now,
        idemExpiresAt,
      );
      host.ctx.storage.sql.exec(
        "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'invite_directory', ?, ?, ?, 'pending', ?, ?, ?, 0, 5)",
        outboxId,
        inviteCode,
        outboxEventId,
        JSON.stringify({ invite_code: inviteCode, channel_id: channelId, status: "active", expires_at: expiresAt, revoked_at: null }),
        now,
        now,
        now,
      );

      return { kind: "ok", responseJson, outboxId };
    });

    if (txResult.kind === "conflict") {
      return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } }, { status: 409 });
    }
    if (txResult.kind === "cached") {
      return host.cachedResponse(txResult.responseJson);
    }

    await host.flushSingleInviteDirectoryOutbox(txResult.outboxId, now);
    await host.scheduleOutboxAlarm(now);
    return Response.json(JSON.parse(txResult.responseJson));
  }

  if (url.pathname === "/internal/invites-accept") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const b = (await request.json()) as {
      operation_id: string;
      channel_id: string;
      invite_code: string;
    };
    const operationId = b.operation_id;
    if (!operationId) {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "operation_id is required", retryable: false } }, { status: 422 });
    }
    const channelId = b.channel_id;
    if (!channelId) {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "channel_id is required", retryable: false } }, { status: 422 });
    }
    const inviteCode = b.invite_code;
    if (!inviteCode) {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "invite_code is required", retryable: false } }, { status: 422 });
    }

    const now = host.nowIso();
    const nowMs = Date.parse(now);
    const requestHash = JSON.stringify({ channel_id: channelId, invite_code: inviteCode });
    const idemExpiresAt = idempotencyExpiresAt(nowMs);

    type TxResult =
      | { kind: "conflict" }
      | { kind: "cached"; responseJson: string }
      | { kind: "ok"; responseJson: string };

    const inviteHead = host.ctx.storage.sql
      .exec("SELECT created_by FROM invites WHERE invite_code=?", inviteCode)
      .toArray()[0] as { created_by: string } | undefined;
    const inviterUserIdForResolve = inviteHead?.created_by ?? userId;
    const actorMap = await host.resolveActorMap([userId, inviterUserIdForResolve]);

    const txResult = await host.ctx.storage.transaction(async (): Promise<TxResult> => {
      const idem = host.ctx.storage.sql
        .exec(
          "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.invite_accept' AND operation_id=?",
          userId,
          operationId,
        )
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" };
        return { kind: "cached", responseJson: idem.response_json ?? "{}" };
      }

      const meta = host.ctx.storage.sql
        .exec(
          "SELECT channel_id, kind, visibility, title, avatar_url, member_count, membership_version, status FROM channel_meta WHERE channel_id=?",
          channelId,
        )
        .toArray()[0] as
        | { channel_id: string; kind: string; visibility: string; title: string; avatar_url: string | null; member_count: number; membership_version: number; status: string }
        | undefined;
      if (!meta) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
      }
      const dissolved = host.assertNotDissolved(meta.status);
      if (dissolved) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: dissolved.code, message: dissolved.message, retryable: false } }) };
      }

      const invite = host.ctx.storage.sql
        .exec(
          "SELECT invite_code, created_by, expires_at, max_uses, used_count, revoked_at FROM invites WHERE invite_code=?",
          inviteCode,
        )
        .toArray()[0] as
        | { invite_code: string; created_by: string; expires_at: string; max_uses: number | null; used_count: number; revoked_at: string | null }
        | undefined;
      if (!invite || invite.invite_code !== inviteCode) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "INVITE_NOT_FOUND", message: "invite not found", retryable: false } }) };
      }

      const expiresAtMs = Date.parse(invite.expires_at);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || invite.revoked_at !== null) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "INVITE_NOT_FOUND", message: "invite not found", retryable: false } }) };
      }

      const currentMember = host.ctx.storage.sql
        .exec("SELECT role, joined_at, left_at FROM members WHERE channel_id=? AND user_id=?", channelId, userId)
        .toArray()[0] as { role: string; joined_at: string; left_at: string | null } | undefined;

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
        host.ctx.storage.sql.exec(
          "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.invite_accept', ?, ?, ?, 'completed', ?, ?)",
          userId,
          operationId,
          requestHash,
          responseJson,
          now,
          idemExpiresAt,
        );
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
        host.ctx.storage.sql.exec(
          "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, ?, ?, NULL)",
          channelId,
          userId,
          "member",
          now,
        );
      } else {
        host.ctx.storage.sql.exec(
          "UPDATE members SET role=?, joined_at=?, left_at=NULL WHERE channel_id=? AND user_id=?",
          "member",
          now,
          channelId,
          userId,
        );
      }
      host.ctx.storage.sql.exec("UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?", mv, meta.member_count + 1, now, channelId);
      host.ctx.storage.sql.exec("UPDATE invites SET used_count = used_count + 1 WHERE invite_code=?", invite.invite_code);

      const joinedId = host.nextEventId(nowMs);
      host.persistEventAndFanout(
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
      host.insertUserDirectoryOutbox(
        userId,
        host.userDirectoryJoinPayload(userId, channelId, meta.kind, mv),
        now,
        `user_directory:join:${channelId}:${userId}:${now}`,
      );
      if (meta.visibility === "public_listed") {
        host.insertOutboxRowForChannelDirectory(channelId, "upsert", host.readChannelDirectorySnapshot(channelId, now), now);
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
      host.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.invite_accept', ?, ?, ?, 'completed', ?, ?)",
        userId,
        operationId,
        requestHash,
        responseJson,
        now,
        idemExpiresAt,
      );
      return { kind: "ok", responseJson };
    });

    if (txResult.kind === "conflict") {
      return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } }, { status: 409 });
    }
    if (txResult.kind === "ok") {
      await host.scheduleOutboxAlarm(now);
      return Response.json(JSON.parse(txResult.responseJson), { status: 200 });
    }
    return host.cachedResponse(txResult.responseJson);
  }

  if (url.pathname === "/internal/create-channel") {
    const creatorUserId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!creatorUserId) return new Response("missing verified user", { status: 401 });
    const b = (await request.json()) as {
      channel_id: string; creator_user_id: string; title: string; topic: string | null;
      avatar_attachment_id: string | null; visibility: string;
      initial_members: Array<{ user_id: string; role: string }>;
    };
    const channelId = b.channel_id;
    if (!channelId) return Response.json({ error: { code: "INVALID_MESSAGE", message: "channel_id required", retryable: false } }, { status: 422 });
    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (title === "") return Response.json({ error: { code: "INVALID_MESSAGE", message: "title is required", retryable: false } }, { status: 422 });
    if (b.avatar_attachment_id !== null && b.avatar_attachment_id !== undefined) {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "avatar_attachment_id not supported in Phase 3", retryable: false } }, { status: 422 });
    }
    const visibility = b.visibility ?? "private";
    if (!["private", "public_unlisted", "public_listed"].includes(visibility)) {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "invalid visibility", retryable: false } }, { status: 422 });
    }
    const initialMembers = Array.isArray(b.initial_members) ? b.initial_members : [];
    for (const im of initialMembers) {
      if (im.role !== "member" && im.role !== "admin") {
        return Response.json({ error: { code: "INVALID_MESSAGE", message: "initial_members role must be member or admin", retryable: false } }, { status: 422 });
      }
      if (im.user_id === creatorUserId) {
        return Response.json({ error: { code: "INVALID_MESSAGE", message: "creator must not be in initial_members", retryable: false } }, { status: 422 });
      }
    }

    const now = host.nowIso();
    const nowMs = Date.parse(now);

    // Pre-resolve actor UserSummary BEFORE the txn (Hyperdrive is a network call).
    const actorMap = await host.resolveActorMap([creatorUserId]);

    // Build all persisted payloads + event ids + live frames up front (sync), then write in one txn.
    const ownerMv = 1;
    const events: Array<{
      id: string;
      type: ManagementPersistedEventType;
      payload: ManagementPersistedPayload;
      mv: number;
    }> = [];
    const channelCreatedId = host.nextEventId(nowMs);
    events.push({ id: channelCreatedId, type: "channel.created", payload: buildChannelCreatedPayload({ channel_id: channelId, kind: "channel", visibility, title, actor_kind: "user", actor_id: creatorUserId }), mv: ownerMv });
    const memberJoinedCreatorId = host.nextEventId(nowMs);
    events.push({ id: memberJoinedCreatorId, type: "member.joined", payload: buildMemberJoinedPayload({ channel_id: channelId, user_id: creatorUserId, role: "owner", membership_version: ownerMv, actor_kind: "system", actor_id: "system" }), mv: ownerMv });

    let mv = ownerMv;
    for (const im of initialMembers) {
      mv += 1;
      const eid = host.nextEventId(nowMs);
      events.push({ id: eid, type: "member.joined", payload: buildMemberJoinedPayload({ channel_id: channelId, user_id: im.user_id, role: im.role, membership_version: mv, actor_kind: "system", actor_id: "system" }), mv });
    }

    const finalMv = mv;
    const memberCount = 1 + initialMembers.length;

    const result = await host.ctx.storage.transaction(async (): Promise<
      | { kind: "cached"; channel: ChannelMetaProjection; joinedAt: string }
      | { kind: "created"; channel: ChannelMetaProjection; joinedAt: string }
    > => {
      const existing = host.ctx.storage.sql.exec("SELECT channel_id FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { channel_id: string } | undefined;
      if (existing !== undefined) {
        // Idempotent re-call (coordinator crashed after create committed, before marking completed).
        // Return the channel FROM THE DB, not from the request body — the re-call may carry a
        // different body shape than the original committed row.
        const meta = host.ctx.storage.sql.exec("SELECT channel_id, kind, visibility, title, topic, avatar_url, member_count, status, created_at, updated_at FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { channel_id: string; kind: string; visibility: string; title: string; topic: string | null; avatar_url: string | null; member_count: number; status: string; created_at: string; updated_at: string };
        const owner = host.ctx.storage.sql.exec("SELECT joined_at FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, creatorUserId).toArray()[0] as { joined_at: string } | undefined;
        const cachedChannel = { channel_id: meta.channel_id, kind: meta.kind, visibility: meta.visibility, title: meta.title, topic: meta.topic, avatar_url: meta.avatar_url, member_count: meta.member_count, status: meta.status, created_at: meta.created_at, updated_at: meta.updated_at };
        return { kind: "cached" as const, channel: cachedChannel, joinedAt: owner?.joined_at ?? meta.created_at };
      }

      host.ctx.storage.sql.exec(
        `INSERT INTO channel_meta (channel_id, kind, visibility, title, topic, avatar_url, status, created_by, created_at, updated_at, member_count, membership_version) VALUES (?, 'channel', ?, ?, ?, NULL, 'active', ?, ?, ?, ?, ?)`,
        channelId, visibility, title, b.topic ?? null, creatorUserId, now, now, memberCount, finalMv,
      );
      host.ctx.storage.sql.exec(
        "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'owner', ?, NULL)",
        channelId, creatorUserId, now,
      );
      for (const im of initialMembers) {
        host.ctx.storage.sql.exec(
          "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, ?, ?, NULL)",
          channelId, im.user_id, im.role, now,
        );
      }
      for (const ev of events) {
        host.persistEventAndFanout(ev.id, ev.type, channelId, now, ev.payload, ev.mv, now, actorMap);
      }
      // user_directory join projections (creator + each initial member)
      host.insertUserDirectoryOutbox(
        creatorUserId,
        host.userDirectoryJoinPayload(creatorUserId, channelId, "channel", ownerMv),
        now,
        `user_directory:join:${channelId}:${creatorUserId}:${now}`,
      );
      for (const im of initialMembers) {
        host.insertUserDirectoryOutbox(
          im.user_id,
          host.userDirectoryJoinPayload(im.user_id, channelId, "channel", finalMv),
          now,
          `user_directory:join:${channelId}:${im.user_id}:${now}`,
        );
      }
      // channel_directory projection: only public_listed channels appear in the directory.
      if (visibility === "public_listed") {
        host.insertOutboxRowForChannelDirectory(channelId, "upsert", {
          title, avatar_url: null, member_count: memberCount, last_message_at: null, status: "active",
        }, now);
      }
      return { kind: "created" as const, channel: { channel_id: channelId, kind: "channel", visibility, title, topic: b.topic ?? null, avatar_url: null, member_count: memberCount, status: "active", created_at: now, updated_at: now }, joinedAt: now };
    });

    if (result.kind === "created") await host.scheduleOutboxAlarm(now);

    return Response.json({
      channel: result.channel,
      membership: { role: "owner", joined_at: result.joinedAt },
      event_ids: result.kind === "created" ? events.map((e) => e.id) : [],
    });
  }

  if (url.pathname === "/internal/create-dm") {
    const createdBy = request.headers.get("X-Verified-User-Id") ?? "";
    if (!createdBy) return new Response("missing verified user", { status: 401 });
    const b = (await request.json()) as {
      channel_id: string;
      user_a: string;
      user_b: string;
      created_by: string;
    };
    const channelId = b.channel_id;
    if (!channelId) {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "channel_id required", retryable: false } }, { status: 422 });
    }
    const userA = b.user_a;
    const userB = b.user_b;
    if (!userA || !userB || userA === userB) {
      return Response.json({ error: { code: "INVALID_DM_TARGET", message: "invalid dm participants", retryable: false } }, { status: 422 });
    }

    const now = host.nowIso();
    const nowMs = Date.parse(now);
    const membershipVersion = 1;

    const result = await host.ctx.storage.transaction(async (): Promise<
      | { kind: "cached"; channel: ChannelMetaProjection; joinedAtByUser: Record<string, string> }
      | { kind: "created"; channel: ChannelMetaProjection; joinedAtByUser: Record<string, string> }
    > => {
      const existing = host.ctx.storage.sql
        .exec("SELECT channel_id FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { channel_id: string } | undefined;

      const members = host.ctx.storage.sql
        .exec("SELECT user_id, joined_at FROM members WHERE channel_id=? AND left_at IS NULL", channelId)
        .toArray() as Array<{ user_id: string; joined_at: string }>;
      const joinedAtByUser: Record<string, string> = {};
      for (const m of members) joinedAtByUser[m.user_id] = m.joined_at;

      if (existing !== undefined) {
        const meta = host.ctx.storage.sql
          .exec("SELECT channel_id, kind, visibility, title, topic, avatar_url, member_count, status, created_at, updated_at FROM channel_meta WHERE channel_id=?", channelId)
          .toArray()[0] as {
            channel_id: string; kind: string; visibility: string; title: string; topic: string | null;
            avatar_url: string | null; member_count: number; status: string; created_at: string; updated_at: string;
          };
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

      host.ctx.storage.sql.exec(
        `INSERT INTO channel_meta (channel_id, kind, visibility, title, topic, avatar_url, status, created_by, created_at, updated_at, member_count, membership_version)
         VALUES (?, 'dm', 'private', '', NULL, NULL, 'active', ?, ?, ?, 2, ?)`,
        channelId, b.created_by, now, now, membershipVersion,
      );
      host.ctx.storage.sql.exec(
        "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'member', ?, NULL)",
        channelId, userA, now,
      );
      host.ctx.storage.sql.exec(
        "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'member', ?, NULL)",
        channelId, userB, now,
      );
      joinedAtByUser[userA] = now;
      joinedAtByUser[userB] = now;

      const auditId = `${channelId}:create-dm:${now}`;
      host.ctx.storage.sql.exec(
        "INSERT INTO audit_logs (audit_id, actor_kind, actor_id, action, target_type, target_id, before_json, after_json, reason, request_id, created_at) VALUES (?, 'user', ?, 'channel.create_dm', 'channel', ?, NULL, ?, NULL, ?, ?)",
        auditId, b.created_by, channelId, JSON.stringify({ channel_id: channelId, kind: "dm", user_a: userA, user_b: userB }), channelId, now,
      );

      const channelCreatedId = host.nextEventId(nowMs);
      host.ctx.storage.sql.exec(
        "INSERT INTO events (event_id, event_type, channel_id, payload_json, occurred_at) VALUES (?, 'channel.created', ?, ?, ?)",
        channelCreatedId, channelId, JSON.stringify(buildChannelCreatedPayload({
          channel_id: channelId, kind: "dm", visibility: "private", title: "", actor_kind: "user", actor_id: b.created_by,
        })), now,
      );

      for (const userId of [userA, userB]) {
        host.insertUserDirectoryOutbox(
          userId,
          host.userDirectoryJoinPayload(userId, channelId, "dm", membershipVersion),
          now,
          `user_directory:join:${channelId}:${userId}:${now}`,
        );
      }

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

    if (result.kind === "created") await host.scheduleOutboxAlarm(now);

    return Response.json({
      ...result.channel,
      joined_at_by_user: result.joinedAtByUser,
    });
  }

  if (url.pathname === "/internal/update-channel") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const kindGate = host.requireChannelKindChannel();
    if (!kindGate.ok) return kindGate.response;
    const b = (await request.json()) as {
      idempotency_key: string; channel_id: string;
      title?: string; topic?: string | null; avatar_attachment_id?: string | null; visibility?: string;
    };
    const channelId = b.channel_id;
    const now = host.nowIso();
    const nowMs = Date.parse(now);

    let pendingAvatarUrl: string | null | undefined;
    if (b.avatar_attachment_id !== undefined) {
      if (b.avatar_attachment_id === null) {
        pendingAvatarUrl = null;
      } else {
        const userDir = host.env.USER_DIRECTORY.getByName(userId);
        const attachmentRes = await userDir.fetch(
          new Request(`https://x/internal/attachment-get?attachment_id=${encodeURIComponent(b.avatar_attachment_id)}`, {
            headers: { "X-Verified-User-Id": userId },
          }),
        );
        if (!attachmentRes.ok) {
          return Response.json(
            { error: { code: "UNSUPPORTED_ATTACHMENT_TYPE", message: "attachment not finalized", retryable: false } },
            { status: 415 },
          );
        }
        const attachmentBody = (await attachmentRes.json()) as { attachment: ChatAttachmentRow };
        const attachmentRow = attachmentBody.attachment;
        if (!attachmentRow || attachmentRow.status !== "finalized" || attachmentRow.owner_user_id !== userId) {
          return Response.json(
            { error: { code: "UNSUPPORTED_ATTACHMENT_TYPE", message: "attachment not available", retryable: false } },
            { status: 415 },
          );
        }
        if (attachmentRow.kind !== "avatar") {
          return Response.json(
            { error: { code: "UNSUPPORTED_ATTACHMENT_TYPE", message: "channel avatar must use the avatar upload namespace", retryable: false } },
            { status: 415 },
          );
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
    const idemExpiresAt = idempotencyExpiresAt(nowMs);

    const actorMap = await host.resolveActorMap([userId]);

    const txResult = await host.ctx.storage.transaction(async (): Promise<
      | { kind: "conflict" }
      | { kind: "cached"; responseJson: string }
      | { kind: "ok"; channel: ChannelMetaProjection }
    > => {
      const idem = host.ctx.storage.sql
        .exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.update' AND operation_id=?", userId, b.idempotency_key)
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" };
        return { kind: "cached", responseJson: idem.response_json ?? "{}" };
      }

      const meta = host.ctx.storage.sql
        .exec("SELECT kind, visibility, title, topic, avatar_url, status, created_at, updated_at, member_count, membership_version FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { kind: string; visibility: string; title: string; topic: string | null; avatar_url: string | null; status: string; created_at: string; updated_at: string; member_count: number; membership_version: number } | undefined;
      if (meta === undefined) {
        // channel gone → 404 CHANNEL_NOT_FOUND (NOT a conflict).
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
      }
      const d = host.assertNotDissolved(meta.status);
      if (d) return { kind: "cached", responseJson: JSON.stringify({ error: { code: d.code, message: d.message, retryable: false } }) };

      const role = host.activeRole(channelId, userId);
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
        host.ctx.storage.sql.exec(
          "UPDATE channel_meta SET title=?, topic=?, visibility=?, avatar_url=?, updated_at=? WHERE channel_id=?",
          newTitle, newTopic, newVisibility, newAvatarUrl, now, channelId,
        );

        const mv = meta.membership_version;
        const updatedId = host.nextEventId(nowMs);
        host.persistEventAndFanout(updatedId, "channel.updated", channelId, now,
          buildChannelUpdatedPayload({ channel_id: channelId, channel_changes: changes, actor_kind: "user", actor_id: userId }), mv, now, actorMap);
      }

      const responseJson = JSON.stringify({ channel });
      host.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.update', ?, ?, ?, 'completed', ?, ?)",
        userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt,
      );
      // channel_directory projection: visibility transitions + public title/topic/avatar updates.
      if (Object.keys(changes).length > 0) {
        if (meta.visibility === "public_listed" && newVisibility !== "public_listed") {
          // public → private/public_unlisted: remove from directory
          host.insertOutboxRowForChannelDirectory(channelId, "delete", null, now);
        } else if (meta.visibility !== "public_listed" && newVisibility === "public_listed") {
          // non-public → public_listed: add to directory with current full snapshot
          host.insertOutboxRowForChannelDirectory(channelId, "upsert", host.readChannelDirectorySnapshot(channelId, now), now);
        } else if (meta.visibility === "public_listed" && newVisibility === "public_listed") {
          // public → public: re-project (title/topic/avatar changed)
          host.insertOutboxRowForChannelDirectory(channelId, "upsert", host.readChannelDirectorySnapshot(channelId, now), now);
        }
      }
      // both non-public → no outbox write
      return { kind: "ok", channel };
    });

    if (txResult.kind === "conflict") {
      return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
    }
    if (txResult.kind === "ok") {
      const mvRow = host.ctx.storage.sql
        .exec("SELECT membership_version FROM channel_meta WHERE channel_id=?", channelId)
        .toArray()[0] as { membership_version: number };
      host.enqueueUserDirectorySummaryUpdates(now, mvRow.membership_version);
      await host.scheduleOutboxAlarm(now);
      return Response.json({ channel: txResult.channel }, { status: 200 });
    }
    // cached branch (success cached OR an error shape encoded inside the txn).
    return host.cachedResponse(txResult.responseJson);
  }

  return null;
}
