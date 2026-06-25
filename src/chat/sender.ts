import type { Env } from "../env";
import { resolveUserSummaries } from "../profile/resolve";
import type { MessageRow } from "../do/chat-channel";
import { projectMessageForBrowser, type MessageMention, type MessageStickerSnapshot } from "./message-projection";
import { projectAttachmentForBrowser, type AttachmentRow } from "./attachment-projection";
import type { UserSummary } from "./event-broadcast";

// v4.0: history/bootstrap projection goes through the ONE shared projectMessageForBrowser
// (addendum J) — same serializer as message.send ack + message.created event + replay. The DO
// returns raw MessageRows + the page's mentions/attachments (grouped by message_id); this helper
// resolves sender UserSummaries and projects each row. No separate RawMessage/ContractMessage serializer.
export type ProjectedMessage = ReturnType<typeof projectMessageForBrowser>;

export async function projectMessagesForBrowser(
  rows: MessageRow[],
  mentionsByMessage: Record<string, MessageMention[]>,
  env: Env,
  attachmentsByMessage: Record<string, AttachmentRow[]> = {},
  stickersByMessage: Record<string, MessageStickerSnapshot> = {},
): Promise<Record<string, unknown>[]> {
  const senderUserIds = [...new Set(rows.filter((r) => r.sender_kind === "user" && r.sender_user_id).map((r) => r.sender_user_id as string))];
  const map = await resolveUserSummaries(senderUserIds, env);

  return rows.map((row) => {
    let senderSummary: UserSummary | null = null;
    if (row.sender_kind === "user" && row.sender_user_id) {
      const raw = map.get(row.sender_user_id);
      // profile/resolve UserSummary.display_name is string | null; projectMessageForBrowser's
      // UserSummary.display_name is string — fall back to user-<shortid> when null.
      senderSummary = raw
        ? { user_id: raw.user_id, display_name: raw.display_name ?? `user-${row.sender_user_id.slice(0, 8)}`, avatar_url: raw.avatar_url }
        : { user_id: row.sender_user_id, display_name: `user-${row.sender_user_id.slice(0, 8)}`, avatar_url: null };
    }
    const attachmentRows = attachmentsByMessage[row.message_id] ?? [];
    const attachments = attachmentRows.map(projectAttachmentForBrowser).filter((a): a is Record<string, unknown> => a !== null);
    return projectMessageForBrowser(row, {
      senderSummary,
      mentions: mentionsByMessage[row.message_id] ?? [],
      attachments,
      sticker: stickersByMessage[row.message_id] ?? null,
    });
  });
}
