import { describe, expect, it } from "vitest";
import { normalizeSlashToken, validateSlashToken, collectSlashTokens } from "../../src/chat/slash-token";

describe("normalizeSlashToken", () => {
  it("strips leading slashes and lowercases", () => {
    expect(normalizeSlashToken("/Ask")).toBe("ask");
    expect(normalizeSlashToken("  /AI  ")).toBe("ai");
  });

  it("applies NFKC", () => {
    expect(normalizeSlashToken("ＡＳＫ")).toBe("ask");
  });
});

describe("validateSlashToken", () => {
  it("rejects empty", () => {
    expect(validateSlashToken("")).toEqual({ ok: false, error: "empty" });
  });

  it("rejects whitespace", () => {
    expect(validateSlashToken("a b")).toEqual({ ok: false, error: "invalid_characters" });
  });

  it("rejects length over 32 code points", () => {
    expect(validateSlashToken("a".repeat(33))).toEqual({ ok: false, error: "too_long" });
  });

  it("accepts unicode alias", () => {
    expect(validateSlashToken("狼人杀")).toEqual({ ok: true, token: "狼人杀" });
  });
});

describe("collectSlashTokens", () => {
  it("returns canonical, aliases, and all tokens", () => {
    const out = collectSlashTokens("/Ask", ["AI"]);
    expect(out).toEqual({
      ok: true,
      canonical: "ask",
      aliases: ["ai"],
      all: ["ask", "ai"],
    });
  });

  it("rejects duplicate canonical/alias in same request", () => {
    expect(collectSlashTokens("ask", ["ASK"])).toEqual({ ok: false, error: "duplicate_in_request" });
  });
});
