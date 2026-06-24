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
import { addMemberHandler, createChannelHandler, dissolveChannelHandler, getMemberHandler, listMembersHandler, removeMemberHandler, updateChannelHandler, updateMemberRoleHandler } from "./routes/channel-mutations";

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
app.post("/api/chat/channels/:channel_id/members", (c) => addMemberHandler(c));
app.get("/api/chat/channels/:channel_id/members", (c) => listMembersHandler(c));
app.get("/api/chat/channels/:channel_id/members/:user_id", (c) => getMemberHandler(c));
app.patch("/api/chat/channels/:channel_id/members/:user_id", (c) => updateMemberRoleHandler(c));
app.delete("/api/chat/channels/:channel_id/members/:user_id", (c) => removeMemberHandler(c));
app.get("/api/chat/channels/:channel_id/messages", (c) => listMessagesHandler(c));
app.get("/api/chat/channels/:channel_id", (c) => channelDetailHandler(c));
app.get("/api/chat/events", (c) => eventsHandler(c));
app.all("/api/chat/*", (c) => {
  throw new ApiError("CHANNEL_NOT_FOUND", "not implemented in phase 0", { httpStatus: 404 });
});

export default app;
export { ChatChannel } from "./do/chat-channel";
export { UserDirectory } from "./do/user-directory";
export { UserConnection } from "./do/user-connection";
export { ChannelDirectory } from "./do/channel-directory";
export { MessageIndex } from "./do/message-index";
export { InviteDirectory } from "./do/invite-directory";
export { BotRegistry } from "./do/bot-registry";
export { ChannelFanout } from "./do/channel-fanout";
export { SchedulerProbe } from "./do/scheduler-probe";
