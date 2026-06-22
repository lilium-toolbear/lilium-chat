import { describe, it, expect } from "vitest";
import { ApiError, errorResponse, HTTP_STATUS_BY_CODE } from "./errors";

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
});
