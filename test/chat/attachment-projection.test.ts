import { describe, it, expect } from "vitest";
import { projectAttachmentForBrowser } from "../../src/chat/attachment-projection";

describe("projectAttachmentForBrowser", () => {
  it("projects a finalized image attachment with blurhash", () => {
    const p = projectAttachmentForBrowser({
      attachment_id: "att-1",
      owner_user_id: "u-1",
      kind: "image",
      filename: "img.png",
      mime_type: "image/png",
      size_bytes: 12345,
      width: 512,
      height: 512,
      blurhash: "LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB",
      storage_key: "secret/key",
      url: "https://s3.kuma.homes/chat/attachments/att-1.png",
      status: "finalized",
      created_at: "2026-06-25T00:00:00.000Z",
    });
    expect(p).not.toBeNull();
    expect(p!.attachment_id).toBe("att-1");
    expect(p!.url).toBe("https://s3.kuma.homes/chat/attachments/att-1.png");
    expect(p!.mime_type).toBe("image/png");
    expect(p!.width).toBe(512);
    expect(p!.height).toBe(512);
    expect(p!.size_bytes).toBe(12345);
    expect(p!.blurhash).toBe("LFE.~f_3%D%M01V@kWM{Rj%Mt7WBt7WB");
    expect(p).not.toHaveProperty("storage_key");
    expect(p).not.toHaveProperty("owner_user_id");
    expect(p).not.toHaveProperty("status");
    expect(p).not.toHaveProperty("kind");
    expect(p).not.toHaveProperty("filename");
  });

  it("returns null for a pending attachment", () => {
    const p = projectAttachmentForBrowser({
      attachment_id: "att-2",
      owner_user_id: "u-1",
      kind: "image",
      filename: "x",
      mime_type: "image/png",
      size_bytes: 1,
      width: null,
      height: null,
      blurhash: null,
      storage_key: "k",
      url: "u",
      status: "pending",
      created_at: "2026-06-25T00:00:00.000Z",
    });
    expect(p).toBeNull();
  });

  it("allows null blurhash", () => {
    const p = projectAttachmentForBrowser({
      attachment_id: "att-3",
      owner_user_id: "u-1",
      kind: "image",
      filename: "img.png",
      mime_type: "image/png",
      size_bytes: 100,
      width: 100,
      height: 100,
      blurhash: null,
      storage_key: "k",
      url: "https://s3.kuma.homes/bucket/att-3",
      status: "finalized",
      created_at: "2026-06-25T00:00:00.000Z",
    });
    expect(p).not.toBeNull();
    expect(p!.blurhash).toBeNull();
  });
});
