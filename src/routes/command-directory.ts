import type { Context } from "hono";
import { getIdentity } from "./auth";
import { botRegistryStub } from "../auth/bot";

export async function commandDirectoryHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { env } = await getIdentity(c);
  const q = c.req.query("query");
  const limit = c.req.query("limit");
  const cursor = c.req.query("cursor");
  const out = await botRegistryStub(env).searchCommands({ query: q, limit, cursor });
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
