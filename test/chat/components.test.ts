import { describe, expect, it } from "vitest";
import {
  ComponentValidationError,
  rejectNonEmptyStreamComponents,
  validateComponents,
} from "../../src/chat/components";

const UUID_A = "00000000-0000-7000-8000-000000000a01";
const UUID_B = "00000000-0000-7000-8000-000000000a02";
const UUID_C = "00000000-0000-7000-8000-000000000a03";

const baseButton = {
  component_id: UUID_A,
  kind: "button",
  style: "primary",
  label: "Confirm",
  custom_id: "confirm",
  disabled: false,
};

describe("validateComponents", () => {
  it("accepts valid components for each kind", () => {
    const components = validateComponents([
      baseButton,
      {
        component_id: UUID_B,
        kind: "select",
        label: "Pick",
        custom_id: "pick",
        disabled: false,
        options: [{ value: "a", label: "A" }],
      },
      {
        component_id: UUID_C,
        kind: "radio",
        label: "Mode",
        custom_id: "mode",
        disabled: false,
        options: [{ value: "easy", label: "Easy" }],
      },
      {
        component_id: "00000000-0000-7000-8000-000000000a04",
        kind: "checkbox",
        label: "Agree",
        custom_id: "agree",
        disabled: false,
        default_checked: false,
      },
      {
        component_id: "00000000-0000-7000-8000-000000000a05",
        kind: "checkbox_group",
        label: "Loot",
        custom_id: "loot",
        disabled: false,
        submit_label: "Apply",
        options: [{ value: "weapon", label: "Weapon" }],
        min_selected: 0,
        max_selected: 2,
      },
      {
        component_id: "00000000-0000-7000-8000-000000000a06",
        kind: "text_input",
        label: "Name",
        custom_id: "name",
        disabled: false,
        placeholder: "Enter name",
        multiline: false,
        min_length: 1,
        max_length: 16,
        submit_label: "Submit",
      },
    ]);
    expect(components).toHaveLength(6);
    expect(components[0]?.kind).toBe("button");
  });

  it.each([
    ["invalid kind", [{ ...baseButton, kind: "slider" }], /kind invalid/],
    ["non-uuid component_id", [{ ...baseButton, component_id: "cmp-1" }], /UUIDv7/],
    ["empty custom_id", [{ ...baseButton, custom_id: "" }], /custom_id required/],
    ["button missing style", [{ ...baseButton, style: undefined }], /style invalid/],
    ["button missing label", [{ ...baseButton, label: "" }], /label required/],
    [
      "select missing options",
      [{ component_id: UUID_A, kind: "select", label: "X", custom_id: "x", disabled: false }],
      /options required/,
    ],
    [
      "option missing label",
      [
        {
          component_id: UUID_A,
          kind: "select",
          label: "X",
          custom_id: "x",
          disabled: false,
          options: [{ value: "a", label: "" }],
        },
      ],
      /options\[0\]\.label required/,
    ],
    [
      "checkbox_group min > max",
      [
        {
          component_id: UUID_A,
          kind: "checkbox_group",
          label: "Group",
          custom_id: "g",
          disabled: false,
          submit_label: "Go",
          options: [{ value: "a", label: "A" }],
          min_selected: 3,
          max_selected: 1,
        },
      ],
      /min_selected must be <= max_selected/,
    ],
    [
      "text_input min_length > max_length",
      [
        {
          component_id: UUID_A,
          kind: "text_input",
          label: "Name",
          custom_id: "n",
          disabled: false,
          multiline: false,
          min_length: 10,
          max_length: 2,
          submit_label: "Submit",
        },
      ],
      /min_length must be <= max_length/,
    ],
    [
      "unknown interaction_policy",
      [{ ...baseButton, interaction_policy: "once" }],
      /interaction_policy invalid/,
    ],
    [
      "targeted without target_user_id",
      [{ ...baseButton, interaction_policy: "targeted" }],
      /target_user_id required/,
    ],
    [
      "duplicate component_id",
      [baseButton, { ...baseButton, custom_id: "other" }],
      /duplicate component_id/,
    ],
  ])("rejects %s", (_name, raw, pattern) => {
    expect(() => validateComponents(raw)).toThrow(ComponentValidationError);
    expect(() => validateComponents(raw)).toThrow(pattern);
    try {
      validateComponents(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(ComponentValidationError);
      expect((err as ComponentValidationError).code).toBe("BOT_EFFECT_INVALID");
    }
  });

  it("accepts targeted policy with target_user_id", () => {
    const components = validateComponents([
      {
        ...baseButton,
        interaction_policy: "targeted",
        target_user_id: "00000000-0000-7000-8000-000000000099",
      },
    ]);
    expect(components[0]?.interaction_policy).toBe("targeted");
    expect(components[0]?.target_user_id).toBe("00000000-0000-7000-8000-000000000099");
  });

  it("returns empty array for empty input", () => {
    expect(validateComponents([])).toEqual([]);
  });
});

describe("rejectNonEmptyStreamComponents", () => {
  it("allows empty components", () => {
    expect(() => rejectNonEmptyStreamComponents([])).not.toThrow();
  });

  it("rejects non-empty components", () => {
    expect(() => rejectNonEmptyStreamComponents([baseButton])).toThrow(ComponentValidationError);
    expect(() => rejectNonEmptyStreamComponents([baseButton])).toThrow(/must not include components/);
  });
});
