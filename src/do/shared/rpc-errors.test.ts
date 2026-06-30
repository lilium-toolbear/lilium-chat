import { describe, expect, it } from "vitest";
import { shouldRetryRpcError } from "./rpc-errors";

describe("shouldRetryRpcError", () => {
  it("retries only local retryable non-overloaded RPC failures", () => {
    expect(shouldRetryRpcError({ retryable: true, remote: false })).toBe(true);
    expect(shouldRetryRpcError({ retryable: true })).toBe(false);
    expect(shouldRetryRpcError({ retryable: true, remote: true })).toBe(false);
    expect(shouldRetryRpcError({ retryable: true, remote: false, overloaded: true })).toBe(false);
    expect(shouldRetryRpcError({ retryable: false, remote: false })).toBe(false);
  });
});
