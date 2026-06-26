import type { EventSeq } from "../ids/uuidv7";

export type { EventSeq };

export interface DueRow {
  id: number | string;
  [k: string]: unknown;
}

export interface DueTable {
  table: string;
  dueColumn: string;
  statusColumn: string;
  pendingStatus: string;
  handler: (rows: DueRow[]) => Promise<void>;
}

export async function runDueJobs(ctx: DurableObjectState, now: number, dueTables: DueTable[]): Promise<void> {
  for (const table of dueTables) {
    const cursor = ctx.storage.sql.exec(
      `SELECT * FROM ${table.table} WHERE ${table.statusColumn} = ? AND ${table.dueColumn} <= ? ORDER BY ${table.dueColumn} ASC`,
      table.pendingStatus,
      now,
    );
    const rows = cursor.toArray() as DueRow[];
    if (rows.length > 0) {
      await table.handler(rows);
    }
  }
}

export async function scheduleNextAlarm(ctx: DurableObjectState, dueTables: DueTable[]): Promise<void> {
  let nextDue: number | null = null;
  for (const table of dueTables) {
    const cursor = ctx.storage.sql.exec(
      `SELECT MIN(${table.dueColumn}) AS due FROM ${table.table} WHERE ${table.statusColumn} = ?`,
      table.pendingStatus,
    );
    const row = cursor.toArray()[0] as { due: number | string | null } | undefined;
    const rawDue = row?.due ?? null;
    const due = typeof rawDue === "string" ? Number(rawDue) : rawDue;
    if (due !== null && Number.isFinite(due) && (nextDue === null || due < nextDue)) {
      nextDue = due;
    }
  }

  if (nextDue === null) {
    await ctx.storage.deleteAlarm();
    return;
  }
  await ctx.storage.setAlarm(nextDue);
}
