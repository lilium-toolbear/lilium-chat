import { describe, expect, it } from "vitest";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_TABLE_WHITELIST,
  RUNTIME_TABLE_BLACKLIST,
  canonicalStringify,
  encodeArchiveId,
  validateArchiveRecord,
  type ArchiveRecord,
} from "../../src/archive/payload";

function minimalRecord(overrides?: Partial<ArchiveRecord>): ArchiveRecord {
  const sourceKind = "dm_directory";
  const sourceKey = "u1:u2";
  const sourceSeq = 1;
  return {
    format: ARCHIVE_FORMAT,
    archive_id: encodeArchiveId(sourceKind, sourceKey, sourceSeq),
    source_kind: sourceKind,
    source_key: sourceKey,
    source_seq: sourceSeq,
    business_event_ids: [],
    occurred_at: "2026-06-28T00:00:00.000Z",
    changes: [
      {
        op: "upsert",
        table: "chat_dm_pairs",
        pk: { pair_key: sourceKey },
        row_version: "source_seq:1",
        after: { pair_key: sourceKey, status: "creating" },
      },
    ],
    ...overrides,
  };
}

describe("validateArchiveRecord", () => {
  it("accepts a valid record", () => {
    expect(validateArchiveRecord(minimalRecord())).toEqual({ ok: true });
  });

  it("encodes pair_key with colons via base64url archive_id", () => {
    const record = minimalRecord();
    expect(record.archive_id).toMatch(/^dm_directory:[A-Za-z0-9_-]+:1$/);
    expect(record.archive_id).not.toContain(":u1:u2:");
  });

  it("rejects bad format", () => {
    const r = validateArchiveRecord({ ...minimalRecord(), format: "x" as typeof ARCHIVE_FORMAT });
    expect(r.ok).toBe(false);
  });

  it("rejects archive_id mismatch", () => {
    const r = validateArchiveRecord({ ...minimalRecord(), archive_id: "dm_directory:bad:1" });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown table", () => {
    const record = minimalRecord({
      changes: [{ op: "upsert", table: "projection_outbox", pk: { id: "1" }, row_version: "v", after: {} }],
    });
    expect(validateArchiveRecord(record).ok).toBe(false);
  });

  it("canonicalStringify is stable across key order", () => {
    const a = canonicalStringify({ z: 1, a: { y: 2, b: 3 } });
    const b = canonicalStringify({ a: { b: 3, y: 2 }, z: 1 });
    expect(a).toBe(b);
  });
});

describe("archive table lists", () => {
  it("whitelist and blacklist are disjoint", () => {
    for (const table of ARCHIVE_TABLE_WHITELIST) {
      expect(RUNTIME_TABLE_BLACKLIST.has(table)).toBe(false);
    }
  });
});
