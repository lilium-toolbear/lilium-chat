import { describe, expect, it } from "vitest";
import {
  BotEffectValidationError,
  computeEffectRequestHash,
  disableComponentsInJson,
  parseBotEffect,
  parseNonStreamEffect,
  validateNonStreamEffectsForApply,
} from "../../src/chat/bot-effects";
import type { MessageRow } from "../../src/contract/persisted";

const VALID_BUTTON = {
  component_id: "00000000-0000-7000-8000-000000000a01",
  kind: "button",
  style: "primary",
  label: "Go",
  custom_id: "go",
  disabled: false,
};

const baseRow = (overrides: Partial<MessageRow & { components_json?: string }> = {}): MessageRow & {
  components_json?: string;
} => ({
  message_id: "msg-1",
  command_id: "eff-0",
  channel_id: "ch-1",
  sender_kind: "bot",
  sender_user_id: null,
  sender_bot_id: "bot-1",
  sender_bot_display_name: "Bot",
  sender_bot_avatar_url: null,
  type: "text",
  format: "plain",
  status: "normal",
  text: "hello",
  reply_to: null,
  reply_snapshot_json: null,
  stream_state: "none",
  created_at: "2026-06-30T00:00:00.000Z",
  updated_at: "2026-06-30T00:00:00.000Z",
  edited_at: null,
  deleted_at: null,
  deleted_by: null,
  recalled_at: null,
  components_json: JSON.stringify([VALID_BUTTON]),
  ...overrides,
});

describe("bot-effects validation", () => {
  it("parses send_message and computes stable request hash", () => {
    const effect = {
      type: "send_message",
      client_effect_id: "eff-1",
      message: {
        type: "text",
        format: "plain",
        text: "hi",
        reply_to_message_id: null,
        attachment_ids: [],
        components: [],
      },
    };
    const parsed = parseNonStreamEffect(effect);
    expect(parsed.type).toBe("send_message");
    expect(computeEffectRequestHash(effect)).toBe(JSON.stringify(effect));
  });

  it("rejects append_stream at parse time via gateway validator contract", () => {
    expect(() =>
      parseNonStreamEffect({ type: "append_stream", client_effect_id: "eff-2", seq: 1, delta: "x" }),
    ).toThrow(BotEffectValidationError);
  });

  it("rejects bot mutating another bot's message", () => {
    expect(() =>
      validateNonStreamEffectsForApply(
        [{ type: "update_message", client_effect_id: "eff-3", message_id: "msg-1", message: { text: "nope" } }],
        {
          botId: "bot-2",
          loadMessage: () => baseRow({ sender_bot_id: "bot-1" }),
        },
      ),
    ).toThrow(/own messages/);
  });

  it("rejects duplicate client_effect_id in one batch", () => {
    const effects = [
      {
        type: "send_message",
        client_effect_id: "dup",
        message: {
          type: "text",
          format: "plain",
          text: "a",
          reply_to_message_id: null,
          attachment_ids: [],
          components: [],
        },
      },
      {
        type: "send_message",
        client_effect_id: "dup",
        message: {
          type: "text",
          format: "plain",
          text: "b",
          reply_to_message_id: null,
          attachment_ids: [],
          components: [],
        },
      },
    ];
    expect(() =>
      validateNonStreamEffectsForApply(effects, {
        botId: "bot-1",
        loadMessage: () => null,
      }),
    ).toThrow(/duplicate client_effect_id/);
  });

  it("marks targeted components disabled in stored json", () => {
    const next = disableComponentsInJson(baseRow().components_json!, ["00000000-0000-7000-8000-000000000a01"]);
    const parsed = JSON.parse(next) as Array<{ component_id: string; disabled: boolean }>;
    expect(parsed[0]?.disabled).toBe(true);
  });

  it("validates send_message components per §3.8", () => {
    expect(() =>
      parseNonStreamEffect({
        type: "send_message",
        client_effect_id: "eff-components",
        message: {
          type: "text",
          format: "plain",
          text: "hi",
          reply_to_message_id: null,
          attachment_ids: [],
          components: [{ ...VALID_BUTTON, kind: "slider" }],
        },
      }),
    ).toThrow(BotEffectValidationError);
  });

  it("rejects start_stream with non-empty components", () => {
    expect(() =>
      parseBotEffect({
        type: "start_stream",
        client_effect_id: "eff-stream-components",
        message: {
          type: "text",
          format: "plain",
          text: "",
          reply_to_message_id: null,
          attachment_ids: [],
          components: [VALID_BUTTON],
        },
      }),
    ).toThrow(/must not include components/);
  });

  it("validates update_message components in validateEffectsForApply", () => {
    expect(() =>
      validateNonStreamEffectsForApply(
        [
          {
            type: "update_message",
            client_effect_id: "eff-update-components",
            message_id: "msg-1",
            message: {
              components: [{ ...VALID_BUTTON, component_id: "not-a-uuid" }],
            },
          },
        ],
        {
          botId: "bot-1",
          loadMessage: () => baseRow(),
        },
      ),
    ).toThrow(/UUIDv7/);
  });
});
