import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createTestChannel, getNamedDo } from "../helpers";
import type { InviteDirectory } from "../../src/do/invite-directory";

describe("ChatChannel alarm: invite_directory outbox", () => {
  it("flushes invite outbox to InviteDirectory and marks delivered", async () => {
    const channelId = "0199aa00-0000-7000-8000-000000000001";
    const ownerId = "u-invite-alarm-1";
    const inviteCode = "invite-corr-1-code";
    const chatStub = await createTestChannel(env, { channelId, ownerId, title: "Invite test", visibility: "private" });
    await chatStub.getSummary(ownerId);

    const now = new Date().toISOString();
    const payload = {
      invite_code: inviteCode,
      channel_id: channelId,
      status: "active",
      expires_at: "2999-01-01T00:00:00Z",
      revoked_at: null,
    };

    const { runInDurableObject, runDurableObjectAlarm } = await import("cloudflare:test") as {
      runInDurableObject: (stub: unknown, cb: (instance: unknown) => Promise<void>) => Promise<void>;
      runDurableObjectAlarm: (stub: unknown) => Promise<void>;
    };
    await runInDurableObject(chatStub, async (instance: unknown) => {
      (instance as {
        ctx: {
          storage: {
            sql: {
              exec: (query: string, ...params: unknown[]) => void;
            };
          };
        };
      }).ctx.storage.sql.exec(
        "INSERT INTO projection_outbox (outbox_id, target_kind, target_key, event_id, payload_json, status, next_attempt_at, created_at, updated_at, attempts, max_attempts) VALUES (?, 'invite_directory', ?, ?, ?, 'pending', ?, ?, ?, 0, 5)",
        `test-invite-outbox-${Math.random().toString(16).slice(2)}`,
        inviteCode,
        `evt-invite-${Math.random().toString(16).slice(2)}`,
        JSON.stringify(payload),
        now,
        now,
        now,
      );
      await (instance as { scheduleOutboxAlarm: (nowIso: string) => Promise<void> }).scheduleOutboxAlarm(now);
    });

    await runDurableObjectAlarm(chatStub);

    let inviteOutboxStatus: string | null = null;
    let inviteOutboxLastError: string | null = null;
    await runInDurableObject(chatStub, async (instance: unknown) => {
      const row = (instance as {
        ctx: { storage: { sql: { exec: (query: string, ...params: unknown[]) => { toArray: () => Array<{ status: string; last_error: string | null }> } } } };
      }).ctx.storage.sql
          .exec("SELECT status, last_error FROM projection_outbox WHERE target_kind='invite_directory' ORDER BY created_at DESC LIMIT 1")
          .toArray()[0];
      if (row) inviteOutboxStatus = row.status;
      inviteOutboxLastError = row?.last_error ?? null;
    });
    if (inviteOutboxStatus !== "delivered") {
      throw new Error(`invite_directory outbox not delivered; status=${inviteOutboxStatus}, last_error=${inviteOutboxLastError}`);
    }
    expect(inviteOutboxStatus).toBe("delivered");

    const inviteStub = getNamedDo<InviteDirectory>(env.INVITE_DIRECTORY as unknown as DurableObjectNamespace<InviteDirectory>, "shared");
    const inviteRow = await inviteStub.getInviteRoute(inviteCode);
    expect(inviteRow).not.toBeNull();
    if (inviteRow === null) throw new Error("invite route missing");
    expect(inviteRow.channel_id).toBe(channelId);
    expect(inviteRow.status).toBe("active");
  });
});
