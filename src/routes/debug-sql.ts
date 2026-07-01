import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { assertDebugToken, type DebugSqlInput, type DebugSqlResult } from "../do/shared/debug-sql";
import type { ChannelDirectory } from "../do/channel-directory";

type AppContext = Context<{ Bindings: Env; Variables: { requestId: string } }>;

type DebugSqlStub = { debugSql(input: DebugSqlInput): Promise<DebugSqlResult> };

const SUPPORTED_CLASSES = [
  "ChatChannel",
  "ChannelFanout",
  "UserConnection",
  "BotConnection",
  "BotStreamConnection",
  "UserDirectory",
] as const;
type SupportedClass = (typeof SUPPORTED_CLASSES)[number];

const CHANNEL_KEYED = new Set<SupportedClass>(["ChatChannel", "ChannelFanout"]);
const FANOUT_CONCURRENCY = 16;

function bearerToken(c: Context): string | null {
  const h = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}

function stubForClass(env: Env, className: SupportedClass, name: string): DebugSqlStub {
  switch (className) {
    case "ChatChannel":
      return env.CHAT_CHANNEL.getByName(name) as unknown as DebugSqlStub;
    case "ChannelFanout":
      return env.CHANNEL_FANOUT.getByName(name) as unknown as DebugSqlStub;
    case "UserConnection":
      return env.USER_CONNECTION.getByName(name) as unknown as DebugSqlStub;
    case "BotConnection":
      return env.BOT_CONNECTION.getByName(name) as unknown as DebugSqlStub;
    case "BotStreamConnection":
      return env.BOT_STREAM_CONNECTION.getByName(name) as unknown as DebugSqlStub;
    case "UserDirectory":
      return env.USER_DIRECTORY.getByName(name) as unknown as DebugSqlStub;
  }
}

function parseClass(value: unknown): SupportedClass {
  if (typeof value !== "string" || !(SUPPORTED_CLASSES as readonly string[]).includes(value)) {
    throw new ApiError("INVALID_MESSAGE", `unsupported class (allowed: ${SUPPORTED_CLASSES.join(", ")})`);
  }
  return value as SupportedClass;
}

function parseBody(body: unknown): { className: SupportedClass; query: string; limit?: number; name?: string; names?: string[] } {
  if (!body || typeof body !== "object") throw new ApiError("INVALID_MESSAGE", "json body required");
  const b = body as Record<string, unknown>;
  const className = parseClass(b.class);
  if (typeof b.query !== "string" || !b.query.trim()) throw new ApiError("INVALID_MESSAGE", "query required");
  const limit = typeof b.limit === "number" ? b.limit : undefined;
  const name = typeof b.name === "string" ? b.name : undefined;
  const names = Array.isArray(b.names) ? b.names.filter((n): n is string => typeof n === "string") : undefined;
  return { className, query: b.query, limit, name, names };
}

/** POST /internal/debug/sql — run a read-only SELECT on a single DO instance. */
export async function debugSqlHandler(c: AppContext): Promise<Response> {
  assertDebugToken(c.env, bearerToken(c));
  const body = await c.req.json().catch(() => null);
  const { className, query, limit, name } = parseBody(body);
  if (!name) throw new ApiError("INVALID_MESSAGE", "name required (the DO instance key)");
  const stub = stubForClass(c.env, className, name);
  const result = await stub.debugSql({ query, limit });
  return c.json({ class: className, name, ...result });
}

/** POST /internal/debug/sql-all — run a read-only SELECT across many DO instances. */
export async function debugSqlAllHandler(c: AppContext): Promise<Response> {
  assertDebugToken(c.env, bearerToken(c));
  const body = await c.req.json().catch(() => null);
  const { className, query, limit, names } = parseBody(body);

  let targets: string[];
  if (CHANNEL_KEYED.has(className)) {
    const dir = c.env.CHANNEL_DIRECTORY.getByName("shared") as unknown as ChannelDirectory;
    targets = dir.listAllChannelIds().channel_ids;
  } else if (names && names.length > 0) {
    targets = names;
  } else {
    throw new ApiError(
      "INVALID_MESSAGE",
      `class ${className} is not channel-keyed; provide explicit "names" (instance keys)`,
    );
  }

  const input: DebugSqlInput = { query, limit };
  const results: Array<{ name: string; ok: true; result: DebugSqlResult } | { name: string; ok: false; error: string }> = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(FANOUT_CONCURRENCY, targets.length) }, async () => {
    while (i < targets.length) {
      const name = targets[i++];
      if (name === undefined) break;
      try {
        const result = await stubForClass(c.env, className, name).debugSql(input);
        results.push({ name, ok: true, result });
      } catch (err) {
        results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  await Promise.all(workers);

  // Summary row for quick triage when the query is an aggregate (e.g. SELECT status, COUNT(*)).
  return c.json({ class: className, instance_count: targets.length, results });
}

/** GET /internal/debug/classes — list supported DO classes and enumeration mode. */
export function debugClassesHandler(c: AppContext): Response {
  assertDebugToken(c.env, bearerToken(c));
  return c.json({
    classes: SUPPORTED_CLASSES.map((cls) => ({
      class: cls,
      enumeration: CHANNEL_KEYED.has(cls) ? "auto (via ChannelDirectory)" : 'explicit "names"',
    })),
  });
}
