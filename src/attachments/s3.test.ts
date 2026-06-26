import { describe, it, expect } from "vitest";
import { presignPut, headObject, deleteObject, publicReadUrl } from "./s3";
import type { Env } from "../env";

function makeEnv(): Pick<Env, "S3_ENDPOINT" | "S3_BUCKET" | "S3_PUBLIC_BASE" | "S3_REGION" | "S3_ACCESS_KEY_ID" | "S3_SECRET_ACCESS_KEY"> {
  return {
    S3_ENDPOINT: "https://s3.kuma.homes",
    S3_BUCKET: "s3.kuma.homes",
    S3_PUBLIC_BASE: "https://s3.kuma.homes",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "AKIATEST",
    S3_SECRET_ACCESS_KEY: "secrettest",
  };
}

describe("publicReadUrl", () => {
  it("builds the long-lived public URL at s3.kuma.homes/chat/{id}", () => {
    const env = makeEnv() as Env;
    expect(publicReadUrl(env, "chat/attachments/abc-123.png")).toBe(
      "https://s3.kuma.homes/chat/attachments/abc-123.png",
    );
  });
});

describe("presignPut", () => {
  it("returns a presigned PUT URL with SigV4 query params and X-Amz-Expires", async () => {
    const env = makeEnv() as Env;
    const { url, method, headers } = await presignPut(env, "chat/attachments/abc-123.png", { mimeType: "image/png", sizeBytes: 12345, expiresSeconds: 300 });
    expect(method).toBe("PUT");
    const u = new URL(url);
    expect(u.host).toBe("s3.kuma.homes");
    expect(u.pathname).toBe("/chat/attachments/abc-123.png");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.has("X-Amz-Signature")).toBe(true);
    expect(u.searchParams.has("X-Amz-Credential")).toBe(true);
    expect(headers["Content-Type"]).toBe("image/png");
  });
});

describe("headObject / deleteObject", () => {
  it("headObject reports exists=false on 404, exists=true with length on 200", async () => {
    const env = makeEnv() as Env;
    // stub fetch: 404 for HEAD
    const originalFetch = globalThis.fetch;
    let calls = 0;
    (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (u.pathname.endsWith("/chat/missing")) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { "Content-Length": "12345", "Content-Type": "image/png" } });
    };
    try {
      const missing = await headObject(env, "chat/missing");
      expect(missing.exists).toBe(false);
      const present = await headObject(env, "chat/present");
      expect(present.exists).toBe(true);
      expect(present.contentLength).toBe(12345);
      expect(present.contentType).toBe("image/png");
      expect(calls).toBe(2);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it("deleteObject issues a DELETE", async () => {
    const env = makeEnv() as Env;
    const originalFetch = globalThis.fetch;
    let methodSeen = "";
    (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      methodSeen = init?.method ?? "GET";
      return new Response(null, { status: 204 });
    };
    try {
      await deleteObject(env, "chat/abc");
      expect(methodSeen).toBe("DELETE");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});
