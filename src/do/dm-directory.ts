import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { uuidv7 } from "../ids/uuidv7";
import { canonicalDmPairKey } from "../chat/dm-pair";
import { handleSchemaVersionRequest } from "./sql-migrations";
import { migrateDmDirectorySchema } from "./migrations/dm-directory";

export class DMDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateDmDirectorySchema(this.ctx);
  }

  async fetch(request: Request): Promise<Response> {
    const schemaVersion = handleSchemaVersionRequest(this.ctx, "DMDirectory", request);
    if (schemaVersion) return schemaVersion;

    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (request.method === "POST" && url.pathname === "/internal/get-or-create-dm") {
      const body = (await request.json()) as { user_a: string; user_b: string; created_by: string };
      const { user_low, user_high } = canonicalDmPairKey(body.user_a, body.user_b);
      const pairKey = `${user_low}:${user_high}`;
      const now = new Date().toISOString();

      const result = await this.ctx.storage.transaction(async () => {
        const existing = this.ctx.storage.sql
          .exec("SELECT channel_id, status FROM dm_pairs WHERE pair_key=?", pairKey)
          .toArray()[0] as { channel_id: string; status: string } | undefined;

        if (existing) {
          return {
            channel_id: existing.channel_id,
            status: existing.status as "active" | "creating",
            created: false,
          };
        }

        const channelId = uuidv7();
        this.ctx.storage.sql.exec(
          `INSERT INTO dm_pairs (pair_key, user_low, user_high, channel_id, created_by, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'creating', ?, ?)`,
          pairKey, user_low, user_high, channelId, body.created_by, now, now,
        );
        return { channel_id: channelId, status: "creating" as const, created: true };
      });

      return Response.json(result);
    }

    if (request.method === "POST" && url.pathname === "/internal/complete-dm") {
      const body = (await request.json()) as { pair_key: string; channel_id: string };
      const now = new Date().toISOString();

      await this.ctx.storage.transaction(async () => {
        const row = this.ctx.storage.sql
          .exec("SELECT channel_id, status FROM dm_pairs WHERE pair_key=?", body.pair_key)
          .toArray()[0] as { channel_id: string; status: string } | undefined;
        if (!row) {
          throw new Error("dm pair not found");
        }
        if (row.channel_id !== body.channel_id) {
          throw new Error("dm pair channel_id mismatch");
        }
        if (row.status === "active") return;
        this.ctx.storage.sql.exec(
          "UPDATE dm_pairs SET status='active', updated_at=? WHERE pair_key=?",
          now, body.pair_key,
        );
      });

      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }
}
