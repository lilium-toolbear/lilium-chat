import type { MessageComponent } from "../contract/message";
import { isRecord } from "../contract/utils";
import { isUuidString } from "./dm-pair";

export type WireComponent = MessageComponent;

export class ComponentValidationError extends Error {
  readonly code = "BOT_EFFECT_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "ComponentValidationError";
  }
}

const ALLOWED_KINDS = new Set([
  "button",
  "select",
  "radio",
  "checkbox",
  "checkbox_group",
  "text_input",
]);

const BUTTON_STYLES = new Set(["primary", "secondary", "danger"]);

const INTERACTION_POLICIES = new Set(["multi", "per_user_once", "exclusive", "targeted"]);

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuidV7(value: string): boolean {
  return UUIDV7_RE.test(value);
}

function invalid(message: string): never {
  throw new ComponentValidationError(message);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${field} required`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    invalid(`${field} must be boolean`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${field} must be a number`);
  }
  return value;
}

function validateOptions(raw: unknown, fieldPrefix: string): Array<{ value: string; label: string }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    invalid(`${fieldPrefix} required`);
  }
  return raw.map((opt, index) => {
    if (!isRecord(opt)) {
      invalid(`${fieldPrefix}[${index}] must be an object`);
    }
    return {
      value: requireNonEmptyString(opt.value, `${fieldPrefix}[${index}].value`),
      label: requireNonEmptyString(opt.label, `${fieldPrefix}[${index}].label`),
    };
  });
}

function readInteractionPolicy(
  raw: Record<string, unknown>,
  index: number,
): { interaction_policy?: MessageComponent["interaction_policy"]; target_user_id?: string } {
  let interactionPolicy: MessageComponent["interaction_policy"] | undefined;
  if (raw.interaction_policy !== undefined) {
    if (typeof raw.interaction_policy !== "string" || !INTERACTION_POLICIES.has(raw.interaction_policy)) {
      invalid(`components[${index}].interaction_policy invalid`);
    }
    interactionPolicy = raw.interaction_policy as MessageComponent["interaction_policy"];
  }

  let targetUserId: string | undefined;
  if (raw.target_user_id !== undefined) {
    if (typeof raw.target_user_id !== "string" || !isUuidString(raw.target_user_id)) {
      invalid(`components[${index}].target_user_id invalid`);
    }
    targetUserId = raw.target_user_id;
  }

  if (interactionPolicy === "targeted" && !targetUserId) {
    invalid("target_user_id required when interaction_policy=targeted");
  }

  return {
    ...(interactionPolicy ? { interaction_policy: interactionPolicy } : {}),
    ...(targetUserId ? { target_user_id: targetUserId } : {}),
  };
}

function validateOneComponent(raw: unknown, index: number, seenIds: Set<string>): WireComponent {
  if (!isRecord(raw)) {
    invalid(`components[${index}] must be an object`);
  }

  const kind = raw.kind;
  if (typeof kind !== "string" || !ALLOWED_KINDS.has(kind)) {
    invalid(`components[${index}].kind invalid`);
  }

  const componentId = raw.component_id;
  if (typeof componentId !== "string" || !isUuidV7(componentId)) {
    invalid(`components[${index}].component_id must be UUIDv7`);
  }
  if (seenIds.has(componentId)) {
    invalid("duplicate component_id in message");
  }
  seenIds.add(componentId);

  const customId = requireNonEmptyString(raw.custom_id, `components[${index}].custom_id`);
  const disabled = requireBoolean(raw.disabled, `components[${index}].disabled`);
  const policyFields = readInteractionPolicy(raw, index);

  const base = {
    component_id: componentId,
    custom_id: customId,
    disabled,
    ...policyFields,
  };

  switch (kind) {
    case "button": {
      const style = raw.style;
      if (typeof style !== "string" || !BUTTON_STYLES.has(style)) {
        invalid(`components[${index}].style invalid`);
      }
      const label = requireNonEmptyString(raw.label, `components[${index}].label`);
      return {
        ...base,
        kind: "button",
        style: style as "primary" | "secondary" | "danger",
        label,
      };
    }
    case "select":
    case "radio": {
      const label = requireNonEmptyString(raw.label, `components[${index}].label`);
      const options = validateOptions(raw.options, `components[${index}].options`);
      return {
        ...base,
        kind,
        label,
        options,
      };
    }
    case "checkbox": {
      const label = requireNonEmptyString(raw.label, `components[${index}].label`);
      const defaultChecked = requireBoolean(raw.default_checked, `components[${index}].default_checked`);
      return {
        ...base,
        kind: "checkbox",
        label,
        default_checked: defaultChecked,
      };
    }
    case "checkbox_group": {
      const label = requireNonEmptyString(raw.label, `components[${index}].label`);
      const submitLabel = requireNonEmptyString(raw.submit_label, `components[${index}].submit_label`);
      const options = validateOptions(raw.options, `components[${index}].options`);
      const minSelected = requireNumber(raw.min_selected, `components[${index}].min_selected`);
      const maxSelected = requireNumber(raw.max_selected, `components[${index}].max_selected`);
      if (minSelected > maxSelected) {
        invalid(`components[${index}].min_selected must be <= max_selected`);
      }
      return {
        ...base,
        kind: "checkbox_group",
        label,
        submit_label: submitLabel,
        options,
        min_selected: minSelected,
        max_selected: maxSelected,
      };
    }
    case "text_input": {
      const label = requireNonEmptyString(raw.label, `components[${index}].label`);
      const multiline = requireBoolean(raw.multiline, `components[${index}].multiline`);
      const minLength = requireNumber(raw.min_length, `components[${index}].min_length`);
      const maxLength = requireNumber(raw.max_length, `components[${index}].max_length`);
      const submitLabel = requireNonEmptyString(raw.submit_label, `components[${index}].submit_label`);
      if (minLength > maxLength) {
        invalid(`components[${index}].min_length must be <= max_length`);
      }
      let placeholder: string | undefined;
      if (raw.placeholder !== undefined) {
        if (typeof raw.placeholder !== "string") {
          invalid(`components[${index}].placeholder must be a string`);
        }
        placeholder = raw.placeholder;
      }
      return {
        ...base,
        kind: "text_input",
        label,
        ...(placeholder !== undefined ? { placeholder } : {}),
        multiline,
        min_length: minLength,
        max_length: maxLength,
        submit_label: submitLabel,
      };
    }
    default:
      invalid(`components[${index}].kind invalid`);
  }
}

export function validateComponents(raw: unknown): WireComponent[] {
  if (!Array.isArray(raw)) {
    invalid("components must be an array");
  }
  const seenIds = new Set<string>();
  return raw.map((item, index) => validateOneComponent(item, index, seenIds));
}

export function rejectNonEmptyStreamComponents(components: unknown[]): void {
  if (components.length > 0) {
    invalid("stream messages must not include components");
  }
}
