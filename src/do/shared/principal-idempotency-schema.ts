/** `idempotency_keys` row shape (ChatChannel + any DO using principal_kind/principal_id PK). */

export interface PrincipalIdempotencyKeyRow {
  principal_kind: string;
  principal_id: string;
  operation: string;
  operation_id: string;
  request_hash: string;
  response_json: string | null;
  status: string;
  created_at: string;
  expires_at: string;
}

export type PrincipalIdempotencyLookupRow = Pick<
  PrincipalIdempotencyKeyRow,
  "request_hash" | "response_json"
>;

export type PrincipalIdempotencyResponseRow = Pick<PrincipalIdempotencyKeyRow, "response_json">;
