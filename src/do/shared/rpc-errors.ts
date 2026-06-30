export function rpcErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function shouldRetryRpcError(err: unknown): boolean {
  const maybe = err as { remote?: unknown; retryable?: unknown; overloaded?: unknown };
  return maybe.remote === false && maybe.retryable === true && maybe.overloaded !== true;
}
