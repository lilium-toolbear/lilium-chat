import type { FinalizedAttachmentProjection, MessageImageAttachment } from "../contract/message";

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

// Message/sticker image projection — no kind/filename (contract §3.6/§8.3).
export function projectAttachmentForBrowser(row: AttachmentRow): MessageImageAttachment | null {
  if (row.status !== "finalized" || row.kind !== "image") return null;
  return {
    attachment_id: row.attachment_id,
    url: row.url,
    mime_type: row.mime_type,
    width: row.width ?? 0,
    height: row.height ?? 0,
    size_bytes: row.size_bytes,
    blurhash: row.blurhash,
  };
}

// Finalize response projection (contract §8.2): full finalized metadata including kind.
export function projectFinalizedAttachmentForBrowser(row: AttachmentRow): FinalizedAttachmentProjection {
  return {
    attachment_id: row.attachment_id,
    kind: row.kind,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    width: row.width ?? 0,
    height: row.height ?? 0,
    blurhash: row.blurhash,
    url: row.url,
  };
}
