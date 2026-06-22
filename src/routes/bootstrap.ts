import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { verifyBrowserJwt } from "../auth/jwt";
import { resolveUserSummaries, type UserSummary } from "../profile/resolve";

function fallbackMe(user_id: string): UserSummary {
  return { user_id, display_name: `user-${user_id.slice(0, 8)}`, avatar_url: null };
}

export async function bootstrapHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new ApiError("UNAUTHORIZED", "Not authenticated");

  const { user_id } = await verifyBrowserJwt(token, c.env.JWT_SECRET);

  const summaries = await resolveUserSummaries([user_id], c.env);
  const me = summaries.get(user_id) ?? fallbackMe(user_id);

  const dirStub = c.env.USER_DIRECTORY.getByName(user_id);
  const dirRes = await dirStub.fetch(new Request("https://internal/my-channels", {
    headers: { "X-Verified-User-Id": user_id },
  }));
  const myChannels = dirRes.ok ? ((await dirRes.json()) as { items: unknown[] }).items : [];

  return c.json(
    {
      me,
      channels: myChannels,
      active_channel: null,
      messages: { items: [], next_cursor: null },
      event_state: { per_channel: {} },
    },
    200,
    { "X-Request-Id": c.get("requestId") },
  );
}

