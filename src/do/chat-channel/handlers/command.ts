import { uuidv7 } from "../../../ids/uuidv7";
import {
  buildEventFrame,
  buildMessageLifecyclePayload,
  type UserSummary as LiveUserSummary,
} from "../../../chat/event-broadcast";
import { projectMessageForBrowser } from "../../../chat/message-projection";
import { buildCommandBindingUpdatedPayload } from "../../../chat/channel-events";
import type { MessageRow } from "../../../contract/persisted";
import type { CommandInvocationReplyContext } from "../../../contract/message";
import type {
  CommandBindingUpdateResponse,
  CommandInvokeResponse,
  CommandManifestResponse,
} from "../../../contract/bot-api";
import { ApiError, logSwallowedError } from "../../../errors";
import { fallbackUserDisplayName } from "../../../contract/primitives";
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
  upsertCommandBindingChange,
  upsertCommandInvocationChange,
  upsertEventChange,
  upsertMessageChange,
} from "../../../archive/chat-channel-record";
import { buildManifestRemoveDelta, buildManifestUpsertDelta, appendPlatformCommandItems, projectCommandManifest } from "../../../chat/command-manifest";
import { parseCommandBindingSnapshot } from "../../../chat/command-snapshot";
import type { CommandOption } from "../../../chat/command-options";
import {
  mergeOfficialIntoBindingRows,
  isOfficialCommandBlocked,
  isOfficialCommandId,
  officialCommandToSnapshot,
  type ChannelBindingRow,
  type OfficialCommandCatalogItem,
} from "../../../chat/official-command-manifest";
import {
  PLATFORM_BOT_AVATAR_URL,
  PLATFORM_BOT_DISPLAY_NAME,
  PLATFORM_BOT_ID,
  PLATFORM_HELP_BOT_COMMAND_ID,
  PLATFORM_HELP_NAME,
  PLATFORM_PERMISSION_BOT_COMMAND_ID,
  PLATFORM_PERMISSION_NAME,
  buildPlatformHelpText,
  buildPlatformPermissionListText,
  buildPlatformPermissionMutationText,
  computeManageableCommands,
  isPlatformHelpCommand,
  isPlatformPermissionCommand,
  resolveManageableCommandName,
} from "../../../chat/platform-commands";
import { invokedNameMatchesSnapshot } from "../../../chat/slash-token";
import { buildReplySnapshot, loadReplySnapshotMedia, replyTargetSenderDisplayName } from "../../../chat/reply-snapshot";
import { projectCommandInvokeReplyContext } from "../../../chat/command-invoke-reply";
import { insertUserCommandInvocationMessage } from "../lib/invocation-message";
import { statefulCommandInvoke } from "./stateful-session";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";
import { asHandlerRef, type ChatChannelHandlerRef } from "../handler-ref";
import type { CommandBindingUpdateRpcInput, InvokeCommandRpcInput } from "../../../contract/chat-channel-rpc";


  async function resolveCommandInvokeReplyContext(channel: ChatChannelHandlerRef, 
    channelId: string,
    replyToMessageId: string | null,
  ): Promise<
    | { ok: true; reply_to: CommandInvocationReplyContext | null; reply_snapshot_json: string | null }
    | { ok: false; code: string; message: string }
  > {
    if (!replyToMessageId) return { ok: true, reply_to: null, reply_snapshot_json: null };

    const targetRow = channel.ctx.storage.sql
      .exec(
        `SELECT message_id, command_id, channel_id, sender_kind, sender_user_id, sender_bot_id,
                sender_bot_display_name, sender_bot_avatar_url, type, format, status, text, reply_to,
                reply_snapshot_json, stream_state, created_at, updated_at, edited_at, deleted_at,
                deleted_by, recalled_at
         FROM messages WHERE message_id=? AND channel_id=?`,
        replyToMessageId,
        channelId,
      )
      .toArray()[0] as MessageRow | undefined;
    if (!targetRow || (targetRow.status !== "normal" && targetRow.status !== "edited")) {
      return { ok: false, code: "MESSAGE_NOT_FOUND", message: "reply target not found" };
    }

    let senderSummary: LiveUserSummary | null = null;
    if (targetRow.sender_kind === "user" && targetRow.sender_user_id) {
      const actorMap = await channel.resolveActorMap([targetRow.sender_user_id]);
      senderSummary = actorMap.get(targetRow.sender_user_id) ?? null;
    }

    const targetSenderDisplayName = senderSummary?.display_name ?? replyTargetSenderDisplayName(targetRow);
    const mediaPreview = loadReplySnapshotMedia(
      channel.ctx.storage.sql,
      targetRow.message_id,
      targetRow.type,
    );

    return {
      ok: true,
      reply_to: projectCommandInvokeReplyContext(targetRow, senderSummary),
      reply_snapshot_json: JSON.stringify(
        buildReplySnapshot(targetRow, targetSenderDisplayName, { mediaPreview }),
      ),
    };
  }

  function memberRoleRank(role: string | null): number {
    if (role === "owner") return 3;
    if (role === "admin") return 2;
    if (role === "member") return 1;
    return 0;
  }

  function hasRolePermission(callerRole: string | null, requiredRole: string): boolean {
    return memberRoleRank(callerRole) >= memberRoleRank(requiredRole);
  }

  function parseInvokeSnapshot(raw: string) {
    return parseCommandBindingSnapshot(raw);
  }

  function validateInvokeOptions(
    provided: Record<string, { type: string; value: unknown }>,
    schemaOptions: CommandOption[],
  ): { ok: true } | { ok: false; message: string } {
    const schemaByName = new Map(schemaOptions.map((option) => [option.name, option]));

    for (const option of schemaOptions) {
      if (option.required && !provided[option.name]) {
        return { ok: false, message: `missing required option: ${option.name}` };
      }
    }

    for (const [name, value] of Object.entries(provided)) {
      const schema = schemaByName.get(name);
      if (!schema) {
        return { ok: false, message: `unknown option: ${name}` };
      }
      if (schema.type !== value.type) {
        return { ok: false, message: `option ${name} type mismatch` };
      }
      if (schema.type === "string") {
        if (typeof value.value !== "string") return { ok: false, message: `option ${name} must be string` };
      } else if (schema.type === "integer") {
        if (typeof value.value !== "number" || !Number.isInteger(value.value)) {
          return { ok: false, message: `option ${name} must be integer` };
        }
        if (typeof schema.min === "number" && value.value < schema.min) {
          return { ok: false, message: `option ${name} below min` };
        }
        if (typeof schema.max === "number" && value.value > schema.max) {
          return { ok: false, message: `option ${name} above max` };
        }
      } else if (schema.type === "number") {
        if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
          return { ok: false, message: `option ${name} must be number` };
        }
        if (typeof schema.min === "number" && value.value < schema.min) {
          return { ok: false, message: `option ${name} below min` };
        }
        if (typeof schema.max === "number" && value.value > schema.max) {
          return { ok: false, message: `option ${name} above max` };
        }
      } else if (schema.type === "boolean") {
        if (typeof value.value !== "boolean") return { ok: false, message: `option ${name} must be boolean` };
      } else if (typeof value.value !== "string" || value.value.length === 0) {
        return { ok: false, message: `option ${name} must be non-empty string` };
      }
    }

    return { ok: true };
  }

  async function fetchOfficialCatalog(channel: ChatChannelHandlerRef): Promise<OfficialCommandCatalogItem[]> {
    try {
      const registry = channel.env.BOT_REGISTRY.getByName("registry") as unknown as {
        officialCommands(): Promise<{ items: OfficialCommandCatalogItem[] }>;
      };
      const body = await registry.officialCommands();
      return Array.isArray(body.items) ? body.items : [];
    } catch (err) {
      logSwallowedError("official_catalog_fetch_failed", err);
      return [];
    }
  }

  function readChannelBindingRows(channel: ChatChannelHandlerRef, channelId: string): ChannelBindingRow[] {
    return channel.ctx.storage.sql
      .exec(
        `SELECT bot_command_id, bot_id, status, command_snapshot_json, permission_override
         FROM channel_command_bindings
         WHERE channel_id=?`,
        channelId,
      )
      .toArray() as unknown as ChannelBindingRow[];
  }

  async function buildMergedManifest(channel: ChatChannelHandlerRef, 
    channelId: string,
    manifestVersion: number,
    callerRole?: string | null,
  ): Promise<ReturnType<typeof appendPlatformCommandItems>> {
    const bindingRows = readChannelBindingRows(channel, channelId);
    const officialCatalog = await fetchOfficialCatalog(channel);
    const merged = mergeOfficialIntoBindingRows(bindingRows, officialCatalog);
    return appendPlatformCommandItems(projectCommandManifest(manifestVersion, merged), callerRole);
  }

async function handleCommandInvoke(channel: ChatChannelHandlerRef, input: InvokeCommandRpcInput): Promise<CommandInvokeResponse> {
    const userId = input.user_id;
    const b = input;
    const operation = "command.invoke";
    const operationId = b.operation_id;
    const channelId = b.channel_id;
    const botCommandId = b.bot_command_id;
    const invokedName = b.invoked_name;
    const commandManifestVersion = b.command_manifest_version;
    const options = b.options;
    const replyToMessageId = b.reply_to_message_id;
    const now = channel.nowIso();
    const nowMs = Date.parse(now);
    const requestHash = JSON.stringify({
      channel_id: channelId,
      bot_command_id: botCommandId,
      invoked_name: invokedName,
      command_manifest_version: commandManifestVersion,
      options,
      reply_to_message_id: replyToMessageId,
    });

    const cachedJson = readUserCompletedIdempotency(
      channel.ctx.storage.sql,
      userId,
      operation,
      operationId,
      requestHash,
    );
    if (cachedJson) return parseRpcCachedJson<CommandInvokeResponse>(cachedJson);

    const meta = channel.repo.channelMetaCommand(channelId);
    if (!meta) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
    if (meta.kind === "dm") throw new ApiError("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels");
    if (meta.status === "dissolved") throw new ApiError("CHANNEL_DISSOLVED", "channel is dissolved");

    const callerRole = channel.activeRole(channelId, userId);
    if (!callerRole) throw new ApiError("FORBIDDEN", "not a channel member");

    if (commandManifestVersion !== meta.command_manifest_version) {
      const err = new ApiError("COMMAND_MANIFEST_VERSION_STALE", "command manifest version is stale");
      Object.assign(err, { current_command_manifest_version: meta.command_manifest_version });
      throw err;
    }

    if (isPlatformHelpCommand(botCommandId)) {
      return handlePlatformHelpInvoke(channel, {
        userId,
        channelId,
        operationId,
        commandManifestVersion,
        options,
        requestHash,
        now,
        nowMs,
        membershipVersion: meta.membership_version,
      });
    }

    if (isPlatformPermissionCommand(botCommandId)) {
      if (callerRole !== "owner" && callerRole !== "admin") {
        throw new ApiError("COMMAND_PERMISSION_DENIED", "You do not have permission to use this command.");
      }
      return handlePlatformPermissionInvoke(channel, {
        userId,
        channelId,
        operationId,
        commandManifestVersion,
        options,
        requestHash,
        now,
        nowMs,
        membershipVersion: meta.membership_version,
        callerRole,
      });
    }

    const binding = channel.ctx.storage.sql
      .exec(
        "SELECT bot_id, status, permission_override, command_snapshot_json, stateful_max_ttl_seconds FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
        channelId,
        botCommandId,
      )
      .toArray()[0] as {
        bot_id: string;
        status: string;
        permission_override: string | null;
        command_snapshot_json: string;
        stateful_max_ttl_seconds: number | null;
      } | undefined;

    const officialCatalog = await fetchOfficialCatalog(channel);
    let bindingBotId: string;
    let bindingPermissionOverride: string | null;
    let bindingMaxTtl: number | null;
    let snapshot = null as ReturnType<typeof parseInvokeSnapshot>;

    if (binding?.status === "blocked") {
      const err = new ApiError("COMMAND_NOT_ALLOWED", "This slash command is not allowed in this channel.");
      Object.assign(err, { current_command_manifest_version: meta.command_manifest_version });
      throw err;
    }

    if (binding?.status === "allowed") {
      snapshot = parseInvokeSnapshot(binding.command_snapshot_json);
      bindingBotId = binding.bot_id;
      bindingPermissionOverride = binding.permission_override;
      bindingMaxTtl = binding.stateful_max_ttl_seconds;
    } else {
      const officialItem = officialCatalog.find((item) => item.bot_command_id === botCommandId);
      if (!officialItem) {
        const err = new ApiError("COMMAND_NOT_ALLOWED", "This slash command is not allowed in this channel.");
        Object.assign(err, { current_command_manifest_version: meta.command_manifest_version });
        throw err;
      }
      snapshot = parseInvokeSnapshot(JSON.stringify(officialCommandToSnapshot(officialItem)));
      bindingBotId = officialItem.bot.bot_id;
      bindingPermissionOverride = null;
      bindingMaxTtl = null;
    }

    if (!snapshot) {
      throw new ApiError("COMMAND_OPTIONS_INVALID", "invalid command snapshot");
    }
    const requiredRole = bindingPermissionOverride ?? snapshot.default_member_permission;
    if (!hasRolePermission(callerRole, requiredRole)) {
      throw new ApiError("COMMAND_PERMISSION_DENIED", "You do not have permission to use this command.");
    }
    const optionsValidation = validateInvokeOptions(options, snapshot.options);
    if (!optionsValidation.ok) {
      throw new ApiError("COMMAND_OPTIONS_INVALID", optionsValidation.message);
    }
    if (!invokedNameMatchesSnapshot(invokedName, snapshot.name, snapshot.aliases)) {
      throw new ApiError(
        "COMMAND_OPTIONS_INVALID",
        "invoked_name does not match command canonical name or aliases",
      );
    }

    const connectionState = await channel.env.BOT_CONNECTION.getByName(bindingBotId)
      .getConnectionState()
      .catch(() => ({ status: "disconnected" as const, session_id: null }));
    if (connectionState.status !== "connected") {
      throw new ApiError("BOT_OFFLINE", "The bot is currently offline.", { retryable: true });
    }

    const actorMap = await channel.resolveActorMap([userId]);
    const actor = actorMap.get(userId) ?? {
      user_id: userId,
      display_name: fallbackUserDisplayName(userId),
      avatar_url: null,
    };

    const replyResolution = await resolveCommandInvokeReplyContext(channel, channelId, replyToMessageId);
    if (!replyResolution.ok) {
      throw new ApiError(replyResolution.code, replyResolution.message);
    }
    const invokeReplyTo = replyResolution.reply_to;
    const invokeReplySnapshotJson = replyResolution.reply_snapshot_json;

    if (snapshot.execution.mode === "stateful") {
      return statefulCommandInvoke(channel, {
        userId,
        channelId,
        botCommandId,
        operationId,
        invokedName,
        options,
        snapshot,
        bindingBotId,
        bindingMaxTtl: bindingMaxTtl,
        requestHash,
        actor,
        reply_to: invokeReplyTo,
      });
    }

    const txResult = channel.ctx.storage.transactionSync(() => {
      const idem = checkUserIdempotencyInTxn(
        channel.ctx.storage.sql,
        userId,
        operation,
        operationId,
        requestHash,
      );
      if (idem.kind === "conflict") return { kind: "conflict" as const };
      if (idem.kind === "cached") return { kind: "cached" as const, responseJson: idem.responseJson };

      const currentMeta = channel.ctx.storage.sql
        .exec(
          "SELECT status, membership_version, command_manifest_version FROM channel_meta WHERE channel_id=?",
          channelId,
        )
        .toArray()[0] as { status: string; membership_version: number; command_manifest_version: number } | undefined;
      if (!currentMeta) {
        return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found" } }) };
      }
      if (currentMeta.status === "dissolved") {
        return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" } }) };
      }
      if (currentMeta.command_manifest_version !== commandManifestVersion) {
        return {
          kind: "error" as const,
          j: JSON.stringify({
            error: {
              code: "COMMAND_MANIFEST_VERSION_STALE",
              message: "command manifest version is stale",
              current_command_manifest_version: currentMeta.command_manifest_version,
            },
          }),
        };
      }

      const currentBinding = channel.ctx.storage.sql
        .exec(
          "SELECT status FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
          channelId,
          botCommandId,
        )
        .toArray()[0] as { status: string } | undefined;
      if (currentBinding?.status === "blocked") {
        return {
          kind: "error" as const,
          j: JSON.stringify({
            error: {
              code: "COMMAND_NOT_ALLOWED",
              message: "This slash command is not allowed in this channel.",
              current_command_manifest_version: currentMeta.command_manifest_version,
            },
          }),
        };
      }

      const currentSnapshot = snapshot;
      if (!currentSnapshot) {
        return {
          kind: "error" as const,
          j: JSON.stringify({ error: { code: "COMMAND_OPTIONS_INVALID", message: "invalid command snapshot" } }),
        };
      }
      const currentRequiredRole = bindingPermissionOverride ?? currentSnapshot.default_member_permission;
      if (!hasRolePermission(callerRole, currentRequiredRole)) {
        return {
          kind: "error" as const,
          j: JSON.stringify({ error: { code: "COMMAND_PERMISSION_DENIED", message: "You do not have permission to use this command." } }),
        };
      }
      const currentOptionsValidation = validateInvokeOptions(options, currentSnapshot.options);
      if (!currentOptionsValidation.ok) {
        return {
          kind: "error" as const,
          j: JSON.stringify({ error: { code: "COMMAND_OPTIONS_INVALID", message: currentOptionsValidation.message } }),
        };
      }

      const invocationMessage = insertUserCommandInvocationMessage(channel, {
        userId,
        channelId,
        operationId,
        botCommandId,
        invokedName: invokedName || currentSnapshot.name,
        options,
        now,
        nowMs,
        membershipVersion: currentMeta.membership_version,
        senderSummary: actor,
        messageId: uuidv7(nowMs),
        reply_to: replyToMessageId,
        reply_snapshot_json: invokeReplySnapshotJson,
      });

      const invocationId = uuidv7(nowMs + 1);
      channel.ctx.storage.sql.exec(
        `INSERT INTO command_invocations (
           invocation_id, channel_id, command_id, invoker_user_id, bot_id, bot_command_id, command_name,
           invoked_name, command_schema_version, command_definition_hash, options_json,
           status, error_code, error_message, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
        invocationId,
        channelId,
        operationId,
        userId,
        bindingBotId,
        botCommandId,
        currentSnapshot.name,
        invokedName || currentSnapshot.name,
        typeof currentSnapshot.execution.schema_version === "number" ? currentSnapshot.execution.schema_version : 1,
        typeof currentSnapshot.execution.definition_hash === "string"
          ? currentSnapshot.execution.definition_hash
          : `snapshot:${botCommandId}`,
        JSON.stringify(options),
        now,
        now,
      );

      const eventId = channel.nextEventId(nowMs + 2);
      const persistedPayload = {
        invocation: { invocation_id: invocationId, status: "pending", created_at: now },
        command_id: operationId,
      };
      channel.ctx.storage.sql.exec(
        "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'command.invoked', ?, 'user', ?, ?, ?, ?)",
        eventId,
        channelId,
        userId,
        JSON.stringify(persistedPayload),
        currentMeta.membership_version,
        now,
      );
      const frame = buildEventFrame({
        event_id: eventId,
        type: "command.invoked",
        channel_id: channelId,
        occurred_at: now,
        payload: persistedPayload,
      });
      channel.insertOutboxRowForFanout(
        channelId,
        eventId,
        JSON.stringify(frame),
        currentMeta.membership_version,
        now,
      );

      const outboxId = `bot_delivery:${channelId}:${invocationId}`;
      channel.ctx.storage.sql.exec(
        `INSERT INTO bot_delivery_outbox (
           outbox_id, channel_id, bot_id, kind, invocation_id, interaction_id, event_id, request_json,
           status, attempts, max_attempts, last_error, failed_at, next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'command_invocation', ?, NULL, ?, ?, 'pending', 0, 5, NULL, NULL, ?, ?, ?)`,
        outboxId,
        channelId,
        bindingBotId,
        invocationId,
        eventId,
        JSON.stringify({
          delivery_type: "command_invocation",
          invocation_id: invocationId,
          bot_command: {
            bot_command_id: botCommandId,
            name: currentSnapshot.name,
            invoked_name: invokedName || currentSnapshot.name,
            schema_version: typeof currentSnapshot.execution.schema_version === "number"
              ? currentSnapshot.execution.schema_version
              : 1,
            definition_hash: typeof currentSnapshot.execution.definition_hash === "string"
              ? currentSnapshot.execution.definition_hash
              : `snapshot:${botCommandId}`,
          },
          invoker: actor,
          options,
          ...(invokeReplyTo ? { reply_to: invokeReplyTo } : {}),
        }),
        now,
        now,
        now,
      );

      const responseBody = {
        channel_id: channelId,
        invocation_id: invocationId,
        event_id: eventId,
        invocation_message: invocationMessage.liveMessage,
      };
      writeUserCompletedIdempotency(channel.ctx.storage.sql, {
        userId,
        operation,
        operationId,
        requestHash,
        responseJson: JSON.stringify(responseBody),
        nowIso: now,
      });

      appendChatChannelArchive(channel.ctx, channelId, now, [invocationMessage.invocationEventId, eventId], () =>
        collectDefinedChanges([
          upsertMessageChange(
            channel.ctx.storage.sql,
            invocationMessage.invocationMessageId,
            channelId,
            rvEvent(invocationMessage.invocationEventId),
          ),
          upsertCommandInvocationChange(channel.ctx.storage.sql, invocationId, rvEvent(eventId)),
          upsertEventChange(channel.ctx.storage.sql, invocationMessage.invocationEventId),
          upsertEventChange(channel.ctx.storage.sql, eventId),
        ]),
      );

      return { kind: "ok" as const, responseJson: JSON.stringify(responseBody) };
    });

    if (txResult.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
    }
    if (txResult.kind === "cached") {
      return parseRpcCachedJson<CommandInvokeResponse>(txResult.responseJson);
    }
    if (txResult.kind === "error") {
      parseRpcCachedJson<never>(txResult.j);
      throw new ApiError("CHAT_WORKER_UNAVAILABLE", "unexpected cached invoke error");
    }
    if (txResult.kind !== "ok") {
      throw new ApiError("CHAT_WORKER_UNAVAILABLE", "unexpected invoke result");
    }
    await channel.scheduleArchiveAlarm(now);
    return parseRpcCachedJson<CommandInvokeResponse>(txResult.responseJson);
  }

  async function handlePlatformHelpInvoke(channel: ChatChannelHandlerRef, input: {
    userId: string;
    channelId: string;
    operationId: string;
    commandManifestVersion: number;
    options: Record<string, { type: string; value: unknown }>;
    requestHash: string;
    now: string;
    nowMs: number;
    membershipVersion: number;
  }): Promise<CommandInvokeResponse> {
    const operation = "command.invoke";
    const manifest = await buildMergedManifest(channel, input.channelId, input.commandManifestVersion);
    const commandOptionRaw = input.options.command?.value;
    const commandOption = typeof commandOptionRaw === "string" ? commandOptionRaw : undefined;
    const helpText = buildPlatformHelpText(manifest.items, commandOption);

    const actorMap = await channel.resolveActorMap([input.userId]);
    const senderSummary = actorMap.get(input.userId) ?? {
      user_id: input.userId,
      display_name: fallbackUserDisplayName(input.userId),
      avatar_url: null,
    };

    const txResult = channel.ctx.storage.transactionSync(() => {
      const idem = checkUserIdempotencyInTxn(
        channel.ctx.storage.sql,
        input.userId,
        operation,
        input.operationId,
        input.requestHash,
      );
      if (idem.kind === "conflict") return { kind: "conflict" as const };
      if (idem.kind === "cached") return { kind: "cached" as const, responseJson: idem.responseJson };

      const invocationMessage = insertUserCommandInvocationMessage(channel, {
        userId: input.userId,
        channelId: input.channelId,
        operationId: input.operationId,
        botCommandId: PLATFORM_HELP_BOT_COMMAND_ID,
        invokedName: PLATFORM_HELP_NAME,
        options: input.options,
        now: input.now,
        nowMs: input.nowMs,
        membershipVersion: input.membershipVersion,
        senderSummary,
        messageId: uuidv7(input.nowMs),
      });

      const messageId = uuidv7(input.nowMs + 1);
      const invocationId = uuidv7(input.nowMs + 2);
      const eventId = channel.nextEventId(input.nowMs + 3);
      const replyToMessageId = invocationMessage.invocationMessageId;
      const replySnapshotJson = JSON.stringify(
        buildReplySnapshot(invocationMessage.invocationMessageRow, senderSummary.display_name),
      );

      channel.ctx.storage.sql.exec(
        `INSERT INTO messages (
           message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
           sender_bot_id, sender_bot_display_name, sender_bot_avatar_url, type, format, status, text,
           reply_to, reply_snapshot_json, stream_state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'bot', NULL, ?, ?, ?, 'text', 'markdown', 'normal', ?, ?, ?, 'none', ?, ?)`,
        messageId,
        input.operationId,
        `bot:${PLATFORM_BOT_ID}`,
        input.channelId,
        PLATFORM_BOT_ID,
        PLATFORM_BOT_DISPLAY_NAME,
        PLATFORM_BOT_AVATAR_URL,
        helpText,
        replyToMessageId,
        replySnapshotJson,
        input.now,
        input.now,
      );

      channel.ctx.storage.sql.exec(
        `INSERT INTO command_invocations (
           invocation_id, channel_id, command_id, invoker_user_id, bot_id, bot_command_id, command_name,
           invoked_name, command_schema_version, command_definition_hash, options_json,
           status, error_code, error_message, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'completed', NULL, NULL, ?, ?, ?)`,
        invocationId,
        input.channelId,
        input.operationId,
        input.userId,
        PLATFORM_BOT_ID,
        PLATFORM_HELP_BOT_COMMAND_ID,
        PLATFORM_HELP_NAME,
        PLATFORM_HELP_NAME,
        `platform:${PLATFORM_HELP_BOT_COMMAND_ID}`,
        JSON.stringify(input.options),
        input.now,
        input.now,
        input.now,
      );

      const messageRow: MessageRow = {
        message_id: messageId,
        command_id: input.operationId,
        channel_id: input.channelId,
        sender_kind: "bot",
        sender_user_id: null,
        sender_bot_id: PLATFORM_BOT_ID,
        sender_bot_display_name: PLATFORM_BOT_DISPLAY_NAME,
        sender_bot_avatar_url: PLATFORM_BOT_AVATAR_URL,
        type: "text",
        format: "markdown",
        status: "normal",
        text: helpText,
        reply_to: replyToMessageId,
        reply_snapshot_json: replySnapshotJson,
        stream_state: "none",
        created_at: input.now,
        updated_at: input.now,
        edited_at: null,
        deleted_at: null,
        deleted_by: null,
        recalled_at: null,
      };

      const liveMessage = projectMessageForBrowser(messageRow, { replyTargetStatus: "normal" });
      const liveEventFrame = buildEventFrame({
        event_id: eventId,
        type: "message.created",
        channel_id: input.channelId,
        occurred_at: input.now,
        payload: { message: liveMessage },
      });
      const persistedPayload = buildMessageLifecyclePayload(messageRow);
      channel.ctx.storage.sql.exec(
        "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'message.created', ?, 'user', ?, ?, ?, ?)",
        eventId,
        input.channelId,
        input.userId,
        JSON.stringify(persistedPayload),
        input.membershipVersion,
        input.now,
      );
      channel.insertOutboxRowForFanout(
        input.channelId,
        eventId,
        JSON.stringify(liveEventFrame),
        input.membershipVersion,
        input.now,
      );

      const responseBody = {
        channel_id: input.channelId,
        invocation_id: invocationId,
        event_id: eventId,
        message_id: messageId,
        message: liveMessage,
        invocation_message: invocationMessage.liveMessage,
      };
      writeUserCompletedIdempotency(channel.ctx.storage.sql, {
        userId: input.userId,
        operation,
        operationId: input.operationId,
        requestHash: input.requestHash,
        responseJson: JSON.stringify(responseBody),
        nowIso: input.now,
      });

      appendChatChannelArchive(channel.ctx, input.channelId, input.now, [invocationMessage.invocationEventId, eventId], () =>
        collectDefinedChanges([
          upsertMessageChange(
            channel.ctx.storage.sql,
            invocationMessage.invocationMessageId,
            input.channelId,
            rvEvent(invocationMessage.invocationEventId),
          ),
          upsertMessageChange(channel.ctx.storage.sql, messageId, input.channelId, rvEvent(eventId)),
          upsertCommandInvocationChange(channel.ctx.storage.sql, invocationId, rvEvent(eventId)),
          upsertEventChange(channel.ctx.storage.sql, invocationMessage.invocationEventId),
          upsertEventChange(channel.ctx.storage.sql, eventId),
        ]),
      );

      return { kind: "ok" as const, responseJson: JSON.stringify(responseBody) };
    });

    if (txResult.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
    }
    if (txResult.kind === "cached") {
      return parseRpcCachedJson<CommandInvokeResponse>(txResult.responseJson);
    }
    await channel.scheduleArchiveAlarm(input.now);
    return parseRpcCachedJson<CommandInvokeResponse>(txResult.responseJson);
  }

  async function handlePlatformPermissionInvoke(channel: ChatChannelHandlerRef, input: {
    userId: string;
    channelId: string;
    operationId: string;
    commandManifestVersion: number;
    options: Record<string, { type: string; value: unknown }>;
    requestHash: string;
    now: string;
    nowMs: number;
    membershipVersion: number;
    callerRole: string;
  }): Promise<CommandInvokeResponse> {
    const operation = "command.invoke";
    const bindingRows = readChannelBindingRows(channel, input.channelId);
    const officialCatalog = await fetchOfficialCatalog(channel);
    const manageableCommands = computeManageableCommands(bindingRows, officialCatalog);

    const commandOptionRaw = input.options.command?.value;
    const actionOptionRaw = input.options.action?.value;
    const commandOption = typeof commandOptionRaw === "string" ? commandOptionRaw.trim() : "";
    const actionOption = typeof actionOptionRaw === "string" ? actionOptionRaw.trim().toLowerCase() : "";

    let replyText = buildPlatformPermissionListText(manageableCommands);
    let mutation:
      | {
          botCommandId: string;
          status: "allowed" | "blocked";
          commandName: string;
        }
      | null = null;

    if (commandOption.length > 0) {
      if (actionOption !== "on" && actionOption !== "off") {
        replyText = "用法: /permission <命令> on|off";
      } else {
        const resolved = resolveManageableCommandName(manageableCommands, commandOption);
        if (!resolved) {
          replyText = `未知命令: ${commandOption}`;
        } else if (
          actionOption === "on"
          && isOfficialCommandId(resolved.bot_command_id, officialCatalog)
          && !isOfficialCommandBlocked(bindingRows, resolved.bot_command_id)
        ) {
          throw new ApiError(
            "OFFICIAL_COMMAND_AUTO_ALLOWED",
            "official commands are auto-allowed in every channel",
          );
        } else {
          mutation = {
            botCommandId: resolved.bot_command_id,
            status: actionOption === "on" ? "allowed" : "blocked",
            commandName: resolved.name,
          };
          replyText = buildPlatformPermissionMutationText(resolved.name, actionOption === "on");
        }
      }
    }

    const actorMap = await channel.resolveActorMap([input.userId]);
    const senderSummary = actorMap.get(input.userId) ?? {
      user_id: input.userId,
      display_name: fallbackUserDisplayName(input.userId),
      avatar_url: null,
    };

    const txResult = channel.ctx.storage.transactionSync(() => {
      const idem = checkUserIdempotencyInTxn(
        channel.ctx.storage.sql,
        input.userId,
        operation,
        input.operationId,
        input.requestHash,
      );
      if (idem.kind === "conflict") return { kind: "conflict" as const };
      if (idem.kind === "cached") return { kind: "cached" as const, responseJson: idem.responseJson };

      const meta = channel.ctx.storage.sql
        .exec(
          "SELECT command_manifest_version FROM channel_meta WHERE channel_id=?",
          input.channelId,
        )
        .toArray()[0] as { command_manifest_version: number } | undefined;
      if (!meta) {
        return {
          kind: "error" as const,
          j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found" } }),
        };
      }

      let bindingUpdatedEventId: string | null = null;

      if (mutation) {
        const binding = channel.ctx.storage.sql
          .exec(
            "SELECT bot_id, status, permission_override, command_snapshot_json FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
            input.channelId,
            mutation.botCommandId,
          )
          .toArray()[0] as {
            bot_id: string;
            status: string;
            permission_override: string | null;
            command_snapshot_json: string;
          } | undefined;

        const beforeStatus = binding?.status ?? "blocked";
        const beforePermission = binding?.permission_override ?? null;
        const beforeSnapshot = binding?.command_snapshot_json ?? null;
        const nextManifestVersion = meta.command_manifest_version + 1;
        let bindingBotId = binding?.bot_id ?? "";
        let snapshotJson = binding?.command_snapshot_json ?? "{}";
        let manifestDelta = buildManifestRemoveDelta(nextManifestVersion);

        if (mutation.status === "allowed") {
          const officialItem = officialCatalog.find((item) => item.bot_command_id === mutation.botCommandId);
          if (officialItem && isOfficialCommandBlocked(bindingRows, mutation.botCommandId)) {
            channel.ctx.storage.sql.exec(
              "DELETE FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
              input.channelId,
              mutation.botCommandId,
            );
            bindingBotId = officialItem.bot.bot_id;
            snapshotJson = JSON.stringify(officialCommandToSnapshot(officialItem));
            const projected = projectCommandManifest(nextManifestVersion, [
              {
                status: "allowed",
                command_snapshot_json: snapshotJson,
                permission_override: beforePermission,
              },
            ]);
            const item = projected.items[0];
            if (!item) {
              return {
                kind: "error" as const,
                j: JSON.stringify({ error: { code: "INVALID_COMMAND_OPTIONS", message: "invalid command snapshot" } }),
              };
            }
            manifestDelta = buildManifestUpsertDelta(nextManifestVersion, item);
          } else {
          const commandSnapshot = binding
            ? parseCommandBindingSnapshot(binding.command_snapshot_json)
            : null;
          if (!commandSnapshot) {
            return {
              kind: "error" as const,
              j: JSON.stringify({ error: { code: "COMMAND_NOT_FOUND", message: "command binding not found" } }),
            };
          }
          bindingBotId = commandSnapshot.bot.bot_id;
          snapshotJson = JSON.stringify(commandSnapshot);

          channel.ctx.storage.sql.exec(
            `INSERT INTO channel_command_bindings (
               channel_id, bot_command_id, bot_id, status, permission_override,
               command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
             ) VALUES (?, ?, ?, 'allowed', ?, ?, NULL, ?, ?)
             ON CONFLICT(channel_id, bot_command_id) DO UPDATE SET
               bot_id=excluded.bot_id,
               status='allowed',
               permission_override=excluded.permission_override,
               command_snapshot_json=excluded.command_snapshot_json,
               updated_by_user_id=excluded.updated_by_user_id,
               updated_at=excluded.updated_at`,
            input.channelId,
            mutation.botCommandId,
            bindingBotId,
            beforePermission,
            snapshotJson,
            input.userId,
            input.now,
          );

          const projected = projectCommandManifest(nextManifestVersion, [
            { status: "allowed", command_snapshot_json: snapshotJson, permission_override: beforePermission },
          ]);
          const item = projected.items[0];
          if (!item) {
            return {
              kind: "error" as const,
              j: JSON.stringify({ error: { code: "INVALID_COMMAND_OPTIONS", message: "invalid command snapshot" } }),
            };
          }
          manifestDelta = buildManifestUpsertDelta(nextManifestVersion, item);
          }
        } else {
          if (!binding) {
            const officialItem = officialCatalog.find((item) => item.bot_command_id === mutation!.botCommandId);
            if (!officialItem) {
              return {
                kind: "error" as const,
                j: JSON.stringify({ error: { code: "COMMAND_NOT_FOUND", message: "command binding not found" } }),
              };
            }
            bindingBotId = officialItem.bot.bot_id;
            snapshotJson = JSON.stringify(officialCommandToSnapshot(officialItem));
            channel.ctx.storage.sql.exec(
              `INSERT INTO channel_command_bindings (
                 channel_id, bot_command_id, bot_id, status, permission_override,
                 command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
               ) VALUES (?, ?, ?, 'blocked', ?, ?, NULL, ?, ?)`,
              input.channelId,
              mutation.botCommandId,
              bindingBotId,
              beforePermission,
              snapshotJson,
              input.userId,
              input.now,
            );
          } else {
            channel.ctx.storage.sql.exec(
              `UPDATE channel_command_bindings
               SET status='blocked', permission_override=?, updated_by_user_id=?, updated_at=?
               WHERE channel_id=? AND bot_command_id=?`,
              beforePermission,
              input.userId,
              input.now,
              input.channelId,
              mutation.botCommandId,
            );
          }
        }

        channel.ctx.storage.sql.exec(
          "UPDATE channel_meta SET command_manifest_version=?, updated_at=? WHERE channel_id=?",
          nextManifestVersion,
          input.now,
          input.channelId,
        );

        const bindingChanges: Record<string, { before: unknown; after: unknown }> = {
          status: { before: beforeStatus, after: mutation.status },
        };
        if (mutation.status === "allowed" && beforeSnapshot !== snapshotJson) {
          bindingChanges.command_snapshot_json = { before: beforeSnapshot, after: snapshotJson };
        }

        bindingUpdatedEventId = channel.nextEventId(input.nowMs);
        channel.persistEventAndFanout(
          bindingUpdatedEventId,
          "command.binding_updated",
          input.channelId,
          input.now,
          buildCommandBindingUpdatedPayload({
            channel_id: input.channelId,
            bot_id: bindingBotId,
            bot_command_id: mutation.botCommandId,
            binding_changes: bindingChanges,
            actor_kind: "user",
            actor_id: input.userId,
            command_manifest_delta: manifestDelta,
          }),
          input.membershipVersion,
          input.now,
          actorMap,
        );
      }

      const invocationMessage = insertUserCommandInvocationMessage(channel, {
        userId: input.userId,
        channelId: input.channelId,
        operationId: input.operationId,
        botCommandId: PLATFORM_PERMISSION_BOT_COMMAND_ID,
        invokedName: PLATFORM_PERMISSION_NAME,
        options: input.options,
        now: input.now,
        nowMs: input.nowMs,
        membershipVersion: input.membershipVersion,
        senderSummary,
        messageId: uuidv7(input.nowMs),
      });

      const messageId = uuidv7(input.nowMs + 1);
      const invocationId = uuidv7(input.nowMs + 2);
      const eventId = channel.nextEventId(input.nowMs + 3);
      const replyToMessageId = invocationMessage.invocationMessageId;
      const replySnapshotJson = JSON.stringify(
        buildReplySnapshot(invocationMessage.invocationMessageRow, senderSummary.display_name),
      );

      channel.ctx.storage.sql.exec(
        `INSERT INTO messages (
           message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
           sender_bot_id, sender_bot_display_name, sender_bot_avatar_url, type, format, status, text,
           reply_to, reply_snapshot_json, stream_state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'bot', NULL, ?, ?, ?, 'text', 'unsafe-markdown', 'normal', ?, ?, ?, 'none', ?, ?)`,
        messageId,
        input.operationId,
        `bot:${PLATFORM_BOT_ID}`,
        input.channelId,
        PLATFORM_BOT_ID,
        PLATFORM_BOT_DISPLAY_NAME,
        PLATFORM_BOT_AVATAR_URL,
        replyText,
        replyToMessageId,
        replySnapshotJson,
        input.now,
        input.now,
      );

      channel.ctx.storage.sql.exec(
        `INSERT INTO command_invocations (
           invocation_id, channel_id, command_id, invoker_user_id, bot_id, bot_command_id, command_name,
           invoked_name, command_schema_version, command_definition_hash, options_json,
           status, error_code, error_message, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'completed', NULL, NULL, ?, ?, ?)`,
        invocationId,
        input.channelId,
        input.operationId,
        input.userId,
        PLATFORM_BOT_ID,
        PLATFORM_PERMISSION_BOT_COMMAND_ID,
        PLATFORM_PERMISSION_NAME,
        PLATFORM_PERMISSION_NAME,
        `platform:${PLATFORM_PERMISSION_BOT_COMMAND_ID}`,
        JSON.stringify(input.options),
        input.now,
        input.now,
        input.now,
      );

      const messageRow: MessageRow = {
        message_id: messageId,
        command_id: input.operationId,
        channel_id: input.channelId,
        sender_kind: "bot",
        sender_user_id: null,
        sender_bot_id: PLATFORM_BOT_ID,
        sender_bot_display_name: PLATFORM_BOT_DISPLAY_NAME,
        sender_bot_avatar_url: PLATFORM_BOT_AVATAR_URL,
        type: "text",
        format: "unsafe-markdown",
        status: "normal",
        text: replyText,
        reply_to: replyToMessageId,
        reply_snapshot_json: replySnapshotJson,
        stream_state: "none",
        created_at: input.now,
        updated_at: input.now,
        edited_at: null,
        deleted_at: null,
        deleted_by: null,
        recalled_at: null,
      };

      const liveMessage = projectMessageForBrowser(messageRow, { replyTargetStatus: "normal" });
      const liveEventFrame = buildEventFrame({
        event_id: eventId,
        type: "message.created",
        channel_id: input.channelId,
        occurred_at: input.now,
        payload: { message: liveMessage },
      });
      const persistedPayload = buildMessageLifecyclePayload(messageRow);
      channel.ctx.storage.sql.exec(
        "INSERT INTO events (event_id, event_type, channel_id, actor_kind, actor_id, payload_json, membership_version_at_event, occurred_at) VALUES (?, 'message.created', ?, 'user', ?, ?, ?, ?)",
        eventId,
        input.channelId,
        input.userId,
        JSON.stringify(persistedPayload),
        input.membershipVersion,
        input.now,
      );
      channel.insertOutboxRowForFanout(
        input.channelId,
        eventId,
        JSON.stringify(liveEventFrame),
        input.membershipVersion,
        input.now,
      );

      const responseBody = {
        channel_id: input.channelId,
        invocation_id: invocationId,
        event_id: eventId,
        message_id: messageId,
        message: liveMessage,
        invocation_message: invocationMessage.liveMessage,
      };
      writeUserCompletedIdempotency(channel.ctx.storage.sql, {
        userId: input.userId,
        operation,
        operationId: input.operationId,
        requestHash: input.requestHash,
        responseJson: JSON.stringify(responseBody),
        nowIso: input.now,
      });

      const archiveEventIds = [invocationMessage.invocationEventId, eventId];
      if (bindingUpdatedEventId) archiveEventIds.push(bindingUpdatedEventId);

      appendChatChannelArchive(channel.ctx, input.channelId, input.now, archiveEventIds, () =>
        collectDefinedChanges([
          upsertMessageChange(
            channel.ctx.storage.sql,
            invocationMessage.invocationMessageId,
            input.channelId,
            rvEvent(invocationMessage.invocationEventId),
          ),
          upsertMessageChange(channel.ctx.storage.sql, messageId, input.channelId, rvEvent(eventId)),
          upsertCommandInvocationChange(channel.ctx.storage.sql, invocationId, rvEvent(eventId)),
          upsertEventChange(channel.ctx.storage.sql, invocationMessage.invocationEventId),
          upsertEventChange(channel.ctx.storage.sql, eventId),
          ...(bindingUpdatedEventId ? [upsertEventChange(channel.ctx.storage.sql, bindingUpdatedEventId)] : []),
        ]),
      );

      return { kind: "ok" as const, responseJson: JSON.stringify(responseBody) };
    });

    if (txResult.kind === "conflict") {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
    }
    if (txResult.kind === "cached") {
      return parseRpcCachedJson<CommandInvokeResponse>(txResult.responseJson);
    }
    if (txResult.kind === "error") {
      parseRpcCachedJson(txResult.j);
      throw new ApiError("CHAT_WORKER_UNAVAILABLE", "platform permission invoke failed");
    }
    await channel.scheduleArchiveAlarm(input.now);
    return parseRpcCachedJson<CommandInvokeResponse>(txResult.responseJson);
  }

export function CommandMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async getCommandManifest(userId: string, channelId: string): Promise<CommandManifestResponse> {
      const meta = this.repo.channelMetaManifestGate(channelId);
      if (!meta) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
      if (meta.status === "dissolved") throw new ApiError("CHANNEL_DISSOLVED", "channel is dissolved");
      if (meta.kind === "dm") return { version: 0, items: [] };

      const callerRole = this.activeRole(channelId, userId);
      if (!callerRole) throw new ApiError("FORBIDDEN", "not a channel member");

      return buildMergedManifest(asHandlerRef(this), channelId, meta.command_manifest_version, callerRole);
    }

    async getChannelCommands(userId: string, channelId: string): Promise<CommandManifestResponse> {
      const meta = this.repo.channelMetaManifestVersion(channelId);
      if (!meta) throw new ApiError("CHANNEL_NOT_FOUND", "channel not found");
      if (meta.status === "dissolved") throw new ApiError("CHANNEL_DISSOLVED", "channel is dissolved");

      const callerRole = this.activeRole(channelId, userId);
      if (!callerRole) throw new ApiError("FORBIDDEN", "not a channel member");

      const fullManifest = await buildMergedManifest(asHandlerRef(this), channelId, meta.command_manifest_version, callerRole);
      return {
        version: fullManifest.version,
        items: fullManifest.items.filter((item) =>
          hasRolePermission(callerRole, item.effective_member_permission),
        ),
      };
    }

    async commandBindingUpdate(input: CommandBindingUpdateRpcInput): Promise<CommandBindingUpdateResponse> {
  this.assertChannelKindChannel();

  const userId = input.user_id;
  const channelId = input.channel_id;
  const botCommandId = input.bot_command_id;
  const status = input.status;
  const permissionOverride = input.permission_override;
  const statefulMaxTtlSeconds = input.stateful_max_ttl_seconds;
  const commandSnapshot = status === "allowed"
    ? parseCommandBindingSnapshot(JSON.stringify(input.command_snapshot))
    : null;
  if (status === "allowed" && !commandSnapshot) {
    throw new ApiError("INVALID_MESSAGE", "command_snapshot required for allowed status");
  }

  const officialCatalog = await fetchOfficialCatalog(asHandlerRef(this));
  const existingBinding = this.ctx.storage.sql
    .exec(
      "SELECT status FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
      channelId,
      botCommandId,
    )
    .toArray()[0] as { status: string } | undefined;
  if (
    status === "allowed"
    && isOfficialCommandId(botCommandId, officialCatalog)
    && existingBinding?.status !== "blocked"
  ) {
    throw new ApiError("OFFICIAL_COMMAND_AUTO_ALLOWED", "official commands are auto-allowed in every channel");
  }

  const operationId = input.operation_id;
  const operation = "bot.command_binding_update";
  const now = this.nowIso();
  const nowMs = Date.parse(now);
  const requestHash = JSON.stringify({
    bot_command_id: botCommandId,
    status,
    permission_override: permissionOverride,
    stateful_max_ttl_seconds: statefulMaxTtlSeconds,
    command_snapshot: commandSnapshot,
  });

  const cachedJson = readUserCompletedIdempotency(
  this.ctx.storage.sql,
  userId,
  operation,
  operationId,
  requestHash,
);
if (cachedJson) return parseRpcCachedJson<CommandBindingUpdateResponse>(cachedJson);
 const actorMap = await this.resolveActorMap([userId]);
const txResult = this.ctx.storage.transactionSync(() => {
  const idem = checkUserIdempotencyInTxn(
    this.ctx.storage.sql,
    userId,
    operation,
    operationId,
    requestHash,
  );
  if (idem.kind === "conflict") return { kind: "conflict" as const };
  if (idem.kind === "cached") return { kind: "cached" as const, responseJson: idem.responseJson };
   const meta = this.ctx.storage.sql
    .exec(
      "SELECT status, membership_version, command_manifest_version FROM channel_meta WHERE channel_id=?",
      channelId,
    )
    .toArray()[0] as { status: string; membership_version: number; command_manifest_version: number } | undefined;
  if (!meta) return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_NOT_FOUND", message: "channel not found" } }) };
  if (meta.status === "dissolved") return { kind: "error" as const, j: JSON.stringify({ error: { code: "CHANNEL_DISSOLVED", message: "channel is dissolved" } }) };
   const callerRole = this.activeRole(channelId, userId);
  if (callerRole !== "owner" && callerRole !== "admin") {
    return { kind: "error" as const, j: JSON.stringify({ error: { code: "FORBIDDEN", message: "only owner/admin may update command bindings" } }) };
  }
   const binding = this.ctx.storage.sql
    .exec(
      "SELECT bot_id, status, permission_override, command_snapshot_json FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
      channelId,
      botCommandId,
    )
    .toArray()[0] as {
      bot_id: string;
      status: string;
      permission_override: string | null;
      command_snapshot_json: string;
    } | undefined;
   const beforeStatus = binding?.status ?? "blocked";
  const beforePermission = binding?.permission_override ?? null;
  const beforeSnapshot = binding?.command_snapshot_json ?? null;
  const nextManifestVersion = meta.command_manifest_version + 1;
   let bindingBotId = binding?.bot_id ?? "";
  let snapshotJson = binding?.command_snapshot_json ?? "{}";
  let manifestDelta = buildManifestRemoveDelta(nextManifestVersion);
   if (status === "allowed") {
    const officialItem = officialCatalog.find((item) => item.bot_command_id === botCommandId);
    if (officialItem && beforeStatus === "blocked") {
      this.ctx.storage.sql.exec(
        "DELETE FROM channel_command_bindings WHERE channel_id=? AND bot_command_id=?",
        channelId,
        botCommandId,
      );
      bindingBotId = officialItem.bot.bot_id;
      snapshotJson = JSON.stringify(officialCommandToSnapshot(officialItem));
      const projected = projectCommandManifest(nextManifestVersion, [
        {
          status: "allowed",
          command_snapshot_json: snapshotJson,
          permission_override: permissionOverride,
        },
      ]);
      const item = projected.items[0];
      if (!item) {
        return {
          kind: "error" as const,
          j: JSON.stringify({ error: { code: "INVALID_COMMAND_OPTIONS", message: "invalid command snapshot" } }),
        };
      }
      manifestDelta = buildManifestUpsertDelta(nextManifestVersion, item);
    } else {
    if (!commandSnapshot) {
      return {
        kind: "error" as const,
        j: JSON.stringify({ error: { code: "INVALID_MESSAGE", message: "command_snapshot required for allowed status" } }),
      };
    }
    bindingBotId = commandSnapshot.bot.bot_id;
    snapshotJson = JSON.stringify(commandSnapshot);
     this.ctx.storage.sql.exec(
      `INSERT INTO channel_command_bindings (
         channel_id, bot_command_id, bot_id, status, permission_override,
         command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
       ) VALUES (?, ?, ?, 'allowed', ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, bot_command_id) DO UPDATE SET
         bot_id=excluded.bot_id,
         status='allowed',
         permission_override=excluded.permission_override,
         command_snapshot_json=excluded.command_snapshot_json,
         stateful_max_ttl_seconds=excluded.stateful_max_ttl_seconds,
         updated_by_user_id=excluded.updated_by_user_id,
         updated_at=excluded.updated_at`,
      channelId,
      botCommandId,
      bindingBotId,
      permissionOverride,
      snapshotJson,
      statefulMaxTtlSeconds,
      userId,
      now,
    );
     const projected = projectCommandManifest(nextManifestVersion, [
      { status: "allowed", command_snapshot_json: snapshotJson, permission_override: permissionOverride },
    ]);
    const item = projected.items[0];
    if (!item) {
      return {
        kind: "error" as const,
        j: JSON.stringify({ error: { code: "INVALID_COMMAND_OPTIONS", message: "invalid command snapshot" } }),
      };
    }
    manifestDelta = buildManifestUpsertDelta(nextManifestVersion, item);
    }
  } else {
    if (!binding) {
      const officialItem = officialCatalog.find((item) => item.bot_command_id === botCommandId);
      if (!officialItem) {
        return {
          kind: "error" as const,
          j: JSON.stringify({ error: { code: "COMMAND_NOT_FOUND", message: "command binding not found" } }),
        };
      }
      bindingBotId = officialItem.bot.bot_id;
      snapshotJson = JSON.stringify(officialCommandToSnapshot(officialItem));
      this.ctx.storage.sql.exec(
        `INSERT INTO channel_command_bindings (
           channel_id, bot_command_id, bot_id, status, permission_override,
           command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
         ) VALUES (?, ?, ?, 'blocked', ?, ?, ?, ?, ?)`,
        channelId,
        botCommandId,
        bindingBotId,
        permissionOverride,
        snapshotJson,
        statefulMaxTtlSeconds,
        userId,
        now,
      );
    } else {
      this.ctx.storage.sql.exec(
        `UPDATE channel_command_bindings
         SET status='blocked', permission_override=?, updated_by_user_id=?, updated_at=?
         WHERE channel_id=? AND bot_command_id=?`,
        permissionOverride,
        userId,
        now,
        channelId,
        botCommandId,
      );
    }
  }
   this.ctx.storage.sql.exec(
    "UPDATE channel_meta SET command_manifest_version=?, updated_at=? WHERE channel_id=?",
    nextManifestVersion,
    now,
    channelId,
  );
   const mv = meta.membership_version;
  const afterStatus = status;
  const bindingUpdatedId = this.nextEventId(nowMs);
  const bindingChanges: Record<string, { before: unknown; after: unknown }> = {
    status: { before: beforeStatus, after: afterStatus },
  };
  if (beforePermission !== permissionOverride) {
    bindingChanges.permission_override = { before: beforePermission, after: permissionOverride };
  }
  if (status === "allowed" && beforeSnapshot !== snapshotJson) {
    bindingChanges.command_snapshot_json = { before: beforeSnapshot, after: snapshotJson };
  }
  this.persistEventAndFanout(
    bindingUpdatedId, "command.binding_updated", channelId, now,
    buildCommandBindingUpdatedPayload({
      channel_id: channelId,
      bot_id: bindingBotId,
      bot_command_id: botCommandId,
      binding_changes: bindingChanges,
      actor_kind: "user", actor_id: userId,
      command_manifest_delta: manifestDelta,
    }),
    mv, now, actorMap,
  );
   const responseBody = { bot_command_id: botCommandId, status: afterStatus, permission_override: permissionOverride };
  const fullResponse = JSON.stringify(responseBody);
  writeUserCompletedIdempotency(this.ctx.storage.sql, {
    userId,
    operation,
    operationId,
    requestHash,
    responseJson: fullResponse,
    nowIso: now,
  });
   appendChatChannelArchive(this.ctx, channelId, now, [bindingUpdatedId], () => {
    const rv = rvEvent(bindingUpdatedId);
    return collectDefinedChanges([
      upsertCommandBindingChange(this.ctx.storage.sql, channelId, botCommandId, rv),
      upsertEventChange(this.ctx.storage.sql, bindingUpdatedId),
    ]);
  });
   return { kind: "ok" as const, responseJson: fullResponse };
});
 if (txResult.kind === "conflict") {
  throw new ApiError("IDEMPOTENCY_CONFLICT", "operation_id reused with different body");
}
if (txResult.kind === "cached") {
  return parseRpcCachedJson<CommandBindingUpdateResponse>(txResult.responseJson);
}
if (txResult.kind === "error") {
  parseRpcCachedJson<never>(txResult.j);
  throw new ApiError("CHAT_WORKER_UNAVAILABLE", "unexpected cached binding error");
}
if (txResult.kind !== "ok") {
  throw new ApiError("CHAT_WORKER_UNAVAILABLE", "unexpected binding result");
}
await this.scheduleArchiveAlarm(now);
return parseRpcCachedJson<CommandBindingUpdateResponse>(txResult.responseJson);
    }

    async invokeCommand(input: InvokeCommandRpcInput): Promise<CommandInvokeResponse> {
      return handleCommandInvoke(asHandlerRef(this), input);
    }
  };
}
