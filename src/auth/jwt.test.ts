import { describe, it, expect } from "vitest";
import { verifyBrowserJwt } from "./jwt";
import { ApiError } from "../errors";
import { makeJwt, TEST_SECRET } from "../../test/helpers";

describe("verifyBrowserJwt", () => {
  it("accepts a self-session browser token", async () => {
    const uid = "00000000-0000-7000-8000-000000000101";
    const token = await makeJwt({ sub: uid });
    const id = await verifyBrowserJwt(token, TEST_SECRET);
    expect(id).toEqual({ user_id: uid });
  });

  it("accepts self-session with explicit owner_user_id == sub and effective == sub", async () => {
    const uid = "00000000-0000-7000-8000-000000000102";
    const token = await makeJwt({ sub: uid, owner_user_id: uid, effective_account_user_id: uid });
    const id = await verifyBrowserJwt(token, TEST_SECRET);
    expect(id.user_id).toBe(uid);
  });

  it("rejects machine token (client_id present) with MACHINE_TOKEN_NOT_ALLOWED", async () => {
    const token = await makeJwt({ sub: "u1", client_id: "client-1" });
    await expect(verifyBrowserJwt(token, TEST_SECRET)).rejects.toMatchObject({
      code: "MACHINE_TOKEN_NOT_ALLOWED",
      httpStatus: 401,
    });
  });

  it("rejects managed_session=true with SESSION_NOT_ALLOWED", async () => {
    const token = await makeJwt({ sub: "u1", managed_session: true });
    await expect(verifyBrowserJwt(token, TEST_SECRET)).rejects.toMatchObject({
      code: "SESSION_NOT_ALLOWED",
      httpStatus: 403,
    });
  });

  it("rejects delegated session where owner != sub, effective == sub with SESSION_NOT_ALLOWED", async () => {
    const token = await makeJwt({ sub: "u1", owner_user_id: "u-owner", effective_account_user_id: "u1" });
    await expect(verifyBrowserJwt(token, TEST_SECRET)).rejects.toMatchObject({
      code: "SESSION_NOT_ALLOWED",
      httpStatus: 403,
    });
  });

  it("rejects delegated session where owner != sub, effective != sub with SESSION_NOT_ALLOWED", async () => {
    const token = await makeJwt({ sub: "u1", owner_user_id: "u-owner", effective_account_user_id: "u-other" });
    await expect(verifyBrowserJwt(token, TEST_SECRET)).rejects.toMatchObject({
      code: "SESSION_NOT_ALLOWED",
      httpStatus: 403,
    });
  });

  it("rejects delegated session where only effective != sub with SESSION_NOT_ALLOWED", async () => {
    const token = await makeJwt({ sub: "u1", effective_account_user_id: "u-other" });
    await expect(verifyBrowserJwt(token, TEST_SECRET)).rejects.toMatchObject({
      code: "SESSION_NOT_ALLOWED",
      httpStatus: 403,
    });
  });

  it("rejects where only owner != sub with SESSION_NOT_ALLOWED", async () => {
    const token = await makeJwt({ sub: "u1", owner_user_id: "u-owner" });
    await expect(verifyBrowserJwt(token, TEST_SECRET)).rejects.toMatchObject({
      code: "SESSION_NOT_ALLOWED",
      httpStatus: 403,
    });
  });

  it("rejects expired token with UNAUTHORIZED", async () => {
    const token = await makeJwt({ sub: "u1", exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(verifyBrowserJwt(token, TEST_SECRET)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      httpStatus: 401,
    });
  });

  it("rejects bad signature with UNAUTHORIZED", async () => {
    const token = await makeJwt({ sub: "u1" }, "wrong-secret");
    await expect(verifyBrowserJwt(token, TEST_SECRET)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      httpStatus: 401,
    });
  });

  it("rejects missing sub with UNAUTHORIZED", async () => {
    // Build a token without sub by signing an empty-ish payload then overriding.
    // Easiest: sign with sub then verify a token where we strip it is hard with jose;
    // instead test the function's guard by passing a token whose payload we control
    // via a minimal manual sign.
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(TEST_SECRET));
    await expect(verifyBrowserJwt(token, TEST_SECRET)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      httpStatus: 401,
    });
  });
});
