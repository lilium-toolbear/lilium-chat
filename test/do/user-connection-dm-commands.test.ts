import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createTestDmChannel } from "../helpers";
import { nextMessage, upgradeUserConnection } from "../ws-helpers";

const USER_A = "00000000-0000-7000-8000-000000000901";
const USER_B = "00000000-0000-7000-8000-000000000902";

describe("UserConnection DM command gates", () => {
  it("rejects command.invoke on dm channel", async () => {
    const { channelId } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const { ws } = await upgradeUserConnection(USER_A);
    ws.send(JSON.stringify({
      frame_type: "command",
      command: "command.invoke",
      command_id: "cmd-dm-invoke",
      channel_id: channelId,
      payload: { bot_command_id: "x" },
    }));
    const frame = JSON.parse(await nextMessage(ws)) as { frame_type: string; error?: { code: string } };
    expect(frame.frame_type).toBe("command_error");
    expect(frame.error?.code).toBe("UNSUPPORTED_CHANNEL_KIND");
    ws.close();
  });

  it("rejects interaction.submit on dm channel", async () => {
    const { channelId } = await createTestDmChannel(env, USER_A, USER_B, USER_A);
    const { ws } = await upgradeUserConnection(USER_A);
    ws.send(JSON.stringify({
      frame_type: "command",
      command: "interaction.submit",
      command_id: "cmd-dm-interact",
      channel_id: channelId,
      payload: {},
    }));
    const frame = JSON.parse(await nextMessage(ws)) as { frame_type: string; error?: { code: string } };
    expect(frame.frame_type).toBe("command_error");
    expect(frame.error?.code).toBe("UNSUPPORTED_CHANNEL_KIND");
    ws.close();
  });
});
