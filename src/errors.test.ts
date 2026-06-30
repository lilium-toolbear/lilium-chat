import { describe, it, expect } from "vitest";
import { ApiError, apiErrorFromRemote, errorResponse, HTTP_STATUS_BY_CODE } from "./errors";

describe("ApiError", () => {
  it("maps code to http status via HTTP_STATUS_BY_CODE", () => {
    expect(HTTP_STATUS_BY_CODE["SESSION_NOT_ALLOWED"]).toBe(403);
    expect(HTTP_STATUS_BY_CODE["ROUTE_INDEX_PENDING"]).toBe(409);
    expect(HTTP_STATUS_BY_CODE["RATE_LIMITED"]).toBe(429);
    expect(HTTP_STATUS_BY_CODE["CHAT_WORKER_UNAVAILABLE"]).toBe(503);
  });

  it("defaults retryable to false", () => {
    const e = new ApiError("FORBIDDEN", "no");
    expect(e.retryable).toBe(false);
    expect(e.httpStatus).toBe(403);
  });

  it("errorResponse builds the contract envelope and headers", async () => {
    const e = new ApiError("SESSION_NOT_ALLOWED", "Chat requires a direct user session");
    const res = errorResponse(e, "req_abc");
    expect(res.status).toBe(403);
    expect(res.headers.get("X-Request-Id")).toBe("req_abc");
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "SESSION_NOT_ALLOWED", message: "Chat requires a direct user session", retryable: false },
      request_id: "req_abc",
    });
  });

  it("CHAT_WORKER_UNAVAILABLE is retryable=true", () => {
    const e = new ApiError("CHAT_WORKER_UNAVAILABLE", "down");
    expect(e.retryable).toBe(true);
  });

  it("maps only remote user-code RPC errors back to ApiError", () => {
    const err = apiErrorFromRemote({
      remote: true,
      code: "INVALID_COMMAND_OPTIONS",
      message: "option.type invalid",
      retryable: false,
    });
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.code).toBe("INVALID_COMMAND_OPTIONS");
    expect(err?.httpStatus).toBe(422);

    expect(apiErrorFromRemote({ remote: false, retryable: true, message: "transport" })).toBeNull();
    expect(apiErrorFromRemote({ remote: true, message: "missing code" })).toBeNull();

    const withExtras = apiErrorFromRemote({
      remote: true,
      code: "STATEFUL_SESSION_BUSY",
      message: "busy",
      active_session: { session_id: "s1" },
      conflict: { bot_id: "b1" },
    });
    expect(withExtras).toMatchObject({
      code: "STATEFUL_SESSION_BUSY",
      active_session: { session_id: "s1" },
      conflict: { bot_id: "b1" },
    });
  });
});
