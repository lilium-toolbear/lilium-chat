import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { migrateInviteDirectorySchema } from "./migrations";

type InvitePreview = {
  invite_code: string;
  channel_id: string;
  status: string;
  expires_at: string;
  revoked_at: string | null;
};

export class InviteDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      migrateInviteDirectorySchema(this.ctx);
    });
  }

  async upsertInvite(body: {
    invite_code?: string;
    channel_id?: string;
    status?: string;
    expires_at?: string;
    revoked_at?: string | null;
  }): Promise<void> {
    const status = body.status ?? "active";
    const expiresAt = body.expires_at ?? "2999-01-01T00:00:00Z";
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO invite_index (invite_code, channel_id, status, expires_at, revoked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      body.invite_code ?? "",
      body.channel_id ?? "",
      status,
      expiresAt,
      body.revoked_at ?? null,
      new Date().toISOString(),
    );
  }

  previewInvite(inviteCode: string): InvitePreview | null {
    const row = this.ctx.storage.sql
      .exec("SELECT invite_code, channel_id, status, expires_at, revoked_at FROM invite_index WHERE invite_code=?", inviteCode)
      .toArray() as
      | Array<{ invite_code: string; channel_id: string; status: string; expires_at: string; revoked_at: string | null }>
      | undefined;
    return row?.[0] ?? null;
  }

  getInviteRoute(inviteCode: string): { channel_id: string; status: string } | null {
    const rows = this.ctx.storage.sql.exec(
      "SELECT channel_id, status FROM invite_index WHERE invite_code=?",
      inviteCode,
    ).toArray() as { channel_id: string; status: string }[];
    return rows[0] ?? null;
  }

  async alarm(): Promise<void> {
    // Phase 0: no due jobs yet.
  }
}
