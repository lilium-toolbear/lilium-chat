import { idempotencyExpiresAt } from "../contract/idempotency";
import { idempotencyConflictResponse } from "../errors";
import { sqlRow } from "../do/shared/sql";
import type {
  PrincipalIdempotencyLookupRow,
  PrincipalIdempotencyResponseRow,
} from "../do/shared/principal-idempotency-schema";

type SyncSql = {
  exec: (query: string, ...params: unknown[]) => { toArray: () => unknown[] };
};

export interface PrincipalIdempotencyKey {
  principalKind: string;
  principalId: string;
  operation: string;
  operationId: string;
}

export function readCompletedPrincipalIdempotency(
  sql: SyncSql,
  key: PrincipalIdempotencyKey & { requestHash: string },
): string | null {
  const row = sqlRow<PrincipalIdempotencyResponseRow>(
    sql
      .exec(
        "SELECT response_json FROM idempotency_keys WHERE principal_kind=? AND principal_id=? AND operation=? AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
        key.principalKind,
        key.principalId,
        key.operation,
        key.operationId,
        key.requestHash,
      )
      .toArray(),
  );
  return row?.response_json ?? null;
}

export function readPrincipalIdempotencyRow(
  sql: SyncSql,
  key: PrincipalIdempotencyKey,
): PrincipalIdempotencyLookupRow | undefined {
  return sqlRow<PrincipalIdempotencyLookupRow>(
    sql
      .exec(
        "SELECT request_hash, response_json FROM idempotency_keys WHERE principal_kind=? AND principal_id=? AND operation=? AND operation_id=?",
        key.principalKind,
        key.principalId,
        key.operation,
        key.operationId,
      )
      .toArray(),
  );
}

export type PrincipalIdempotencyTxnResult =
  | { kind: "missing" }
  | { kind: "conflict" }
  | { kind: "cached"; responseJson: string };

export function checkPrincipalIdempotencyInTxn(
  sql: SyncSql,
  key: PrincipalIdempotencyKey & { requestHash: string },
): PrincipalIdempotencyTxnResult {
  const idem = readPrincipalIdempotencyRow(sql, key);
  if (!idem) return { kind: "missing" };
  if (idem.request_hash !== key.requestHash) return { kind: "conflict" };
  return { kind: "cached", responseJson: idem.response_json ?? "{}" };
}

export function writeCompletedPrincipalIdempotency(
  sql: SyncSql,
  key: PrincipalIdempotencyKey & { requestHash: string; responseJson: string; nowIso: string },
): void {
  const expiresAt = idempotencyExpiresAt(Date.parse(key.nowIso));
  sql.exec(
    "INSERT INTO idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)",
    key.principalKind,
    key.principalId,
    key.operation,
    key.operationId,
    key.requestHash,
    key.responseJson,
    key.nowIso,
    expiresAt,
  );
}

export function principalIdempotencyConflictResponse(): Response {
  return idempotencyConflictResponse();
}
