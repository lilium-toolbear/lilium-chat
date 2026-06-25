import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { ApiError, errorResponse } from "./errors";
import { uuidv7 } from "./ids/uuidv7";
import { bootstrapHandler } from "./routes/bootstrap";
import { wsUpgradeHandler } from "./routes/ws";
import { listChannelsHandler, channelDetailHandler } from "./routes/channels";
import { listMessagesHandler } from "./routes/messages";
import { eventsHandler } from "./routes/events";
import { presignUploadHandler, finalizeUploadHandler } from "./routes/uploads";
import {
  createInviteHandler,
  previewInviteHandler,
  acceptInviteHandler,
  addMemberHandler,
  createChannelHandler,
  dissolveChannelHandler,
  getMemberHandler,
  listMembersHandler,
  ownerTransferHandler,
  removeMemberHandler,
  updateChannelHandler,
  updateMemberRoleHandler,
  listStickersHandler,
  saveStickerHandler,
  deleteStickerHandler,
} from "./routes/channel-mutations";

const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

app.use(
  "/api/chat/*",
  cors({
    origin: ["https://lilium.kuma.homes", "http://localhost:5173"],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    exposeHeaders: ["X-Request-Id"],
    credentials: false,
    maxAge: 86400,
  }),
);

// request_id middleware: assign req_<uuidv7> if absent, attach to context, set response header
app.use("/api/chat/*", async (c, next) => {
  const requestId = c.req.header("X-Request-Id") ?? `req_${uuidv7()}`;
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  await next();
});

// Error handler: ApiError → contract envelope; unknown → CHAT_WORKER_UNAVAILABLE
app.onError((err, c) => {
  const requestId = (c.get("requestId") as string | undefined) ?? `req_${uuidv7()}`;
  if (err instanceof ApiError) {
    return errorResponse(err, requestId);
  }
  console.error("unhandled error", { requestId, error: String(err) });
  return errorResponse(new ApiError("CHAT_WORKER_UNAVAILABLE", "worker temporarily unavailable"), requestId);
});

app.get("/api/chat/bootstrap", (c) => bootstrapHandler(c));
app.get("/api/chat/ws", (c) => wsUpgradeHandler(c));
app.get("/api/chat/channels", (c) => listChannelsHandler(c));
app.post("/api/chat/channels", (c) => createChannelHandler(c));
app.patch("/api/chat/channels/:channel_id", (c) => updateChannelHandler(c));
app.post("/api/chat/channels/:channel_id/dissolve", (c) => dissolveChannelHandler(c));
app.post("/api/chat/channels/:channel_id/owner-transfer", (c) => ownerTransferHandler(c));
app.post("/api/chat/channels/:channel_id/invites", (c) => createInviteHandler(c));
app.post("/api/chat/channels/:channel_id/members", (c) => addMemberHandler(c));
app.get("/api/chat/invites/:invite_code", (c) => previewInviteHandler(c));
app.post("/api/chat/invites/:invite_code/accept", (c) => acceptInviteHandler(c));
app.get("/api/chat/channels/:channel_id/members", (c) => listMembersHandler(c));
app.get("/api/chat/channels/:channel_id/members/:user_id", (c) => getMemberHandler(c));
app.patch("/api/chat/channels/:channel_id/members/:user_id", (c) => updateMemberRoleHandler(c));
app.delete("/api/chat/channels/:channel_id/members/:user_id", (c) => removeMemberHandler(c));
app.get("/api/chat/channels/:channel_id/messages", (c) => listMessagesHandler(c));
app.get("/api/chat/channels/:channel_id", (c) => channelDetailHandler(c));
app.post("/api/chat/uploads/images/presign", (c) => presignUploadHandler(c));
app.post("/api/chat/uploads/images/:attachment_id/finalize", (c) => finalizeUploadHandler(c));
app.get("/api/chat/stickers", (c) => listStickersHandler(c));
app.post("/api/chat/stickers", (c) => saveStickerHandler(c));
app.delete("/api/chat/stickers/:sticker_id", (c) => deleteStickerHandler(c));
app.get("/api/chat/events", (c) => eventsHandler(c));
app.all("/api/chat/*", (c) => {
  throw new ApiError("CHANNEL_NOT_FOUND", "not implemented in phase 0", { httpStatus: 404 });
});

export default app;
export { ChatChannel } from "./do/chat-channel";
export { UserDirectory } from "./do/user-directory";
export { UserConnection } from "./do/user-connection";
export { ChannelDirectory } from "./do/channel-directory";
export { InviteDirectory } from "./do/invite-directory";
export { BotRegistry } from "./do/bot-registry";
export { ChannelFanout } from "./do/channel-fanout";
export { SchedulerProbe } from "./do/scheduler-probe";
