import type { EventSeq } from "../../ids/uuidv7";

export type { EventSeq };

export interface DueRow {
  id: number | string;
  [k: string]: unknown;
}

export type DueValueKind = "epoch_ms" | "iso_string";

export interface DueTable {
  table: string;
  dueColumn: string;
  statusColumn: string;
  pendingStatus: string;
  /** How `dueColumn` values are stored. Defaults to epoch_ms (numeric ms or numeric string). */
  dueValueKind?: DueValueKind;
  handler: (rows: DueRow[]) => Promise<void>;
}

function dueCompareValue(now: number | string, kind: DueValueKind): number | string {
  if (kind === "iso_string") {
    return typeof now === "string" ? now : new Date(now).toISOString();
  }
  return typeof now === "number" ? now : Date.parse(now);
}

function parseDueMs(raw: number | string | null, kind: DueValueKind): number | null {
  if (raw === null) return null;
  if (kind === "iso_string") {
    const ms = typeof raw === "string" ? Date.parse(raw) : raw;
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = typeof raw === "string" ? Number(raw) : raw;
  return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
}

export async function runDueJobs(
  ctx: DurableObjectState,
  now: number | string,
  dueTables: DueTable[],
): Promise<void> {
  for (const table of dueTables) {
    const kind = table.dueValueKind ?? "epoch_ms";
    const compareNow = dueCompareValue(now, kind);
    const cursor = ctx.storage.sql.exec(
      `SELECT * FROM ${table.table} WHERE ${table.statusColumn} = ? AND ${table.dueColumn} <= ? ORDER BY ${table.dueColumn} ASC`,
      table.pendingStatus,
      compareNow,
    );
    const rows = cursor.toArray() as DueRow[];
    if (rows.length > 0) {
      await table.handler(rows);
    }
  }
}

export async function scheduleNextAlarm(
  ctx: DurableObjectState,
  dueTables: DueTable[],
  opts?: { respectExistingAlarm?: boolean; extraDueMs?: number | null },
): Promise<void> {
  let nextDueMs: number | null =
    typeof opts?.extraDueMs === "number" && Number.isFinite(opts.extraDueMs) ? opts.extraDueMs : null;
  for (const table of dueTables) {
    const kind = table.dueValueKind ?? "epoch_ms";
    const cursor = ctx.storage.sql.exec(
      `SELECT MIN(${table.dueColumn}) AS due FROM ${table.table} WHERE ${table.statusColumn} = ?`,
      table.pendingStatus,
    );
    const row = cursor.toArray()[0] as { due: number | string | null } | undefined;
    const dueMs = parseDueMs(row?.due ?? null, kind);
    if (dueMs !== null && (nextDueMs === null || dueMs < nextDueMs)) {
      nextDueMs = dueMs;
    }
  }

  if (nextDueMs === null) {
    await ctx.storage.deleteAlarm();
    return;
  }

  if (opts?.respectExistingAlarm) {
    const currentAlarm = await ctx.storage.getAlarm();
    if (currentAlarm !== null && nextDueMs >= currentAlarm) {
      return;
    }
  }

  await ctx.storage.setAlarm(nextDueMs);
}

export function isoDueTable(
  table: string,
  dueColumn: string,
  statusColumn: string,
  pendingStatus: string,
  handler: (rows: DueRow[]) => Promise<void>,
): DueTable {
  return { table, dueColumn, statusColumn, pendingStatus, dueValueKind: "iso_string", handler };
}
