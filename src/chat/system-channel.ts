import type { Env } from "../env";

export const SYSTEM_CHANNEL_NAME = "system-general";
export const SYSTEM_TITLE = "Lilium";

export async function ensureSystemChannel(env: Env): Promise<{ channelId: string }> {
  const stub = env.CHAT_CHANNEL.getByName(SYSTEM_CHANNEL_NAME);
  const res = await stub.fetch(new Request("https://x/internal/maybe-create-system", {
    method: "POST", body: JSON.stringify({ title: SYSTEM_TITLE }),
  }));
  return { channelId: (await res.json() as { channel_id: string }).channel_id };
}

export async function ensureSystemJoined(env: Env, userId: string): Promise<{ channelId: string; membershipVersion: number }> {
  const { channelId } = await ensureSystemChannel(env);
  const stub = env.CHAT_CHANNEL.getByName(SYSTEM_CHANNEL_NAME);
  const jr = await stub.fetch(new Request("https://x/internal/join", {
    method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  }));
  const jb = await jr.json() as { channel_id: string; membership_version: number };
  return { channelId: jb.channel_id, membershipVersion: jb.membership_version };
}

export async function channelRouteNameFor(env: Env, userId: string, clientChannelId: string): Promise<string | null> {
  const sys = await ensureSystemChannel(env);
  if (clientChannelId === sys.channelId) return SYSTEM_CHANNEL_NAME;
  // Phase 3+ convention: user-created channels use channel_id as the DO name.
  // For Phase 1, any non-system id is unresolved → null (caller returns CHANNEL_NOT_FOUND).
  return null;
}
