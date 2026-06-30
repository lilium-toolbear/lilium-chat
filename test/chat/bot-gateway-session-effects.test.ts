import { describe, expect, it } from "vitest";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import {
  buildSessionEffectsAck,
  parseSessionEffects,
} from "../../src/chat/bot-gateway-session";

describe("session.effects frame parsing", () => {
  it("parses a valid session.effects frame", () => {
    const parsed = parseSessionEffects(JSON.stringify({
      type: "session.effects",
      api_version: BOT_GATEWAY_API_VERSION,
      session_id: "sess-1",
      effect_seq: 3,
      effects: [{ type: "send_message", client_effect_id: "eff-1", message: { text: "hi" } }],
    }));
    expect(parsed.session_id).toBe("sess-1");
    expect(parsed.effect_seq).toBe(3);
    expect(parsed.effects).toHaveLength(1);
  });

  it("rejects session.effects with wrong api_version", () => {
    expect(() =>
      parseSessionEffects(JSON.stringify({
        type: "session.effects",
        api_version: "lilium.chat.bot.v0",
        session_id: "sess-1",
        effect_seq: 1,
        effects: [],
      })),
    ).toThrow("not session.effects");
  });

  it("builds session.effects_ack with applied status and effect_results", () => {
    const ack = buildSessionEffectsAck("sess-1", 2, "applied", {
      effect_results: [
        {
          client_effect_id: "eff-1",
          type: "send_message",
          status: "applied",
          message_id: "msg-1",
          event_id: "evt-1",
        },
      ],
    });
    expect(ack).toMatchObject({
      type: "session.effects_ack",
      api_version: BOT_GATEWAY_API_VERSION,
      session_id: "sess-1",
      effect_seq: 2,
      status: "applied",
    });
    expect(ack.effect_results).toHaveLength(1);
  });

  it("builds session.effects_ack with rejected status and error", () => {
    const ack = buildSessionEffectsAck("sess-1", 4, "rejected", {
      error: { code: "BOT_EFFECT_INVALID", message: "effect sequence gap" },
    });
    expect(ack.status).toBe("rejected");
    expect(ack.error?.code).toBe("BOT_EFFECT_INVALID");
  });
});
