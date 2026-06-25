# Lilium Chat Phase 5 + E Implementation Plan (attachments + personal stickers + sticker messages)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the image-upload pipeline (presign → browser PUT → finalize), `message.send type=image`, the personal sticker library (list / save / delete), and `message.send type=sticker`, all on the v4.0 base (channel-scoped messages, `operation_id` idempotency, payload-bearing acks via `projectMessageForBrowser`), using SeaweedFS (S3-compatible) via `aws4fetch` for binary storage.

**Architecture:** Section A (attachments): `POST /api/chat/uploads/images/presign` → Worker mints `attachment_id`, inserts `attachments` row (status=`pending`) in ChatChannel DO, returns a presigned S3 PUT URL. Browser PUTs the binary to S3. `POST /api/chat/uploads/images/{id}/finalize` → Worker HEADs S3 to verify, updates `attachments.status=finalized`, returns canonical projection. `message.send type=image` resolves finalized attachments + projects them. Section B (stickers): `personal_stickers` table in UserDirectory DO (sticker_id PK, unique per user+attachment); `GET/POST/DELETE /api/chat/stickers`; `resolveVisibleAttachment` (ChatChannel internal — visibility check + canonical projection for save-from-message); `message.send type=sticker` calls UserDirectory `resolveSticker` → canonical projection; `message_stickers` table snapshots url/mime/dims for historical stability; `projectMessageForBrowser` carries `attachments` + `sticker`.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), Hono, vitest-pool-workers, jose, `aws4fetch` (1.0.20) for S3 SigV4 presign. SeaweedFS at `s3.kuma.homes` (S3-compatible, public-read after finalize). Both wrangler configs already have `S3_ENDPOINT`/`S3_BUCKET`/`S3_PUBLIC_BASE`/`S3_REGION` vars + `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` secrets.

## Global Constraints

(Phase 0–4 + v4.0 constraints carry forward. Load-bearing for this plan:)

- **S3 integration is via `aws4fetch` SigV4.** The Worker never receives binary — presign returns a PUT URL; finalize HEADs S3 to verify. `aws4fetch` `AwsClient.presign(method, url, { expiresIn, headers })` generates the signed URL. `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` are Worker secrets; `S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/`S3_PUBLIC_BASE` are vars.
- **The S3 client must be mockable in tests.** Tests that exercise presign/finalize do NOT hit live S3 — they inject a fake S3 client (a module-level `S3Client` interface that tests replace). The real `aws4fetch` client is wired only in production. This avoids a test dependency on `s3.kuma.homes` being reachable.
- **`attachments` / `message_attachments` tables already exist** in `src/do/chat-channel.ts` (status `pending`→`finalized`). `message_stickers` does NOT exist yet (Task B5 adds it). `personal_stickers` does NOT exist in UserDirectory yet (Task B2 adds it).
- **Sticker ownership:** personal sticker library is owned by `UserDirectory DO(user_id)`. `ChatChannel DO` owns `message_stickers` (snapshot for historical stability) + the `resolveVisibleAttachment` internal method (visibility check for save-from-message).
- **`message.send` is the ONE entry for all `type` values** (`text`/`image`/`sticker`). The existing `parseMessageSendCommand` in `src/chat/command.ts` currently rejects `type !== "text"` — Task A4 + B6 extend it.
- **`projectMessageForBrowser`** is the ONE message serializer. It already accepts `attachments`/`components`/`mentions` opts (Phase 3.5). Task A5 extends it to carry resolved `attachments` (array of attachment projections); Task B6 extends it to carry `sticker` (null for non-sticker; full projection for sticker; null for deleted/recalled sticker).
- **No `AttachmentDirectory DO`.** Phase E does NOT add one. Save-sticker uses `{channel_id, attachment_id}` (Task B3).
- **Deleted/recalled safety:** `projectMessageForBrowser` already nulls text/attachments/components/mentions for deleted/recalled. Tasks A5/B6 add sticker to the same hidden-projection rule.
- **Git:** USE THE REPO DEFAULT git config (do NOT pass `-c user.name=...`). `git add <files> && git commit -m '...'`. Do NOT push or deploy.
- **Test config:** `npx vitest run <files> --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Typecheck: `npm run typecheck`.
- **`CHANNEL_DISSOLVED` write-gate** applies to presign/finalize + sticker save + sticker send (every write into ChatChannel).

---

## File Structure

**Create:**
- `src/s3/client.ts` — `S3Client` interface + `createS3Client(env)` factory (returns the real `aws4fetch` `AwsClient` wired with `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_REGION`/`S3_ENDPOINT`). Pure; injectable in tests via a module-level `let client: S3Client | null` that tests can replace.
- `src/s3/presign.ts` — pure helpers: `presignPutUrl(client, {bucket, key, contentType, expiresIn, sizeBytes})` + `headObject(client, url)`. Thin wrappers around the `aws4fetch` client.
- `src/routes/uploads.ts` — `presignUploadHandler` + `finalizeUploadHandler` (the two HTTP routes).
- `src/chat/attachment-projection.ts` — pure `projectAttachmentForBrowser(row): Record<string, unknown>` (the canonical image attachment projection: `{attachment_id, url, mime_type, width, height, size_bytes}`). Pure; no S3.
- `test/s3/presign.test.ts` — presign/head helpers with a fake S3 client.
- `test/routes/uploads.test.ts` — presign + finalize HTTP routes (using the fake S3 client).
- `test/do/chat-channel-image-send.test.ts` — `message.send type=image` DO internals + projection.
- `test/do/user-directory-stickers.test.ts` — personal sticker library DO internals (list/save/delete/resolveSticker).
- `test/routes/stickers.test.ts` — sticker library HTTP routes.
- `test/do/chat-channel-sticker-send.test.ts` — `message.send type=sticker` DO internals + `resolveVisibleAttachment`.

**Modify:**
- `src/chat/attachment-projection.ts` (above) — used by history/send ack/event.
- `src/do/chat-channel.ts` — add `/internal/attachment-presign`, `/internal/attachment-finalize`, extend `/internal/message-send` for `type=image`/`sticker`, add `message_stickers` table, add `resolveVisibleAttachment` internal method, extend `projectMessageForBrowser` to carry `attachments`/`sticker` (or feed it in the call sites), extend `buildMessageLifecyclePayload`.
- `src/do/user-directory.ts` — add `personal_stickers` table + `/internal/sticker-save`, `/internal/sticker-list`, `/internal/sticker-delete`, `/internal/sticker-resolve` (resolveSticker).
- `src/chat/command.ts` — extend `parseMessageSendCommand` to accept `type:"image"` (with `attachment_ids`) + `type:"sticker"` (with `sticker_id`).
- `src/chat/message-projection.ts` — add `sticker` field to the projection (null for non-sticker; full projection for sticker; null for deleted/recalled).
- `src/routes/channel-mutations.ts` — add `listStickersHandler`, `saveStickerHandler`, `deleteStickerHandler`.
- `src/index.ts` — register `POST /uploads/images/presign`, `POST /uploads/images/:attachment_id/finalize`, `GET/POST/DELETE /stickers`.

**Do NOT touch:** `src/do/channel-fanout.ts`, `src/do/user-connection.ts` (message.send already routed), `src/ws/frames.ts`, `src/auth/jwt.ts`, `src/ids/uuidv7.ts`, wrangler configs (S3 vars already there).

---

## Section A — Image attachments (presign / finalize / image message)

### Task A0: Baseline green + S3 vars confirm

**Files:** (none)

- [ ] **Step 1:** Run `npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Expected: clean + green (current ~221 passed). Record HEAD (`git rev-parse --short HEAD`).
- [ ] **Step 2:** Confirm S3 vars present: `grep -E 'S3_ENDPOINT|S3_BUCKET|S3_REGION' wrangler.jsonc wrangler.test.jsonc`. Expected: both configs have them. Confirm `aws4fetch` in `package.json`.

---

### Task A1: S3 client + presign helpers (mockable) + tests

**Files:**
- Create: `src/s3/client.ts`, `src/s3/presign.ts`
- Test: `test/s3/presign.test.ts`

**Interfaces:**
- Consumes: `aws4fetch` (1.0.20), `Env` (S3 secrets + vars).
- Produces:
  - `S3Client` interface: `{ presign(method: string, url: string | URL, opts?: { expiresIn?: number; headers?: Record<string,string> }): Promise<URL>; fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }`.
  - `createS3Client(env: Env): S3Client` — returns an `aws4fetch.AwsClient` wrapper. A module-level `let _testClient: S3Client | null = null` + `setTestS3Client(c: S3Client | null)` lets tests inject a fake.
  - `presignPutUrl(client: S3Client, env: Env, key: string, contentType: string, sizeBytes: number): Promise<{ upload_url: string; expires_at: string }>` — builds the S3 PUT URL `${S3_ENDPOINT}/${S3_BUCKET}/${key}`, presigns it (5min), returns the URL + expiry ISO.
  - `headObject(client: S3Client, url: string, expectedContentType: string, expectedSize: number): Promise<{ ok: boolean; contentType?: string; contentLength?: number }>` — HEADs the S3 URL, returns whether the object exists + matches the expected Content-Type + Content-Length.

- [ ] **Step 1: Write failing test** (`test/s3/presign.test.ts`):
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { type S3Client, setTestS3Client, presignPutUrl, headObject } from "../../src/s3/presign";

class FakeS3 implements S3Client {
  presignedUrls = new Map<string, URL>();
  objects = new Map<string, { contentType: string; contentLength: number }>();
  async presign(_method: string, url: string | URL, opts?: { expiresIn?: number }) {
    const u = new URL(url);
    u.searchParams.set("X-Amz-Fake", "signed");
    return u;
  }
  async fetch(input: RequestInfo | URL) {
    const u = new URL(input instanceof Request ? input.url : input.toString());
    const method = input instanceof Request ? input.method : "GET";
    if (method === "HEAD") {
      const obj = this.objects.get(u.pathname);
      if (!obj) return new Response("Not Found", { status: 404 });
      return new Response(null, { status: 200, headers: { "Content-Type": obj.contentType, "Content-Length": String(obj.contentLength) } });
    }
    return new Response("ok", { status: 200 });
  }
}

describe("S3 presign helpers", () => {
  beforeEach(() => setTestS3Client(new FakeS3()));

  it("presignPutUrl returns a signed URL + expiry", async () => {
    const r = await presignPutUrl({ S3_ENDPOINT: "https://s3.kuma.homes", S3_BUCKET: "bucket", S3_REGION: "us-east-1" } as any, "chat/img-1", "image/png", 12345);
    expect(r.upload_url).toContain("https://s3.kuma.homes/bucket/chat/img-1");
    expect(r.upload_url).toContain("X-Amz-Fake=signed");
    expect(r.expires_at).toBeTruthy();
  });

  it("headObject returns ok when object matches", async () => {
    const fake = new FakeS3();
    fake.objects.set("/bucket/chat/img-1", { contentType: "image/png", contentLength: 12345 });
    setTestS3Client(fake);
    const r = await headObject({ S3_ENDPOINT: "https://s3.kuma.homes", S3_BUCKET: "bucket", S3_REGION: "us-east-1" } as any, "https://s3.kuma.homes/bucket/chat/img-1", "image/png", 12345);
    expect(r.ok).toBe(true);
    expect(r.contentType).toBe("image/png");
  });

  it("headObject returns ok=false for missing object", async () => {
    const r = await headObject({ S3_ENDPOINT: "https://s3.kuma.homes", S3_BUCKET: "bucket", S3_REGION: "us-east-1" } as any, "https://s3.kuma.homes/bucket/missing", "image/png", 12345);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run test/s3/presign.test.ts --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Expected: FAIL (module not found).

- [ ] **Step 3:** Implement `src/s3/client.ts` + `src/s3/presign.ts`:
```typescript
// src/s3/client.ts
import { AwsClient } from "aws4fetch";
import type { Env } from "../env";

export interface S3Client {
  presign(method: string, url: string | URL, opts?: { expiresIn?: number; headers?: Record<string,string> }): Promise<URL>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export function createS3Client(env: Env): S3Client {
  return new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION,
    service: "s3",
  }) as unknown as S3Client;
}
```
```typescript
// src/s3/presign.ts
import type { Env } from "../env";
import type { S3Client } from "./client";
import { createS3Client } from "./client";

let _testClient: S3Client | null = null;
export function setTestS3Client(c: S3Client | null): void { _testClient = c; }
export function getS3Client(env: Env): S3Client { return _testClient ?? createS3Client(env); }

export interface S3EnvLike { S3_ENDPOINT: string; S3_BUCKET: string; S3_REGION: string; }

export const PRESIGN_TTL_SECONDS = 5 * 60; // 5 min

export async function presignPutUrl(env: S3EnvLike, key: string, contentType: string, _sizeBytes?: number): Promise<{ upload_url: string; expires_at: string }> {
  const client = getS3Client(env as Env);
  const url = `${env.S3_ENDPOINT}/${env.S3_BUCKET}/${key}`;
  const signed = await client.presign("PUT", url, { expiresIn: PRESIGN_TTL_SECONDS, headers: { "Content-Type": contentType } });
  return { upload_url: signed.toString(), expires_at: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString() };
}

export async function headObject(env: S3EnvLike, url: string, expectedContentType: string, expectedSize: number): Promise<{ ok: boolean; contentType?: string; contentLength?: number }> {
  const client = getS3Client(env as Env);
  try {
    const res = await client.fetch(url, { method: "HEAD" });
    if (!res.ok) return { ok: false };
    const contentType = res.headers.get("Content-Type") ?? undefined;
    const contentLength = Number(res.headers.get("Content-Length") ?? "0");
    if (contentType !== expectedContentType) return { ok: false, contentType };
    if (contentLength !== expectedSize) return { ok: false, contentType, contentLength };
    return { ok: true, contentType, contentLength };
  } catch {
    return { ok: false };
  }
}
```

- [ ] **Step 4:** Run the test (PASS) + `npm run typecheck`.

- [ ] **Step 5:** Commit:
```bash
git add src/s3/client.ts src/s3/presign.ts test/s3/presign.test.ts
git commit -m "feat(s3): mockable S3 client + presign/head helpers (aws4fetch)"
```

---

### Task A2: `attachment-projection` builder + tests

**Files:**
- Create: `src/chat/attachment-projection.ts`
- Test: `test/chat/attachment-projection.test.ts`

**Interfaces:**
- Produces: `projectAttachmentForBrowser(row: AttachmentRow): Record<string, unknown>` → `{ attachment_id, kind, filename, mime_type, size_bytes, width, height, url }`. Pure; takes a row (the `attachments` table shape); no S3.

- [ ] **Step 1: Write failing test** (`test/chat/attachment-projection.test.ts`):
```typescript
import { describe, it, expect } from "vitest";
import { projectAttachmentForBrowser } from "../../src/chat/attachment-projection";

describe("projectAttachmentForBrowser", () => {
  it("projects a finalized image attachment", () => {
    const p = projectAttachmentForBrowser({
      attachment_id: "att-1", owner_user_id: "u-1", kind: "image",
      filename: "img.png", mime_type: "image/png", size_bytes: 12345,
      width: 512, height: 512, storage_key: "secret/key", url: "https://s3.kuma.homes/bucket/img-1",
      status: "finalized", created_at: "t",
    });
    expect(p.attachment_id).toBe("att-1");
    expect(p.kind).toBe("image");
    expect(p.mime_type).toBe("image/png");
    expect(p.width).toBe(512);
    expect(p.height).toBe(512);
    expect(p.size_bytes).toBe(12345);
    expect(p.url).toBe("https://s3.kuma.homes/bucket/img-1");
    expect(p).not.toHaveProperty("storage_key");
    expect(p).not.toHaveProperty("owner_user_id");
    expect(p).not.toHaveProperty("status");
  });
  it("rejects non-finalized (internal defense)", () => {
    const p = projectAttachmentForBrowser({
      attachment_id: "att-2", owner_user_id: "u-1", kind: "image",
      filename: "x", mime_type: "image/png", size_bytes: 1,
      width: null, height: null, storage_key: "k", url: "u", status: "pending", created_at: "t",
    });
    expect(p).toBeNull();
  });
});
```

- [ ] **Step 2:** Run test (FAIL).

- [ ] **Step 3:** Implement `src/chat/attachment-projection.ts`:
```typescript
export interface AttachmentRow {
  attachment_id: string; owner_user_id: string; kind: string;
  filename: string; mime_type: string; size_bytes: number;
  width: number | null; height: number | null; storage_key: string;
  url: string; status: string; created_at: string;
}

// The ONE shared Browser-visible image attachment projection. Returns null for non-finalized
// (pending attachments are not Browser-visible). Never exposes storage_key / owner_user_id / status.
export function projectAttachmentForBrowser(row: AttachmentRow): Record<string, unknown> | null {
  if (row.status !== "finalized") return null;
  return {
    attachment_id: row.attachment_id,
    kind: row.kind,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
    url: row.url,
  };
}
```

- [ ] **Step 4:** Run test (PASS) + typecheck.

- [ ] **Step 5:** Commit:
```bash
git add src/chat/attachment-projection.ts test/chat/attachment-projection.test.ts
git commit -m "feat(chat): projectAttachmentForBrowser builder (canonical image projection)"
```

---

### Task A3: ChatChannel `/internal/attachment-presign` + `/internal/attachment-finalize` + tests

**Files:**
- Modify: `src/do/chat-channel.ts`
- Test: `test/do/chat-channel-attachments.test.ts` (create)

**Interfaces:**
- Consumes: `presignPutUrl`, `headObject` (Task A1); `uuidv7`.
- Produces:
  - `/internal/attachment-presign` (header `X-Verified-User-Id`, body `{ filename, mime_type, size_bytes, width?, height? }`) → INSERT `attachments(status='pending')` (mint `attachment_id=uuidv7`, `storage_key=chat/{attachment_id}`, `url=${S3_PUBLIC_BASE}/${S3_BUCKET}/chat/{attachment_id}`, `owner_user_id=userId`, `created_at`); return `{attachment_id, upload_url, upload_method:"PUT", upload_headers:{"Content-Type":mime_type}, expires_at}` via `presignPutUrl`.
  - `/internal/attachment-finalize` (body `{ attachment_id, etag? }`) → load `attachments` row; verify owner; S3 HEAD via `headObject`; if ok UPDATE `status='finalized'`; return `{attachment: projectAttachmentForBrowser(row)}`.

- [ ] **Step 1: Write failing test** (`test/do/chat-channel-attachments.test.ts`):
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { setTestS3Client, type S3Client } from "../../src/s3/presign";

class FakeS3 implements S3Client {
  objects = new Map<string, { contentType: string; contentLength: number }>();
  async presign(_m: string, url: string | URL, _o?: { expiresIn?: number }) { return new URL(url); }
  async fetch(input: RequestInfo | URL) {
    const u = new URL(input instanceof Request ? input.url : input.toString());
    const method = input instanceof Request ? input.method : "GET";
    if (method === "HEAD") {
      const obj = this.objects.get(u.pathname);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { "Content-Type": obj.contentType, "Content-Length": String(obj.contentLength) } });
    }
    return new Response("ok");
  }
}

describe("ChatChannel attachment presign + finalize", () => {
  let fake: FakeS3;
  beforeEach(() => { fake = new FakeS3(); setTestS3Client(fake); });

  it("presign creates a pending attachment + returns upload URL", async () => {
    const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "att-ch-1");
    await stub.fetch(new Request("https://x/internal/create-channel", { method: "POST", headers: { "X-Verified-User-Id": "u-att-1", "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: "att-ch-1", creator_user_id: "u-att-1", title: "A", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }) }));
    const res = await stub.fetch(new Request("https://x/internal/attachment-presign", { method: "POST", headers: { "X-Verified-User-Id": "u-att-1", "Content-Type": "application/json" }, body: JSON.stringify({ filename: "img.png", mime_type: "image/png", size_bytes: 12345, width: 512, height: 512 }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachment_id: string; upload_url: string; upload_method: string; upload_headers: { "Content-Type": string }; expires_at: string };
    expect(body.attachment_id).toBeTruthy();
    expect(body.upload_url).toContain("s3.kuma.homes");
    expect(body.upload_method).toBe("PUT");
    expect(body.upload_headers["Content-Type"]).toBe("image/png");
  });

  it("finalize verifies S3 HEAD + returns attachment projection", async () => {
    const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "att-ch-2");
    await stub.fetch(new Request("https://x/internal/create-channel", { method: "POST", headers: { "X-Verified-User-Id": "u-att-2", "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: "att-ch-2", creator_user_id: "u-att-2", title: "A", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }) }));
    const presign = await (await stub.fetch(new Request("https://x/internal/attachment-presign", { method: "POST", headers: { "X-Verified-User-Id": "u-att-2", "Content-Type": "application/json" }, body: JSON.stringify({ filename: "img.png", mime_type: "image/png", size_bytes: 12345, width: 512, height: 512 }) }))).json() as { attachment_id: string; upload_url: string };
    // simulate the browser PUT landed in S3
    fake.objects.set(`${new URL(presign.upload_url).pathname}`, { contentType: "image/png", contentLength: 12345 });
    const res = await stub.fetch(new Request("https://x/internal/attachment-finalize", { method: "POST", headers: { "X-Verified-User-Id": "u-att-2", "Content-Type": "application/json" }, body: JSON.stringify({ attachment_id: presign.attachment_id, etag: "\"x\"" }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachment: { attachment_id: string; kind: string; url: string; mime_type: string; size_bytes: number } };
    expect(body.attachment.attachment_id).toBe(presign.attachment_id);
    expect(body.attachment.kind).toBe("image");
    expect(body.attachment.mime_type).toBe("image/png");
    expect(body.attachment.size_bytes).toBe(12345);
    expect(body.attachment.url).toContain("s3.kuma.homes");
  });

  it("finalize rejects when S3 HEAD fails (object missing)", async () => {
    const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], "att-ch-3");
    await stub.fetch(new Request("https://x/internal/create-channel", { method: "POST", headers: { "X-Verified-User-Id": "u-att-3", "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: "att-ch-3", creator_user_id: "u-att-3", title: "A", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }) }));
    const presign = await (await stub.fetch(new Request("https://x/internal/attachment-presign", { method: "POST", headers: { "X-Verified-User-Id": "u-att-3", "Content-Type": "application/json" }, body: JSON.stringify({ filename: "img.png", mime_type: "image/png", size_bytes: 1, width: 1, height: 1 }) }))).json() as { attachment_id: string };
    // don't put the object in fake S3
    const res = await stub.fetch(new Request("https://x/internal/attachment-finalize", { method: "POST", headers: { "X-Verified-User-Id": "u-att-3", "Content-Type": "application/json" }, body: JSON.stringify({ attachment_id: presign.attachment_id }) }));
    expect(res.status).toBe(409); // or 422 — pick one, document it
  });
});
```

> **HTTP status for finalize-HEAD-fail:** return `409` `ATTACHMENT_NOT_FINALIZED` (add to errors.ts) OR `422 INVALID_MESSAGE`. Pick `409` with a new code `ATTACHMENT_NOT_FINALIZED` to be specific; the contract doesn't define it, but it's cleaner than 422. Add `ATTACHMENT_NOT_FINALIZED: 409` to `src/errors.ts` in this task.

- [ ] **Step 2:** Run test (FAIL — handlers 404).

- [ ] **Step 3:** Implement both handlers in `src/do/chat-channel.ts` (before the final 404). Mirror the pattern: read `S3_ENDPOINT`/`S3_BUCKET`/`S3_PUBLIC_BASE`/`S3_REGION` from `this.env`. Use `presignPutUrl` + `headObject` from `src/s3/presign`. For presign: mint `attachment_id=uuidv7()`, `storage_key="chat/"+attachment_id`, `url=env.S3_PUBLIC_BASE+"/"+env.S3_BUCKET+"/"+storage_key`, INSERT into `attachments`. For finalize: SELECT row, check `owner_user_id===userId`, `headObject`, UPDATE `status='finalized'`, return `projectAttachmentForBrowser`.

- [ ] **Step 4:** Run test (PASS) + typecheck + full suite (no regression — the fake S3 client is set per-test).

- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts src/errors.ts test/do/chat-channel-attachments.test.ts
git commit -m "feat(do): ChatChannel attachment-presign + attachment-finalize (S3 presign + HEAD verify)"
```

---

### Task A4: `message.send type=image` + tests

**Files:**
- Modify: `src/do/chat-channel.ts` (message-send) + `src/chat/command.ts` (parser)
- Test: `test/do/chat-channel-image-send.test.ts` (create)

**Interfaces:**
- Consumes: `projectAttachmentForBrowser` (Task A2); the message-send idempotency/projection pattern.
- Produces: `parseMessageSendCommand` accepts `type:"image"` (with `attachment_ids: string[]`, non-empty). `message-send` handler: for `type=image`, verify each `attachment_id` is a finalized attachment owned by the sender OR visible to them (the existing attachment visibility rules — the attachment must belong to the channel's messages or the sender); resolve the `attachments` projections via `projectAttachmentForBrowser`; store `message_attachments` links; the `message.created` event + ack `payload.message.attachments` carries the resolved projections.

- [ ] **Step 1: Write failing test** (`test/do/chat-channel-image-send.test.ts`): presign+finalize an attachment, then `message.send type=image` with it, assert the ack `payload.message.attachments` has the projection.
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getNamedDo } from "../helpers";
import { setTestS3Client, type S3Client } from "../../src/s3/presign";

class FakeS3 implements S3Client {
  objects = new Map<string, { contentType: string; contentLength: number }>();
  async presign(_m: string, url: string | URL) { return new URL(url); }
  async fetch(input: RequestInfo | URL) {
    const u = new URL(input instanceof Request ? input.url : input.toString());
    const method = input instanceof Request ? input.method : "GET";
    if (method === "HEAD") { const obj = this.objects.get(u.pathname); return obj ? new Response(null, { status: 200, headers: { "Content-Type": obj.contentType, "Content-Length": String(obj.contentLength) } }) : new Response(null, { status: 404 }); }
    return new Response("ok");
  }
}
async function presignAndFinalize(stub: DurableObjectStub, userId: string, mime: string, size: number, fake: FakeS3): Promise<string> {
  const p = await (await stub.fetch(new Request("https://x/internal/attachment-presign", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ filename: "img.png", mime_type: mime, size_bytes: size, width: 1, height: 1 }) }))).json() as { attachment_id: string; upload_url: string };
  fake.objects.set(`${new URL(p.upload_url).pathname}`, { contentType: mime, contentLength: size });
  await stub.fetch(new Request("https://x/internal/attachment-finalize", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ attachment_id: p.attachment_id }) }));
  return p.attachment_id;
}

describe("message.send type=image", () => {
  let fake: FakeS3;
  beforeEach(() => { fake = new FakeS3(); setTestS3Client(fake); });
  it("sends an image message with a finalized attachment", async () => {
    const userId = "u-img-1"; const cid = "01b50001-0000-7000-8000-000000000001";
    const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], cid);
    await stub.fetch(new Request("https://x/internal/create-channel", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: cid, creator_user_id: userId, title: "I", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }) }));
    const attId = await presignAndFinalize(stub, userId, "image/png", 12345, fake);
    const res = await stub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ command_id: "cmd-img-1", dedupe_principal_key: `user:${userId}`, type: "image", text: "", reply_to: null, mentions: [], channel_id: cid, attachment_ids: [attId] }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { type: string; attachments: Array<{ attachment_id: string; mime_type: string }>; text: string | null } };
    expect(body.message.type).toBe("image");
    expect(body.message.attachments).toHaveLength(1);
    expect(body.message.attachments[0]?.attachment_id).toBe(attId);
    expect(body.message.attachments[0]?.mime_type).toBe("image/png");
    expect(body.message.text).toBeNull();
  });
  it("rejects image message with a non-finalized attachment", async () => {
    const userId = "u-img-2"; const cid = "01b50002-0000-7000-8000-000000000001";
    const stub = getNamedDo(env.CHAT_CHANNEL as unknown as Parameters<typeof getNamedDo>[0], cid);
    await stub.fetch(new Request("https://x/internal/create-channel", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: cid, creator_user_id: userId, title: "I", topic: null, avatar_attachment_id: null, visibility: "private", initial_members: [] }) }));
    // presign but don't finalize
    const p = await (await stub.fetch(new Request("https://x/internal/attachment-presign", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ filename: "img.png", mime_type: "image/png", size_bytes: 1, width: 1, height: 1 }) }))).json() as { attachment_id: string };
    const res = await stub.fetch(new Request("https://x/internal/message-send", { method: "POST", headers: { "X-Verified-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify({ command_id: "cmd-img-2", dedupe_principal_key: `user:${userId}`, type: "image", text: "", reply_to: null, mentions: [], channel_id: cid, attachment_ids: [p.attachment_id] }) }));
    expect(res.status).toBe(409); // or 422 — ATTACHMENT_NOT_FINALIZED
  });
});
```

- [ ] **Step 2:** Run test (FAIL — parser rejects type=image; handler doesn't handle it).

- [ ] **Step 3:** Extend `parseMessageSendCommand` (`src/chat/command.ts`) to accept `type:"image"` with `attachment_ids: string[]`; extend the message-send handler to validate each attachment is finalized + owned by sender, resolve projections via `projectAttachmentForBrowser`, store `message_attachments`, and feed the `attachments` into `projectMessageForBrowser(row, {senderSummary, mentions, attachments})` for the ack + event.

- [ ] **Step 4:** Run test (PASS) + typecheck + full suite.

- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts src/chat/command.ts test/do/chat-channel-image-send.test.ts
git commit -m "feat(do): message.send type=image (attachment resolve + projection)"
```

---

### Task A5: `projectMessageForBrowser` carries resolved `attachments` + history/replay image projection

**Files:**
- Modify: `src/do/chat-channel.ts` (history `/internal/messages` reads `message_attachments` → resolves → projects; replay message.* events for image messages)
- Test: update `test/do/chat-channel-image-send.test.ts` (append history/replay assertions)

**Interfaces:**
- Consumes: `projectAttachmentForBrowser` (Task A2).
- Produces: history `/internal/messages` + replay message events for image messages carry `attachments` array (resolved from `message_attachments` + the `attachments` table).

- [ ] **Step 1: Write failing tests** (append to `test/do/chat-channel-image-send.test.ts` — send an image, then `GET /internal/messages` + replay, assert `attachments` present).

- [ ] **Step 2:** Run (FAIL — history returns `attachments:[]`).

- [ ] **Step 3:** Extend `/internal/messages` to return `message_attachments` grouped by `message_id` (like mentions); the Worker route resolves `projectAttachmentForBrowser` per attachment. Extend replay message.* re-projection to read `message_attachments` + project them.

- [ ] **Step 4:** Run (PASS) + typecheck + full suite.

- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts test/do/chat-channel-image-send.test.ts
git commit -m "feat(do): history + replay carry resolved image attachments (projectMessageForBrowser)"
```

---

### Task A6: HTTP routes `POST /uploads/images/presign` + `POST /uploads/images/{id}/finalize` + tests

**Files:**
- Modify: `src/routes/uploads.ts` (create) + `src/index.ts`
- Test: `test/routes/uploads.test.ts` (create, using fake S3)

- [ ] **Step 1: Write failing test** (`test/routes/uploads.test.ts`) — authed presign + finalize via the HTTP routes (not DO direct). Assert the contract shapes from §8.1/§8.2.
- [ ] **Step 2:** Run (FAIL — routes 404).
- [ ] **Step 3:** Create `src/routes/uploads.ts` with `presignUploadHandler` + `finalizeUploadHandler` (auth → route to ChatChannel). Register in `src/index.ts`: `app.post("/api/chat/uploads/images/presign", ...)`, `app.post("/api/chat/uploads/images/:attachment_id/finalize", ...)`.
- [ ] **Step 4:** Run (PASS) + typecheck + full suite.
- [ ] **Step 5:** Commit:
```bash
git add src/routes/uploads.ts src/index.ts test/routes/uploads.test.ts
git commit -m "feat(routes): POST /uploads/images/presign + finalize (contract-aligned)"
```

---

## Section B — Personal stickers + sticker messages

### Task B1: UserDirectory `personal_stickers` table + `/internal/sticker-resolve` (resolveSticker) + tests

**Files:**
- Modify: `src/do/user-directory.ts`
- Test: `test/do/user-directory-stickers.test.ts` (create)

**Interfaces:**
- Produces:
  - `personal_stickers` table in UserDirectory SCHEMA (sticker_id PK, user_id, attachment_id, url, mime_type, width, height, size_bytes, created_at, deleted_at; UNIQUE(user_id, attachment_id); index on (user_id, created_at DESC WHERE deleted_at IS NULL)).
  - `/internal/sticker-resolve?sticker_id=` (header `X-Verified-User-Id`) → if the sticker belongs to the user + `deleted_at IS NULL`, return `{sticker_id, attachment_id, url, mime_type, width, height, size_bytes}`; else 404 `STICKER_NOT_FOUND`.

- [ ] **Step 1: Write failing test** (`test/do/user-directory-stickers.test.ts`) — save a sticker (direct INSERT via a test helper), then resolve it; resolve a deleted one → 404; resolve another user's → 404.
- [ ] **Step 2:** Run (FAIL).
- [ ] **Step 3:** Add the `personal_stickers` table to UserDirectory SCHEMA + implement `/internal/sticker-resolve`.
- [ ] **Step 4:** Run (PASS) + typecheck.
- [ ] **Step 5:** Commit:
```bash
git add src/do/user-directory.ts test/do/user-directory-stickers.test.ts
git commit -m "feat(do): UserDirectory personal_stickers table + resolveSticker"
```

---

### Task B2: UserDirectory `/internal/sticker-save` + `/internal/sticker-list` + `/internal/sticker-delete` + tests

**Files:**
- Modify: `src/do/user-directory.ts`
- Test: `test/do/user-directory-stickers.test.ts` (append)

**Interfaces:**
- Consumes: `ChatChannel /internal/resolve-visible-attachment` (Task B3 — but B3 comes after; B2's save calls it, so implement the ChatChannel side in B3 first? No — B2 can mock the ChatChannel call for now, or B3 comes before B2. Swap: B3 (ChatChannel resolveVisibleAttachment) before B2 (save). Actually B2's save calls resolveVisibleAttachment, so B3 must be first. Reorder: do B3 before B2.) → **Reorder: B3 (ChatChannel resolveVisibleAttachment) → B1 (UserDirectory table + resolveSticker) → B2 (save/list/delete).**
- Produces:
  - `/internal/sticker-save` (body `{attachment_id, channel_id, attachment_projection}`) — idempotency `operation='sticker.save'`; the Worker calls ChatChannel resolveVisibleAttachment first (B3), then calls this with the resolved projection; UPSERT `personal_stickers` (or restore a soft-deleted row); return `{sticker, ...}`.
  - `/internal/sticker-list` (header `X-Verified-User-Id`, query `limit`/`cursor`) → `personal_stickers WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`.
  - `/internal/sticker-delete` (body `{sticker_id}`) — `UPDATE personal_stickers SET deleted_at=? WHERE sticker_id=? AND user_id=?`; idempotent.

- [ ] **Step 1-5:** TDD as above. Commit `feat(do): UserDirectory sticker save/list/delete + idempotency`.

---

### Task B3: ChatChannel `/internal/resolve-visible-attachment` (resolveVisibleAttachment) + tests

**Files:**
- Modify: `src/do/chat-channel.ts`
- Test: `test/do/chat-channel-attachments.test.ts` (append)

**Interfaces:**
- Produces: `/internal/resolve-visible-attachment?attachment_id=` (header `X-Verified-User-Id`) → load `attachments` row; verify the caller is an active member of the channel; verify the attachment is linked to at least one **Browser-visible** (status normal/edited, not deleted/recalled) image/sticker message in this channel; if the linked message is deleted/recalled → `INVALID_STICKER_SOURCE`; return the canonical projection `{attachment_id, url, mime_type, width, height, size_bytes}` (no `storage_key`). Read-only.

- [ ] **Step 1: Write failing test** (append to `test/do/chat-channel-attachments.test.ts`) — send an image message, then resolve-visible-attachment the attachment → ok; recall the message → resolve → `INVALID_STICKER_SOURCE`.
- [ ] **Step 2:** Run (FAIL).
- [ ] **Step 3:** Implement `/internal/resolve-visible-attachment`.
- [ ] **Step 4:** Run (PASS) + typecheck + full suite.
- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts test/do/chat-channel-attachments.test.ts
git commit -m "feat(do): ChatChannel resolveVisibleAttachment (sticker save visibility check)"
```

---

### Task B4: HTTP routes `GET/POST/DELETE /api/chat/stickers` + tests

**Files:**
- Modify: `src/routes/channel-mutations.ts` + `src/index.ts`
- Test: `test/routes/stickers.test.ts` (create)

**Interfaces:**
- Produces:
  - `GET /api/chat/stickers?limit=&cursor=` → UserDirectory `/internal/sticker-list`.
  - `POST /api/chat/stickers` (body `{channel_id, attachment_id}`, `Idempotency-Key`) → ChatChannel `/internal/resolve-visible-attachment` → UserDirectory `/internal/sticker-save` → return `{sticker: {...}}`.
  - `DELETE /api/chat/stickers/:sticker_id` (`Idempotency-Key`) → UserDirectory `/internal/sticker-delete` → `{sticker_id, deleted: true}`.

- [ ] **Step 1-5:** TDD. Commit `feat(routes): GET/POST/DELETE /stickers (personal sticker library)`.

---

### Task B5: ChatChannel `message_stickers` table + `message.send type=sticker` + tests

**Files:**
- Modify: `src/do/chat-channel.ts` (add `message_stickers` table; extend message-send for type=sticker) + `src/chat/command.ts` (parser)
- Test: `test/do/chat-channel-sticker-send.test.ts` (create)

**Interfaces:**
- Produces:
  - `message_stickers` SCHEMA (message_id PK, sticker_id, attachment_id, url, mime_type, width, height, size_bytes).
  - `parseMessageSendCommand` accepts `type:"sticker"` with `sticker_id: string`.
  - message-send for type=sticker: idempotency pre-check FIRST (return cached ack without resolving sticker — v4.0 addendum K); resolve `sticker_id` via `UserDirectory(user_id) /internal/sticker-resolve`; INSERT `messages` (type=sticker, text=null) + `message_stickers` (snapshot); `message.created` event + ack `payload.message.sticker` carries the snapshot; `projectMessageForBrowser` extended to carry `sticker` (null for non-sticker; full snapshot for sticker; null for deleted/recalled).

- [ ] **Step 1: Write failing test** (`test/do/chat-channel-sticker-send.test.ts`) — save a sticker, send type=sticker, assert ack `payload.message.type="sticker"` + `payload.message.sticker.attachment_id`; replay → sticker present; recall → sticker null.
- [ ] **Step 2:** Run (FAIL).
- [ ] **Step 3:** Add `message_stickers` table; extend parser; extend message-send (the idempotency-pre-check-first rule); cross-DO call to UserDirectory resolveSticker; `projectMessageForBrowser` `sticker` opt.
- [ ] **Step 4:** Run (PASS) + typecheck + full suite.
- [ ] **Step 5:** Commit:
```bash
git add src/do/chat-channel.ts src/chat/command.ts src/chat/message-projection.ts test/do/chat-channel-sticker-send.test.ts
git commit -m "feat(do): message.send type=sticker (resolveSticker + message_stickers snapshot)"
```

---

### Task B6: `projectMessageForBrowser` `sticker` field + history/replay sticker projection + tests

**Files:**
- Modify: `src/chat/message-projection.ts` + `src/do/chat-channel.ts` (history/replay read `message_stickers`)
- Test: update `test/do/chat-channel-sticker-send.test.ts` (history/replay assertions)

- [ ] **Step 1:** Extend `projectMessageForBrowser` to accept `sticker?: {sticker_id, attachment_id, url, mime_type, width, height, size_bytes} | null`; adds `sticker` to the projection (null for non-sticker; the snapshot for sticker; null for deleted/recalled — hidden rule).
- [ ] **Step 2:** Extend history `/internal/messages` to read `message_stickers` by `message_id` + feed `sticker` into the projection.
- [ ] **Step 3:** Extend replay message.* re-projection to read `message_stickers` + feed `sticker`.
- [ ] **Step 4-5:** Test + commit `feat(chat): projectMessageForBrowser sticker field + history/replay sticker projection`.

---

### Task B7: Full-suite green + self-review

- [ ] **Step 1:** `npm run typecheck && npx vitest run --no-file-parallelism --test-timeout=60000 --hook-timeout=60000`. Expected: clean + green.
- [ ] **Step 2:** Spec coverage — presign/finalize (A3/A6), image send (A4), history/replay image (A5), personal_stickers (B1/B2), resolveVisibleAttachment (B3), sticker routes (B4), sticker send (B5), sticker projection (B6). Out-of-scope: none left.
- [ ] **Step 3:** Report.

---

## Notes for the executor

- **Task order:** A0→A1→A2→A3→A4→A5→A6→B3→B1→B2→B4→B5→B6→B7. B3 before B2 (save calls resolveVisibleAttachment).
- **S3 is mocked in tests** via `setTestS3Client` — never hit live `s3.kuma.homes` in tests.
- **`message.send` extends for type=image/sticker** — keep the idempotency/full-ack/fanout pattern identical; only the attach-to-row + projection differ.
- **Sticker send idempotency-pre-check-first** (B5): resolve `sticker_id` AFTER the cached-ack check, so a retry after sticker deletion still returns the cached ack.
- **Git:** repo default config, no override, no push/deploy.
