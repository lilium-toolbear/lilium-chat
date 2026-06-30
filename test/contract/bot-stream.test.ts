import { describe, expect, it } from "vitest";
import {
  buildBotStreamAppend,
  buildBotStreamAppendAck,
  buildBotStreamError,
  buildBotStreamFinalize,
  buildBotStreamFinalizedAck,
  buildBotStreamHello,
  buildBotStreamPing,
  buildBotStreamPong,
  buildBotStreamReady,
  parseBotStreamAppend,
  parseBotStreamAppendAck,
  parseBotStreamError,
  parseBotStreamFinalize,
  parseBotStreamFinalizedAck,
  parseBotStreamHello,
  parseBotStreamPing,
  parseBotStreamPong,
  parseBotStreamReady,
} from "../../src/chat/bot-stream-protocol";
import {
  BOT_STREAM_API_VERSION,
  BROWSER_STREAM_EVENT_API_VERSION,
  LIVE_STREAM_EVENT_TYPES,
} from "../../src/contract/bot-stream";
import { buildWireStreamEventFrame } from "../../src/contract/wire-frames";

describe("bot stream contract", () => {
  it("uses stable api_version strings", () => {
    expect(BOT_STREAM_API_VERSION).toBe("lilium.chat.bot.stream.v1");
    expect(BROWSER_STREAM_EVENT_API_VERSION).toBe("lilium.chat.stream.v1");
  });

  it("lists live-only stream event types", () => {
    expect(LIVE_STREAM_EVENT_TYPES).toEqual([
      "message.stream_started",
      "message.stream_delta",
      "message.stream_abandon_cleanup",
    ]);
  });

  it("builds browser stream_event frames", () => {
    const frame = buildWireStreamEventFrame({
      type: "message.stream_delta",
      channel_id: "ch-1",
      payload: { message_id: "msg-1", delta: "hello" },
      stream_seq: 3,
      occurred_at: "2026-06-30T12:00:00Z",
    });
    expect(frame.frame_type).toBe("stream_event");
    expect(frame.api_version).toBe("lilium.chat.stream.v1");
    expect(frame.type).toBe("message.stream_delta");
    expect(frame.stream_seq).toBe(3);
  });
});

describe("bot stream WS frame round-trip", () => {
  const cases = [
    { name: "hello", build: () => buildBotStreamHello(), parse: parseBotStreamHello },
    {
      name: "ready",
      build: () =>
        buildBotStreamReady({
          channel_id: "ch-1",
          message_id: "msg-1",
          expires_at: "2026-06-30T12:00:00Z",
          ack_seq: 0,
        }),
      parse: parseBotStreamReady,
    },
    {
      name: "append",
      build: () => buildBotStreamAppend({ seq: 1, delta: "hello" }),
      parse: parseBotStreamAppend,
    },
    {
      name: "append_ack",
      build: () => buildBotStreamAppendAck({ ack_seq: 1 }),
      parse: parseBotStreamAppendAck,
    },
    {
      name: "finalize",
      build: () => buildBotStreamFinalize({ final_seq: 2, components: [] }),
      parse: parseBotStreamFinalize,
    },
    {
      name: "finalized_ack",
      build: () => buildBotStreamFinalizedAck({ message_id: "msg-1", event_id: "evt-1" }),
      parse: parseBotStreamFinalizedAck,
    },
    {
      name: "stream_error",
      build: () =>
        buildBotStreamError({
          code: "BOT_STREAM_SEQUENCE_GAP",
          message: "gap",
          retryable: true,
        }),
      parse: parseBotStreamError,
    },
    { name: "ping", build: () => buildBotStreamPing(), parse: parseBotStreamPing },
    { name: "pong", build: () => buildBotStreamPong(), parse: parseBotStreamPong },
  ] as const;

  it.each(cases)("$name frame parse/serialize round-trip", ({ build, parse }) => {
    const frame = build();
    expect(parse(JSON.stringify(frame))).toEqual(frame);
  });
});
