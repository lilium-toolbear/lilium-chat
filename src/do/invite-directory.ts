import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { execSchema } from "./sql";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS invite_index (
    invite_code TEXT PRIMARY KEY, channel_id TEXT NOT NULL, status TEXT NOT NULL,
    expires_at TEXT NOT NULL, revoked_at TEXT, updated_at TEXT NOT NULL
  )`,
];

export class InviteDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    execSchema(this.ctx, SCHEMA);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (request.method === "POST" && url.pathname === "/upsert") {
      const body = (await request.json()) as { invite_code?: string; channel_id?: string; status?: string };
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO invite_index (invite_code, channel_id, status, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        body.invite_code ?? "",
        body.channel_id ?? "",
        body.status ?? "active",
        "2999-01-01T00:00:00Z",
        new Date().toISOString(),
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/get") {
      const inviteCode = url.searchParams.get("code") ?? "";
      const rows = this.ctx.storage.sql.exec(
        "SELECT channel_id, status FROM invite_index WHERE invite_code=?",
        inviteCode,
      ).toArray() as { channel_id: string; status: string }[];
      const row = rows[0] ?? undefined;
      return Response.json(row ?? {});
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    // Phase 0: no due jobs yet.
  }
}
