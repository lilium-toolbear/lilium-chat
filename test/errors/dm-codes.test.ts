import { describe, expect, it } from "vitest";
import { ApiError, HTTP_STATUS_BY_CODE } from "../../src/errors";

describe("DM error codes", () => {
  it("maps INVALID_DM_TARGET to 422", () => {
    expect(HTTP_STATUS_BY_CODE.INVALID_DM_TARGET).toBe(422);
  });

  it("maps DM_TARGET_NOT_FOUND to 404", () => {
    expect(HTTP_STATUS_BY_CODE.DM_TARGET_NOT_FOUND).toBe(404);
  });

  it("maps UNSUPPORTED_CHANNEL_KIND to 409", () => {
    expect(HTTP_STATUS_BY_CODE.UNSUPPORTED_CHANNEL_KIND).toBe(409);
  });

  it("UNSUPPORTED_CHANNEL_KIND is not retryable by default", () => {
    const err = new ApiError("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels");
    expect(err.retryable).toBe(false);
  });
});
