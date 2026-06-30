import { expect } from "vitest";
import { SignJWT } from "jose";
import { attachmentObjectKey, avatarObjectKey } from "../src/s3/object-key";
import type { Env } from "../src/env";
import type { AddMemberApiResponse, JoinChannelApiResponse, RemoveMemberApiResponse } from "../src/contract/channel-api";
import type { ChannelFanout, ChannelFanoutDebugDump } from "../src/do/channel-fanout";
import type { MessageMutationAckPayload } from "../src/contract/idempotency";
import { ApiError, apiErrorFromRemote } from "../src/errors";
import type { BotConnection } from "../src/do/bot-connection";
import type { ChatChannel } from "../src/do/chat-channel";
import type { UserConnection } from "../src/do/user-connection";
import type { DMDirectory } from "../src/do/dm-directory";
import type { UserDirectory } from "../src/do/user-directory";

export const TEST_SECRET = "test-jwt-secret-do-not-use-in-prod";

export const TEST_S3_BUCKET = "s3.kuma.homes";

/** FakeS3 map key for weed path after nginx bucket-prefix injection. */
export function fakeS3PublicPath(attachmentId: string, filename = "img.png", mimeType = "image/png"): string {
  return `/${TEST_S3_BUCKET}/${attachmentObjectKey(attachmentId, filename, mimeType)}`;
}

export function fakeS3AvatarPublicPath(attachmentId: string, filename = "avatar.png", mimeType = "image/png"): string {
  return `/${TEST_S3_BUCKET}/${avatarObjectKey(attachmentId, filename, mimeType)}`;
}

export function getNamedDo<T extends Rpc.DurableObjectBranded | undefined = undefined>(
  binding: DurableObjectNamespace<T>,
  name: string,
): DurableObjectStub<T> {
  // prod uses getByName; tests use idFromName+get. Works in both environments.
  return binding.get(binding.idFromName(name));
}

export async function dumpChannelFanout(
  stub: DurableObjectStub<ChannelFanout>,
  channelId: string,
): Promise<ChannelFanoutDebugDump> {
  return stub.debugDump({ channel_id: channelId });
}

export async function readDoSchemaVersion(stub: DurableObjectStub): Promise<{
  current_version: number;
  applied: Array<{ version: number; name?: string; applied_at?: string }>;
}> {
  const { runInDurableObject } = await import("cloudflare:test");
  let result: { current_version: number; applied: Array<{ version: number; name?: string; applied_at?: string }> } | null = null;
  await runInDurableObject(stub, async (instance: unknown) => {
    const ctx = (instance as { ctx: DurableObjectState }).ctx;
    const applied = ctx.storage.sql
      .exec("SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC")
      .toArray() as Array<{ version: number; name: string; applied_at: string }>;
    const maxRow = ctx.storage.sql.exec("SELECT MAX(version) AS current_version FROM schema_migrations").toArray()[0] as
      | { current_version: number | null }
      | undefined;
    result = { current_version: maxRow?.current_version ?? 0, applied };
  });
  if (result === null) throw new Error("failed to read DO schema version");
  return result;
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
): Promise<{ stub: DurableObjectStub<ChatChannel>; channelId: string }> {
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
): Promise<{ stub: DurableObjectStub<ChatChannel>; channelId: string }> {
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
  const dir = getNamedDo<UserDirectory>(env.USER_DIRECTORY, userId);
  for (let i = 0; i < 40; i++) {
    await runDurableObjectAlarm(channelStub);
    const body = await dir.listMyChannels(userId).catch(() => null);
    if (body) {
      if (body.items.some((it) => it.channel_id === channelId)) return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`channel ${channelId} not projected to user_directory for ${userId}`);
}

export async function readMyChannels(
  env: Pick<Env, "USER_DIRECTORY">,
  userId: string,
): Promise<Array<{ channel_id: string; kind?: string; membership_version?: number; last_read_event_id?: string | null }>> {
  const dir = getNamedDo<UserDirectory>(env.USER_DIRECTORY, userId);
  return (await dir.listMyChannels(userId)).items;
}

export function botConnectionTestStub(
  env: Pick<Env, "BOT_CONNECTION">,
  botId: string,
): DurableObjectStub<BotConnection> {
  return getNamedDo(env.BOT_CONNECTION as unknown as DurableObjectNamespace<BotConnection>, botId);
}

export async function enqueueBotInvocationDelivery(
  stub: DurableObjectStub<BotConnection>,
  botId: string,
  input: { outbox_id: string; channel_id: string; target_id?: string; invoker_user_id?: string },
): Promise<void> {
  const targetId = input.target_id ?? "inv-stream";
  await stub.enqueueDelivery(botId, {
    outbox_id: input.outbox_id,
    channel_id: input.channel_id,
    kind: "command_invocation",
    target_id: targetId,
    request_json: JSON.stringify({
      channel_id: input.channel_id,
      invocation_id: targetId,
      command: { name: "ask" },
      invoker: { user_id: input.invoker_user_id ?? "owner-1" },
    }),
  });
}

export function userConnectionTestStub(
  env: Pick<Env, "USER_CONNECTION">,
  userId: string,
): DurableObjectStub<UserConnection> {
  return getNamedDo(env.USER_CONNECTION as unknown as DurableObjectNamespace<UserConnection>, userId);
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
): Promise<DurableObjectStub<ChatChannel>> {
  const stub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL, opts.channelId);
  await stub.createChannel({
    user_id: opts.ownerId,
    channel_id: opts.channelId,
    creator_user_id: opts.ownerId,
    title: opts.title ?? "Test Channel",
    topic: null,
    avatar_attachment_id: null,
    visibility: opts.visibility ?? "private",
    initial_members: opts.initial_members ?? [],
  });
  return stub;
}

export async function joinTestChannel(
  stub: DurableObjectStub<ChatChannel>,
  userId: string,
  operationId = `join-${userId}`,
): Promise<JoinChannelApiResponse> {
  return stub.joinChannel({ user_id: userId, operation_id: operationId });
}

export async function addTestMember(
  stub: DurableObjectStub<ChatChannel>,
  input: { actorUserId: string; targetUserId: string; channelId: string; role?: string; idempotencyKey?: string },
): Promise<AddMemberApiResponse> {
  return stub.addMember({
    user_id: input.actorUserId,
    idempotency_key: input.idempotencyKey ?? `add-${input.targetUserId}`,
    channel_id: input.channelId,
    target_user_id: input.targetUserId,
    role: input.role ?? "member",
  });
}

export async function removeTestMember(
  stub: DurableObjectStub<ChatChannel>,
  input: { actorUserId: string; targetUserId: string; channelId: string; idempotencyKey?: string },
): Promise<RemoveMemberApiResponse> {
  return stub.removeMember({
    user_id: input.actorUserId,
    idempotency_key: input.idempotencyKey ?? `remove-${input.targetUserId}`,
    channel_id: input.channelId,
    target_user_id: input.targetUserId,
  });
}

export async function expectDoRpcError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    throw new Error(`expected DO RPC error ${code}`);
  } catch (err) {
    expect(err).toMatchObject({ code, remote: true });
  }
}

export async function sendTestMessage(
  stub: DurableObjectStub<ChatChannel>,
  input: {
    userId: string;
    channelId: string;
    commandId: string;
    type?: string;
    text?: string;
    replyTo?: string | null;
    attachmentIds?: string[];
    stickerId?: string;
    mentions?: Array<{ user_id: string; start: number; end: number }>;
  },
): Promise<Response> {
  try {
    const payload = await stub.sendMessage({
      user_id: input.userId,
      command_id: input.commandId,
      dedupe_principal_key: `user:${input.userId}`,
      type: input.type ?? "text",
      text: input.text ?? "",
      reply_to: input.replyTo ?? null,
      attachment_ids: input.attachmentIds ?? [],
      sticker_id: input.stickerId,
      mentions: input.mentions ?? [],
      channel_id: input.channelId,
    });
    return Response.json(payload satisfies MessageMutationAckPayload);
  } catch (err) {
    const apiErr = apiErrorFromRemote(err);
    if (apiErr) {
      return Response.json({ error: { code: apiErr.code, message: apiErr.message, retryable: apiErr.retryable } }, { status: apiErr.httpStatus });
    }
    throw err;
  }
}

export async function mutateTestMessage(
  stub: DurableObjectStub<ChatChannel>,
  input: {
    userId: string;
    channelId: string;
    messageId: string;
    operation: "message.edit" | "message.recall" | "message.delete";
    operationId: string;
    text?: string;
    reason?: string | null;
  },
): Promise<Response> {
  try {
    const payload = await stub.mutateMessage({
      user_id: input.userId,
      operation: input.operation,
      operation_id: input.operationId,
      channel_id: input.channelId,
      message_id: input.messageId,
      text: input.text,
      reason: input.reason,
    });
    return Response.json(payload satisfies MessageMutationAckPayload);
  } catch (err) {
    const apiErr = apiErrorFromRemote(err);
    if (apiErr) {
      return Response.json({ error: { code: apiErr.code, message: apiErr.message, retryable: apiErr.retryable } }, { status: apiErr.httpStatus });
    }
    throw err;
  }
}

/** Low-level sendMessage RPC with Response envelope for tests that pass the full DO input. */
export async function rpcSendMessage(
  stub: DurableObjectStub<ChatChannel>,
  input: Parameters<ChatChannel["sendMessage"]>[0],
): Promise<Response> {
  try {
    const payload = await stub.sendMessage(input);
    return Response.json(payload satisfies MessageMutationAckPayload);
  } catch (err) {
    const apiErr = apiErrorFromRemote(err);
    if (apiErr) {
      return Response.json({ error: { code: apiErr.code, message: apiErr.message, retryable: apiErr.retryable } }, { status: apiErr.httpStatus });
    }
    throw err;
  }
}

export async function rpcResolveVisibleAttachment(
  stub: DurableObjectStub<ChatChannel>,
  input: { user_id: string; attachment_id: string },
): Promise<Response> {
  try {
    const body = await stub.resolveVisibleAttachment(input);
    return Response.json(body);
  } catch (err) {
    const apiErr = apiErrorFromRemote(err);
    if (apiErr) {
      return Response.json({ error: { code: apiErr.code, message: apiErr.message, retryable: apiErr.retryable } }, { status: apiErr.httpStatus });
    }
    throw err;
  }
}

export async function readTestMessages(
  stub: DurableObjectStub<ChatChannel>,
  userId: string,
  limit = 10,
): Promise<{ items: TimelineHistoryItem[]; next_cursor: string | null }> {
  return stub.getMessages(userId, { before: null, after: null, limit }) as Promise<{ items: TimelineHistoryItem[]; next_cursor: string | null }>;
}

export async function replayTestEvents(
  stub: DurableObjectStub<ChatChannel>,
  userId: string,
  after = "",
): Promise<{ events: Array<{ event_id: string; event_json: string }> }> {
  return stub.replayEvents(userId, after);
}

/** Create a kind=dm channel between two users (DMDirectory + ChatChannel create-dm). */
export async function createTestDmChannel(
  env: Pick<Env, "CHAT_CHANNEL" | "DM_DIRECTORY">,
  userA: string,
  userB: string,
  createdBy: string,
): Promise<{ stub: DurableObjectStub<ChatChannel>; channelId: string }> {
  const { canonicalDmPairKey } = await import("../src/chat/dm-pair");
  const { pair_key, user_low, user_high } = canonicalDmPairKey(userA, userB);
  const dmStub = getNamedDo<DMDirectory>(env.DM_DIRECTORY, pair_key);
  const dmBody = await dmStub.getOrCreateDm({ user_a: user_low, user_b: user_high, created_by: createdBy });
  const stub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL, dmBody.channel_id);
  await stub.createDm({
    user_id: createdBy,
    channel_id: dmBody.channel_id,
    user_a: user_low,
    user_b: user_high,
    created_by: createdBy,
  });
  await dmStub.completeDm({ pair_key, channel_id: dmBody.channel_id });
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

/** Timeline history item shape returned by ChatChannel history RPC (unified event frames). */
export type TimelineHistoryItem = {
  type: string;
  payload?: {
    message?: {
      message_id: string;
      type?: string;
      status?: string;
      text?: string | null;
      attachments?: Array<{ attachment_id: string; blurhash?: string | null }>;
      sticker?: { sticker_id: string } | null;
    };
  };
};

export function findTimelineMessageCreated(
  items: TimelineHistoryItem[],
  messageId?: string,
): TimelineHistoryItem | undefined {
  return items.find(
    (item) =>
      item.type === "message.created" &&
      (messageId === undefined || item.payload?.message?.message_id === messageId),
  );
}

export function getTimelineMessageIdFromHistory(items: TimelineHistoryItem[]): string {
  const messageId = findTimelineMessageCreated(items)?.payload?.message?.message_id;
  if (!messageId) throw new Error("no message.created in timeline history");
  return messageId;
}

/** Let pending DO console-log RPC finish before vitest pool worker teardown. */
export async function drainPoolWorkerTeardown(): Promise<void> {
  await new Promise((r) => setTimeout(r, 500));
}
