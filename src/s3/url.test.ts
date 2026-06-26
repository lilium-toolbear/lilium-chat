import { describe, expect, it } from "vitest";
import { s3BrowserUploadUrl, s3ObjectUrl, s3PublicObjectUrl, s3WeedPathname } from "./url";

describe("s3 url helpers", () => {
  it("builds weed path-style sign URL and clean browser upload URL", () => {
    const signUrl = s3ObjectUrl("https://s3.kuma.homes", "s3.kuma.homes", "chat/attachments/a.png");
    expect(signUrl.pathname).toBe("/s3.kuma.homes/chat/attachments/a.png");
    expect(s3WeedPathname("s3.kuma.homes", "chat/attachments/a.png")).toBe("/s3.kuma.homes/chat/attachments/a.png");

    const signed = new URL("https://s3.kuma.homes/s3.kuma.homes/chat/attachments/a.png?X-Amz-Signature=abc");
    expect(s3BrowserUploadUrl(signed, "chat/attachments/a.png")).toBe(
      "https://s3.kuma.homes/chat/attachments/a.png?X-Amz-Signature=abc",
    );
  });

  it("builds clean public read URL", () => {
    expect(s3PublicObjectUrl("https://s3.kuma.homes", "chat/attachments/a.png")).toBe(
      "https://s3.kuma.homes/chat/attachments/a.png",
    );
  });
});
