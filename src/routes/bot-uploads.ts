import type { Context } from "hono";
import type { FinalizedAttachmentProjection } from "../contract/message";
import type { Env } from "../env";
import { getBotIdentity } from "../auth/bot";
import { ApiError, apiErrorFromRemote } from "../errors";
import type { ChatChannel } from "../do/chat-channel";

interface UploadPresignResponse {
  attachment_id: string;
  upload_url: string;
  upload_headers: Record<string, string>;
  expires_at: string;
}

async function presignBotUpload(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { botId, env } = await getBotIdentity(c, "chat:messages:write");
  const channelId = c.req.param("channel_id") ?? "";
  if (!channelId) throw new ApiError("INVALID_MESSAGE", "channel_id is required");

  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!idempotencyKey) throw new ApiError("INVALID_MESSAGE", "Idempotency-Key required");

  const body = (await c.req.json().catch(() => null)) as {
    filename?: string;
    mime_type?: string;
    size_bytes?: number;
    width?: number;
    height?: number;
    blurhash?: string;
  } | null;
  if (!body || typeof body.filename !== "string" || typeof body.mime_type !== "string" || typeof body.size_bytes !== "number") {
    throw new ApiError("INVALID_MESSAGE", "filename, mime_type and size_bytes are required");
  }

  const stub = env.CHAT_CHANNEL.getByName(channelId) as DurableObjectStub<ChatChannel>;
  const out = await stub.botAttachmentPresign({
    channel_id: channelId,
    bot_id: botId,
    idempotency_key: idempotencyKey,
    filename: body.filename,
    mime_type: body.mime_type,
    size_bytes: body.size_bytes,
    width: body.width ?? null,
    height: body.height ?? null,
    blurhash: body.blurhash ?? undefined,
  }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  });

  return c.json(out as UploadPresignResponse, 200, { "X-Request-Id": c.get("requestId") });
}

async function finalizeBotUpload(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  const { botId, env } = await getBotIdentity(c, "chat:messages:write");
  const channelId = c.req.param("channel_id") ?? "";
  const attachmentId = c.req.param("attachment_id") ?? "";
  if (!channelId) throw new ApiError("INVALID_MESSAGE", "channel_id is required");
  if (!attachmentId) throw new ApiError("INVALID_MESSAGE", "attachment_id is required");

  const body = (await c.req.json().catch(() => ({}))) as { etag?: string };
  const stub = env.CHAT_CHANNEL.getByName(channelId) as DurableObjectStub<ChatChannel>;
  const out = await stub.botAttachmentFinalize({
    channel_id: channelId,
    bot_id: botId,
    attachment_id: attachmentId,
    etag: body.etag ?? undefined,
  }).catch((err) => {
    throw apiErrorFromRemote(err) ?? err;
  }) as { attachment: FinalizedAttachmentProjection };

  return c.json(out, 200, { "X-Request-Id": c.get("requestId") });
}

export async function botPresignUploadHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  return presignBotUpload(c);
}

export async function botFinalizeUploadHandler(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
): Promise<Response> {
  return finalizeBotUpload(c);
}
