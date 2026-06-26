import { describe, expect, it } from "vitest";
import { attachmentFileExtension, attachmentObjectKey, attachmentPublicUrl } from "./object-key";

describe("attachmentFileExtension", () => {
  it("preserves allowed extension from filename", () => {
    expect(attachmentFileExtension("vacation Photo.JPEG", "image/jpeg")).toBe("jpeg");
    expect(attachmentFileExtension("dir/cat.png", "image/png")).toBe("png");
  });

  it("falls back to mime_type when extension is missing or disallowed", () => {
    expect(attachmentFileExtension("noext", "image/webp")).toBe("webp");
    expect(attachmentFileExtension("evil.exe", "image/png")).toBe("png");
  });
});

describe("attachmentObjectKey", () => {
  it("includes attachment id and file extension", () => {
    expect(attachmentObjectKey("att-1", "img.png", "image/png")).toBe("chat/attachments/att-1.png");
    expect(attachmentPublicUrl("https://s3.kuma.homes", "att-1", "img.gif", "image/gif")).toBe(
      "https://s3.kuma.homes/chat/attachments/att-1.gif",
    );
  });
});
