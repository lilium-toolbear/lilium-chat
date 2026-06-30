import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo, readDoSchemaVersion } from "../../test/helpers";
import type { BotConnection } from "../../src/do/bot-connection";
import type { BotRegistry } from "../../src/do/bot-registry";
import type { BotStreamConnection } from "../../src/do/bot-stream-connection";
import type { ChannelDirectory } from "../../src/do/channel-directory";
import type { ChannelFanout } from "../../src/do/channel-fanout";
import type { ChatChannel } from "../../src/do/chat-channel";
import type { DMDirectory } from "../../src/do/dm-directory";
import type { InviteDirectory } from "../../src/do/invite-directory";
import type { UserConnection } from "../../src/do/user-connection";
import type { UserDirectory } from "../../src/do/user-directory";
import { botStreamDoName } from "../../src/do/bot-stream-connection";

const SMOKE_ID = "do-smoke-init";

describe("DO module smoke", () => {
  it("each binding initializes sqlite schema", async () => {
    const checks: Array<Promise<{ current_version: number }>> = [
      readDoSchemaVersion(getNamedDo(env.CHAT_CHANNEL, SMOKE_ID) as DurableObjectStub),
      readDoSchemaVersion(getNamedDo<UserDirectory>(env.USER_DIRECTORY, SMOKE_ID)),
      readDoSchemaVersion(getNamedDo<UserConnection>(env.USER_CONNECTION, SMOKE_ID)),
      readDoSchemaVersion(getNamedDo<ChannelDirectory>(env.CHANNEL_DIRECTORY, SMOKE_ID)),
      readDoSchemaVersion(getNamedDo<InviteDirectory>(env.INVITE_DIRECTORY, SMOKE_ID)),
      readDoSchemaVersion(getNamedDo<BotRegistry>(env.BOT_REGISTRY, SMOKE_ID)),
      readDoSchemaVersion(getNamedDo<ChannelFanout>(env.CHANNEL_FANOUT, SMOKE_ID)),
      readDoSchemaVersion(getNamedDo<BotConnection>(env.BOT_CONNECTION, SMOKE_ID)),
      readDoSchemaVersion(getNamedDo<BotStreamConnection>(env.BOT_STREAM_CONNECTION, botStreamDoName("smoke", "bot"))),
      readDoSchemaVersion(getNamedDo<DMDirectory>(env.DM_DIRECTORY, SMOKE_ID)),
    ];
    const versions = await Promise.all(checks);
    for (const v of versions) {
      expect(v.current_version).toBeGreaterThan(0);
    }
  });

  it("test-gated debug RPC is available in test worker", async () => {
    const stub = getNamedDo<ChatChannel>(env.CHAT_CHANNEL, `${SMOKE_ID}-debug`);
    const pending = await stub.debugOutboxPending();
    expect(pending.count).toBeGreaterThanOrEqual(0);
  });
});
