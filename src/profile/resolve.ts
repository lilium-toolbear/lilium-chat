import type { Env } from "../env";

export interface UserSummary {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface ClientLike {
  connect(): Promise<void>;
  query(sql: string, params: unknown[]): Promise<{ rows: Array<{ user_id: string; full_name: string | null; avatar_url: string | null }> }>;
  end(): Promise<void>;
}

export interface ResolveOptions {
  /** Test-only injection of a custom pg.Client constructor. */
  clientFactory?: (connectionString: string) => ClientLike;
  batchSize?: number;
}

const DEFAULT_BATCH = 50;
let CachedPgClient: (new (opts: { connectionString: string }) => ClientLike) | null = null;

async function defaultClientFactory(connectionString: string): Promise<ClientLike> {
  if (!CachedPgClient) {
    const module = (await new Function("return import('pg')")()) as {
      Client: new (opts: { connectionString: string }) => ClientLike;
    };
    CachedPgClient = module.Client;
  }
  return new (CachedPgClient!)({ connectionString }) as ClientLike;
}

/**
 * Resolve display_name/avatar for a set of user_ids by reading ToolBear's
 * `users` table read-only via Hyperdrive. Never persists anything.
 * Dedupes input, batches in chunks of 50 (no silent truncation).
 * Missing users are simply absent from the returned map.
 */
export async function resolveUserSummaries(
  userIds: string[],
  env: Env,
  opts: ResolveOptions = {},
): Promise<Map<string, UserSummary>> {
  const unique = [...new Set(userIds)];
  const map = new Map<string, UserSummary>();
  if (unique.length === 0) return map;

  const batchSize = opts.batchSize ?? DEFAULT_BATCH;

  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const client = opts.clientFactory ? opts.clientFactory(env.TOOLBEAR_DB.connectionString) : await defaultClientFactory(env.TOOLBEAR_DB.connectionString);
    try {
      await client.connect();
      const res = await client.query(
        "SELECT user_id::text, full_name, avatar_url FROM users WHERE user_id = ANY($1)",
        [batch],
      );
      for (const row of res.rows) {
        map.set(row.user_id, { user_id: row.user_id, display_name: row.full_name, avatar_url: row.avatar_url });
      }
    } catch (error) {
      console.warn("resolveUserSummaries: profile query failed", { batch, error: String(error) });
      // leave these ids absent; caller applies fallback
    } finally {
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
  }
  return map;
}
