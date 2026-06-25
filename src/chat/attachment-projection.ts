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

// The ONE shared Browser-visible image attachment projection.
// Returns null for non-finalized attachments (pending attachments are not Browser-visible).
// Never exposes storage_key / owner_user_id / status.
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
