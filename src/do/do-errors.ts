export { doErrorResponse, idempotencyConflictResponse } from "../errors";

/** Prod worker omits ALLOW_INTERNAL_TEST_ROUTES; test worker sets it to "1" in wrangler.test.jsonc. */
export function requireTestOnly(
  request: Request,
  env: { ALLOW_INTERNAL_TEST_ROUTES?: string },
): Response | null {
  if (env.ALLOW_INTERNAL_TEST_ROUTES !== "1") {
    return new Response("forbidden", { status: 403 });
  }
  if (request.headers.get("X-Test-Only") !== "1") {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}
