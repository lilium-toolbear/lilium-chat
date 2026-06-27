/** Stable per-(channel, user) invite code — same member always gets the same link in a channel. */
export async function personalInviteCode(channelId: string, userId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`lilium-invite:v1:${channelId}:${userId}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
