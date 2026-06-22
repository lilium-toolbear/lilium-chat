import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { execSchema } from "./sql";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS message_index (
    message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mi_channel ON message_index(channel_id)`,
];

export class MessageIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    execSchema(this.ctx, SCHEMA);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (request.method === "POST" && url.pathname === "/upsert") {
      const body = (await request.json()) as { message_id?: string; channel_id?: string };
      const messageId = body.message_id ?? "";
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO message_index (message_id, channel_id, created_at) VALUES (?, ?, ?)",
        messageId,
        body.channel_id ?? "",
        new Date().toISOString(),
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/get") {
      const messageId = url.searchParams.get("message_id") ?? "";
      const rows = this.ctx.storage.sql.exec("SELECT channel_id FROM message_index WHERE message_id=?", messageId).toArray() as
        { channel_id: string }[];
      const row = rows[0] ?? undefined;
      return Response.json(row ?? {});
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    // Phase 0: no due jobs yet.
  }
}
