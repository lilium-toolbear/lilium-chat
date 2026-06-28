import { describe, expect, it } from "vitest";

import {
  compareMemberListRows,
  decodeMemberListCursor,
  encodeMemberListCursor,
  memberListRowsAfterCursor,
} from "./member-list-order";

describe("member-list-order", () => {
  it("sorts owner before admin before member", () => {
    const rows = [
      { user_id: "u-member", role: "member", joined_at: "2026-01-01T00:00:00.000Z" },
      { user_id: "u-admin", role: "admin", joined_at: "2026-01-02T00:00:00.000Z" },
      { user_id: "u-owner", role: "owner", joined_at: "2026-01-03T00:00:00.000Z" },
    ];
    expect([...rows].sort(compareMemberListRows).map((row) => row.user_id)).toEqual([
      "u-owner",
      "u-admin",
      "u-member",
    ]);
  });

  it("encodes and decodes composite cursors", () => {
    const row = { user_id: "u-2", role: "admin", joined_at: "2026-01-01T00:00:00.000Z" };
    const cursor = encodeMemberListCursor(row);
    expect(decodeMemberListCursor(cursor)).toEqual({
      roleRank: 1,
      joined_at: "2026-01-01T00:00:00.000Z",
      user_id: "u-2",
    });
  });

  it("filters rows after a composite cursor", () => {
    const rows = [
      { user_id: "u-owner", role: "owner", joined_at: "2026-01-01T00:00:00.000Z" },
      { user_id: "u-admin", role: "admin", joined_at: "2026-01-02T00:00:00.000Z" },
      { user_id: "u-member", role: "member", joined_at: "2026-01-03T00:00:00.000Z" },
    ];
    const cursor = encodeMemberListCursor(rows[1]!);
    expect(memberListRowsAfterCursor(rows, cursor).map((row) => row.user_id)).toEqual(["u-member"]);
  });
});
