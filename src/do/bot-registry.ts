import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { handleSchemaVersionRequest } from "./sql-migrations";
import { migrateBotRegistrySchema } from "./migrations/bot-registry";

export class BotRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateBotRegistrySchema(this.ctx);
  }

  async fetch(request: Request): Promise<Response> {
    const schemaVersion = handleSchemaVersionRequest(this.ctx, "BotRegistry", request);
    if (schemaVersion) return schemaVersion;

    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    // Phase 0: no due jobs yet.
  }
}
