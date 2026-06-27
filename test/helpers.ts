import { SignJWT } from "jose";
import { attachmentObjectKey, avatarObjectKey } from "../src/s3/object-key";
import type { Env } from "../src/env";

export const TEST_SECRET = "test-jwt-secret-do-not-use-in-prod";

export const TEST_S3_BUCKET = "s3.kuma.homes";

/** FakeS3 map key for weed path after nginx bucket-prefix injection. */
export function fakeS3PublicPath(attachmentId: string, filename = "img.png", mimeType = "image/png"): string {
  return `/${TEST_S3_BUCKET}/${attachmentObjectKey(attachmentId, filename, mimeType)}`;
}

export function fakeS3AvatarPublicPath(attachmentId: string, filename = "avatar.png", mimeType = "image/png"): string {
  return `/${TEST_S3_BUCKET}/${avatarObjectKey(attachmentId, filename, mimeType)}`;
}

export function getNamedDo(binding: DurableObjectNamespace, name: string): DurableObjectStub {
  // prod uses getByName; tests use idFromName+get. Works in both environments.
  return binding.get(binding.idFromName(name));
}

/** Create a channel owned by `userId` (already a member). */
export async function createOwnedTestChannel(
  env: Pick<Env, "CHAT_CHANNEL">,
  userId: string,
  opts?: {
    channelId?: string;
    title?: string;
    visibility?: string;
  },
): Promise<{ stub: DurableObjectStub; channelId: string }> {
  const channelId = opts?.channelId ?? crypto.randomUUID();
  const stub = await createTestChannel(env, {
    channelId,
    ownerId: userId,
    title: opts?.title ?? "Test Channel",
    visibility: opts?.visibility ?? "public_listed",
  });
  return { stub, channelId };
}

/** Create an owned channel and project membership into UserDirectory. */
export async function setupOwnedChannelForUser(
  env: Pick<Env, "CHAT_CHANNEL" | "USER_DIRECTORY">,
  userId: string,
  opts?: {
    channelId?: string;
    title?: string;
    visibility?: string;
  },
): Promise<{ stub: DurableObjectStub; channelId: string }> {
  const { stub, channelId } = await createOwnedTestChannel(env, userId, opts);
  await flushChannelToUserDirectory(env, stub, userId, channelId);
  return { stub, channelId };
}

/** Drive ChatChannel outbox until `userId` sees `channelId` in UserDirectory.my_channels. */
export async function flushChannelToUserDirectory(
  env: Pick<Env, "USER_DIRECTORY">,
  channelStub: DurableObjectStub,
  userId: string,
  channelId: string,
): Promise<void> {
  const { runDurableObjectAlarm } = await import("cloudflare:test") as {
    runDurableObjectAlarm: (stub: DurableObjectStub) => Promise<void>;
  };
  const dir = getNamedDo(env.USER_DIRECTORY as unknown as DurableObjectNamespace, userId);
  for (let i = 0; i < 40; i++) {
    await runDurableObjectAlarm(channelStub);
    const res = await dir.fetch(new Request("https://x/my-channels", { headers: { "X-Verified-User-Id": userId } }));
    if (res.ok) {
      const body = (await res.json()) as { items: Array<{ channel_id: string }> };
      if (body.items.some((it) => it.channel_id === channelId)) return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`channel ${channelId} not projected to user_directory for ${userId}`);
}

export async function createTestChannel(
  env: Pick<Env, "CHAT_CHANNEL">,
  opts: {
    channelId: string;
    ownerId: string;
    title?: string;
    visibility?: string;
    initial_members?: Array<{ user_id: string; role: string }>;
  },
): Promise<DurableObjectStub> {
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace, opts.channelId);
  const res = await stub.fetch(
    new Request("https://x/internal/create-channel", {
      method: "POST",
      headers: { "X-Verified-User-Id": opts.ownerId, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: opts.channelId,
        creator_user_id: opts.ownerId,
        title: opts.title ?? "Test Channel",
        topic: null,
        avatar_attachment_id: null,
        visibility: opts.visibility ?? "private",
        initial_members: opts.initial_members ?? [],
      }),
    }),
  );
  if (!res.ok) {
    throw new Error(`createTestChannel failed: ${res.status} ${await res.text()}`);
  }
  return stub;
}

/** Create a kind=dm channel between two users (DMDirectory + ChatChannel create-dm). */
export async function createTestDmChannel(
  env: Pick<Env, "CHAT_CHANNEL" | "DM_DIRECTORY">,
  userA: string,
  userB: string,
  createdBy: string,
): Promise<{ stub: DurableObjectStub; channelId: string }> {
  const { canonicalDmPairKey } = await import("../src/chat/dm-pair");
  const { pair_key, user_low, user_high } = canonicalDmPairKey(userA, userB);
  const dmStub = getNamedDo(env.DM_DIRECTORY as unknown as DurableObjectNamespace, pair_key);
  const dmRes = await dmStub.fetch(new Request("https://x/internal/get-or-create-dm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_a: user_low, user_b: user_high, created_by: createdBy }),
  }));
  if (!dmRes.ok) throw new Error(`get-or-create-dm failed: ${await dmRes.text()}`);
  const dmBody = await dmRes.json() as { channel_id: string };
  const stub = getNamedDo(env.CHAT_CHANNEL as unknown as DurableObjectNamespace, dmBody.channel_id);
  const createRes = await stub.fetch(new Request("https://x/internal/create-dm", {
    method: "POST",
    headers: { "X-Verified-User-Id": createdBy, "Content-Type": "application/json" },
    body: JSON.stringify({
      channel_id: dmBody.channel_id,
      user_a: user_low,
      user_b: user_high,
      created_by: createdBy,
    }),
  }));
  if (!createRes.ok) throw new Error(`create-dm failed: ${await createRes.text()}`);
  await dmStub.fetch(new Request("https://x/internal/complete-dm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pair_key, channel_id: dmBody.channel_id }),
  }));
  return { stub, channelId: dmBody.channel_id };
}

export interface JwtClaims {
  sub: string;
  exp?: number; // unix seconds
  iat?: number;
  client_id?: string;
  principal_id?: string;
  owner_user_id?: string;
  effective_account_user_id?: string;
  managed_session?: boolean;
  scope?: string;
  [k: string]: unknown;
}

export async function makeJwt(claims: JwtClaims, secret: string = TEST_SECRET): Promise<string> {
  const { sub, exp, iat, ...rest } = claims;
  const now = Math.floor(Date.now() / 1000);
  let builder = new SignJWT(rest).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(sub);
  builder = builder.setExpirationTime(exp ?? now + 3600);
  if (iat !== undefined) builder = builder.setIssuedAt(iat);
  return builder.sign(new TextEncoder().encode(secret));
}
