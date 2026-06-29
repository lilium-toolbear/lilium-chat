import type { Context } from "hono";
import type { CommandDirectoryItem } from "../contract/bot-api";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { getIdentity } from "./auth";

function botRegistryStub(env: Env): DurableObjectStub {
  return env.BOT_REGISTRY.get(env.BOT_REGISTRY.idFromName("registry"));
}

export async function commandDirectoryHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { env } = await getIdentity(c);
  const query = new URLSearchParams();
  const q = c.req.query("query");
  const limit = c.req.query("limit");
  const cursor = c.req.query("cursor");
  if (q) query.set("query", q);
  if (limit) query.set("limit", limit);
  if (cursor) query.set("cursor", cursor);

  const res = await botRegistryStub(env).fetch(
    new Request(`https://x/internal/commands-directory?${query.toString()}`),
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    throw new ApiError(body.error?.code ?? "CHAT_WORKER_UNAVAILABLE", body.error?.message ?? "directory lookup failed");
  }
  const out = (await res.json()) as { items: CommandDirectoryItem[]; next_cursor: string | null };
  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}
