import type { ArchiveRecord } from "../archive/payload.js";
import type { PgQueryable } from "./pg-writer.js";

export async function insertArchiveRecordIfAbsent(
  client: PgQueryable,
  record: ArchiveRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO chat_archive_records (
       archive_id, source_kind, source_key, source_seq, payload
     ) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (archive_id) DO NOTHING`,
    [
      record.archive_id,
      record.source_kind,
      record.source_key,
      record.source_seq,
      JSON.stringify(record),
    ],
  );
}
