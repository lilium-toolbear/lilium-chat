import type {
  PrincipalIdempotencyKey,
  PrincipalIdempotencyTxnResult,
} from "../../../chat/principal-idempotency";
import {
  checkPrincipalIdempotencyInTxn,
  readCompletedPrincipalIdempotency,
  readPrincipalIdempotencyRow,
  writeCompletedPrincipalIdempotency,
} from "../../../chat/principal-idempotency";
import type { PrincipalIdempotencyLookupRow } from "../../shared/principal-idempotency-schema";

type SyncSql = DurableObjectState["storage"]["sql"];

const USER_PRINCIPAL = "user" as const;

export function userIdempotencyKey(
  userId: string,
  operation: string,
  operationId: string,
): PrincipalIdempotencyKey {
  return {
    principalKind: USER_PRINCIPAL,
    principalId: userId,
    operation,
    operationId,
  };
}

export function readUserCompletedIdempotency(
  sql: SyncSql,
  userId: string,
  operation: string,
  operationId: string,
  requestHash: string,
): string | null {
  return readCompletedPrincipalIdempotency(sql, {
    ...userIdempotencyKey(userId, operation, operationId),
    requestHash,
  });
}

export function readUserIdempotencyRow(
  sql: SyncSql,
  userId: string,
  operation: string,
  operationId: string,
): PrincipalIdempotencyLookupRow | undefined {
  return readPrincipalIdempotencyRow(sql, userIdempotencyKey(userId, operation, operationId));
}

export function checkUserIdempotencyInTxn(
  sql: SyncSql,
  userId: string,
  operation: string,
  operationId: string,
  requestHash: string,
): PrincipalIdempotencyTxnResult {
  return checkPrincipalIdempotencyInTxn(sql, {
    ...userIdempotencyKey(userId, operation, operationId),
    requestHash,
  });
}

export function writeUserCompletedIdempotency(
  sql: SyncSql,
  input: {
    userId: string;
    operation: string;
    operationId: string;
    requestHash: string;
    responseJson: string;
    nowIso: string;
  },
): void {
  writeCompletedPrincipalIdempotency(sql, {
    ...userIdempotencyKey(input.userId, input.operation, input.operationId),
    requestHash: input.requestHash,
    responseJson: input.responseJson,
    nowIso: input.nowIso,
  });
}
