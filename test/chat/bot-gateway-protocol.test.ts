import { describe, expect, it } from "vitest";
import {
  BOT_GATEWAY_API_VERSION,
  buildDeliveryAck,
  MainGatewayEffectValidationError,
  parseDeliveryResult,
  parseHello,
  validateMainGatewayEffects,
} from "../../src/chat/bot-gateway-protocol";
import { ApiError } from "../../src/errors";

describe("bot gateway frame parsing", () => {
  it("rejects hello frames with a wrong api_version", () => {
    expect(() =>
      parseHello(JSON.stringify({
        type: "hello",
        api_version: "lilium.chat.bot.v0",
        last_received_delivery_id: null,
      })),
    ).toThrow("not a hello frame");
  });

  it("rejects delivery_result frames with a wrong api_version", () => {
    expect(() =>
      parseDeliveryResult(JSON.stringify({
        type: "delivery_result",
        api_version: "lilium.chat.bot.v0",
        delivery_id: "delivery-1",
        status: "ok",
        effects: [],
      })),
    ).toThrow("not a delivery_result frame");
  });

  it("accepts frames with the current api_version", () => {
    expect(parseHello(JSON.stringify({
      type: "hello",
      api_version: BOT_GATEWAY_API_VERSION,
      last_received_delivery_id: null,
    })).api_version).toBe(BOT_GATEWAY_API_VERSION);
    expect(parseDeliveryResult(JSON.stringify({
      type: "delivery_result",
      api_version: BOT_GATEWAY_API_VERSION,
      delivery_id: "delivery-1",
      status: "ok",
      effects: [],
    })).api_version).toBe(BOT_GATEWAY_API_VERSION);
  });
});

describe("validateMainGatewayEffects", () => {
  it("rejects append_stream on main gateway", () => {
    expect(() =>
      validateMainGatewayEffects([
        { type: "append_stream", client_effect_id: "eff-1", seq: 1, delta: "hi" },
      ]),
    ).toThrow(MainGatewayEffectValidationError);
    try {
      validateMainGatewayEffects([
        { type: "append_stream", client_effect_id: "eff-1", seq: 1, delta: "hi" },
      ]);
    } catch (err) {
      expect(err).toBeInstanceOf(MainGatewayEffectValidationError);
      expect((err as MainGatewayEffectValidationError).code).toBe("BOT_EFFECT_INVALID");
    }
  });

  it("rejects finalize_stream on main gateway", () => {
    expect(() =>
      validateMainGatewayEffects([{ type: "finalize_stream", client_effect_id: "eff-2", final_seq: 1 }]),
    ).toThrow(MainGatewayEffectValidationError);
  });

  it("accepts allowed main gateway effect types", () => {
    const effects = validateMainGatewayEffects([
      { type: "send_message", client_effect_id: "eff-3", message: { text: "hi" } },
      { type: "start_stream", client_effect_id: "eff-4", message: { format: "plain" } },
    ]);
    expect(effects).toHaveLength(2);
    expect(effects[0]?.type).toBe("send_message");
    expect(effects[1]?.type).toBe("start_stream");
  });
});

describe("buildDeliveryAck effect_results", () => {
  it("includes start_stream effect_results on applied ack", () => {
    const ack = buildDeliveryAck("delivery-1", "applied", {
      effect_results: [
        {
          client_effect_id: "eff-1",
          type: "start_stream",
          status: "applied",
          message_id: "msg-1",
          stream: {
            channel_id: "ch-1",
            message_id: "msg-1",
            ws_url: "/api/chat/bot/channels/ch-1/streams/msg-1/ws",
            expires_at: "2026-06-30T12:00:00Z",
          },
        },
      ],
    });
    expect(ack.effect_results).toHaveLength(1);
    expect(ack.effect_results?.[0]?.type).toBe("start_stream");
  });
});

describe("streaming and rich UI error codes", () => {
  it("maps BOT_STREAM_* and interaction policy codes", () => {
    expect(new ApiError("BOT_STREAM_NOT_FOUND", "x").httpStatus).toBe(404);
    expect(new ApiError("BOT_STREAM_EXPIRED", "x").httpStatus).toBe(410);
    expect(new ApiError("BOT_STREAM_SEQUENCE_GAP", "x").httpStatus).toBe(409);
    expect(new ApiError("BOT_STREAM_CONFLICT", "x").httpStatus).toBe(409);
    expect(new ApiError("COMPONENT_ALREADY_USED", "x").httpStatus).toBe(409);
    expect(new ApiError("INTERACTION_ALREADY_SUBMITTED", "x").httpStatus).toBe(409);
    expect(new ApiError("INTERACTION_FORBIDDEN_TARGET", "x").httpStatus).toBe(403);
  });
});
