import { describe, expect, it } from "vitest";
import {
  replaceScopeMentionsChange,
  replaceScopeMessageAttachmentsChange,
  replaceScopeMessageStickersChange,
} from "../../src/archive/chat-channel-record";

describe("replaceScope* omitWhenEmpty", () => {
  const sql = {
    exec: () => ({ toArray: () => [] as Array<Record<string, unknown>> }),
  } as unknown as DurableObjectState["storage"]["sql"];

  it("returns null for empty scopes when omitWhenEmpty is true", () => {
    expect(replaceScopeMentionsChange(sql, "msg-1", "rv", { omitWhenEmpty: true })).toBeNull();
    expect(replaceScopeMessageAttachmentsChange(sql, "msg-1", "rv", { omitWhenEmpty: true })).toBeNull();
    expect(replaceScopeMessageStickersChange(sql, "msg-1", "rv", { omitWhenEmpty: true })).toBeNull();
  });

  it("keeps empty replace_scope when omitWhenEmpty is false", () => {
    const change = replaceScopeMentionsChange(sql, "msg-1", "rv");
    expect(change?.op).toBe("replace_scope");
    expect(change && change.op === "replace_scope" ? change.rows : []).toEqual([]);
  });
});
