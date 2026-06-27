import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { inflateChannelSummaryForViewer } from "../chat/channel-summary";
import { getIdentity } from "./channel-mutations";

type OpenDmInternalResponse =
  | { kind: "cached"; response: { channel: Record<string, unknown>; membership: { role: string; joined_at: string } } }
  | { kind: "needs_inflate"; channel_id: string; joined_at: string; role: string };

export async function openDmHandler(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<Response> {
  const { userId, env } = await getIdentity(c);
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => null)) as { recipient_user_id?: string } | null;
  if (!body?.recipient_user_id) throw new ApiError("INVALID_DM_TARGET", "recipient_user_id required");
  if (body.recipient_user_id === userId) throw new ApiError("INVALID_DM_TARGET", "cannot open DM with yourself");

  const dirStub = env.USER_DIRECTORY.getByName(userId);
  const res = await dirStub.fetch(new Request("https://x/internal/open-dm", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: idempotencyKey, recipient_user_id: body.recipient_user_id }),
  }));

  if (res.status === 404) {
    const e = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new ApiError("DM_TARGET_NOT_FOUND", e.error?.message ?? "recipient user not found");
  }
  if (res.status === 409) {
    const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(e.error?.code ?? "IDEMPOTENCY_CONFLICT", e.error?.message ?? "idempotency conflict");
  }
  if (res.status === 422) {
    const e = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new ApiError("INVALID_DM_TARGET", e.error?.message ?? "invalid dm target");
  }
  if (!res.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "dm open failed");

  const internal = await res.json() as OpenDmInternalResponse;
  if (internal.kind === "cached") {
    return c.json(internal.response, 200, { "X-Request-Id": c.get("requestId") });
  }

  const channelId = internal.channel_id;
  const chStub = env.CHAT_CHANNEL.getByName(channelId);
  const summaryRes = await chStub.fetch(new Request("https://x/internal/summary", {
    headers: { "X-Verified-User-Id": userId },
  }));
  if (!summaryRes.ok) throw new ApiError("CHAT_WORKER_UNAVAILABLE", "failed to load dm summary");

  const summary = await summaryRes.json() as Parameters<typeof inflateChannelSummaryForViewer>[0]["summary"];

  let myChannelRow: { last_read_event_id: string | null } | null = null;
  const myChannelsRes = await dirStub.fetch(new Request("https://x/my-channels", {
    headers: { "X-Verified-User-Id": userId },
  }));
  if (myChannelsRes.ok) {
    const items = ((await myChannelsRes.json()) as { items: Array<{ channel_id: string; last_read_event_id: string | null }> }).items;
    const row = items.find((it) => it.channel_id === channelId);
    if (row) myChannelRow = { last_read_event_id: row.last_read_event_id };
  }

  const channel = await inflateChannelSummaryForViewer({
    summary,
    viewerUserId: userId,
    myChannelRow,
    env,
  });

  const response = {
    channel,
    membership: { role: internal.role, joined_at: internal.joined_at },
  };

  await dirStub.fetch(new Request("https://x/internal/open-dm-complete", {
    method: "POST",
    headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      response_json: JSON.stringify(response),
    }),
  }));

  return c.json(response, 200, { "X-Request-Id": c.get("requestId") });
}
