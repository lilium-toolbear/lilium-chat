import { ApiError } from "../errors";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_MAX_PAYLOAD_BYTES,
  canonicalStringify,
  encodeArchiveId,
  payloadByteLength,
  type ArchiveChange,
  type ArchiveRecord,
  type ArchiveSourceKind,
} from "./payload";

export interface AppendArchiveInput {
  sourceKind: ArchiveSourceKind;
  sourceKey: string;
  occurredAt: string;
  businessEventIds: string[];
  buildChanges: (sourceSeq: number) => ArchiveChange[];
}

export function appendArchiveRecordSync(
  ctx: DurableObjectState,
  input: AppendArchiveInput,
): { archive_id: string; source_seq: number } {
  const seqRow = ctx.storage.sql
    .exec("SELECT last_seq FROM archive_seq WHERE id=1")
    .toArray()[0] as { last_seq: number } | undefined;
  const lastSeq = seqRow?.last_seq ?? 0;
  const sourceSeq = lastSeq + 1;

  ctx.storage.sql.exec("UPDATE archive_seq SET last_seq=? WHERE id=1", sourceSeq);

  const changes = input.buildChanges(sourceSeq);
  const archiveId = encodeArchiveId(input.sourceKind, input.sourceKey, sourceSeq);
  const record: ArchiveRecord = {
    format: ARCHIVE_FORMAT,
    archive_id: archiveId,
    source_kind: input.sourceKind,
    source_key: input.sourceKey,
    source_seq: sourceSeq,
    business_event_ids: input.businessEventIds,
    occurred_at: input.occurredAt,
    changes,
  };

  const payloadJson = canonicalStringify(record);
  if (payloadByteLength(payloadJson) > ARCHIVE_MAX_PAYLOAD_BYTES) {
    throw new ApiError(
      "ARCHIVE_RECORD_TOO_LARGE",
      `archive payload exceeds ${ARCHIVE_MAX_PAYLOAD_BYTES} bytes`,
      { httpStatus: 413 },
    );
  }

  ctx.storage.sql.exec(
    `INSERT INTO archive_outbox (
      archive_id, source_kind, source_key, source_seq, payload_json,
      status, attempts, max_attempts, last_error, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, 20, NULL, ?, ?, ?)`,
    archiveId,
    input.sourceKind,
    input.sourceKey,
    sourceSeq,
    payloadJson,
    input.occurredAt,
    input.occurredAt,
    input.occurredAt,
  );

  return { archive_id: archiveId, source_seq: sourceSeq };
}
