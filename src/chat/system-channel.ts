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
  void userId;
  // The system channel DO is named system-general; its channel_id is a UUIDv7 minted at bootstrap.
  const sys = await ensureSystemChannel(env);
  if (clientChannelId === sys.channelId) return SYSTEM_CHANNEL_NAME;
  // Defense: the literal DO-name string "system-general" is never a user channel id.
  if (clientChannelId === SYSTEM_CHANNEL_NAME) return null;
  // Phase 3: user-created channels use channel_id as the DO name (optimistic routing).
  // The ChatChannel DO self-validates (404/409 if the channel doesn't exist).
  return clientChannelId;
}
