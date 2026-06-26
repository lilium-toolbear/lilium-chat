import { describe, expect, it } from "vitest";
import {
  BOT_GATEWAY_API_VERSION,
  parseDeliveryResult,
  parseHello,
} from "../../src/chat/bot-gateway-protocol";

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
