import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { execSchema } from "./sql";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS public_channels (
    channel_id TEXT PRIMARY KEY, title TEXT NOT NULL, avatar_url TEXT,
    member_count INTEGER NOT NULL, last_message_at TEXT, status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

export class ChannelDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    execSchema(this.ctx, SCHEMA);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    // Phase 0: no due jobs yet.
  }
}
