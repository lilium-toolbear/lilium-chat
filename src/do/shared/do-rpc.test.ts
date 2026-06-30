import { describe, expect, it } from "vitest";
import { ApiError } from "../../errors";
import { parseMessageMutationAckFromCached, parseRpcCachedJson, throwApiErrorFromJsonBody } from "./do-rpc";

describe("do-rpc", () => {
  it("parseRpcCachedJson throws ApiError for error envelopes", () => {
    expect(() => parseRpcCachedJson(JSON.stringify({ error: { code: "FORBIDDEN", message: "nope" } })))
      .toThrow(ApiError);
    try {
      parseRpcCachedJson(JSON.stringify({ error: { code: "FORBIDDEN", message: "nope" } }));
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("FORBIDDEN");
    }
  });

  it("parseRpcCachedJson returns payload for success envelopes", () => {
    const out = parseRpcCachedJson<{ ok: true }>(JSON.stringify({ ok: true }));
    expect(out.ok).toBe(true);
  });

  it("parseMessageMutationAckFromCached decodes cached mutation ack", () => {
    const ack = parseMessageMutationAckFromCached(JSON.stringify({
      payload: {
        channel_id: "ch-1",
        event_id: "ev-1",
        message: { message_id: "m-1" },
      },
    }));
    expect(ack.channel_id).toBe("ch-1");
    expect(ack.event_id).toBe("ev-1");
  });

  it("throwApiErrorFromJsonBody preserves extra error fields", () => {
    try {
      throwApiErrorFromJsonBody({ error: { code: "ACTIVE_SESSION", message: "busy", active_session: "s-1" } });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError & { active_session?: string }).active_session).toBe("s-1");
    }
  });
});
