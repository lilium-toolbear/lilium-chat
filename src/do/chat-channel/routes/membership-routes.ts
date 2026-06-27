import type { ChatChannelHost } from "../host";
import {
  buildChannelDissolvedPayload,
  buildMemberJoinedPayload,
  buildMemberLeftPayload,
  buildMemberRoleUpdatedPayload,
} from "../../../chat/channel-events";
import { idempotencyExpiresAt } from "../../../contract/idempotency";
import type { MemberProjection } from "../../../contract/channel-api";
import type { DissolvedChannelProjection } from "../../../contract/channel";

export async function dispatchMembershipRoutes(host: ChatChannelHost, request: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/internal/join") {
    const b = (await request.json()) as { user_id: string; operation_id?: string };
    const userId = b.user_id;
    const callerUserId = request.headers.get("X-Verified-User-Id") ?? userId;
    const now = host.nowIso();
    const nowMs = Date.parse(now);
    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    const operationId = typeof b.operation_id === "string" && b.operation_id !== "" ? b.operation_id : null;
    // request_hash for join is just {user_id, channel_id} — the only body fields that matter.
    // The differentiator between branches is the membership state at execution time, not the body.
    const requestHash = JSON.stringify({ user_id: userId });

    const meta = host.ctx.storage.sql.exec("SELECT channel_id, kind, visibility, status, membership_version, member_count FROM channel_meta").toArray()[0] as
      | { channel_id: string; kind: string; visibility: string; status: string; membership_version: number; member_count: number }
      | undefined;
    if (meta === undefined) {
      return new Response("not found", { status: 404 });
    }
    const channelId = meta.channel_id;
    if (meta.status === "dissolved") {
      return Response.json(
        { error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } },
        { status: 409 },
      );
    }
    // DM channels are not joinable.
    if (meta.kind === "dm") {
      return Response.json(
        { error: { code: "UNSUPPORTED_CHANNEL_KIND", message: "operation not supported for DM channels", retryable: false } },
        { status: 409 },
      );
    }

    const actorMap = await host.resolveActorMap([userId]);

    // Cheap pre-check: if operation_id present and the same operation already completed with the
    // same request_hash, return the cached response WITHOUT opening a transaction.
    if (operationId) {
      const preCheck = host.ctx.storage.sql
        .exec("SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.join' AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
          callerUserId, operationId, requestHash)
        .toArray()[0] as { response_json: string } | undefined;
      if (preCheck) {
        const cached = JSON.parse(preCheck.response_json) as { channel_id?: string; membership_version?: number; joined_at?: string; role?: string };
        return Response.json({
          channel_id: cached.channel_id ?? channelId,
          membership_version: cached.membership_version ?? 0,
          joined_at: cached.joined_at ?? now,
          role: cached.role ?? "member",
        });
      }
    }

    type JoinTxResult =
      | { kind: "conflict" }
      | { kind: "ok"; membershipVersion: number; joinedAt: string; role: string; writeProjection: boolean };

    const txResult = await host.ctx.storage.transaction(async (): Promise<JoinTxResult> => {
      // Re-read meta inside the txn (handles concurrent joins).
      const m2 = host.ctx.storage.sql.exec("SELECT status, visibility, membership_version, member_count FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as
        | { status: string; visibility: string; membership_version: number; member_count: number }
        | undefined;
      if (m2 === undefined) return { kind: "conflict" };
      if (m2.status === "dissolved") return { kind: "conflict" };

      // Idempotency cache check inside the txn (handles the race where two concurrent joins interleave).
      if (operationId) {
        const idem = host.ctx.storage.sql
          .exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.join' AND operation_id=?",
            callerUserId, operationId)
          .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
        if (idem) {
          if (idem.request_hash !== requestHash) return { kind: "conflict" };
          const cached = JSON.parse(idem.response_json ?? "{}") as { membership_version?: number; joined_at?: string; role?: string };
          return { kind: "ok", membershipVersion: cached.membership_version ?? m2.membership_version, joinedAt: cached.joined_at ?? now, role: cached.role ?? "member", writeProjection: false };
        }
      }

      const m = host.ctx.storage.sql
        .exec("SELECT joined_at, left_at, role FROM members WHERE channel_id=? AND user_id=?", channelId, userId)
        .toArray()[0] as { joined_at: string; left_at: string | null; role: string } | undefined;

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
          host.ctx.storage.sql.exec(
            "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.join', ?, ?, ?, 'completed', ?, ?)",
            callerUserId, operationId, requestHash, responseJson, now, idemExpiresAt,
          );
        }
        return { kind: "ok", membershipVersion: m2.membership_version, joinedAt: m!.joined_at, role, writeProjection: false };
      }

      // Fresh join OR rejoin (left/removed): real mutation. Rejoin resets role to 'member'.
      const membershipVersion = m2.membership_version + 1;
      const joinedAt = now;
      if (m === undefined) {
        host.ctx.storage.sql.exec(
          "INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, 'member', ?, NULL)",
          channelId, userId, joinedAt,
        );
      } else {
        host.ctx.storage.sql.exec(
          "UPDATE members SET joined_at=?, left_at=NULL, role='member' WHERE channel_id=? AND user_id=?",
          joinedAt, channelId, userId,
        );
      }
      const nextCount = (m2.member_count ?? 0) + 1;
      host.ctx.storage.sql.exec(
        "UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?",
        membershipVersion, nextCount, now, channelId,
      );

      const eventId = host.nextEventId(nowMs);
      host.persistEventAndFanout(
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

      host.insertUserDirectoryOutbox(
        userId,
        { action: "join", channel_id: channelId, kind: meta.kind, membership_version: membershipVersion },
        now,
        `user_directory:join:${channelId}:${userId}:${now}`,
      );
      // channel_directory projection: bump the directory's member_count for public channels.
      if (m2.visibility === "public_listed") {
        host.insertOutboxRowForChannelDirectory(channelId, "upsert", host.readChannelDirectorySnapshot(channelId, now), now);
      }

      const role = "member";
      const responseJson = JSON.stringify({ channel_id: channelId, membership_version: membershipVersion, joined_at: joinedAt, role });
      if (operationId) {
        host.ctx.storage.sql.exec(
          "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.join', ?, ?, ?, 'completed', ?, ?)",
          callerUserId, operationId, requestHash, responseJson, now, idemExpiresAt,
        );
      }
      return { kind: "ok", membershipVersion: membershipVersion, joinedAt: joinedAt, role, writeProjection: true };
    });

    // The "conflict" kind is overloaded here to signal the visibility-gate failure (403) because
    // the gate is evaluated inside the txn. We disambiguate by re-checking visibility post-txn.
    if (txResult.kind === "conflict") {
      // If the cache had a request_hash mismatch, that's a 409 IDEMPOTENCY_CONFLICT.
      if (operationId) {
        const idem = host.ctx.storage.sql
          .exec("SELECT request_hash FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.join' AND operation_id=?",
            callerUserId, operationId)
          .toArray()[0] as { request_hash: string } | undefined;
        if (idem && idem.request_hash !== requestHash) {
          return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } }, { status: 409 });
        }
      }
      // Otherwise the txn rejected because the channel is not publicly joinable (visibility gate)
      // or the channel dissolved concurrently. The post-txn meta read distinguishes.
      const postMeta = host.ctx.storage.sql.exec("SELECT status, visibility FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; visibility: string } | undefined;
      if (postMeta?.status === "dissolved") {
        return Response.json({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }, { status: 409 });
      }
      return Response.json({ error: { code: "FORBIDDEN", message: "channel is not publicly joinable", retryable: false } }, { status: 403 });
    }

    if (txResult.writeProjection) await host.scheduleOutboxAlarm(now);
    return Response.json({ channel_id: channelId, membership_version: txResult.membershipVersion, joined_at: txResult.joinedAt, role: txResult.role });
  }

  if (url.pathname === "/internal/test-leave") {
    const testOnly = request.headers.get("X-Test-Only");
    if (testOnly !== "1") return new Response("forbidden", { status: 403 });

    const b = (await request.json()) as { user_id: string };
    const userId = b.user_id;
    const meta = host.ctx.storage.sql.exec("SELECT channel_id, kind FROM channel_meta").toArray()[0] as { channel_id: string; kind: string } | undefined;
    if (meta === undefined) {
      return new Response("not found", { status: 404 });
    }
    const now = host.nowIso();
    await host.markMemberLeftAndEnqueueFanoutUnregister(meta.channel_id, userId, now);
    const mvAfter = (host.ctx.storage.sql.exec("SELECT membership_version FROM channel_meta WHERE channel_id=?", meta.channel_id).toArray()[0] as { membership_version: number }).membership_version;
    host.insertUserDirectoryOutbox(
      userId,
      { action: "leave", channel_id: meta.channel_id, kind: meta.kind, membership_version: mvAfter },
      now,
      `user_directory:leave:${meta.channel_id}:${userId}:${now}`,
    );
    await host.scheduleOutboxAlarm(now);
    return Response.json({ ok: true });
  }

  if (url.pathname === "/internal/owner-transfer") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const kindGate = host.requireChannelKindChannel();
    if (!kindGate.ok) return kindGate.response;
    const b = (await request.json()) as {
      operation_id: string;
      channel_id: string;
      target_user_id: string;
      previous_owner_role: string;
    };
    const requestHash = JSON.stringify({ target_user_id: b.target_user_id, previous_owner_role: b.previous_owner_role });
    const now = host.nowIso();
    const nowMs = Date.parse(now);
    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    const actorMap = await host.resolveActorMap([userId, b.target_user_id]);

    const preCheck = host.ctx.storage.sql
      .exec(
        "SELECT response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.owner_transfer' AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
        userId, b.operation_id, requestHash,
      )
      .toArray()[0] as { response_json: string } | undefined;
    if (preCheck) return host.cachedResponse(preCheck.response_json);

    type TxResult =
      | { kind: "conflict" }
      | { kind: "cached"; responseJson: string }
      | { kind: "ok"; responseJson: string };
    const txResult = await host.ctx.storage.transaction(async (): Promise<TxResult> => {
      const idem = host.ctx.storage.sql
        .exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.owner_transfer' AND operation_id=?",
          userId, b.operation_id)
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" };
        return { kind: "cached", responseJson: idem.response_json ?? "{}" };
      }

      const meta = host.ctx.storage.sql
        .exec("SELECT status, created_by, membership_version FROM channel_meta WHERE channel_id=?", b.channel_id)
        .toArray()[0] as { status: string; created_by: string; membership_version: number } | undefined;
      if (!meta) return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
      if (meta.status === "dissolved") {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
      }

      const callerRole = host.activeRole(b.channel_id, userId);
      if (callerRole !== "owner" || meta.created_by !== userId) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may transfer ownership", retryable: false } }) };
      }

      if (b.previous_owner_role !== "admin" && b.previous_owner_role !== "member") {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "previous_owner_role must be admin or member", retryable: false } }) };
      }

      const target = host.ctx.storage.sql
        .exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", b.channel_id, b.target_user_id)
        .toArray()[0] as { role: string } | undefined;
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

      host.ctx.storage.sql.exec("UPDATE members SET role=? WHERE channel_id=? AND user_id=?", b.previous_owner_role, b.channel_id, userId);
      host.ctx.storage.sql.exec("UPDATE members SET role=? WHERE channel_id=? AND user_id=?", "owner", b.channel_id, b.target_user_id);
      host.ctx.storage.sql.exec("UPDATE channel_meta SET created_by=?, membership_version=?, updated_at=? WHERE channel_id=?", b.target_user_id, secondMembershipVersion, now, b.channel_id);

      const oldOwnerEventId = host.nextEventId(nowMs);
      host.persistEventAndFanout(
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

      const newOwnerEventId = host.nextEventId(nowMs);
      host.persistEventAndFanout(
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
      host.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.owner_transfer', ?, ?, ?, 'completed', ?, ?)",
        userId, b.operation_id, requestHash, responseJson, now, idemExpiresAt,
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

  if (url.pathname === "/internal/dissolve") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const kindGate = host.requireChannelKindChannel();
    if (!kindGate.ok) return kindGate.response;
    const b = (await request.json()) as { idempotency_key: string; channel_id: string };
    const channelId = b.channel_id;
    const now = host.nowIso();
    const nowMs = Date.parse(now);
    const requestHash = "{}";
    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    const actorMap = await host.resolveActorMap([userId]);

    const txResult = await host.ctx.storage.transaction(async (): Promise<
      | { kind: "conflict" }
      | { kind: "cached"; responseJson: string }
      | { kind: "dissolved"; channel: DissolvedChannelProjection }
    > => {
      const idem = host.ctx.storage.sql
        .exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='channel.dissolve' AND operation_id=?", userId, b.idempotency_key)
        .toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) {
        if (idem.request_hash !== requestHash) return { kind: "conflict" };
        return { kind: "cached", responseJson: idem.response_json ?? "{}" };
      }

      const meta = host.ctx.storage.sql.exec("SELECT status, visibility, created_by FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; visibility: string; created_by: string } | undefined;
      if (meta === undefined) return { kind: "cached", responseJson: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };

      if (meta.status === "dissolved") {
        // already dissolved — idempotent cached result (no key recorded yet → record now)
        const responseJson = JSON.stringify({ channel: { channel_id: channelId, status: "dissolved", updated_at: now } });
        host.ctx.storage.sql.exec(
          "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.dissolve', ?, ?, ?, 'completed', ?, ?)",
          userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt,
        );
        return { kind: "cached", responseJson };
      }

      if (meta.created_by !== userId) {
        return { kind: "cached", responseJson: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may dissolve", retryable: false } }) };
      }

      const mvRow = host.ctx.storage.sql.exec("SELECT membership_version, kind FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { membership_version: number; kind: string } | undefined;
      const mv = (mvRow?.membership_version ?? 0) + 1;
      const activeMembers = host.ctx.storage.sql
        .exec("SELECT user_id FROM members WHERE channel_id=? AND left_at IS NULL", channelId)
        .toArray() as Array<{ user_id: string }>;
      host.ctx.storage.sql.exec("UPDATE channel_meta SET status='dissolved', membership_version=?, updated_at=? WHERE channel_id=?", mv, now, channelId);
      const dissolvedId = host.nextEventId(nowMs);
      host.persistEventAndFanout(dissolvedId, "channel.dissolved", channelId, now,
        buildChannelDissolvedPayload({ channel_id: channelId, dissolved_at: now, actor_kind: "user", actor_id: userId }), mv, now, actorMap);

      const responseJson = JSON.stringify({ channel: { channel_id: channelId, status: "dissolved", updated_at: now } });
      host.ctx.storage.sql.exec(
        "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'channel.dissolve', ?, ?, ?, 'completed', ?, ?)",
        userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt,
      );
      // channel_directory projection: a dissolved channel must leave the public directory.
      if (meta.visibility === "public_listed") {
        host.insertOutboxRowForChannelDirectory(channelId, "delete", null, now);
      }
      for (const member of activeMembers) {
        host.insertUserDirectoryOutbox(
          member.user_id,
          { action: "dissolve", channel_id: channelId, kind: mvRow?.kind ?? "channel", membership_version: mv },
          now,
          `user_directory:dissolve:${channelId}:${member.user_id}:${now}`,
        );
      }
      return { kind: "dissolved", channel: { channel_id: channelId, status: "dissolved", updated_at: now } };
    });

    if (txResult.kind === "conflict") {
      return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
    }
    if (txResult.kind === "dissolved") {
      await host.scheduleOutboxAlarm(now);
      return Response.json({ channel: txResult.channel }, { status: 200 });
    }
    // cached (already-dissolved cached result OR an error shape encoded inside the txn).
    return host.cachedResponse(txResult.responseJson);
  }

  if (url.pathname === "/internal/members-add") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const kindGate = host.requireChannelKindChannel();
    if (!kindGate.ok) return kindGate.response;
    const b = (await request.json()) as { idempotency_key: string; channel_id: string; user_id: string; role: string };
    const channelId = b.channel_id;
    const now = host.nowIso();
    const nowMs = Date.parse(now);
    const requestHash = JSON.stringify({ user_id: b.user_id, role: b.role });
    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    const actorMap = await host.resolveActorMap([userId, b.user_id]);

    const tx = await host.ctx.storage.transaction(async (): Promise<{ kind: "cached"; j: string } | { kind: "conflict" } | { kind: "ok"; member: MemberProjection & { channel_id: string } }> => {
      const idem = host.ctx.storage.sql.exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='members.add' AND operation_id=?", userId, b.idempotency_key).toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) { if (idem.request_hash !== requestHash) return { kind: "conflict" }; return { kind: "cached", j: idem.response_json ?? "{}" }; }

      const meta = host.ctx.storage.sql.exec("SELECT status, visibility, membership_version, member_count, kind, created_by FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; visibility: string; membership_version: number; member_count: number; kind: string; created_by: string } | undefined;
      if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
      if (meta.status === "dissolved") return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
      const callerRole = host.activeRole(channelId, userId);
      if (callerRole !== "owner" && callerRole !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "not authorized to add members", retryable: false } }) };
      if (b.role !== "member" && b.role !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "role must be member or admin", retryable: false } }) };
      if (b.user_id === userId) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "cannot add self", retryable: false } }) };
      if (b.user_id === meta.created_by) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner is fixed; cannot add the owner", retryable: false } }) };

      // Member state machine (P0-5): distinguish never-joined / left / active.
      const existing = host.ctx.storage.sql.exec("SELECT role, left_at FROM members WHERE channel_id=? AND user_id=?", channelId, b.user_id).toArray()[0] as { role: string; left_at: string | null } | undefined;

      if (existing !== undefined && existing.left_at === null) {
        // Already an ACTIVE member — adding must NOT mutate role (that's PATCH /members/{user_id}).
        if (existing.role !== b.role) {
          return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "member already active; use PATCH /members/{user_id} to change role", retryable: false } }) };
        }
        // Idempotent re-add, no state change.
        const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: b.user_id, role: existing.role } });
        host.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.add', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
        return { kind: "cached", j: responseJson };
      }

      const mv = meta.membership_version + 1;
      // never joined → INSERT; left → reactivate (clear left_at, set role). Count +1 either way.
      if (existing === undefined) {
        host.ctx.storage.sql.exec("INSERT INTO members (channel_id, user_id, role, joined_at, left_at) VALUES (?, ?, ?, ?, NULL)", channelId, b.user_id, b.role, now);
      } else {
        host.ctx.storage.sql.exec("UPDATE members SET role=?, joined_at=?, left_at=NULL WHERE channel_id=? AND user_id=?", b.role, now, channelId, b.user_id);
      }
      host.ctx.storage.sql.exec("UPDATE channel_meta SET membership_version=?, member_count=?, updated_at=? WHERE channel_id=?", mv, meta.member_count + 1, now, channelId);

      const joinedId = host.nextEventId(nowMs);
      host.persistEventAndFanout(joinedId, "member.joined", channelId, now, buildMemberJoinedPayload({ channel_id: channelId, user_id: b.user_id, role: b.role, membership_version: mv, actor_kind: "user", actor_id: userId, join_source: "admin_add" }), mv, now, actorMap);
      host.insertUserDirectoryOutbox(
        b.user_id,
        { action: "join", channel_id: channelId, kind: meta.kind, membership_version: mv },
        now,
        `user_directory:join:${channelId}:${b.user_id}:${now}`,
      );
      // channel_directory projection: bump the directory's member_count for public channels.
      if (meta.visibility === "public_listed") {
        host.insertOutboxRowForChannelDirectory(channelId, "upsert", host.readChannelDirectorySnapshot(channelId, now), now);
      }

      const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: b.user_id, role: b.role, joined_at: now } });
      host.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.add', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
      return { kind: "ok", member: { channel_id: channelId, user_id: b.user_id, role: b.role, joined_at: now } };
    });
    if (tx.kind === "conflict") return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
    if (tx.kind === "ok") await host.scheduleOutboxAlarm(now);
    return tx.kind === "ok" ? Response.json({ member: tx.member }, { status: 200 }) : host.cachedResponse(tx.j);
  }

  if (url.pathname === "/internal/members-update-role") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const kindGate = host.requireChannelKindChannel();
    if (!kindGate.ok) return kindGate.response;
    const b = (await request.json()) as { idempotency_key: string; channel_id: string; user_id: string; role: string };
    const channelId = b.channel_id;
    const now = host.nowIso();
    const nowMs = Date.parse(now);
    const requestHash = JSON.stringify({ user_id: b.user_id, role: b.role });
    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    const actorMap = await host.resolveActorMap([userId, b.user_id]);

    const tx = await host.ctx.storage.transaction(async (): Promise<{ kind: "conflict" } | { kind: "cached"; j: string } | { kind: "ok"; member: MemberProjection & { channel_id: string } }> => {
      const idem = host.ctx.storage.sql.exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='members.role' AND operation_id=?", userId, b.idempotency_key).toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) { if (idem.request_hash !== requestHash) return { kind: "conflict" }; return { kind: "cached", j: idem.response_json ?? "{}" }; }

      const meta = host.ctx.storage.sql.exec("SELECT status, membership_version, created_by, kind FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; membership_version: number; created_by: string; kind: string } | undefined;
      if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
      if (meta.status === "dissolved") return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
      const callerRole = host.activeRole(channelId, userId);
      if (callerRole !== "owner") return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may change roles", retryable: false } }) };
      if (b.role !== "member" && b.role !== "admin") return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "role must be member or admin", retryable: false } }) };
      const target = host.ctx.storage.sql.exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, b.user_id).toArray()[0] as { role: string } | undefined;
      if (!target) return { kind: "cached", j: JSON.stringify({ error: { code: "MEMBER_NOT_FOUND", message: "target not an active member", retryable: false } }) };
      if (b.user_id === meta.created_by) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "cannot change the owner's role (owner is fixed)", retryable: false } }) };
      if (b.user_id === userId) return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner cannot change own role", retryable: false } }) };

      const mv = meta.membership_version + 1;
      const beforeRole = target.role;
      host.ctx.storage.sql.exec("UPDATE members SET role=? WHERE channel_id=? AND user_id=?", b.role, channelId, b.user_id);
      host.ctx.storage.sql.exec("UPDATE channel_meta SET membership_version=?, updated_at=? WHERE channel_id=?", mv, now, channelId);

      const updatedId = host.nextEventId(nowMs);
      host.persistEventAndFanout(updatedId, "member.role_updated", channelId, now, buildMemberRoleUpdatedPayload({ channel_id: channelId, user_id: b.user_id, before_role: beforeRole, after_role: b.role, membership_version: mv, actor_kind: "user", actor_id: userId }), mv, now, actorMap);
      host.insertUserDirectoryOutbox(
        b.user_id,
        { action: "join", channel_id: channelId, kind: meta.kind, membership_version: mv },
        now,
        `user_directory:membership:${channelId}:${b.user_id}:${now}`,
      );

      const responseJson = JSON.stringify({ member: { channel_id: channelId, user_id: b.user_id, role: b.role } });
      host.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.role', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
      return { kind: "ok", member: { channel_id: channelId, user_id: b.user_id, role: b.role } as MemberProjection & { channel_id: string } };
    });
    if (tx.kind === "conflict") return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
    if (tx.kind === "ok") await host.scheduleOutboxAlarm(now);
    return tx.kind === "ok" ? Response.json({ member: tx.member }, { status: 200 }) : host.cachedResponse(tx.j);
  }

  if (url.pathname === "/internal/members-remove") {
    const userId = request.headers.get("X-Verified-User-Id") ?? "";
    if (!userId) return new Response("missing verified user", { status: 401 });
    const kindGate = host.requireChannelKindChannel();
    if (!kindGate.ok) return kindGate.response;
    const b = (await request.json()) as { idempotency_key: string; channel_id: string; user_id: string };
    const channelId = b.channel_id;
    const now = host.nowIso();
    const nowMs = Date.parse(now);
    const requestHash = JSON.stringify({ user_id: b.user_id });
    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    const actorMap = await host.resolveActorMap([userId, b.user_id]);

    const tx = await host.ctx.storage.transaction(async (): Promise<{ kind: "conflict" } | { kind: "cached"; j: string } | { kind: "ok" }> => {
      const idem = host.ctx.storage.sql.exec("SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind='user' AND principal_id=? AND operation='members.remove' AND operation_id=?", userId, b.idempotency_key).toArray()[0] as { request_hash: string; response_json: string | null } | undefined;
      if (idem) { if (idem.request_hash !== requestHash) return { kind: "conflict" }; return { kind: "cached", j: idem.response_json ?? "{}" }; }

      const meta = host.ctx.storage.sql.exec("SELECT status, visibility, membership_version, kind, created_by FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { status: string; visibility: string; membership_version: number; kind: string; created_by: string } | undefined;
      if (!meta) return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found", retryable: false } }) };
      const callerRole = host.activeRole(channelId, userId);
      const isSelf = b.user_id === userId;
      if (meta.status === "dissolved") {
        if (!isSelf) {
          return { kind: "cached", j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved", retryable: false } }) };
        }
      } else if (!isSelf && callerRole !== "owner") {
        return { kind: "cached", j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner may remove others", retryable: false } }) };
      } else if (isSelf && b.user_id === meta.created_by) {
        // Owner invariant (P1-6): active channels require dissolve/transfer before owner self-leave.
        return { kind: "cached", j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "owner cannot leave; dissolve the channel or transfer ownership in a future phase", retryable: false } }) };
      }
      const target = host.ctx.storage.sql.exec("SELECT role FROM members WHERE channel_id=? AND user_id=? AND left_at IS NULL", channelId, b.user_id).toArray()[0] as { role: string } | undefined;
      if (!target) return { kind: "cached", j: JSON.stringify({ error: { code: "MEMBER_NOT_FOUND", message: "target not an active member", retryable: false } }) };

      const mv = meta.membership_version + 1;
      // Reuse the SINGLE sync leave implementation (P0-6): co-atomic left_at + count + fanout unregister outbox.
      host.markMemberLeftAndEnqueueFanoutUnregisterSync(channelId, b.user_id, now);
      // Re-read the bumped mv/counts the sync core wrote, so the events below carry the authoritative mv.
      const mvAfter = (host.ctx.storage.sql.exec("SELECT membership_version FROM channel_meta WHERE channel_id=?", channelId).toArray()[0] as { membership_version: number }).membership_version;

      const leftId = host.nextEventId(nowMs);
      host.persistEventAndFanout(leftId, "member.left", channelId, now, buildMemberLeftPayload({
        channel_id: channelId,
        user_id: b.user_id,
        role: target.role,
        membership_version: mvAfter,
        actor_kind: "user",
        actor_id: userId,
        leave_source: isSelf ? "self" : "removed",
      }), mvAfter, now, actorMap);
      // user_directory leave projection
      host.insertUserDirectoryOutbox(
        b.user_id,
        { action: "leave", channel_id: channelId, kind: meta.kind, membership_version: mvAfter },
        now,
        `user_directory:leave:${channelId}:${b.user_id}:${now}`,
      );
      // channel_directory projection: decrement the directory's member_count for public channels.
      if (meta.visibility === "public_listed") {
        host.insertOutboxRowForChannelDirectory(channelId, "upsert", host.readChannelDirectorySnapshot(channelId, now), now);
      }

      const responseJson = JSON.stringify({ channel_id: channelId, user_id: b.user_id, removed: true });
      host.ctx.storage.sql.exec("INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('user', ?, 'members.remove', ?, ?, ?, 'completed', ?, ?)", userId, b.idempotency_key, requestHash, responseJson, now, idemExpiresAt);
      return { kind: "ok" };
    });
    if (tx.kind === "conflict") return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key reused with different body", retryable: false } }, { status: 409 });
    if (tx.kind === "ok") await host.scheduleOutboxAlarm(now);
    if (tx.kind === "ok") return Response.json({ channel_id: channelId, user_id: b.user_id, removed: true }, { status: 200 });
    return host.cachedResponse((tx as { j: string }).j);
  }

  return null;
}
