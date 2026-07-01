import { ApiError } from "../../errors";

/**
 * Read-only SQL debug helper for Durable Objects. Exposed via the
 * `debugSql` RPC on each stateful DO and the `/internal/debug/sql` route,
 * gated by a DEBUG_TOKEN secret. Only SELECT / WITH statements are allowed;
 * results are capped to prevent runaway scans.
 */

export interface DebugSqlInput {
  query: string;
  limit?: number;
}

export interface DebugSqlResult {
  columns: string[];
  rows: unknown[];
  rows_read: number;
  truncated: boolean;
  alarm_ms: number | null;
  now_ms: number;
}

const READ_ONLY_PREFIX = /^(SELECT|WITH)\s/i;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

export async function runDebugSql(
  ctx: DurableObjectState,
  input: DebugSqlInput,
): Promise<DebugSqlResult> {
  const raw = (input.query ?? "").trim().replace(/;+\s*$/, "");
  if (!raw) throw new ApiError("INVALID_MESSAGE", "empty query");
  if (!READ_ONLY_PREFIX.test(raw)) {
    throw new ApiError("FORBIDDEN", "debugSql only allows SELECT/WITH");
  }
  // Reject statement chaining — a stray ';' mid-query means multiple statements.
  if (raw.includes(";")) {
    throw new ApiError("FORBIDDEN", "debugSql does not allow multiple statements");
  }
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(input.limit ?? DEFAULT_LIMIT)));
  // Wrap + LIMIT n+1 so we can detect truncation without reading unbounded rows.
  const wrapped = `SELECT * FROM ( ${raw} ) _debug LIMIT ${limit + 1}`;
  const cursor = ctx.storage.sql.exec(wrapped);
  const all = cursor.toArray();
  const rows = all.slice(0, limit);
  return {
    columns: cursor.columnNames,
    rows,
    rows_read: rows.length,
    truncated: all.length > limit,
    alarm_ms: await ctx.storage.getAlarm(),
    now_ms: Date.now(),
  };
}

export function assertDebugToken(env: { DEBUG_TOKEN?: string }, token: string | undefined | null): void {
  if (!env.DEBUG_TOKEN || !token || token !== env.DEBUG_TOKEN) {
    throw new ApiError("FORBIDDEN", "debug endpoint requires valid DEBUG_TOKEN", { httpStatus: 403 });
  }
}
