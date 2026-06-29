export interface RawArchiveRow {
  id: string;
  payload: unknown;
}

export function orderRawArchiveRows(rows: RawArchiveRow[]): RawArchiveRow[] {
  return [...rows].sort((a, b) => {
    const pa = typeof a.payload === "object" && a.payload !== null ? (a.payload as Record<string, unknown>) : {};
    const pb = typeof b.payload === "object" && b.payload !== null ? (b.payload as Record<string, unknown>) : {};
    const kindA = String(pa.source_kind ?? "");
    const kindB = String(pb.source_kind ?? "");
    if (kindA !== kindB) return kindA.localeCompare(kindB);
    const keyA = String(pa.source_key ?? "");
    const keyB = String(pb.source_key ?? "");
    if (keyA !== keyB) return keyA.localeCompare(keyB);
    const seqA = Number(pa.source_seq ?? 0);
    const seqB = Number(pb.source_seq ?? 0);
    if (seqA !== seqB) return seqA - seqB;
    return Number(a.id) - Number(b.id);
  });
}
