import { describe, it, expect } from "vitest";
import { ApiError } from "../src/errors";

describe("ApiError HTTP status mapping (Phase 3 codes)", () => {
  it("MEMBER_NOT_FOUND → 404", () => {
    expect(new ApiError("MEMBER_NOT_FOUND", "x").httpStatus).toBe(404);
    expect(new ApiError("MEMBER_NOT_FOUND", "x").retryable).toBe(false);
  });
  it("CHANNEL_DISSOLVED → 409", () => {
    expect(new ApiError("CHANNEL_DISSOLVED", "x").httpStatus).toBe(409);
    expect(new ApiError("CHANNEL_DISSOLVED", "x").retryable).toBe(false);
  });
  it("INVITE_NOT_FOUND → 404 (forward-compat for Phase 6)", () => {
    expect(new ApiError("INVITE_NOT_FOUND", "x").httpStatus).toBe(404);
  });
});
