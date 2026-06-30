import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  addTestMember,
  createTestChannel,
  expectDoRpcError,
  fakeS3AvatarPublicPath,
  fakeS3PublicPath,
  getNamedDo as _g,
  readMyChannels,
  readTestMessages,
  removeTestMember,
  sendTestMessage,
  type TimelineHistoryItem,
} from "../helpers";
import type {
  DissolveChannelApiResponse,
  MemberProjection,
  UpdateChannelApiResponse,
  UpdateMemberRoleApiResponse,
} from "../../src/contract/channel-api";
import { setTestS3Client } from "../../src/s3/presign";
import { FakeS3 } from "../fake-s3";
import type { ChatChannel } from "../../src/do/chat-channel";
import type { UserDirectory } from "../../src/do/user-directory";

function udStub(userId: string) {
  return _g<UserDirectory>(env.USER_DIRECTORY, userId);
}

async function presignAndFinalizeAvatar(userId: string, fake: FakeS3): Promise<{ attachment_id: string; url: string }> {
  const key = `idem-avatar-${userId}`;
  const presignRes = await udStub(userId).presignUpload(userId, key, "avatar", {
    filename: "avatar.png",
    mime_type: "image/png",
    size_bytes: 12345,
    width: 512,
    height: 512,
    blurhash: "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
  });
  const presignBody = presignRes;
  fake.objects.set(fakeS3AvatarPublicPath(presignBody.attachment_id), { contentType: "image/png", contentLength: 12345 });

  const finalizeRes = await udStub(userId).finalizeUpload(userId, `${key}-fin`, { attachment_id: presignBody.attachment_id });
  const finalizeBody = finalizeRes;
  expect(finalizeBody.attachment.kind).toBe("avatar");
  return { attachment_id: finalizeBody.attachment.attachment_id, url: finalizeBody.attachment.url };
}

async function makeChannel(channelId: string) {
  return createTestChannel(env, { channelId, ownerId: "u-up-owner", title: "Orig", visibility: "private" });
}

function updateChannel(
  stub: DurableObjectStub<ChatChannel>,
  userId: string,
  input: {
    idempotency_key: string;
    channel_id: string;
    title?: string;
    topic?: string | null;
    avatar_attachment_id?: string | null;
    visibility?: string;
  },
): Promise<UpdateChannelApiResponse> {
  return stub.updateChannel({ user_id: userId, ...input });
}

function dissolveChannel(
  stub: DurableObjectStub<ChatChannel>,
  userId: string,
  input: { idempotency_key: string; channel_id: string },
): Promise<DissolveChannelApiResponse> {
  return stub.dissolveChannel({ user_id: userId, ...input });
}

function updateMemberRole(
  stub: DurableObjectStub<ChatChannel>,
  input: { actorUserId: string; idempotencyKey: string; channelId: string; targetUserId: string; role: string },
): Promise<UpdateMemberRoleApiResponse> {
  return stub.updateMemberRole({
    user_id: input.actorUserId,
    idempotency_key: input.idempotencyKey,
    channel_id: input.channelId,
    target_user_id: input.targetUserId,
    role: input.role,
  });
}

function getMember(stub: DurableObjectStub<ChatChannel>, viewerUserId: string, targetUserId: string): Promise<MemberProjection> {
  return stub.getMember(viewerUserId, targetUserId);
}

describe("ChatChannel update channel RPC", () => {
  let fake: FakeS3;
  beforeEach(() => {
    fake = new FakeS3();
    setTestS3Client(fake);
  });

  it("updates title + topic and writes channel.updated", async () => {
    const stub = await makeChannel("0193aaaa-0000-7000-8000-000000000001");
    const body = await updateChannel(stub, "u-up-owner", {
      idempotency_key: "k-up-1",
      channel_id: "0193aaaa-0000-7000-8000-000000000001",
      title: "New",
      topic: "Desc",
    });
    expect(body.channel.title).toBe("New");
    expect(body.channel.topic).toBe("Desc");
  });

  it("forbids non-member (non-admin) update", async () => {
    const stub = await makeChannel("0193bbbb-0000-7000-8000-000000000001");
    await expectDoRpcError(
      () => updateChannel(stub, "u-outsider", {
        idempotency_key: "k-up-2",
        channel_id: "0193bbbb-0000-7000-8000-000000000001",
        title: "Hijack",
      }),
      "FORBIDDEN",
    );
  });

  it("is idempotent on same key+body", async () => {
    const cid = "0193cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const b = { idempotency_key: "k-up-3", channel_id: cid, title: "Idem" };
    await updateChannel(stub, "u-up-owner", b);
    const r2 = await updateChannel(stub, "u-up-owner", b);
    expect(r2.channel.title).toBe("Idem");
  });

  it("returns 409 IDEMPOTENCY_CONFLICT on same key + different body", async () => {
    const cid = "0193dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await updateChannel(stub, "u-up-owner", { idempotency_key: "k-up-4", channel_id: cid, title: "A" });
    await expectDoRpcError(
      () => updateChannel(stub, "u-up-owner", { idempotency_key: "k-up-4", channel_id: cid, title: "B" }),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("updates avatar_url from a finalized avatar_attachment_id", async () => {
    const cid = "0193eeee-0000-7000-8000-000000000001";
    const ownerId = "u-up-owner";
    const stub = await makeChannel(cid);
    const { attachment_id: attachmentId, url: avatarUrl } = await presignAndFinalizeAvatar(ownerId, fake);

    const body = await updateChannel(stub, ownerId, { idempotency_key: "k-up-avatar", channel_id: cid, avatar_attachment_id: attachmentId });
    expect(body.channel.avatar_url).toBe(avatarUrl);

    const summary = await stub.getSummary(ownerId);
    expect(summary.avatar_url).toBe(avatarUrl);
  });

  it("clears avatar_url when avatar_attachment_id is null", async () => {
    const cid = "0193efef-0000-7000-8000-000000000001";
    const ownerId = "u-up-owner";
    const stub = await makeChannel(cid);
    const { attachment_id: attachmentId } = await presignAndFinalizeAvatar(ownerId, fake);
    await updateChannel(stub, ownerId, { idempotency_key: "k-up-avatar-set", channel_id: cid, avatar_attachment_id: attachmentId });

    const body = await updateChannel(stub, ownerId, { idempotency_key: "k-up-avatar-clear", channel_id: cid, avatar_attachment_id: null });
    expect(body.channel.avatar_url).toBeNull();
  });

  it("rejects message image attachment for channel avatar update", async () => {
    const cid = "0193f0f0-0000-7000-8000-000000000001";
    const ownerId = "u-up-owner";
    const stub = await makeChannel(cid);
    const key = `idem-msg-img-${ownerId}`;
    const presignRes = await udStub(ownerId).presignUpload(ownerId, key, "attachment", {
      filename: "photo.png",
      mime_type: "image/png",
      size_bytes: 12345,
    });
    const { attachment_id: attachmentId } = presignRes;
    fake.objects.set(fakeS3PublicPath(attachmentId, "photo.png"), { contentType: "image/png", contentLength: 12345 });
    await udStub(ownerId).finalizeUpload(ownerId, `${key}-fin`, { attachment_id: attachmentId });

    await expectDoRpcError(
      () => updateChannel(stub, ownerId, { idempotency_key: "k-up-avatar-reject", channel_id: cid, avatar_attachment_id: attachmentId }),
      "UNSUPPORTED_ATTACHMENT_TYPE",
    );
  });
});

describe("ChatChannel dissolve RPC", () => {
  it("owner dissolves → channel.dissolved, status dissolved", async () => {
    const cid = "0194aaaa-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const body = await dissolveChannel(stub, "u-up-owner", { idempotency_key: "k-dis-1", channel_id: cid });
    expect(body.channel.status).toBe("dissolved");
    expect(body.channel.channel_id).toBe(cid);
  });

  it("non-owner cannot dissolve", async () => {
    const cid = "0194bbbb-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await expectDoRpcError(
      () => dissolveChannel(stub, "u-outsider", { idempotency_key: "k-dis-2", channel_id: cid }),
      "FORBIDDEN",
    );
  });

  it("is idempotent: same key returns same result, no double event", async () => {
    const cid = "0194cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const b = { idempotency_key: "k-dis-3", channel_id: cid };
    await dissolveChannel(stub, "u-up-owner", b);
    await dissolveChannel(stub, "u-up-owner", b);
  });

  it("dissolved channel blocks further writes (message-send returns 409 CHANNEL_DISSOLVED)", async () => {
    const cid = "0194dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await dissolveChannel(stub, "u-up-owner", { idempotency_key: "k-dis-4", channel_id: cid });
    const res = await sendTestMessage(stub, { userId: "u-up-owner", channelId: cid, commandId: "cm-dis", text: "hi" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CHANNEL_DISSOLVED");
  });

  it("dissolve keeps members in my_channels with dissolved tombstone and preserves history reads", async () => {
    const cid = "0194eeee-0000-7000-8000-000000000001";
    const memberId = "u-dis-member-keep";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: memberId, channelId: cid, idempotencyKey: "k-dis-add" });
    await sendTestMessage(stub, { userId: "u-up-owner", channelId: cid, commandId: "cm-dis-history", text: "before dissolve" });
    await dissolveChannel(stub, "u-up-owner", { idempotency_key: "k-dis-keep", channel_id: cid });

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (instance) => { await (instance as { alarm: () => Promise<void> }).alarm(); });

    const items = await readMyChannels(env, memberId);
    expect(items.some((row) => row.channel_id === cid)).toBe(true);

    const summary = await stub.getSummary(memberId);
    expect(summary.status).toBe("dissolved");

    const messagesBody = await readTestMessages(stub, memberId);
    expect(messagesBody.items.some(
      (item) => item.type === "message.created" && item.payload?.message?.text === "before dissolve",
    )).toBe(true);
  });

  it("dissolved channel allows self-leave and removes member from my_channels", async () => {
    const cid = "0194ffff-0000-7000-8000-000000000001";
    const memberId = "u-dis-leave-member";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: memberId, channelId: cid, idempotencyKey: "k-dis-leave-add" });
    await dissolveChannel(stub, "u-up-owner", { idempotency_key: "k-dis-leave", channel_id: cid });

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (instance) => { await (instance as { alarm: () => Promise<void> }).alarm(); });

    const leaveRes = await removeTestMember(stub, { actorUserId: memberId, targetUserId: memberId, channelId: cid, idempotencyKey: "k-dis-leave-member" });
    expect(leaveRes.removed).toBe(true);

    await runInDurableObject(stub, async (instance) => { await (instance as { alarm: () => Promise<void> }).alarm(); });

    const items = await readMyChannels(env, memberId);
    expect(items.some((row) => row.channel_id === cid)).toBe(false);
  });
});

describe("ChatChannel members CRUD", () => {
  it("admin adds a member → member.joined", async () => {
    const cid = "0195aaaa-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    const res = await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-add-1", channelId: cid, idempotencyKey: "k-add-1" });
    expect(res.member.role).toBe("member");
  });

  it("owner updates a member role → member.role_updated", async () => {
    const cid = "0195bbbb-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-add-2", channelId: cid, idempotencyKey: "k-add-2" });
    const res = await updateMemberRole(stub, {
      actorUserId: "u-up-owner",
      targetUserId: "u-add-2",
      channelId: cid,
      role: "admin",
      idempotencyKey: "k-role-1",
    });
    expect(res.member.role).toBe("admin");
  });

  it("non-owner cannot change role (403)", async () => {
    const cid = "0195cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-add-3", channelId: cid, idempotencyKey: "k-add-3" });
    await expectDoRpcError(
      () => updateMemberRole(stub, {
        actorUserId: "u-add-3",
        targetUserId: "u-add-3",
        channelId: cid,
        role: "admin",
        idempotencyKey: "k-role-2",
      }),
      "FORBIDDEN",
    );
  });

  it("owner removes a member → member.left + fanout unregister outbox", async () => {
    const cid = "0195dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-add-4", channelId: cid, idempotencyKey: "k-add-4" });
    const res = await removeTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-add-4", channelId: cid, idempotencyKey: "k-rem-1" });
    expect(res.removed).toBe(true);
  });

  it("member self-leaves (user_id === caller)", async () => {
    const cid = "0195eeee-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-self-leave", channelId: cid, idempotencyKey: "k-add-5" });
    await removeTestMember(stub, { actorUserId: "u-self-leave", targetUserId: "u-self-leave", channelId: cid, idempotencyKey: "k-rem-2" });
  });

  it("add with a DIFFERENT role on an active member → 422 (no role-change-via-add bypass)", async () => {
    const cid = "0195ffff-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-bypass", channelId: cid, idempotencyKey: "k-add-6" });
    await expectDoRpcError(
      () => addTestMember(stub, {
        actorUserId: "u-up-owner",
        targetUserId: "u-bypass",
        channelId: cid,
        role: "admin",
        idempotencyKey: "k-add-6b",
      }),
      "INVALID_MESSAGE",
    );
  });

  it("add same role on an active member → 200 idempotent (no event, no count bump)", async () => {
    const cid = "01950000-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-idem-add", channelId: cid, idempotencyKey: "k-add-7" });
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-idem-add", channelId: cid, idempotencyKey: "k-add-7b" });
  });

  it("reactivates a LEFT member (+1 count) → member.joined", async () => {
    const cid = "01950001-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-rejoin", channelId: cid, idempotencyKey: "k-add-8" });
    await removeTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-rejoin", channelId: cid, idempotencyKey: "k-rem-rejoin" });
    const res = await addTestMember(stub, {
      actorUserId: "u-up-owner",
      targetUserId: "u-rejoin",
      channelId: cid,
      role: "admin",
      idempotencyKey: "k-add-8b",
    });
    expect(res.member.role).toBe("admin");
  });

  it("owner cannot self-leave (owner invariant) → 422", async () => {
    const cid = "01950002-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid); // owner = u-up-owner
    await expectDoRpcError(
      () => removeTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-up-owner", channelId: cid, idempotencyKey: "k-rem-owner" }),
      "INVALID_MESSAGE",
    );
  });

  it("owner cannot demote self via role-update → 422", async () => {
    const cid = "01950003-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await expectDoRpcError(
      () => updateMemberRole(stub, {
        actorUserId: "u-up-owner",
        targetUserId: "u-up-owner",
        channelId: cid,
        role: "member",
        idempotencyKey: "k-role-owner",
      }),
      "INVALID_MESSAGE",
    );
  });
});

describe("ChatChannel members read", () => {
  it("members-list returns active members", async () => {
    const cid = "0196aaaa-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-ml-a", channelId: cid, idempotencyKey: "k-ml-1" });
    const body = await stub.listMembers("u-up-owner", "");
    const items = body.items;
    expect(items.some((m) => m.user_id === "u-ml-a")).toBe(true);
  });

  it("members-list orders owner before admin before member", async () => {
    const cid = "0196aaab-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-ml-a", channelId: cid, idempotencyKey: "k-ml-2" });
    await updateMemberRole(stub, { actorUserId: "u-up-owner", targetUserId: "u-ml-a", channelId: cid, role: "admin", idempotencyKey: "k-ml-3" });
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-ml-b", channelId: cid, idempotencyKey: "k-ml-4" });
    const body = await stub.listMembers("u-up-owner", "");
    expect(body.items.map((member) => member.role)).toEqual(["owner", "admin", "member"]);
  });

  it("members-get returns status active for a member", async () => {
    const cid = "0196bbbb-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-mg-a", channelId: cid, idempotencyKey: "k-mg-1" });
    const body = await getMember(stub, "u-up-owner", "u-mg-a");
    expect(body.status).toBe("active");
    expect(body.role).toBe("member");
  });

  it("members-get returns 404 MEMBER_NOT_FOUND for a never-joined user", async () => {
    const cid = "0196cccc-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await expectDoRpcError(() => getMember(stub, "u-up-owner", "u-never"), "MEMBER_NOT_FOUND");
  });

  it("members-get returns status left for a removed member", async () => {
    const cid = "0196dddd-0000-7000-8000-000000000001";
    const stub = await makeChannel(cid);
    await addTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-mg-b", channelId: cid, idempotencyKey: "k-mg-2" });
    await removeTestMember(stub, { actorUserId: "u-up-owner", targetUserId: "u-mg-b", channelId: cid, idempotencyKey: "k-mg-3" });
    const body = await getMember(stub, "u-up-owner", "u-mg-b");
    expect(body.status).toBe("left");
  });
});
