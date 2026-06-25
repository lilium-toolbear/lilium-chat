import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../helpers";

const SELF = (await import("../../src/index")).default as {
  fetch: (request: Request, envOverride?: unknown, ctx?: { waitUntil: () => void; passThroughOnException: () => void }) => Promise<Response> | Response;
};

async function authedReq(userId: string, method: string, path: string, body?: unknown, idemKey?: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await makeJwt({ sub: userId }, TEST_SECRET)}` };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (idemKey) {
    headers["Idempotency-Key"] = idemKey;
  }
  return SELF.fetch(new Request(`https://chat.kuma.homes${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }), { ...env, JWT_SECRET: TEST_SECRET } as typeof env);
}

describe("POST /api/chat/channels/:id/invites", () => {
  it("creates invite with contract fields and invite_url", async () => {
    const create = await authedReq("u-invite-create-1", "POST", "/api/chat/channels", {
      title: "Invite room",
      visibility: "private",
      initial_members: [],
    }, "invite-create-channel-1");
    expect(create.status).toBe(201);
    const createBody = (await create.json()) as { channel: { channel_id: string } };

    const res = await authedReq("u-invite-create-1", "POST", `/api/chat/channels/${createBody.channel.channel_id}/invites`, {
      expires_in_seconds: 3600,
      max_uses: null,
    }, "invite-create-key-1");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { invite_code: string; invite_url: string; expires_at: string; max_uses: number | null };
    expect(body.invite_code).toBeTypeOf("string");
    expect(body.invite_code.length).toBeGreaterThan(0);
    expect(body.invite_url).toBe(`https://chat.kuma.homes/api/chat/invites/${body.invite_code}`);
    expect(body.max_uses).toBeNull();
    expect(typeof body.expires_at).toBe("string");
    const expiresAt = Date.parse(body.expires_at);
    const now = Date.now();
    expect(expiresAt).toBeGreaterThan(now);
    expect(expiresAt).toBeLessThan(now + 2 * 3600 * 1000);
  });

  it("is idempotent for the same Idempotency-Key", async () => {
    const create = await authedReq("u-invite-create-2", "POST", "/api/chat/channels", {
      title: "Invite room",
      visibility: "private",
      initial_members: [],
    }, "invite-create-channel-2");
    const createBody = (await create.json()) as { channel: { channel_id: string } };

    const req = {
      expires_in_seconds: 3600,
      max_uses: null,
    };

    const r1 = await authedReq("u-invite-create-2", "POST", `/api/chat/channels/${createBody.channel.channel_id}/invites`, req, "invite-create-key-idem");
    const b1 = (await r1.json()) as { invite_code: string; invite_url: string; expires_at: string; max_uses: number | null };

    const r2 = await authedReq("u-invite-create-2", "POST", `/api/chat/channels/${createBody.channel.channel_id}/invites`, req, "invite-create-key-idem");
    const b2 = (await r2.json()) as { invite_code: string; invite_url: string; expires_at: string; max_uses: number | null };

    expect(r2.status).toBe(200);
    expect(b2.invite_code).toBe(b1.invite_code);
    expect(b2.expires_at).toBe(b1.expires_at);
    expect(b2.max_uses).toBeNull();
  });

  it("previews invite details for owner and strangers", async () => {
    const create = await authedReq("u-invite-preview-1", "POST", "/api/chat/channels", {
      title: "Invite preview room",
      visibility: "private",
      initial_members: [
        { user_id: "u-preview-member-1", role: "member" },
        { user_id: "u-preview-member-2", role: "member" },
        { user_id: "u-preview-member-3", role: "member" },
      ],
    }, "invite-preview-channel-1");
    expect(create.status).toBe(201);
    const createBody = (await create.json()) as { channel: { channel_id: string } };

    const createInvite = await authedReq("u-invite-preview-1", "POST", `/api/chat/channels/${createBody.channel.channel_id}/invites`, {
      expires_in_seconds: 3600,
      max_uses: null,
    }, "invite-preview-key-1");
    const invite = (await createInvite.json()) as { invite_code: string };

    const previewOwner = await authedReq("u-invite-preview-1", "GET", `/api/chat/invites/${invite.invite_code}`);
    expect(previewOwner.status).toBe(200);
    const ownerBody = await previewOwner.json() as {
      invite: { invite_code: string; expires_at: string; max_uses: number | null };
      channel: { channel_id: string; kind: string; visibility: string; title: string; avatar_url: null; member_count: number; status: string };
      inviter: { user_id: string; display_name: string | null; avatar_url: null };
      sample_members: Array<{ user_id: string; display_name: string | null; avatar_url: null }>;
      my_membership: { status: string; channel_id: string | null };
    };
    expect(ownerBody.invite.invite_code).toBe(invite.invite_code);
    expect(ownerBody.invite.max_uses).toBeNull();
    expect(typeof ownerBody.invite.expires_at).toBe("string");
    expect(ownerBody.channel.channel_id).toBe(createBody.channel.channel_id);
    expect(ownerBody.channel.kind).toBe("channel");
    expect(ownerBody.channel.visibility).toBe("private");
    expect(ownerBody.channel.status).toBe("active");
    expect(ownerBody.channel.member_count).toBe(4);
    expect(ownerBody.inviter.user_id).toBe("u-invite-preview-1");
    expect(Array.isArray(ownerBody.sample_members)).toBe(true);
    expect(ownerBody.sample_members.length).toBeLessThanOrEqual(3);
    expect(ownerBody.my_membership.status).toBe("active");
    expect(ownerBody.my_membership.channel_id).toBe(createBody.channel.channel_id);

    const previewStranger = await authedReq("u-invite-preview-stranger", "GET", `/api/chat/invites/${invite.invite_code}`);
    expect(previewStranger.status).toBe(200);
    const strangerBody = (await previewStranger.json()) as {
      my_membership: { status: string; channel_id: string | null };
    };
    expect(strangerBody.my_membership.status).toBe("not_joined");
    expect(strangerBody.my_membership.channel_id).toBeNull();
  });

  it("returns INVITE_NOT_FOUND for unknown code", async () => {
    const preview = await authedReq("u-invite-preview-2", "GET", "/api/chat/invites/not-found-code");
    expect(preview.status).toBe(404);
    const body = await preview.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVITE_NOT_FOUND");
  });
});
