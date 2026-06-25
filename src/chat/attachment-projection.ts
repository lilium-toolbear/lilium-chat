export interface AttachmentRow {
  attachment_id: string;
  owner_user_id: string;
  kind: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  storage_key: string;
  url: string;
  status: string;
  created_at: string;
}

// The ONE shared Browser-visible image attachment projection (used by message.attachments
// and sticker image projection). Returns null for non-finalized attachments (pending
// attachments are not Browser-visible). Never exposes storage_key / owner_user_id / status.
// Contract §3.6/§8.3 sticker image projection: {attachment_id, url, mime_type, width, height,
// size_bytes, blurhash} — no kind/filename here (those are finalize-only, see below).
export function projectAttachmentForBrowser(row: AttachmentRow): Record<string, unknown> | null {
  if (row.status !== "finalized") return null;
  return {
    attachment_id: row.attachment_id,
    url: row.url,
    mime_type: row.mime_type,
    width: row.width,
    height: row.height,
    size_bytes: row.size_bytes,
    blurhash: row.blurhash,
  };
}

// Finalize response attachment projection (contract §8.2): the full finalized metadata,
// including kind + filename (which the message/sticker image projection intentionally omits).
export function projectFinalizedAttachmentForBrowser(row: AttachmentRow): Record<string, unknown> {
  return {
    attachment_id: row.attachment_id,
    kind: row.kind,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
    blurhash: row.blurhash,
    url: row.url,
  };
}
