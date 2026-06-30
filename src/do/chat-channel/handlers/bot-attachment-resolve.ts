import { BotEffectValidationError } from "../../../chat/bot-effects";
import {
  projectAttachmentForBrowser,
  type AttachmentRow,
} from "../../../chat/attachment-projection";
import type { MessageImageAttachment } from "../../../contract/message";

export function resolveBotAttachmentIds(
  sql: SqlStorage,
  input: { botId: string; channelId: string; attachmentIds: string[] },
): MessageImageAttachment[] {
  const projections: MessageImageAttachment[] = [];
  for (const attachmentId of input.attachmentIds) {
    const row = sql
      .exec(
        `SELECT attachment_id, owner_user_id, owner_bot_id, channel_id, kind, filename, mime_type, size_bytes,
                width, height, blurhash, storage_key, url, status, created_at
         FROM attachments WHERE attachment_id=?`,
        attachmentId,
      )
      .toArray()[0] as AttachmentRow | undefined;
    if (
      !row ||
      row.status !== "finalized" ||
      row.owner_bot_id !== input.botId ||
      row.channel_id !== input.channelId ||
      row.kind !== "image"
    ) {
      throw new BotEffectValidationError("attachment not available");
    }
    const projection = projectAttachmentForBrowser(row);
    if (!projection) {
      throw new BotEffectValidationError("attachment not available");
    }
    projections.push(projection);
  }
  return projections;
}

export function loadMessageAttachmentProjections(
  sql: SqlStorage,
  messageId: string,
): MessageImageAttachment[] {
  const rows = sql
    .exec(
      `SELECT a.attachment_id, a.owner_user_id, a.owner_bot_id, a.channel_id, a.kind, a.filename, a.mime_type,
              a.size_bytes, a.width, a.height, a.blurhash, a.storage_key, a.url, a.status, a.created_at
       FROM attachments a
       JOIN message_attachments ma ON ma.attachment_id = a.attachment_id
       WHERE ma.message_id=?`,
      messageId,
    )
    .toArray() as AttachmentRow[];
  const projections: MessageImageAttachment[] = [];
  for (const row of rows) {
    const projection = projectAttachmentForBrowser(row);
    if (projection) projections.push(projection);
  }
  return projections;
}

export function linkBotMessageAttachments(
  sql: SqlStorage,
  messageId: string,
  attachmentIds: string[],
): void {
  for (const attachmentId of attachmentIds) {
    sql.exec(
      "INSERT OR IGNORE INTO message_attachments (message_id, attachment_id) VALUES (?, ?)",
      messageId,
      attachmentId,
    );
  }
}

export function replaceBotMessageAttachments(
  sql: SqlStorage,
  messageId: string,
  attachmentIds: string[],
): void {
  sql.exec("DELETE FROM message_attachments WHERE message_id=?", messageId);
  linkBotMessageAttachments(sql, messageId, attachmentIds);
}
