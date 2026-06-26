import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { headObject, presignPut, publicReadUrl } from "../../src/attachments/s3";
import type { Env } from "../../src/env";

const LIVE = !!(globalThis as { process?: { env?: { SPIKE_LIVE?: string } } }).process?.env?.SPIKE_LIVE;

describe.skipIf(!LIVE)("spike: SeaweedFS presign + HEAD", () => {
  it("presigns a PUT and HEADs a known object", async () => {
    const key = "chat/attachments/spike-probe.txt";
    const { url } = await presignPut(env as unknown as Env, key, { mimeType: "text/plain", sizeBytes: 5, expiresSeconds: 60 });

    const putRes = await fetch(url, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "hello" });
    expect(putRes.ok).toBe(true);

    const head = await headObject(env as unknown as Env, key);
    expect(head.exists).toBe(true);
    expect(head.contentType).toBe("text/plain");

    const pubRes = await fetch(publicReadUrl(env as unknown as Env, key));
    expect(pubRes.status).toBe(200);
  });
});
