import { ApiError } from "../../errors";

/** Gate test-only DO RPC methods (prod worker omits ALLOW_INTERNAL_TEST_ROUTES). */
export function assertTestRoutesEnabled(env: { ALLOW_INTERNAL_TEST_ROUTES?: string }): void {
  if (env.ALLOW_INTERNAL_TEST_ROUTES !== "1") {
    throw new ApiError("FORBIDDEN", "test-only RPC");
  }
}
