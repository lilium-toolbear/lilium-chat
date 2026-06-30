import type { MessageComponent } from "../contract/message";
import { parseStoredComponents } from "./bot-effects";

export type InteractionPolicy = "multi" | "per_user_once" | "exclusive" | "targeted";

export type StoredComponent = MessageComponent & Record<string, unknown>;

export type PolicyGateResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function resolveInteractionPolicy(component: StoredComponent): InteractionPolicy {
  const policy = component.interaction_policy;
  if (policy === "per_user_once" || policy === "exclusive" || policy === "targeted" || policy === "multi") {
    return policy;
  }
  return "multi";
}

export function findMessageComponent(
  componentsJson: string,
  componentId: string,
  customId: string,
): { ok: true; component: StoredComponent; components: StoredComponent[] } | PolicyGateResult & { ok: false } {
  const components = parseStoredComponents(componentsJson) as StoredComponent[];
  const component = components.find((c) => c.component_id === componentId);
  if (!component) {
    return { ok: false, code: "COMPONENT_NOT_FOUND", message: "component not found" };
  }
  if (component.custom_id !== customId) {
    return { ok: false, code: "INVALID_MESSAGE", message: "custom_id mismatch" };
  }
  if (component.disabled) {
    return { ok: false, code: "COMPONENT_DISABLED", message: "component is disabled" };
  }
  return { ok: true, component, components };
}

export type ComponentLookupResult =
  | { ok: true; component: StoredComponent; components: StoredComponent[] }
  | { ok: false; code: string; message: string; component?: StoredComponent; components?: StoredComponent[] };

export function findMessageComponentIncludingDisabled(
  componentsJson: string,
  componentId: string,
  customId: string,
): ComponentLookupResult {
  const components = parseStoredComponents(componentsJson) as StoredComponent[];
  const component = components.find((c) => c.component_id === componentId);
  if (!component) {
    return { ok: false, code: "COMPONENT_NOT_FOUND", message: "component not found" };
  }
  if (component.custom_id !== customId) {
    return { ok: false, code: "INVALID_MESSAGE", message: "custom_id mismatch" };
  }
  return { ok: true, component, components };
}

export function disabledComponentSubmitError(
  component: StoredComponent,
  exclusiveAlreadyUsed: boolean,
): PolicyGateResult & { ok: false } {
  if (exclusiveAlreadyUsed) {
    return {
      ok: false,
      code: "COMPONENT_ALREADY_USED",
      message: "This component has already been used.",
    };
  }
  return { ok: false, code: "COMPONENT_DISABLED", message: "component is disabled" };
}

export function checkTargetedPolicy(component: StoredComponent, actorUserId: string): PolicyGateResult {
  if (resolveInteractionPolicy(component) !== "targeted") return { ok: true };
  const targetUserId = component.target_user_id;
  if (typeof targetUserId !== "string" || targetUserId.length === 0) {
    return { ok: false, code: "INVALID_MESSAGE", message: "targeted component missing target_user_id" };
  }
  if (actorUserId !== targetUserId) {
    return {
      ok: false,
      code: "INTERACTION_FORBIDDEN_TARGET",
      message: "You cannot submit this interaction.",
    };
  }
  return { ok: true };
}

export function validateInteractionValue(component: StoredComponent, value: unknown): PolicyGateResult {
  switch (component.kind) {
    case "button":
      if (value !== true) {
        return { ok: false, code: "INVALID_INTERACTION_VALUE", message: "button value must be true" };
      }
      return { ok: true };
    case "checkbox":
      if (typeof value !== "boolean") {
        return { ok: false, code: "INVALID_INTERACTION_VALUE", message: "checkbox value must be boolean" };
      }
      return { ok: true };
    case "select":
    case "radio": {
      if (typeof value !== "string") {
        return { ok: false, code: "INVALID_INTERACTION_VALUE", message: "value must be a string option" };
      }
      const options = Array.isArray(component.options) ? component.options : [];
      if (!options.some((opt) => isOptionRecord(opt) && opt.value === value)) {
        return { ok: false, code: "INVALID_INTERACTION_VALUE", message: "value is not a valid option" };
      }
      return { ok: true };
    }
    case "checkbox_group": {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        return {
          ok: false,
          code: "INVALID_INTERACTION_VALUE",
          message: "checkbox_group value must be string[]",
        };
      }
      const options = Array.isArray(component.options) ? component.options : [];
      const allowed = new Set(
        options.filter(isOptionRecord).map((opt) => opt.value),
      );
      for (const item of value) {
        if (!allowed.has(item)) {
          return { ok: false, code: "INVALID_INTERACTION_VALUE", message: "value contains invalid option" };
        }
      }
      const minSelected = typeof component.min_selected === "number" ? component.min_selected : 0;
      const maxSelected = typeof component.max_selected === "number" ? component.max_selected : value.length;
      if (value.length < minSelected || value.length > maxSelected) {
        return {
          ok: false,
          code: "INVALID_INTERACTION_VALUE",
          message: "selected count out of range",
        };
      }
      return { ok: true };
    }
    case "text_input": {
      if (typeof value !== "string") {
        return { ok: false, code: "INVALID_INTERACTION_VALUE", message: "text_input value must be string" };
      }
      const minLength = typeof component.min_length === "number" ? component.min_length : 0;
      const maxLength = typeof component.max_length === "number" ? component.max_length : value.length;
      if (value.length < minLength || value.length > maxLength) {
        return { ok: false, code: "INVALID_INTERACTION_VALUE", message: "text length out of range" };
      }
      return { ok: true };
    }
    default:
      return { ok: false, code: "INVALID_INTERACTION_VALUE", message: "unsupported component kind" };
  }
}

function isOptionRecord(value: unknown): value is { value: string } {
  return typeof value === "object" && value !== null && typeof (value as { value?: unknown }).value === "string";
}

/** Active interactions block per_user_once retries with a different command_id. */
export function policyBlocksPerUserOnce(existingCount: number): PolicyGateResult {
  if (existingCount > 0) {
    return {
      ok: false,
      code: "INTERACTION_ALREADY_SUBMITTED",
      message: "You have already submitted this interaction.",
    };
  }
  return { ok: true };
}

/** Active interactions block exclusive component reuse. */
export function policyBlocksExclusive(existingCount: number): PolicyGateResult {
  if (existingCount > 0) {
    return {
      ok: false,
      code: "COMPONENT_ALREADY_USED",
      message: "This component has already been used.",
    };
  }
  return { ok: true };
}

/** SQL statuses that count as a committed interaction for policy gates. */
export const ACTIVE_INTERACTION_STATUSES = ["pending", "completed"] as const;
