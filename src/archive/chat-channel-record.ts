import type { ArchiveChange } from "./payload";
import {
  archiveReplaceScope,
  archiveUpsert,
  chatChannelTable,
  rowVersionFromEvent,
  rowVersionFromSeq,
} from "./changes";
import { appendArchiveRecordSync } from "./source-outbox";

type SqlStorage = DurableObjectState["storage"]["sql"];

export function appendChatChannelArchive(
  ctx: DurableObjectState,
  channelId: string,
  occurredAt: string,
  businessEventIds: string[],
  buildChanges: (sourceSeq: number) => ArchiveChange[],
): { archive_id: string; source_seq: number } {
  return appendArchiveRecordSync(ctx, {
    sourceKind: "chat_channel",
    sourceKey: channelId,
    occurredAt,
    businessEventIds,
    buildChanges,
  });
}

function rvEvent(eventId: string): string {
  return rowVersionFromEvent(eventId);
}

function rvSeq(sourceSeq: number): string {
  return rowVersionFromSeq(sourceSeq);
}

function readChannelMeta(sql: SqlStorage, channelId: string): Record<string, unknown> | null {
  const row = sql
    .exec(
      "SELECT channel_id, kind, visibility, title, topic, avatar_url, status, created_by, created_at, updated_at, member_count, membership_version FROM channel_meta WHERE channel_id=?",
      channelId,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

function readMember(sql: SqlStorage, channelId: string, userId: string): Record<string, unknown> | null {
  const row = sql
    .exec(
      "SELECT channel_id, user_id, role, joined_at, left_at FROM members WHERE channel_id=? AND user_id=?",
      channelId,
      userId,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

function readEvent(sql: SqlStorage, eventId: string): Record<string, unknown> | null {
  const row = sql
    .exec(
      "SELECT event_id, event_type, channel_id, actor_kind, actor_id, actor_session_id, payload_json, membership_version_at_event, occurred_at FROM events WHERE event_id=?",
      eventId,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

function readInvite(sql: SqlStorage, inviteCode: string): Record<string, unknown> | null {
  const row = sql
    .exec(
      "SELECT invite_code, created_by, expires_at, max_uses, used_count, revoked_at, created_at FROM invites WHERE invite_code=?",
      inviteCode,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

function readAuditLog(sql: SqlStorage, auditId: string): Record<string, unknown> | null {
  const row = sql
    .exec(
      "SELECT audit_id, actor_kind, actor_id, action, target_type, target_id, before_json, after_json, reason, request_id, created_at FROM audit_logs WHERE audit_id=?",
      auditId,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

function readMessage(sql: SqlStorage, messageId: string, channelId: string): Record<string, unknown> | null {
  const row = sql
    .exec(
      `SELECT message_id, command_id, dedupe_principal_key, channel_id, sender_kind, sender_user_id,
              sender_bot_id, type, format, status, text, reply_to, reply_snapshot_json, stream_state,
              created_at, updated_at, edited_at, deleted_at, deleted_by, recalled_at, invocation_json
       FROM messages WHERE message_id=? AND channel_id=?`,
      messageId,
      channelId,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

function readMessageEdit(sql: SqlStorage, editId: string): Record<string, unknown> | null {
  const row = sql
    .exec(
      "SELECT edit_id, message_id, old_text, new_text, editor_user_id, request_id, edited_at FROM message_edits WHERE edit_id=?",
      editId,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

function readCommandBinding(sql: SqlStorage, channelId: string, botCommandId: string): Record<string, unknown> | null {
  const row = sql
    .exec(
      `SELECT channel_id, bot_command_id, bot_id, status, permission_override,
              command_snapshot_json, stateful_max_ttl_seconds, updated_by_user_id, updated_at
       FROM channel_command_bindings
       WHERE channel_id=? AND bot_command_id=?`,
      channelId,
      botCommandId,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

function normalizeMentionRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    message_id: row.message_id,
    user_id: row.user_id,
    start_index: row.start,
    end_index: row.end_,
  };
}

export function upsertChannelChange(
  sql: SqlStorage,
  channelId: string,
  rowVersion: string,
): ArchiveChange | null {
  const row = readChannelMeta(sql, channelId);
  if (!row) return null;
  return archiveUpsert(chatChannelTable("channel_meta"), { channel_id: channelId }, rowVersion, row);
}

export function upsertMemberChange(
  sql: SqlStorage,
  channelId: string,
  userId: string,
  rowVersion: string,
): ArchiveChange | null {
  const row = readMember(sql, channelId, userId);
  if (!row) return null;
  return archiveUpsert(
    chatChannelTable("members"),
    { channel_id: channelId, user_id: userId },
    rowVersion,
    row,
  );
}

export function upsertEventChange(sql: SqlStorage, eventId: string): ArchiveChange | null {
  const row = readEvent(sql, eventId);
  if (!row) return null;
  return archiveUpsert(
    chatChannelTable("events"),
    { event_id: eventId },
    rvEvent(eventId),
    row,
  );
}

export function upsertInviteChange(
  sql: SqlStorage,
  inviteCode: string,
  rowVersion: string,
): ArchiveChange | null {
  const row = readInvite(sql, inviteCode);
  if (!row) return null;
  return archiveUpsert(chatChannelTable("invites"), { invite_code: inviteCode }, rowVersion, row);
}

export function upsertAuditLogChange(
  sql: SqlStorage,
  auditId: string,
  rowVersion: string,
): ArchiveChange | null {
  const row = readAuditLog(sql, auditId);
  if (!row) return null;
  return archiveUpsert(chatChannelTable("audit_logs"), { audit_id: auditId }, rowVersion, row);
}

export function upsertMessageChange(
  sql: SqlStorage,
  messageId: string,
  channelId: string,
  rowVersion: string,
): ArchiveChange | null {
  const row = readMessage(sql, messageId, channelId);
  if (!row) return null;
  return archiveUpsert(chatChannelTable("messages"), { message_id: messageId }, rowVersion, row);
}

export function upsertMessageEditChange(
  sql: SqlStorage,
  editId: string,
  rowVersion: string,
): ArchiveChange | null {
  const row = readMessageEdit(sql, editId);
  if (!row) return null;
  return archiveUpsert(chatChannelTable("message_edits"), { edit_id: editId }, rowVersion, row);
}

export function upsertCommandBindingChange(
  sql: SqlStorage,
  channelId: string,
  botCommandId: string,
  rowVersion: string,
): ArchiveChange | null {
  const row = readCommandBinding(sql, channelId, botCommandId);
  if (!row) return null;
  return archiveUpsert(
    chatChannelTable("channel_command_bindings"),
    { channel_id: channelId, bot_command_id: botCommandId },
    rowVersion,
    row,
  );
}

function readCommandInvocation(sql: SqlStorage, invocationId: string): Record<string, unknown> | null {
  const row = sql
    .exec(
      `SELECT invocation_id, channel_id, command_id, invoker_user_id, bot_id, bot_command_id, command_name,
              invoked_name, command_schema_version, command_definition_hash, options_json,
              status, error_code, error_message, created_at, updated_at, completed_at
       FROM command_invocations WHERE invocation_id=?`,
      invocationId,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

export function upsertCommandInvocationChange(
  sql: SqlStorage,
  invocationId: string,
  rowVersion: string,
): ArchiveChange | null {
  const row = readCommandInvocation(sql, invocationId);
  if (!row) return null;
  return archiveUpsert(
    chatChannelTable("command_invocations"),
    { invocation_id: invocationId },
    rowVersion,
    row,
  );
}

function readStatefulSession(sql: SqlStorage, sessionId: string): Record<string, unknown> | null {
  const row = sql
    .exec(
      `SELECT session_id, channel_id, bot_id, bot_command_id, invocation_id, started_by_user_id,
              status, listen_rules_json, input_next_seq, input_last_acked_seq, effect_last_acked_seq,
              started_at, expires_at, closed_at, close_reason, summary_json
       FROM stateful_command_sessions WHERE session_id=?`,
      sessionId,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

export function upsertStatefulSessionChange(
  sql: SqlStorage,
  sessionId: string,
  rowVersion: string,
): ArchiveChange | null {
  const row = readStatefulSession(sql, sessionId);
  if (!row) return null;
  return archiveUpsert(
    chatChannelTable("stateful_command_sessions"),
    { session_id: sessionId },
    rowVersion,
    row,
  );
}

function readStatefulSessionInput(
  sql: SqlStorage,
  sessionId: string,
  seq: number,
): Record<string, unknown> | null {
  const row = sql
    .exec(
      `SELECT session_id, seq, channel_id, event_id, message_id, message_projection_json,
              status, created_at, sent_at, acked_at
       FROM stateful_session_inputs WHERE session_id=? AND seq=?`,
      sessionId,
      seq,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

export function upsertStatefulSessionInputChange(
  sql: SqlStorage,
  sessionId: string,
  seq: number,
  rowVersion: string,
): ArchiveChange | null {
  const row = readStatefulSessionInput(sql, sessionId, seq);
  if (!row) return null;
  return archiveUpsert(
    chatChannelTable("stateful_session_inputs"),
    { session_id: sessionId, seq },
    rowVersion,
    row,
  );
}

export function replaceScopeMentionsChange(
  sql: SqlStorage,
  messageId: string,
  rowVersion: string,
  opts?: { omitWhenEmpty?: boolean },
): ArchiveChange | null {
  const rows = sql
    .exec("SELECT message_id, user_id, start, end_ FROM mentions WHERE message_id=?", messageId)
    .toArray() as Array<Record<string, unknown>>;
  if (opts?.omitWhenEmpty && rows.length === 0) return null;
  return archiveReplaceScope(
    chatChannelTable("mentions"),
    { message_id: messageId },
    rowVersion,
    rows.map(normalizeMentionRow),
  );
}

export function replaceScopeMessageAttachmentsChange(
  sql: SqlStorage,
  messageId: string,
  rowVersion: string,
  opts?: { omitWhenEmpty?: boolean },
): ArchiveChange | null {
  const rows = sql
    .exec(
      "SELECT message_id, attachment_id FROM message_attachments WHERE message_id=?",
      messageId,
    )
    .toArray() as Array<Record<string, unknown>>;
  if (opts?.omitWhenEmpty && rows.length === 0) return null;
  return archiveReplaceScope(
    chatChannelTable("message_attachments"),
    { message_id: messageId },
    rowVersion,
    rows,
  );
}

export function replaceScopeMessageStickersChange(
  sql: SqlStorage,
  messageId: string,
  rowVersion: string,
  opts?: { omitWhenEmpty?: boolean },
): ArchiveChange | null {
  const rows = sql
    .exec(
      `SELECT message_id, sticker_id, attachment_id, url, mime_type, width, height, size_bytes, blurhash
       FROM message_stickers WHERE message_id=?`,
      messageId,
    )
    .toArray() as Array<Record<string, unknown>>;
  if (opts?.omitWhenEmpty && rows.length === 0) return null;
  return archiveReplaceScope(
    chatChannelTable("message_stickers"),
    { message_id: messageId },
    rowVersion,
    rows,
  );
}

export function upsertAttachmentsForMessageChanges(
  sql: SqlStorage,
  messageId: string,
  rowVersion: string,
): ArchiveChange[] {
  const rows = sql
    .exec(
      `SELECT a.attachment_id, a.owner_user_id, a.kind, a.filename, a.mime_type, a.size_bytes,
              a.width, a.height, a.blurhash, a.storage_key, a.url, a.status, a.created_at
       FROM attachments a
       JOIN message_attachments ma ON ma.attachment_id = a.attachment_id
       WHERE ma.message_id=?`,
      messageId,
    )
    .toArray() as Array<Record<string, unknown>>;
  return rows.map((row) =>
    archiveUpsert(
      chatChannelTable("attachments"),
      { attachment_id: String(row.attachment_id) },
      rowVersion,
      row,
    ),
  );
}

export function collectDefinedChanges(changes: Array<ArchiveChange | null>): ArchiveChange[] {
  return changes.filter((c): c is ArchiveChange => c !== null);
}

export { rvEvent, rvSeq };
