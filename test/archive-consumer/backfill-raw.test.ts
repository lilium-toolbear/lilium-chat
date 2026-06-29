import { describe, expect, it } from "vitest";
import { orderRawArchiveRows } from "../../src/archive-consumer/backfill-order";

describe("orderRawArchiveRows", () => {
  it("orders by source_kind, source_key, source_seq, then raw id", () => {
    const rows = orderRawArchiveRows([
      {
        id: "10",
        payload: { source_kind: "chat_channel", source_key: "ch-1", source_seq: 2 },
      },
      {
        id: "5",
        payload: { source_kind: "chat_channel", source_key: "ch-1", source_seq: 1 },
      },
      {
        id: "20",
        payload: { source_kind: "dm_directory", source_key: "a:b", source_seq: 1 },
      },
    ]);

    expect(rows.map((r) => r.id)).toEqual(["5", "10", "20"]);
  });
});
