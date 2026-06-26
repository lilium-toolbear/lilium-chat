import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { makeJwt, TEST_SECRET } from "../../test/helpers";
import { wsUpgradeHandler } from "./ws";
import type { Env } from "../env";

const ALLOWED_ORIGIN = "https://lilium.kuma.homes";

function upgradeReq(opts: { subprotocol?: string; origin?: string; cursors?: string }): Request {
  const qs = opts.cursors ? `?cursors=${opts.cursors}` : "";
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    Origin: opts.origin ?? ALLOWED_ORIGIN,
  };
  if (opts.subprotocol !== undefined) headers["Sec-WebSocket-Protocol"] = opts.subprotocol;
  return new Request(`https://chat.kuma.homes/api/chat/ws${qs}`, { headers });
}

describe("wsUpgradeHandler", () => {
  it("rejects missing subprotocol with 400", async () => {
    const res = await wsUpgradeHandler({
      req: {
        header: (h: string) =>
          h === "Upgrade"
            ? "websocket"
            : h === "Sec-WebSocket-Protocol"
              ? null
              : h === "Origin"
                ? ALLOWED_ORIGIN
                : null,
        raw: upgradeReq({}),
      },
      env: ({ ...env, JWT_SECRET: TEST_SECRET } as Env),
      get: () => undefined,
      set: () => {},
    } as any);
    expect(res.status).toBe(400);
  });

  it("rejects subprotocol without bearer.<jwt> with 401", async () => {
    const res = await wsUpgradeHandler({
      req: {
        header: (h: string) =>
          h === "Sec-WebSocket-Protocol"
            ? "lilium.chat.v2"
            : h === "Origin"
              ? ALLOWED_ORIGIN
              : null,
        raw: upgradeReq({ subprotocol: "lilium.chat.v2" }),
      },
      env: ({ ...env, JWT_SECRET: TEST_SECRET } as Env),
      get: () => undefined,
      set: () => {},
    } as any);
    expect(res.status).toBe(401);
  });

  it("accepts 127.0.0.1 dev origin for upgrade", async () => {
    const uid = "00000000-0000-7000-8000-000000000202";
    const token = await makeJwt({ sub: uid });
    const req = upgradeReq({
      subprotocol: `lilium.chat.v2, bearer.${token}`,
      origin: "http://127.0.0.1:5174",
    });
    const res = await wsUpgradeHandler({
      req: {
        header: (h: string) => req.headers.get(h),
        raw: req,
      },
      env: ({ ...env, JWT_SECRET: TEST_SECRET } as Env),
      get: () => undefined,
      set: () => { },
    } as any);
    expect(res.status).toBe(101);
  });

  it("accepts toolbear FastAPI dev origin for upgrade", async () => {
    const uid = "00000000-0000-7000-8000-000000000203";
    const token = await makeJwt({ sub: uid });
    const req = upgradeReq({
      subprotocol: `lilium.chat.v2, bearer.${token}`,
      origin: "http://127.0.0.1:3334",
    });
    const res = await wsUpgradeHandler({
      req: {
        header: (h: string) => req.headers.get(h),
        raw: req,
      },
      env: ({ ...env, JWT_SECRET: TEST_SECRET } as Env),
      get: () => undefined,
      set: () => { },
    } as any);
    expect(res.status).toBe(101);
  });

  it("rejects bad origin with 403", async () => {
    const token = await makeJwt({ sub: "u1" });
    const res = await wsUpgradeHandler({
      req: {
        header: (h: string) =>
          h === "Upgrade"
            ? "websocket"
            : h === "Sec-WebSocket-Protocol"
              ? `lilium.chat.v2, bearer.${token}`
              : h === "Origin"
                ? "https://evil.example"
                : null,
        raw: upgradeReq({ subprotocol: `lilium.chat.v2, bearer.${token}`, origin: "https://evil.example" }),
      },
      env: ({ ...env, JWT_SECRET: TEST_SECRET } as Env),
      get: () => undefined,
      set: () => {},
    } as any);
    expect(res.status).toBe(403);
  });

  it("rejects machine token with 401 MACHINE_TOKEN_NOT_ALLOWED", async () => {
    const token = await makeJwt({ sub: "u1", client_id: "c1" });
    const res = await wsUpgradeHandler({
      req: {
        header: (h: string) =>
          h === "Upgrade"
            ? "websocket"
            : h === "Sec-WebSocket-Protocol"
              ? `lilium.chat.v2, bearer.${token}`
              : h === "Origin"
                ? ALLOWED_ORIGIN
                : null,
        raw: upgradeReq({ subprotocol: `lilium.chat.v2, bearer.${token}` }),
      },
      env: ({ ...env, JWT_SECRET: TEST_SECRET } as Env),
      get: () => undefined,
      set: () => {},
    } as any);
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe("MACHINE_TOKEN_NOT_ALLOWED");
  });

  it("proxies upgrade to UserConnection DO for a valid self-session (101)", async () => {
    const uid = "00000000-0000-7000-8000-000000000201";
    const token = await makeJwt({ sub: uid });
    const req = upgradeReq({ subprotocol: `lilium.chat.v2, bearer.${token}` });
    const res = await wsUpgradeHandler({
      req: {
        header: (h: string) => req.headers.get(h),
        raw: req,
      },
      env: ({ ...env, JWT_SECRET: TEST_SECRET } as Env),
      get: () => undefined,
      set: () => {},
    } as any);
    expect(res.status).toBe(101);
    expect(res.headers.get("X-Verified-User-Id") ?? res.headers.get("x-verified-user-id")).toBeNull();
  });
});
