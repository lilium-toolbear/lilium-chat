export const MEMBER_ROLE_ORDER_CASE = "CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END";

export type MemberListRow = {
  user_id: string;
  role: string;
  joined_at: string;
};

export function memberRoleRank(role: string): number {
  if (role === "owner") return 0;
  if (role === "admin") return 1;
  return 2;
}

export function compareMemberListRows(a: MemberListRow, b: MemberListRow): number {
  const roleDiff = memberRoleRank(a.role) - memberRoleRank(b.role);
  if (roleDiff !== 0) return roleDiff;
  const joinedDiff = a.joined_at.localeCompare(b.joined_at);
  if (joinedDiff !== 0) return joinedDiff;
  return a.user_id.localeCompare(b.user_id);
}

export function encodeMemberListCursor(row: MemberListRow): string {
  return `${memberRoleRank(row.role)}|${row.joined_at}|${row.user_id}`;
}

export function decodeMemberListCursor(cursor: string): { roleRank: number; joined_at: string; user_id: string } | null {
  if (!cursor) return null;
  const parts = cursor.split("|");
  if (parts.length !== 3) return null;
  const roleRank = Number(parts[0]);
  if (!Number.isInteger(roleRank) || roleRank < 0 || roleRank > 2) return null;
  const joined_at = parts[1] ?? "";
  const user_id = parts[2] ?? "";
  if (!joined_at || !user_id) return null;
  return { roleRank, joined_at, user_id };
}

export function memberListRowsAfterCursor(
  rows: MemberListRow[],
  cursor: string,
): MemberListRow[] {
  const decoded = decodeMemberListCursor(cursor);
  if (!decoded) return rows;
  return rows.filter((row) => {
    const roleRank = memberRoleRank(row.role);
    if (roleRank > decoded.roleRank) return true;
    if (roleRank < decoded.roleRank) return false;
    if (row.joined_at > decoded.joined_at) return true;
    if (row.joined_at < decoded.joined_at) return false;
    return row.user_id > decoded.user_id;
  });
}
